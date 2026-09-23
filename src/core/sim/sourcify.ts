/**
 * A contract's own error ABI, from Sourcify — so a project's custom revert shows its name instead
 * of four bytes of hex.
 *
 *   GET https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=abi,proxyResolution
 *   (docs.sourcify.dev/docs/api — v2 is current; the v1 API was turned off on 2026-07-07)
 *
 * What leaves the browser is the chain id and the contract address, nothing else: no key, no
 * account, no transaction, no amount. A 404 means "not verified here", which is an ordinary answer
 * and never an error. Only verified matches are accepted (`match` / `exact_match`, i.e. Sourcify's
 * partial and full match), and a proxy is followed to its implementation, because the proxy's own
 * ABI carries none of the errors.
 *
 * Everything that comes back is untrusted: only `type: "error"` entries are kept, names and
 * parameter types are re-validated against the shapes Solidity can actually produce, and the result
 * is used for ONE thing — turning revert bytes into a name. It never reaches a transaction.
 *
 * No runtime imports on purpose: scripts/gen-headers.mjs loads this file with plain Node to put the
 * host in the Content-Security-Policy.
 */
import type { Abi, AbiParameter } from 'viem'

export const SOURCIFY_SERVER = 'https://sourcify.dev/server'

/** Sourcify's verified-match levels. Anything else is treated as "not verified". */
const ACCEPTED_MATCHES = new Set(['exact_match', 'match'])

export type SourcifyAbi = {
  /** Only the `error` entries, re-validated. */
  abi: Abi
  match: string
  /** The address the ABI actually came from — the implementation, for a proxy. */
  from: string
  viaProxy: boolean
}

export type SourcifyFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** Per-session memory. `null` records "asked, not available", so a miss is not re-fetched. */
const cache = new Map<string, SourcifyAbi | null>()

const key = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

export function clearSourcifyCache(): void {
  cache.clear()
}

/** Exposed for tests: what the cache currently holds. */
export function sourcifyCacheSize(): number {
  return cache.size
}

const isHexAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/** Solidity identifiers only; anything else cannot be a real error name. */
const isIdentifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(v)

/** The elementary and array types an error parameter can have. Tuples are handled recursively. */
const TYPE_RE = /^(address|bool|string|bytes|bytes([1-9]|[12][0-9]|3[0-2])|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|tuple)(\[\d*\])*$/

function cleanParam(raw: unknown, depth = 0): AbiParameter | undefined {
  if (!raw || typeof raw !== 'object' || depth > 4) return undefined
  const r = raw as Record<string, unknown>
  const type = r['type']
  if (typeof type !== 'string' || !TYPE_RE.test(type)) return undefined
  const name = isIdentifier(r['name']) ? (r['name'] as string) : ''
  if (type.startsWith('tuple')) {
    const components = Array.isArray(r['components']) ? (r['components'] as unknown[]).map((c) => cleanParam(c, depth + 1)) : []
    if (components.some((c) => c === undefined)) return undefined
    return { name, type, components: components as AbiParameter[] } as AbiParameter
  }
  return { name, type } as AbiParameter
}

/** Keeps only well-formed `error` entries. A malformed one is dropped, never repaired. */
export function sanitizeErrorAbi(raw: unknown): Abi {
  if (!Array.isArray(raw)) return []
  const out: { type: 'error'; name: string; inputs: AbiParameter[] }[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (e['type'] !== 'error' || !isIdentifier(e['name'])) continue
    const inputsRaw = Array.isArray(e['inputs']) ? (e['inputs'] as unknown[]) : []
    if (inputsRaw.length > 32) continue
    const inputs = inputsRaw.map((i) => cleanParam(i))
    if (inputs.some((i) => i === undefined)) continue
    out.push({ type: 'error', name: e['name'] as string, inputs: inputs as AbiParameter[] })
    if (out.length >= 256) break
  }
  return out as Abi
}

export function sourcifyUrl(chainId: number, address: string): string {
  if (!isHexAddress(address)) throw new Error('not an address')
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('bad chain id')
  return `${SOURCIFY_SERVER}/v2/contract/${chainId}/${address.toLowerCase()}?fields=abi,proxyResolution`
}

type Parsed = { abi: Abi; match: string; implementation?: string }

/** Pure: what one Sourcify response means. Anything unexpected reads as "not verified". */
export function parseSourcifyResponse(json: unknown): Parsed | undefined {
  if (!json || typeof json !== 'object') return undefined
  const r = json as Record<string, unknown>
  const match = typeof r['match'] === 'string' ? r['match'] : ''
  if (!ACCEPTED_MATCHES.has(match)) return undefined

  const proxy = r['proxyResolution'] as Record<string, unknown> | undefined
  let implementation: string | undefined
  if (proxy && proxy['isProxy'] === true && Array.isArray(proxy['implementations'])) {
    const first = (proxy['implementations'] as unknown[])[0] as Record<string, unknown> | undefined
    if (first && isHexAddress(first['address'])) implementation = (first['address'] as string).toLowerCase()
  }

  return { abi: sanitizeErrorAbi(r['abi']), match, ...(implementation ? { implementation } : {}) }
}

/**
 * The contract's error ABI, or undefined when it is not verified, the chain is not indexed, or
 * Sourcify cannot be reached. Never throws: a missing ABI just means the selector stays raw.
 */
export async function fetchContractErrorAbi(chainId: number, address: string, fetchImpl: SourcifyFetch = fetch): Promise<SourcifyAbi | undefined> {
  if (!isHexAddress(address)) return undefined
  const cached = cache.get(key(chainId, address))
  if (cached !== undefined) return cached ?? undefined

  const parsed = await request(chainId, address, fetchImpl)
  if (!parsed) {
    cache.set(key(chainId, address), null)
    return undefined
  }

  // A proxy holds no errors of its own; the implementation does.
  if (parsed.implementation && parsed.abi.length === 0) {
    const impl = await request(chainId, parsed.implementation, fetchImpl)
    if (impl && impl.abi.length > 0) {
      const result: SourcifyAbi = { abi: impl.abi, match: impl.match, from: parsed.implementation, viaProxy: true }
      cache.set(key(chainId, address), result)
      cache.set(key(chainId, parsed.implementation), { ...result, viaProxy: false })
      return result
    }
  }

  if (parsed.abi.length === 0) {
    cache.set(key(chainId, address), null)
    return undefined
  }
  const result: SourcifyAbi = { abi: parsed.abi, match: parsed.match, from: address.toLowerCase(), viaProxy: false }
  cache.set(key(chainId, address), result)
  return result
}

async function request(chainId: number, address: string, fetchImpl: SourcifyFetch): Promise<Parsed | undefined> {
  let res
  try {
    res = await fetchImpl(sourcifyUrl(chainId, address))
  } catch {
    return undefined // unreachable: not an answer about the contract
  }
  if (!res.ok) return undefined // 404 = not verified here, which is an ordinary answer
  try {
    return parseSourcifyResponse(await res.json())
  } catch {
    return undefined
  }
}
