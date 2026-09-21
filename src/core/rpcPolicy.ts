/**
 * ONE list of RPC hosts the app may talk to. It feeds both the CSP `connect-src`
 * (scripts/gen-headers.mjs) and validateRpcUrl(): a user-supplied RPC that the browser would
 * block is refused in settings with a clear message instead of failing silently.
 *
 * Patterns: an exact host, or `*.domain` (any subdomain — this is CSP's own wildcard form).
 */
import { CHAINS } from './chains.ts'

/** Well-known RPC providers people bring their own keys for. Apex domains do not match `*.`. */
export const RPC_PROVIDER_PATTERNS: readonly string[] = [
  '*.alchemy.com',
  '*.infura.io',
  '*.quiknode.pro',
  '*.drpc.org',
  '*.helius-rpc.com',
  '*.rpcpool.com',
  '*.publicnode.com',
  '*.ankr.com',
  '*.chainstack.com',
  '*.blastapi.io',
  '*.nodereal.io',
  '*.tenderly.co',
  '*.1rpc.io',
  '*.onfinality.io',
  '*.getblock.io',
  '*.syndica.io',
  '*.hellomoon.io',
  '*.triton.one',
]

/** Registry hosts (exact) + provider patterns. */
export function allowedRpcHostPatterns(): string[] {
  const exact = new Set<string>()
  for (const c of CHAINS) for (const u of c.rpcUrls) exact.add(new URL(u).hostname)
  return [...[...exact].sort(), ...RPC_PROVIDER_PATTERNS]
}

export function isAllowedRpcHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  for (const p of allowedRpcHostPatterns()) {
    if (p.startsWith('*.')) {
      if (h.endsWith(p.slice(1))) return true // "*.x.com" matches "a.x.com" and "a.b.x.com"
    } else if (h === p) return true
  }
  return false
}

/** CSP `connect-src` entries for every allowed host, https only (wss for the same hosts is not needed). */
export function cspConnectSources(): string[] {
  return allowedRpcHostPatterns().map((p) => `https://${p}`)
}

export type RpcValidation = { ok: true; url: string } | { ok: false; reason: 'empty' | 'not_url' | 'insecure' | 'bad_scheme' | 'host_not_allowed' }

/**
 * Validates a user-supplied RPC URL (§4): `https://` only; `http://` allowed only for localhost;
 * and the host must be one the Content-Security-Policy lets the browser reach — otherwise the
 * request would be blocked silently on the production domain.
 * Returns the normalized origin+path (no credentials, no hash).
 */
export function validateRpcUrl(input: string): RpcValidation {
  const s = input.trim()
  if (s === '') return { ok: false, reason: 'empty' }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, reason: 'not_url' }
  }
  if (u.username || u.password) return { ok: false, reason: 'not_url' }
  if (u.protocol === 'https:') {
    if (!isAllowedRpcHost(u.hostname)) return { ok: false, reason: 'host_not_allowed' }
    return { ok: true, url: u.toString() }
  }
  if (u.protocol === 'http:') {
    const h = u.hostname
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return { ok: true, url: u.toString() }
    return { ok: false, reason: 'insecure' }
  }
  return { ok: false, reason: 'bad_scheme' }
}
