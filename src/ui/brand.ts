/**
 * How each network is drawn: the colour of its card and tile, and whether the name on the card
 * is dark or light. The logo itself is `public/chains/<key>.svg` (see ATTRIBUTION.md there).
 *
 * Colours are the networks' own brand colours; `dark` is set where the brand colour is light
 * enough that white text would not read on it.
 */
import type { ChainKey } from '@/core/chains'

export type Brand = {
  /** A CSS background: a colour or a gradient. */
  bg: string
  /** The name on the card is drawn in near-black rather than white. */
  dark?: boolean
}

export const BRAND: Record<ChainKey, Brand> = {
  ethereum: { bg: 'linear-gradient(180deg, #88AAF1, #C9B3F5)' },
  arbitrum: { bg: '#1C4ADD' },
  optimism: { bg: '#FF0420' },
  base: { bg: '#0000FF' },
  bsc: { bg: '#FFE900', dark: true },
  polygon: { bg: 'linear-gradient(180deg, #7F49F3, #693CC8)' },
  avalanche: { bg: '#E84142' },
  hyperevm: { bg: 'linear-gradient(180deg, #042C24, #031D1A)' },
  linea: { bg: '#61DFFF', dark: true },
  scroll: { bg: '#FFEEDA', dark: true },
  robinhood: { bg: '#000000' },
  solana: { bg: 'linear-gradient(0deg, #1A1622, #121212)' },
}
