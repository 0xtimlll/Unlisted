/**
 * Cloudflare Pages Function: `POST /rpc/<chainId>` and `POST /rpc/solana` — the one door between
 * the page and any JSON-RPC node.
 *
 * The page never talks to an RPC host itself (the Content-Security-Policy's connect-src is the
 * site's own origin); it posts the JSON-RPC call here, and this function forwards it to one of
 * the public RPCs written down for that chain in src/core/networks.ts. The wallet still sends
 * transactions through its own RPC: nothing that writes is accepted here.
 *
 * What it does, and does not, do:
 *
 *   • Reads only. `eth_call`, `eth_getLogs`, `eth_simulateV1` and the rest of the allow-list
 *     below pass; `eth_sendRawTransaction`, every `eth_sign*`, `personal_sign`, `wallet_*` and
 *     anything not listed is refused with 403 before any node is contacted. The same for Solana:
 *     `sendTransaction` and `requestAirdrop` are not read methods.
 *   • Fails over. Each upstream gets a short timeout; a transport failure, a 429/5xx or a
 *     provider-level JSON-RPC error (rate limit, method not found, block range) moves to the next
 *     URL. The last URL that answered is remembered per chain (in this isolate's memory) and asked
 *     first next time, so a dead node is not retried at the head of every request. A contract's
 *     own answer — a revert — is returned as is; another node would only revert again.
 *   • Hedges. When more than one upstream is eligible, a second one is started after a short
 *     pause if the first has not answered, and the first answer wins. Reads are idempotent, so a
 *     duplicated read costs nothing but one node's time.
 *   • Keeps operators apart. `?provider=<operator>` restricts the upstreams to that operator's
 *     URLs (the `provider` field in networks.ts), so a cross-check that asks two operators gets
 *     two operators — never one answering twice through this function's failover.
 *   • Takes a personal RPC. The `x-rpc-url` header names an https URL the user set in Settings;
 *     it goes first in the queue. It is accepted only for a public hostname on the default port
 *     without credentials, and only after it has answered `eth_chainId` (Solana: `getGenesisHash`)
 *     with this chain's id — checked here, once per isolate, not only in the browser.
 *     `RPC_<chainId>` / `RPC_SOLANA` in the Pages project's environment is the same thing set by the
 *     deployment (a keyed node whose key never reaches the browser).
 *   • Rate-limits. A token bucket per client IP, sized for the bursts a cross-chain search makes.
 *
 * The site password is checked by functions/_middleware.js before this runs, for /rpc as for
 * every other path.
 */
import { NETWORKS } from '../../src/core/networks.ts'

type Rpc = { url: string; provider: string }
type Route = { key: string; vm: 'evm' | 'svm'; chainId: number | null; rpcs: readonly Rpc[] }

type Env = Record<string, string | undefined>
type Context = { request: Request; env: Env; params: { chain?: string | string[] } }

export const EVM_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_call',
  'eth_getCode',
  'eth_getBalance',
  'eth_getLogs',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getStorageAt',
  'eth_chainId',
  'eth_blockNumber',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_simulateV1',
  'net_version',
])

export const SVM_READ_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getVersion',
  'getGenesisHash',
  'getHealth',
  'getSlot',
  'getBlockHeight',
  'getEpochInfo',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getFeeForMessage',
  'getRecentPrioritizationFees',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTransaction',
  'getSignatureStatuses',
  'simulateTransaction',
])

/** Solana mainnet-beta, by its genesis hash — the only "chain id" Solana has. */
export const SOLANA_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

export const LIMITS = {
  upstreamTimeoutMs: 6_000,
  /** A log scan over tens of thousands of blocks or a simulation is slow by nature; it gets this long. */
  heavyTimeoutMs: 15_000,
  hedgeAfterMs: 400,
  maxBodyBytes: 128 * 1024,
  maxBatch: 20,
  /**
   * Token bucket per client. One analysis is a burst of ~300 requests (a search across every
   * chain, two probes, eight route checks with their log scans); the bucket holds several of
   * those and refills faster than a person can paste addresses.
   */
  bucketCapacity: 2_000,
  bucketRefillPerSec: 40,
  customVerifyTtlMs: 10 * 60_000,
} as const

