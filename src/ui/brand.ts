/**
 * How each network is drawn: the colour of its card and tile, whether the name on the card is
 * dark or light, and whether it has a mark at all. Read from the generated src/core/networks.ts:
 * the hand-curated chains keep the colours chosen for them (scripts/networks-curated.json), the
 * rest take the most-used colour of their web3icons branded mark, and a network with no mark is
 * drawn as its initials on a neutral tile. The logo itself is `public/chains/<key>.svg` (see
 * ATTRIBUTION.md there).
 */
import { type ChainKey } from '@/core/chains'
import { NETWORKS } from '@/core/networks'

export type Brand = {
  /** A CSS background: a colour or a gradient. */
  bg: string
  /** The name on the card is drawn in near-black rather than white. */
  dark?: boolean
  /** False when there is no mark in public/chains: the tile shows the network's initials instead. */
  logo: boolean
}

export const BRAND: Record<ChainKey, Brand> = Object.fromEntries(
  (Object.keys(NETWORKS) as ChainKey[]).map((key) => {
    const b = NETWORKS[key].brand
    return [key, { bg: b.bg, ...(b.dark ? { dark: true } : {}), logo: b.logo }]
  }),
) as Record<ChainKey, Brand>

/**
 * The letters a network with no mark is drawn with: the first letter of its first two words
 * ("Flow EVM" → "FE"), or the first two letters of a one-word name ("Mezo" → "ME").
 */
export function initialsOf(name: string): string {
  const words = name.split(/[\s-]+/).filter(Boolean)
  const s = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2)
  return s.toUpperCase()
}
