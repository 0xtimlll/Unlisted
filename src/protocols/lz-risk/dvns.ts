/**
 * §4 check 3: what LayerZero itself says about the DVNs a route is configured with.
 *
 * The table is committed (scripts/gen-lz-dvns.mjs) and read from disk. Three answers matter, and
 * §4 gives each a different weight:
 *
 *   deprecated / the dead DVN  →  BLOCKED. `LZDeadDVN` exists so a route can be made unverifiable
 *                                 on purpose; a message needing its attestation never arrives.
 *   known and not deprecated   →  nothing. An unusual set of healthy DVNs is a project's choice,
 *                                 and §4 says plainly that it is not a reason to warn.
 *   not in the list at all     →  a warning at most. LayerZero's list is not exhaustive and a DVN
 *                                 can be legitimate without being on it, so this can never block.
 */
import { getAddress, type Address } from 'viem'
import type { ChainKey } from '../../core/chains'
import raw from './dvns.json'

export type DvnEntry = { name: string; id: string; version: number; deprecated: boolean }

/** LayerZero's own id for the DVN that exists to make a route unverifiable. */
export const DEAD_DVN_ID = 'lz-dead-dvn'

type ChainDvns = { metadataKey: string; dvns: Record<string, DvnEntry> }
const BY_CHAIN = raw.chains as Record<string, ChainDvns>

export const DVN_SOURCE: string = raw.$source
export const DVN_GENERATED: string = raw.$generated

/** Lookup key: EVM addresses are compared lowercased, Solana keys verbatim (base58 is case-significant). */
function keyOf(addressOrPubkey: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(addressOrPubkey) ? addressOrPubkey.toLowerCase() : addressOrPubkey
}

export function dvnInfo(chain: ChainKey, address: string): DvnEntry | undefined {
  return BY_CHAIN[chain]?.dvns[keyOf(address)]
}

/** True when this chain has a committed DVN list at all. Without one, nothing can be judged. */
export function hasDvnList(chain: ChainKey): boolean {
  return BY_CHAIN[chain] !== undefined && Object.keys(BY_CHAIN[chain]!.dvns).length > 0
}

export type DvnVerdict = {
  /** Any DVN in the set that LayerZero has deprecated, the dead DVN included. Blocks the route. */
  dead: { address: Address; entry: DvnEntry }[]
  /** DVNs the committed list does not describe. A warning at most. */
  unknown: Address[]
  /** DVNs the list knows and has not deprecated — the ordinary case, and not worth a word. */
  healthy: { address: Address; entry: DvnEntry }[]
}

/**
 * Judges the DVNs of one route on one chain.
 *
 * `addresses` is the required set plus the optional set: an optional DVN can still be the one a
 * message waits on, so a dead entry among them is no less fatal.
 */
export function judgeDvns(chain: ChainKey, addresses: readonly string[]): DvnVerdict {
  const out: DvnVerdict = { dead: [], unknown: [], healthy: [] }
  for (const a of addresses) {
    let address: Address
    try {
      address = getAddress(a)
    } catch {
      // Not an EVM address: keep it as given so the reason can still name it.
      address = a as Address
    }
    const entry = dvnInfo(chain, a)
    if (!entry) {
      out.unknown.push(address)
    } else if (entry.deprecated || entry.id === DEAD_DVN_ID) {
      out.dead.push({ address, entry })
    } else {
      out.healthy.push({ address, entry })
    }
  }
  return out
}

/** How the panel names a DVN: LayerZero's canonical name, or the address when it knows none. */
export function dvnLabel(chain: ChainKey, address: string): string {
  const e = dvnInfo(chain, address)
  return e ? e.name : `${address.slice(0, 10)}…${address.slice(-4)}`
}
