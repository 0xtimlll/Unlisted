/**
 * What the page may connect to, and what a personal RPC may be.
 *
 * Since the reads moved behind the site's own /rpc function (core/rpcProxy.ts, functions/rpc),
 * the browser talks to no EVM RPC host at all: the Content-Security-Policy's connect-src is the
 * site's origin plus the few APIs named in scripts/gen-headers.mjs. A personal EVM RPC is any
 * public https host — the function fetches it, verifies it serves the chain, and never lets the
 * browser near it.
 *
 * Solana is the one exception, and it is this file's reason to still name hosts. The Solana send
 * path submits the signed transaction through its own RPC (core/svm/urls.ts) — a submit is the
 * one call the function refuses — so the page must be allowed to reach that host directly. The
 * registry's Solana RPCs and the known Solana providers below are therefore in connect-src, and
 * a personal Solana RPC has to be one of them or the browser would block it silently.
 */
import { byKey, CHAINS, isSvm } from './chains.ts'

/**
 * Hosts that serve a chain of their own choosing rather than the chain. A Tenderly Virtual
 * TestNet is an endpoint whose contract state its creator chooses, so a pasted URL to one could
 * answer `token()`, `peers()` and `eth_call` for a contract that does not exist — the whole of
 * the fake-route attack in one link. Refused for every chain, here and in the /rpc function
 * (functions/rpc/[chain].ts, FORK_HOSTS), whatever chain id the fork answers.
 */
export const FORK_HOSTS = /(^|\.)tenderly\.co$|(^|\.)tenderly\.dev$|(^|\.)buildbear\.io$|(^|\.)phalcon\.xyz$/i

/**
 * Well-known RPC providers people bring their own Solana keys for. Apex domains do not match `*.`.
 * These are node operators serving the real chain; anything added here should be a provider of
 * the chain, not a provider of a chain.
 */
export const SOLANA_PROVIDER_PATTERNS: readonly string[] = [
  '*.helius-rpc.com',
  '*.rpcpool.com',
  '*.quiknode.pro',
  '*.alchemy.com',
  '*.drpc.org',
  '*.publicnode.com',
  '*.ankr.com',
  '*.chainstack.com',
  '*.getblock.io',
  '*.syndica.io',
  '*.hellomoon.io',
  '*.triton.one',
]

/** The Solana hosts the page may reach directly: the registry's (exact) + the providers (patterns). */
export function allowedSolanaHostPatterns(): string[] {
  const exact = new Set<string>()
  for (const c of CHAINS) if (isSvm(c)) for (const u of c.rpcUrls) exact.add(new URL(u).hostname)
  return [...[...exact].sort(), ...SOLANA_PROVIDER_PATTERNS]
}

export function isAllowedSolanaHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  for (const p of allowedSolanaHostPatterns()) {
    if (p.startsWith('*.')) {
      if (h.endsWith(p.slice(1))) return true // "*.x.com" matches "a.x.com" and "a.b.x.com"
    } else if (h === p) return true
  }
  return false
}

/** CSP `connect-src` entries beyond 'self': the Solana hosts, https only. */
export function cspConnectSources(): string[] {
  return allowedSolanaHostPatterns().map((p) => `https://${p}`)
}

/**
 * A hostname on the public internet — the same rule the /rpc function applies before it fetches
 * anything (functions/rpc/[chain].ts, isPublicHostname): no IP literal, no single-label name,
 * none of the loopback, link-local or private suffixes.
 */
export function isPublicHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === '' || h.startsWith('[') || /^[0-9.]+$/.test(h) || /^[0-9a-f:]+$/.test(h)) return false
  if (!h.includes('.')) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || h.endsWith('.lan') || h.endsWith('.corp') || h.endsWith('.intranet')) return false
  if (h.endsWith('.onion') || h.endsWith('.i2p')) return false
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)
}

export type RpcValidation = { ok: true; url: string } | { ok: false; reason: 'empty' | 'not_url' | 'insecure' | 'bad_scheme' | 'port' | 'private_host' | 'fork_service' | 'host_not_allowed' }

/**
 * Validates a user-supplied RPC URL (§4) for a chain of the given VM: `https://` only, the
 * default port, no credentials, a public hostname. For Solana the host must also be one the
 * Content-Security-Policy lets the page reach (see the top of this file). Whether the URL serves
 * the right chain is checked separately, by the /rpc function, when it is saved and whenever it is
 * used. Returns the normalized URL (no credentials, no hash).
 */
export function validateRpcUrl(input: string, vm: 'evm' | 'svm' = 'evm'): RpcValidation {
  const s = input.trim()
  if (s === '') return { ok: false, reason: 'empty' }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, reason: 'not_url' }
  }
  if (u.username || u.password) return { ok: false, reason: 'not_url' }
  if (u.protocol === 'http:') return { ok: false, reason: 'insecure' }
  if (u.protocol !== 'https:') return { ok: false, reason: 'bad_scheme' }
  if (u.port !== '') return { ok: false, reason: 'port' }
  if (!isPublicHostname(u.hostname)) return { ok: false, reason: 'private_host' }
  if (FORK_HOSTS.test(u.hostname)) return { ok: false, reason: 'fork_service' }
  if (vm === 'svm' && !isAllowedSolanaHost(u.hostname)) return { ok: false, reason: 'host_not_allowed' }
  // A fragment is never sent to the server, yet it is stored and shown back, so it is dropped.
  u.hash = ''
  return { ok: true, url: u.toString() }
}

/** The VM a chain key belongs to, for callers that validate by key. */
export function vmOfKey(key: Parameters<typeof byKey>[0]): 'evm' | 'svm' {
  return byKey(key).vm
}
