/**
 * The /rpc Pages Function (functions/rpc/[chain].ts) with a fake upstream: the method
 * allow-list, failover, hedging, the operator pin, the personal RPC gate, the rate limit.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createRpcProxy, EVM_READ_METHODS, isPublicHostname, LIMITS, resetProxyMemory, SOLANA_GENESIS, SVM_READ_METHODS, validateCustomRpc } from '../../functions/rpc/[chain]'
import { evmByKey, byKey } from '@/core/chains'
import { proxyUrl, readTargets, readUrls } from '@/core/rpcProxy'

type Upstream = (url: string, body: unknown) => Promise<Response> | Response

const ETH = evmByKey('ethereum')
const [ETH_A, ETH_B] = ETH.rpcUrls as [string, string]

const ok = (result: unknown, id: unknown = 1) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
const rpcErr = (code: number, message: string, id: unknown = 1) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status: 200 })
const never = () => new Promise<Response>(() => {})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A proxy whose upstreams are `routes`, with every fetch recorded. */
function harness(routes: Record<string, Upstream>, opts: { now?: () => number } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? 'null')) as { method?: string } | { method?: string }[]
    const method = Array.isArray(body) ? body.map((b) => b.method).join(',') : (body?.method ?? '')
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries())
    calls.push({ url, method, headers })
    const up = routes[url]
    if (!up) return new Response('no such upstream', { status: 404 })
    const signal = init?.signal
    const p = up(url, body)
    if (signal) {
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        Promise.resolve(p).then(resolve, reject)
      })
    }
    return p
  }
  const handler = createRpcProxy({ fetch: fetchImpl, now: opts.now ?? (() => Date.now()) })
  const send = (chain: string, body: unknown, init: { headers?: Record<string, string>; query?: string; ip?: string; method?: string } = {}) =>
    handler({
      request: new Request(`https://unlisted.example/rpc/${chain}${init.query ?? ''}`, {
        method: init.method ?? 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': init.ip ?? '203.0.113.1', ...(init.headers ?? {}) },
        ...(init.method === 'GET' ? {} : { body: JSON.stringify(body) }),
      }),
      env: {},
      params: { chain },
    })
  return { calls, send }
}

const CALL = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest'] }

beforeEach(() => resetProxyMemory())

describe('allow-list', () => {
  it('names no write or signing method', () => {
    for (const m of [...EVM_READ_METHODS]) expect(m).not.toMatch(/send|sign|wallet_|personal_|submit|subscribe|miner|admin|debug_|txpool/i)
    for (const m of [...SVM_READ_METHODS]) expect(m).not.toMatch(/^(send|sign|request)|airdrop|subscribe/i)
    expect(EVM_READ_METHODS.has('eth_call')).toBe(true)
    expect(EVM_READ_METHODS.has('eth_simulateV1')).toBe(true)
    expect(SVM_READ_METHODS.has('simulateTransaction')).toBe(true)
  })

  it('refuses writes before any node is contacted', async () => {
    const h = harness({ [ETH_A]: () => ok('0x1') })
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_addEthereumChain', 'debug_traceCall', 'eth_subscribe']) {
      const r = await h.send('1', { jsonrpc: '2.0', id: 7, method, params: [] })
      expect(r.status, method).toBe(403)
      const body = (await r.json()) as { error: { code: number; message: string }; id: unknown }
      expect(body.error.code).toBe(-32601)
      expect(body.error.message).toContain(method)
      expect(body.id).toBe(7)
    }
    for (const method of ['sendTransaction', 'requestAirdrop', 'signTransaction']) {
      const r = await h.send('solana', { jsonrpc: '2.0', id: 1, method, params: [] })
      expect(r.status, method).toBe(403)
    }
    expect(h.calls).toHaveLength(0)
  })

  it('refuses a write hidden inside a batch, and a batch that is too long', async () => {
    const h = harness({ [ETH_A]: () => ok('0x1') })
    const r = await h.send('1', [CALL, { ...CALL, id: 2, method: 'eth_sendRawTransaction' }])
    expect(r.status).toBe(403)
    const big = await h.send('1', Array.from({ length: LIMITS.maxBatch + 1 }, (_, i) => ({ ...CALL, id: i })))
    expect(big.status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })

  it('answers 404 for a chain it does not serve, 405 for GET, 400 for bad JSON', async () => {
    const h = harness({})
    expect((await h.send('999999', CALL)).status).toBe(404)
    expect((await h.send('1', CALL, { method: 'GET' })).status).toBe(405)
    const bad = await createRpcProxy({ fetch: async () => ok('0x'), now: () => 0 })({
      request: new Request('https://x/rpc/1', { method: 'POST', body: '{not json' }),
      env: {},
      params: { chain: '1' },
    })
    expect(bad.status).toBe(400)
  })
})

