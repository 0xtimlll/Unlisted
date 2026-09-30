/**
 * The committed list of NTT locking hubs.
 *
 * A burning manager can be proven on chain: the real token names it as `minter()`, or grants it
 * `MINTER_ROLE`, and neither of those is something the manager gets to write about itself. A
 * LOCKING hub has no such fact. Nothing is minted there, so the token grants it nothing — a
 * locking manager simply holds tokens, and *any* contract can claim to hold any token. Every other
 * answer a locking manager gives (`getMode()`, `getPeer()`, its transceiver) is written by whoever
 * deployed it, so none of it can raise trust; see rule 2 in CLAUDE.md.
 *
 * That leaves exactly one anchor the rule permits: a list committed to this repository, where a
 * human put each entry there on purpose and a diff shows any change. `scripts/update-ntt-hubs.ts`
 * proposes entries and verifies each one on chain before writing them; it is run by hand and never
 * at build or run time. This module only reads the result.
 *
 * A match is `chain` + `manager` + `token`, all three. A hub listed for one token does not vouch
 * for a manager that now claims a different one.
 */
import { getAddress, isAddress, type Address } from 'viem'
import { CHAINS, type ChainKey } from '../../core/chains'
import raw from './locking-hubs.json'

export type LockingHub = {
  chain: ChainKey
  manager: Address
  token: Address
  symbol: string
  /** ISO date the entry was added, for the diff to read like a record. */
  addedAt: string
  /** Where the candidate came from, before it was verified on chain. */
  source: string
}

const CHAIN_KEYS: ReadonlySet<string> = new Set(CHAINS.map((c) => c.key))

/**
 * Parses the committed file. A malformed entry is a build-time mistake in our own repository, not
 * untrusted input, so it throws rather than being quietly dropped — a hub that silently vanished
 * would turn into "this route is unverified" with no explanation.
 */
function parse(): readonly LockingHub[] {
  const rows = (raw as { hubs?: unknown }).hubs
  if (!Array.isArray(rows)) throw new Error('locking-hubs.json: `hubs` is not an array')
  return rows.map((r, i) => {
    const o = r as Record<string, unknown>
    const at = `locking-hubs.json[${i}]`
    if (typeof o['chain'] !== 'string' || !CHAIN_KEYS.has(o['chain'])) throw new Error(`${at}: unknown chain ${String(o['chain'])}`)
    for (const f of ['manager', 'token'] as const) {
      if (typeof o[f] !== 'string' || !isAddress(o[f] as string, { strict: false })) throw new Error(`${at}: ${f} is not an address`)
    }
    return {
      chain: o['chain'] as ChainKey,
      manager: getAddress(o['manager'] as string),
      token: getAddress(o['token'] as string),
      symbol: typeof o['symbol'] === 'string' ? o['symbol'] : '',
      addedAt: typeof o['addedAt'] === 'string' ? o['addedAt'] : '',
      source: typeof o['source'] === 'string' ? o['source'] : '',
    }
  })
}

export const LOCKING_HUBS: readonly LockingHub[] = parse()

/** When the committed list was last generated, for the card to show. */
export const LOCKING_HUBS_GENERATED: string = typeof (raw as { generated?: unknown }).generated === 'string' ? (raw as { generated: string }).generated : ''

/**
 * Is this exact manager a listed locking hub for this exact token on this chain?
 *
 * All three have to match. The manager alone is not enough: `token()` is the manager's own claim,
 * and a listed hub must not end up vouching for a manager that has started naming something else.
 */
export function listedLockingHub(chain: ChainKey, manager: string, token: string): LockingHub | undefined {
  let m: Address
  let t: Address
  try {
    m = getAddress(manager)
    t = getAddress(token)
  } catch {
    return undefined
  }
  return LOCKING_HUBS.find((h) => h.chain === chain && h.manager === m && h.token === t)
}
