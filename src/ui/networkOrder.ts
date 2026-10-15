/**
 * The order of the network picker, as pure functions so the rule is testable without a DOM.
 *
 * Default is popularity: the registry's own order (src/core/chains.ts — DefiLlama TVL descending,
 * then by name). "Recent first" lifts the networks the user picked last — at most RECENT_MAX of
 * them, newest first — above the rest, which stay in popularity order. Both the mode and the
 * recent list live in localStorage with the other settings (ui/storage.ts).
 */
import { CHAINS, type ChainKey } from '@/core/chains'

export type NetworkOrder = 'popular' | 'recent'
export const DEFAULT_NETWORK_ORDER: NetworkOrder = 'popular'
export const RECENT_MAX = 5

export function isNetworkOrder(v: unknown): v is NetworkOrder {
  return v === 'popular' || v === 'recent'
}

const RANK: ReadonlyMap<ChainKey, number> = new Map(CHAINS.map((c, i) => [c.key, i]))

/** Registry (popularity) order for any list of keys. Unknown keys sort last, in their given order. */
export function byPopularity(keys: readonly ChainKey[]): ChainKey[] {
  return keys.map((k, i) => ({ k, i, r: RANK.get(k) ?? Number.MAX_SAFE_INTEGER })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.k)
}

/**
 * The picker's order for the given keys. In 'recent' mode the recent keys that ARE in the list
 * come first, newest first; everything else follows by popularity. A key the list does not have
 * (a destination the contract has no route to, say) is simply not lifted.
 */
export function orderNetworks(keys: readonly ChainKey[], mode: NetworkOrder, recent: readonly ChainKey[]): ChainKey[] {
  const popular = byPopularity(keys)
  if (mode !== 'recent') return popular
  const have = new Set(keys)
  const lifted: ChainKey[] = []
  for (const k of recent.slice(0, RECENT_MAX)) if (have.has(k) && !lifted.includes(k)) lifted.push(k)
  const rest = popular.filter((k) => !lifted.includes(k))
  return [...lifted, ...rest]
}

/** `key` becomes the newest recent pick; the list stays unique and at most RECENT_MAX long. */
export function pushRecentChain(recent: readonly ChainKey[], key: ChainKey): ChainKey[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_MAX)
}
