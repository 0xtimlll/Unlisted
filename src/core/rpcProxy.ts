/**
 * Where a read goes: through the site's own `/rpc/<chain>` function in the browser, straight to
 * the public RPCs anywhere else.
 *
 * In the browser the page talks to no RPC host directly — the Content-Security-Policy's
 * connect-src is the site's origin — so every viem transport and every Solana read client is
 * pointed at functions/rpc/[chain].ts, which fails over, hedges and remembers the live node. A
 * personal RPC from Settings rides along in the `x-rpc-url` header and goes first in the
 * function's queue; the function verifies it answers for this chain before using it.
 *
 * Node has no page and no function: the integration tests and the scripts read the public RPCs
 * as they always have. That is what `proxyOrigin()` decides, by whether there is a `location`.
 *
 * The operator question survives the hop. A cross-check (core/quorum.ts) asks two OPERATORS, and
 * the function's failover would quietly turn "publicnode said so" into "whoever answered said
 * so" — so a client made for one operator asks `?provider=<operator>` and the function then
 * uses that operator's URLs and no other.
 */
import { providerOfUrl, type ChainDef } from './chains'

export const RPC_PROXY_PATH = '/rpc/'

/** The origin the proxy lives on: the page's own. Undefined outside a browser. */
export function proxyOrigin(): string | undefined {
  const loc = (globalThis as { location?: { origin?: string; protocol?: string } }).location
  if (!loc?.origin || loc.protocol === 'file:' || loc.protocol === 'about:') return undefined
  return loc.origin
}

/** The chain's segment of the proxy path: its EVM chain id, or `solana`. */
export function proxyChainSegment(c: ChainDef): string {
  return c.vm === 'evm' ? String(c.chainId) : 'solana'
}

/** `https://<site>/rpc/<chain>[?provider=<operator>]`, or undefined outside a browser. */
export function proxyUrl(c: ChainDef, provider?: string): string | undefined {
  const origin = proxyOrigin()
  if (!origin) return undefined
  const u = new URL(`${RPC_PROXY_PATH}${proxyChainSegment(c)}`, origin)
  if (provider) u.searchParams.set('provider', provider)
  return u.toString()
}

/** The header that carries a personal RPC to the function. */
export function proxyHeaders(customRpc: string | undefined): Record<string, string> {
  return customRpc ? { 'x-rpc-url': customRpc } : {}
}

/**
 * One read target per OPERATOR, in registry order, the user's own RPC first when set. In the
 * browser each target is a proxy URL pinned to that operator; in Node it is the operator's URLs
 * themselves (one target may hold several, which fall back among each other and are one opinion).
 */
export type ReadTarget = { provider: string; urls: readonly string[]; headers: Record<string, string>; viaProxy: boolean }

export function readTargets(c: ChainDef, customRpc?: string): ReadTarget[] {
  const out: ReadTarget[] = []
  const origin = proxyOrigin()
  if (customRpc) {
    const provider = providerOfUrl(customRpc)
    out.push({ provider, urls: origin ? [proxyUrl(c, provider)!] : [customRpc], headers: proxyHeaders(customRpc), viaProxy: !!origin })
  }
  const seen = new Set(out.map((t) => t.provider))
  for (const r of c.rpcs) {
    if (seen.has(r.provider)) continue
    seen.add(r.provider)
    out.push({ provider: r.provider, urls: origin ? [proxyUrl(c, r.provider)!] : c.rpcs.filter((x) => x.provider === r.provider).map((x) => x.url), headers: {}, viaProxy: !!origin })
  }
  return out
}

/**
 * The plain read path, when no operator is being singled out: the function's whole queue in the
 * browser (personal RPC, the deployment's node, the registry with its remembered good node first),
 * the personal RPC then the registry's URLs in Node.
 */
export function readUrls(c: ChainDef, customRpc?: string): { urls: readonly string[]; headers: Record<string, string>; viaProxy: boolean } {
  const origin = proxyOrigin()
  if (origin) return { urls: [proxyUrl(c)!], headers: proxyHeaders(customRpc), viaProxy: true }
  return { urls: customRpc ? [customRpc, ...c.rpcUrls] : [...c.rpcUrls], headers: {}, viaProxy: false }
}