const ROUTES: ReadonlyMap<string, Route> = (() => {
  const m = new Map<string, Route>()
  for (const [key, n] of Object.entries(NETWORKS)) {
    const route: Route = { key, vm: n.vm, chainId: n.chainId, rpcs: n.rpcs }
    if (n.vm === 'svm') m.set(key, route)
    else if (n.chainId !== null) m.set(String(n.chainId), route)
  }
  return m
})()

/* ------------------------------------------------------------------------------------------ */

export type RpcProxyDeps = {
  fetch: typeof fetch
  now: () => number
}

type Attempt = { ok: true; status: number; body: string; url: string } | { ok: false; reason: string; url: string }

const HEAVY_METHODS: ReadonlySet<string> = new Set(['eth_getLogs', 'eth_simulateV1', 'simulateTransaction', 'getTransaction'])

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } })

const rpcError = (status: number, id: unknown, code: number, message: string) => json(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })

/** The operator behind a URL the registry does not know: its registrable domain (src/core/chains.ts, providerOfHost). */
function providerOfHost(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean)
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.')
}

/**
 * Hostnames this function will not fetch: anything that is not a public name on the public
 * internet. An IP literal, a single-label name, the loopback and link-local names, and the
 * reserved private suffixes are refused before DNS is ever asked.
 */
export function isPublicHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === '' || h.startsWith('[') || /^[0-9.]+$/.test(h) || /^[0-9a-f:]+$/.test(h)) return false
  if (!h.includes('.')) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || h.endsWith('.lan') || h.endsWith('.corp') || h.endsWith('.intranet')) return false
  if (h.endsWith('.onion') || h.endsWith('.i2p')) return false
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return false
  return true
}

/**
 * Hosts that serve a chain of their own choosing rather than the chain: a Tenderly Virtual
 * TestNet answers `token()`, `peers()` and every `eth_call` for a contract that does not exist,
 * which is the whole of the fake-route attack in one pasted URL (src/core/rpcPolicy.ts has
 * refused these since the first audit). A fork is not an RPC of the chain, whatever chain id it
 * answers.
 */
export const FORK_HOSTS = /(^|\.)tenderly\.co$|(^|\.)tenderly\.dev$|(^|\.)buildbear\.io$|(^|\.)phalcon\.xyz$/i

/** A personal RPC as the page may name it: https, default port, public hostname, no credentials, no fragment, not a fork service. */
export function validateCustomRpc(raw: string): { ok: true; url: string; provider: string } | { ok: false; reason: string } {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https only' }
  if (u.port !== '') return { ok: false, reason: 'default port only' }
  if (u.username || u.password) return { ok: false, reason: 'no credentials in the URL' }
  if (!isPublicHostname(u.hostname)) return { ok: false, reason: 'not a public hostname' }
  if (FORK_HOSTS.test(u.hostname)) return { ok: false, reason: 'a fork or simulation service is not an RPC of the chain' }
  u.hash = ''
  return { ok: true, url: u.toString(), provider: providerOfHost(u.hostname) }
}

/** JSON-RPC errors that are the provider's, not the contract's: another node may answer. */
function providerLevelError(err: { code?: unknown; message?: unknown }): boolean {
  const code = typeof err.code === 'number' ? err.code : undefined
  const msg = String(err.message ?? '').toLowerCase()
  if (/revert|execution|insufficient funds|nonce|gas required|intrinsic gas|out of gas|invalid opcode|stack underflow|invalid jump|transaction underpriced/.test(msg)) return false
  // -32001 is how keyless tiers say "quota spent" (1rpc.io: "You've reached the usage limit for your current plan").
  if (code === -32601 || code === -32005 || code === -32016 || code === -32029 || code === -32603 || code === -32001 || code === 429) return true
  return /rate limit|too many|limit exceeded|usage limit|quota|your current plan|api key|apikey|unauthorized|capacity|try again|timeout|timed out|unavailable|overloaded|not supported|unsupported|block range|range too|exceed|not found/.test(msg)
}

/* Per-isolate memory: the last upstream that answered for a chain, verified personal RPCs, buckets. */
const lastGood = new Map<string, string>()
const verifiedCustom = new Map<string, { ok: boolean; reason: string; at: number }>()
const buckets = new Map<string, { tokens: number; at: number }>()