describe('failover', () => {
  it('the second RPC answers when the first is down (HTTP 500)', async () => {
    const h = harness({ [ETH_A]: () => new Response('boom', { status: 500 }), [ETH_B]: () => ok('0xaa') })
    const r = await h.send('1', CALL)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { result: string }).result).toBe('0xaa')
    expect(r.headers.get('x-rpc-provider')).toBe(ETH.rpcs[1]!.provider)
    expect(h.calls.map((c) => c.url)).toEqual([ETH_A, ETH_B])
  })

  it('a 429, a non-JSON body and a provider-level JSON-RPC error all move on; a revert does not', async () => {
    for (const first of [() => new Response('slow down', { status: 429 }), () => new Response('<html>', { status: 200 }), () => rpcErr(-32005, 'limit exceeded'), () => rpcErr(-32601, 'the method eth_simulateV1 does not exist')]) {
      resetProxyMemory()
      const h = harness({ [ETH_A]: first, [ETH_B]: () => ok('0xbb') })
      const r = await h.send('1', CALL)
      expect(((await r.json()) as { result: string }).result).toBe('0xbb')
    }
    resetProxyMemory()
    const h = harness({ [ETH_A]: () => rpcErr(3, 'execution reverted: SlippageExceeded'), [ETH_B]: () => ok('0xbb') })
    const r = await h.send('1', CALL)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain('reverted')
    expect(h.calls).toHaveLength(1)
  })

  it('remembers the RPC that answered and asks it first next time', async () => {
    const h = harness({ [ETH_A]: () => new Response('', { status: 503 }), [ETH_B]: () => ok('0xcc') })
    await h.send('1', CALL)
    expect(h.calls.map((c) => c.url)).toEqual([ETH_A, ETH_B])
    h.calls.length = 0
    await h.send('1', CALL)
    expect(h.calls[0]!.url).toBe(ETH_B)
    expect(h.calls).toHaveLength(1)
  })

  it('answers 502 with the last reason when every RPC fails', async () => {
    const h = harness({ [ETH_A]: () => new Response('', { status: 500 }), [ETH_B]: () => new Response('', { status: 502 }) })
    const r = await h.send('1', CALL)
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/no RPC answered/)
  })

  it('hedges: a second RPC is started when the first stays silent, and the first answer wins', async () => {
    const h = harness({ [ETH_A]: never, [ETH_B]: () => ok('0xdd') })
    const t0 = Date.now()
    const r = await h.send('1', CALL)
    expect(((await r.json()) as { result: string }).result).toBe('0xdd')
    expect(Date.now() - t0).toBeLessThan(LIMITS.upstreamTimeoutMs)
    expect(h.calls.map((c) => c.url)).toEqual([ETH_A, ETH_B])
  })

  it('does not hedge a batch', async () => {
    const h = harness({ [ETH_A]: async () => { await sleep(LIMITS.hedgeAfterMs + 150); return ok('0xee') }, [ETH_B]: () => ok('0xff') })
    const r = await h.send('1', [CALL])
    expect(((await r.json()) as { result: string }).result).toBe('0xee')
    expect(h.calls.map((c) => c.url)).toEqual([ETH_A])
  })
})

describe('operators stay apart', () => {
  it('?provider= pins the upstreams to that operator — a cross-check never gets one operator twice', async () => {
    const h = harness({ [ETH_A]: () => ok('0x01'), [ETH_B]: () => ok('0x02') })
    const b = ETH.rpcs[1]!
    const r = await h.send('1', CALL, { query: `?provider=${b.provider}` })
    expect(((await r.json()) as { result: string }).result).toBe('0x02')
    expect(h.calls.map((c) => c.url)).toEqual([ETH_B])
  })

  it('a pinned operator that is down is not quietly replaced by another', async () => {
    const h = harness({ [ETH_A]: () => new Response('', { status: 500 }), [ETH_B]: () => ok('0x02') })
    const r = await h.send('1', CALL, { query: `?provider=${ETH.rpcs[0]!.provider}` })
    expect(r.status).toBe(502)
    expect(h.calls.map((c) => c.url)).toEqual([ETH_A])
  })

  it('an operator the chain has no RPC of is a 400', async () => {
    const h = harness({})
    expect((await h.send('1', CALL, { query: '?provider=nobody.example' })).status).toBe(400)
  })
})

