/**
 * The committed registry hint table (scripts/gen-hyperlane-warp.mjs), read from disk.
 *
 * Hyperlane keeps its warp routes in git, not on chain, so a plain ERC-20 has nothing on chain
 * that points at the collateral router holding it. This table answers "which routers might hold
 * this token on this chain?" — and nothing more. Every candidate it names is then probed from
 * scratch (discover.ts): it must name the registry Mailbox, hold exactly this token, and answer
 * for itself. A token missing here is not refused; paste its router. Nothing here colours the
 * indicator (CLAUDE.md rule 1: a list narrows the search and never raises trust).
 *
 * Nothing from this table is ever shown unasked: it is consulted only after a pasted address turns
 * out to be a plain ERC-20, and a native route (HypNative) is pasted by its own address.
 */
import { getAddress, type Address } from 'viem'
import type { ChainKey } from '../../core/chains'
import raw from './warpRoutes.json'

export type WarpRouteHint = {
  router: Address
  /** The registry's standard name: EvmHypCollateral, EvmHypXERC20, … */
  standard: string
  symbol: string
  /** The registry's route id, e.g. "PAXG/arbitrum-ethereum". */
  route: string
}

type ChainHints = { tokens: Record<string, WarpRouteHint[]> }
const BY_CHAIN = raw.chains as Record<string, ChainHints>

export const WARP_ROUTES_SOURCE: string = raw.source

const checksum = (h: WarpRouteHint): WarpRouteHint => ({ ...h, router: getAddress(h.router) })

/** Routers the registry lists as holding this token on this chain. Candidates to probe, never facts. */
export function warpRouteHints(chain: ChainKey, token: string): WarpRouteHint[] {
  const entry = BY_CHAIN[chain]
  if (!entry) return []
  return (entry.tokens[token.toLowerCase()] ?? []).map(checksum)
}