/** Visible for tests: forget everything this isolate learned. */
export function resetProxyMemory(): void {
  lastGood.clear()
  verifiedCustom.clear()
  buckets.clear()
}

function takeToken(ip: string, now: number): boolean {
  const b = buckets.get(ip) ?? { tokens: LIMITS.bucketCapacity, at: now }
  const refill = ((now - b.at) / 1000) * LIMITS.bucketRefillPerSec
  b.tokens = Math.min(LIMITS.bucketCapacity, b.tokens + refill)
  b.at = now
  if (b.tokens < 1) {
    buckets.set(ip, b)
    return false
  }
  b.tokens -= 1
  buckets.set(ip, b)
  if (buckets.size > 10_000) {
    // Keep the map bounded: drop whoever has been quiet longest.
    for (const [k, v] of buckets) if (now - v.at > 60_000) buckets.delete(k)
  }
  return true
}

export function createRpcProxy(deps: RpcProxyDeps) {
  async function call(url: string, body: string, signal: AbortSignal, timeoutMs: number = LIMITS.upstreamTimeoutMs): Promise<Attempt> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), timeoutMs)
    const onOuter = () => ctrl.abort(signal.reason)
    signal.addEventListener('abort', onOuter, { once: true })
    try {
      const r = await deps.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal: ctrl.signal, redirect: 'manual' })
      if (r.status === 429 || r.status >= 500 || r.status === 403 || r.status === 402) return { ok: false, reason: `HTTP ${r.status}`, url }
      if (r.status !== 200) return { ok: false, reason: `HTTP ${r.status}`, url }
      const text = await r.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, reason: 'not JSON', url }
      }
      // A provider-level error is a reason to ask the next node; a contract's answer is final.
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const it of items) {
        const err = (it as { error?: { code?: unknown; message?: unknown } } | null)?.error
        if (err && providerLevelError(err)) return { ok: false, reason: `rpc error: ${String(err.message ?? err.code)}`, url }
      }
      return { ok: true, status: 200, body: text, url }
    } catch (e) {
      return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 120), url }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuter)
    }
  }

  /**
   * Try the upstreams in order with at most two in flight: the next one starts when the current
   * one fails, or after `hedgeAfterMs` of silence. The first success wins and the rest are aborted.
   */
  async function race(urls: readonly string[], body: string, hedge: boolean, timeoutMs: number): Promise<Attempt> {
    const outer = new AbortController()
    const failures: Attempt[] = []
    let next = 0
    let inFlight = 0
    return new Promise<Attempt>((resolve) => {
      let done = false
      const finish = (a: Attempt) => {
        if (done) return
        done = true
        outer.abort(new Error('settled'))
        resolve(a)
      }
      const launch = () => {
        if (done || next >= urls.length) return
        const url = urls[next++]!
        inFlight++
        void call(url, body, outer.signal, timeoutMs).then((a) => {
          inFlight--
          if (a.ok) return finish(a)
          failures.push(a)
          if (next < urls.length) launch()
          else if (inFlight === 0) finish(failures[failures.length - 1]!)
        })
      }
      launch()
      if (hedge && urls.length > 1) {
        setTimeout(() => {
          if (!done && inFlight < 2) launch()
        }, LIMITS.hedgeAfterMs)
      }
    })
  }

  async function verifyCustom(route: Route, url: string): Promise<{ ok: boolean; reason: string }> {
    const now = deps.now()
    const cached = verifiedCustom.get(`${route.key} ${url}`)
    if (cached && now - cached.at < LIMITS.customVerifyTtlMs) return cached
    const probe = route.vm === 'evm' ? { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } : { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }
    const a = await call(url, JSON.stringify(probe), new AbortController().signal)
    let result: { ok: boolean; reason: string }
    if (!a.ok) result = { ok: false, reason: `the RPC did not answer: ${a.reason}` }
    else {
      let got: unknown
      try {
        got = (JSON.parse(a.body) as { result?: unknown }).result
      } catch {
        got = undefined
      }
      if (route.vm === 'evm') {
        const id = typeof got === 'string' ? Number(got) : NaN
        result = id === route.chainId ? { ok: true, reason: '' } : { ok: false, reason: `the RPC serves chain ${Number.isNaN(id) ? '?' : id}, not ${route.chainId}` }
      } else {
        result = got === SOLANA_GENESIS ? { ok: true, reason: '' } : { ok: false, reason: 'the RPC is not Solana mainnet-beta' }
      }
    }
    verifiedCustom.set(`${route.key} ${url}`, { ...result, at: now })
    return result
  }

  return async function onRequest(context: Context): Promise<Response> {
    const { request, env } = context
    if (request.method !== 'POST') return json(405, { error: 'POST only' }, { allow: 'POST' })
    const chainParam = Array.isArray(context.params.chain) ? context.params.chain[0] : context.params.chain
    const route = chainParam ? ROUTES.get(chainParam) : undefined
    if (!route) return json(404, { error: 'unknown chain' })

    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    if (!takeToken(ip, deps.now())) return rpcError(429, null, -32005, 'rate limit: slow down')

    const text = await request.text()
    if (text.length > LIMITS.maxBodyBytes) return rpcError(413, null, -32600, 'request too large')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return rpcError(400, null, -32700, 'invalid JSON')
    }
    const items = Array.isArray(parsed) ? parsed : [parsed]
    if (items.length === 0 || items.length > LIMITS.maxBatch) return rpcError(400, null, -32600, 'bad batch size')
    const allowed = route.vm === 'evm' ? EVM_READ_METHODS : SVM_READ_METHODS
    for (const it of items) {
      const o = it as { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown } | null
      if (!o || typeof o !== 'object' || typeof o.method !== 'string') return rpcError(400, null, -32600, 'invalid request')
      if (!allowed.has(o.method)) return rpcError(403, o.id, -32601, `method not allowed by this proxy: ${o.method.slice(0, 64)}`)
      if (o.params !== undefined && !Array.isArray(o.params) && (typeof o.params !== 'object' || o.params === null)) return rpcError(400, o.id, -32602, 'invalid params')
    }

    // The queue: personal RPC, the deployment's own node, then the registry — the remembered
    // good one first — filtered to one operator when the page asks for one.
    const url = new URL(request.url)
    const wantProvider = url.searchParams.get('provider')?.toLowerCase() ?? ''
    const queue: Rpc[] = []
    const custom = request.headers.get('x-rpc-url')
    if (custom) {
      const v = validateCustomRpc(custom)
      if (!v.ok) return rpcError(400, null, -32600, `custom RPC refused: ${v.reason}`)
      const ver = await verifyCustom(route, v.url)
      if (!ver.ok) return rpcError(400, null, -32600, `custom RPC refused: ${ver.reason}`)
      queue.push({ url: v.url, provider: v.provider })
    }
    const envRpc = env[route.vm === 'svm' ? 'RPC_SOLANA' : `RPC_${route.chainId}`]
    if (envRpc) {
      const v = validateCustomRpc(envRpc)
      if (v.ok) queue.push({ url: v.url, provider: v.provider })
    }
    const remembered = lastGood.get(route.key)
    const registry = [...route.rpcs].sort((a, b) => (a.url === remembered ? -1 : b.url === remembered ? 1 : 0))
    queue.push(...registry)
    const eligible = wantProvider ? queue.filter((r) => r.provider === wantProvider) : queue
    if (eligible.length === 0) return rpcError(400, null, -32600, `no RPC of operator ${wantProvider.slice(0, 64)} for this chain`)

    const heavy = items.some((it) => HEAVY_METHODS.has(String((it as { method: string }).method)))
    const a = await race(
      eligible.map((r) => r.url),
      text,
      !Array.isArray(parsed),
      heavy ? LIMITS.heavyTimeoutMs : LIMITS.upstreamTimeoutMs,
    )
    if (!a.ok) {
      if (remembered === a.url) lastGood.delete(route.key)
      return rpcError(502, (items[0] as { id?: unknown }).id, -32603, `no RPC answered: ${a.reason}`)
    }
    if (route.rpcs.some((r) => r.url === a.url)) lastGood.set(route.key, a.url)
    const provider = eligible.find((r) => r.url === a.url)?.provider ?? ''
    return new Response(a.body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-rpc-provider': provider } })
  }
}

const defaultProxy = createRpcProxy({ fetch: (input, init) => fetch(input, init), now: () => Date.now() })

export const onRequest = (context: Context): Promise<Response> => defaultProxy(context)