describe('personal RPC', () => {
  const MINE = 'https://my-node.example.org/v1/key'

  it('goes first, after answering eth_chainId for this chain — checked once, then remembered', async () => {
    let probes = 0
    const h = harness({
      [MINE]: (_u, body) => {
        if ((body as { method: string }).method === 'eth_chainId') {
          probes++
          return ok('0x1')
        }
        return ok('0xmine')
      },
      [ETH_A]: () => ok('0xregistry'),
    })
    const r1 = await h.send('1', CALL, { headers: { 'x-rpc-url': MINE } })
    expect(((await r1.json()) as { result: string }).result).toBe('0xmine')
    expect(r1.headers.get('x-rpc-provider')).toBe('example.org')
    const r2 = await h.send('1', CALL, { headers: { 'x-rpc-url': MINE } })
    expect(((await r2.json()) as { result: string }).result).toBe('0xmine')
    expect(probes).toBe(1)
  })

  it('is refused when it serves another chain, and the registry is NOT used instead', async () => {
    const h = harness({ [MINE]: () => ok('0x38'), [ETH_A]: () => ok('0xregistry') })
    const r = await h.send('1', CALL, { headers: { 'x-rpc-url': MINE } })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/serves chain 56, not 1/)
    expect(h.calls.map((c) => c.url)).toEqual([MINE])
  })

  it('is refused when it is not a public https host on the default port', async () => {
    const h = harness({ [ETH_A]: () => ok('0x1') })
    for (const bad of ['https://virtual.mainnet.rpc.tenderly.co/abc', 'https://rpc.buildbear.io/x', 'http://my-node.example.org', 'https://localhost/rpc', 'https://127.0.0.1/rpc', 'https://10.0.0.5/rpc', 'https://[::1]/rpc', 'https://node.internal/rpc', 'https://rpc.local/', 'https://node.example.org:8545/', 'https://user:pw@node.example.org/', 'https://node/', 'ftp://node.example.org/']) {
      const r = await h.send('1', CALL, { headers: { 'x-rpc-url': bad } })
      expect(r.status, bad).toBe(400)
    }
    expect(h.calls).toHaveLength(0)
  })

  it('a Solana RPC must be mainnet-beta by genesis hash', async () => {
    const SOL = byKey('solana').rpcUrls[0]!
    const h = harness({ [MINE]: (_u, body) => ((body as { method: string }).method === 'getGenesisHash' ? ok('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') : ok({})), [SOL]: () => ok({ 'solana-core': '2.0' }) })
    const r = await h.send('solana', { jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] }, { headers: { 'x-rpc-url': MINE } })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/not Solana mainnet-beta/)
    expect(SOLANA_GENESIS).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
  })

  it('validateCustomRpc and isPublicHostname agree with the browser-side rule', () => {
    expect(validateCustomRpc('https://mainnet.helius-rpc.com/?api-key=x#frag')).toEqual({ ok: true, url: 'https://mainnet.helius-rpc.com/?api-key=x', provider: 'helius-rpc.com' })
    expect(isPublicHostname('rpc.example.org')).toBe(true)
    expect(isPublicHostname('example')).toBe(false)
    expect(isPublicHostname('192.168.0.1')).toBe(false)
    expect(isPublicHostname('node.home.arpa')).toBe(false)
  })
})

describe('rate limit', () => {
  it('stops a client that exhausts its bucket and lets it refill', async () => {
    let t = 1_000_000
    const h = harness({ [ETH_A]: () => ok('0x1') }, { now: () => t })
    for (let i = 0; i < LIMITS.bucketCapacity; i++) expect((await h.send('1', CALL)).status).toBe(200)
    expect((await h.send('1', CALL)).status).toBe(429)
    expect((await h.send('1', CALL, { ip: '198.51.100.9' })).status).toBe(200) // another client is unaffected
    t += 1_000
    expect((await h.send('1', CALL)).status).toBe(200) // ~15 tokens refilled
  })
})

describe('the page side (core/rpcProxy.ts)', () => {
  it('has no proxy outside a browser, so tests and scripts read the public RPCs directly', () => {
    expect(proxyUrl(ETH)).toBeUndefined()
    expect(readUrls(ETH).urls).toEqual(ETH.rpcUrls)
    expect(readUrls(ETH, 'https://mine.example.org').urls[0]).toBe('https://mine.example.org')
  })

  it('in a browser every read is a proxy URL, one per operator for a cross-check, the personal RPC in a header', () => {
    const g = globalThis as { location?: unknown }
    g.location = { origin: 'https://unlisted.example', protocol: 'https:' }
    try {
      expect(proxyUrl(ETH)).toBe('https://unlisted.example/rpc/1')
      expect(proxyUrl(byKey('solana'), 'publicnode.com')).toBe('https://unlisted.example/rpc/solana?provider=publicnode.com')
      const targets = readTargets(ETH)
      expect(targets.map((t) => t.provider)).toEqual([...new Set(ETH.rpcs.map((r) => r.provider))])
      for (const t of targets) expect(t.urls).toEqual([`https://unlisted.example/rpc/1?provider=${t.provider}`])
      const mine = readTargets(ETH, 'https://mine.example.org/x')
      expect(mine[0]).toEqual({ provider: 'example.org', urls: ['https://unlisted.example/rpc/1?provider=example.org'], headers: { 'x-rpc-url': 'https://mine.example.org/x' }, viaProxy: true })
      expect(readUrls(ETH, 'https://mine.example.org/x')).toEqual({ urls: ['https://unlisted.example/rpc/1'], headers: { 'x-rpc-url': 'https://mine.example.org/x' }, viaProxy: true })
    } finally {
      delete g.location
    }
  })
})
