/**
 * The official list of NTT tokens, from Wormhole's own explorer:
 *
 *   GET https://api.wormholescan.io/api/v1/native-token-transfer/token-list
 *   (documented at wormhole.com/docs/products/messaging/guides/wormholescan-api/)
 *
 * It lists TOKENS, not managers: symbol, a CoinGecko id, market data, and `platforms`, the token's
 * address on each chain. That is exactly what it is used for here — deciding whether the token a
 * user is about to bridge is an NTT token at all. The manager is never taken from this list,
 * because the list does not contain one; it is anchored from the token side instead (verify.ts).
 *
 * The response is untrusted data: everything is re-validated, and anything odd is dropped.
 */
import { getAddress, isAddress, type Address } from 'viem'
import type { ChainKey } from '../../core/chains.ts'
import { WORMHOLESCAN_API } from './chains.ts'

export { WORMHOLESCAN_API }
export const TOKEN_LIST_URL = `${WORMHOLESCAN_API}/api/v1/native-token-transfer/token-list?withLinks=false`

/**
 * CoinGecko asset-platform ids, which is how the list keys its `platforms` map. A wrong entry here
 * can only ever fail to find a token (the address must still match exactly), never match the wrong
 * one — so this mapping cannot turn into an approval for something else.
 */
export const COINGECKO_PLATFORM: Partial<Record<ChainKey, string>> = {
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  polygon: 'polygon-pos',
  avalanche: 'avalanche',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  base: 'base',
  linea: 'linea',
  scroll: 'scroll',
  hyperevm: 'hyperevm',
  solana: 'solana',
}

export type NttToken = {
  symbol: string
  coingeckoId: string
  /** platform id -> token address, as the list gives it. */
  platforms: Record<string, string>
}

const str = (v: unknown, max = 64): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Parses the API response. Never throws on shape; a malformed entry is simply not in the result. */
export function parseTokenList(json: unknown): NttToken[] {
  if (!Array.isArray(json)) return []
  const out: NttToken[] = []
  for (const raw of json) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const platformsRaw = r['platforms']
    if (!platformsRaw || typeof platformsRaw !== 'object') continue
    const platforms: Record<string, string> = {}
    for (const [k, v] of Object.entries(platformsRaw as Record<string, unknown>)) {
      const key = str(k, 48)
      const addr = str(v, 64)
      if (key && addr) platforms[key] = addr
    }
    if (Object.keys(platforms).length === 0) continue
    out.push({ symbol: str(r['symbol'], 32), coingeckoId: str(r['coingecko_id'], 64), platforms })
  }
  return out
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>

export class TokenListError extends Error {
  constructor(public readonly code: 'unavailable') {
    super(code)
    this.name = 'TokenListError'
  }
}

/** One request. A failure is an outage, never "this token is not listed". */
export async function fetchNttTokenList(fetchImpl: FetchLike = fetch): Promise<NttToken[]> {
  let res
  try {
    res = await fetchImpl(TOKEN_LIST_URL)
  } catch {
    throw new TokenListError('unavailable')
  }
  if (!res.ok) throw new TokenListError('unavailable')
  try {
    return parseTokenList(await res.json())
  } catch {
    throw new TokenListError('unavailable')
  }
}

export type ListedToken = { token: NttToken; address: Address; platform: string }

/**
 * Is this EVM token address listed as an NTT token on this chain? The address must match the
 * listed one exactly (case-insensitively); nothing else counts as a match.
 */
export function findListedToken(list: readonly NttToken[], chain: ChainKey, tokenAddress: string): ListedToken | undefined {
  const platform = COINGECKO_PLATFORM[chain]
  if (!platform || !isAddress(tokenAddress, { strict: false })) return undefined
  const wanted = tokenAddress.toLowerCase()
  for (const token of list) {
    const listed = token.platforms[platform]
    if (listed && listed.toLowerCase() === wanted) return { token, address: getAddress(listed), platform }
  }
  return undefined
}

/** Every chain in our registry this token is listed on — the destinations worth offering. */
export function listedChains(token: NttToken, chains: readonly ChainKey[]): ChainKey[] {
  return chains.filter((c) => {
    const p = COINGECKO_PLATFORM[c]
    return !!p && !!token.platforms[p]
  })
}
