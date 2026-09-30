/**
 * The committed list of reviewed OFTAdapter lockboxes, and the two indirect signals used when an
 * adapter is not on it.
 *
 * ── Why an adapter needs a list at all ──
 *
 * A plain OFT *is* the token, so approving it is approving the token to itself and there is nothing
 * to confuse. An OFTAdapter is a lockbox: it holds a real token that knows nothing about it. The
 * token grants it no role, sets no minter, and has no opinion on it whatsoever — so there is no
 * `minter()`-shaped fact on the source side that could vouch for it, the way NTT's burning managers
 * have one (wormhole-ntt/verify.ts).
 *
 * Everything else a user could look at is written by whoever deployed the adapter:
 *
 *   - `token()` is the adapter's claim about which token it locks;
 *   - `peers(dstEid)` is the adapter's claim about the far side;
 *   - guard 17 then asks THAT far side whether it names us back — but we only know where to ask
 *     because the adapter told us, so both halves of the answer belong to the same author.
 *
 * That is the same self-confirmation CLAUDE.md rule 2 is about. The conclusion is the same too: a
 * committed list is the only thing that can make an adapter green.
 *
 * ── Which adapters this applies to ──
 *
 * Only those that take an allowance (`approvalRequired === true`). An adapter that answers false
 * never calls `transferFrom`, so guard 11 forbids approving it and an impersonator would have
 * nothing to spend; such an adapter also holds no reserve by design, so the locked share would
 * refuse a working bridge over a number that cannot apply to it. USDT0 on HyperEVM is exactly
 * that shape: 0% of supply locked across more than twenty thousand deliveries.
 *
 * ── What the indirect signals are worth ──
 *
 * For an adapter that is NOT listed, two facts are available that its deployer does not write:
 *
 *   locked   `token.balanceOf(adapter) / token.totalSupply()`, both read from the REAL token
 *            contract. An adapter that is genuinely in use holds the supply bridged out through it.
 *   history  the outbound nonce the verified EndpointV2 records for this adapter, summed over its
 *            peers. Honest only because probeOft now refuses an OFT that names a foreign endpoint
 *            (core/probe.ts) — otherwise the "endpoint" would be the adapter's own contract.
 *
 * Neither proves anything. The owner of a fake adapter can deposit real tokens, pass the check and
 * withdraw afterwards, and can pay for twenty real sends. What the two do is raise the cost of the
 * attack from "deploy a contract" to "tie up capital and pay fees" — which is worth having, and is
 * emphatically not evidence. So they can only ever reach amber (§4 `UNVERIFIED`), never green: the
 * list is the only thing that vouches for an adapter. Amber is a warning the single tick covers,
 * not a cap (CLAUDE.md rule 2).
 */
import { getAddress, isAddress, type Address } from 'viem'
import { CHAINS, type ChainKey } from '../../core/chains'
import raw from './adapters.json'

export type ReviewedAdapter = {
  chain: ChainKey
  adapter: Address
  token: Address
  symbol: string
  addedAt: string
  /** Why this adapter was accepted — the sentence a future reader needs. */
  note: string
}

/**
 * Thresholds for the indirect signals, in one place so they are argued about once.
 *
 * `MIN_LOCKED_BPS` is 10 (0.1% of supply) rather than the 50 first proposed. 0.5% of a large
 * token's supply is a very high bar: an OFTAdapter holds exactly what has been bridged out through
 * it, so a real but modestly used lockbox on a big token sits well below that, and the penalty for
 * missing the bar is the red "unproven" warning, the loudest thing the panel says. 0.1% still costs
 * an attacker real capital while being reachable by adapters that are genuinely in service.
 *
 * `MIN_OUTBOUND_NONCE` is 20, as proposed. Twenty deliveries recorded by the real EndpointV2 are
 * twenty LayerZero fees an attacker would have to pay before the route looked used, and unlike the
 * balance they cannot be withdrawn afterwards.
 *
 * Both are floors on a signal, not a measure of safety. Raising either makes false refusals more
 * likely without making a fake adapter impossible; the list is what makes it impossible.
 */
export const ADAPTER_MIN_LOCKED_BPS = 10
export const ADAPTER_MIN_OUTBOUND_NONCE = 20n

const CHAIN_KEYS: ReadonlySet<string> = new Set(CHAINS.map((c) => c.key))

/** Throws on a malformed row: this is our own committed file, so a bad entry is a build error. */
function parse(): readonly ReviewedAdapter[] {
  const rows = (raw as { adapters?: unknown }).adapters
  if (!Array.isArray(rows)) throw new Error('adapters.json: `adapters` is not an array')
  return rows.map((r, i) => {
    const o = r as Record<string, unknown>
    const at = `adapters.json[${i}]`
    if (typeof o['chain'] !== 'string' || !CHAIN_KEYS.has(o['chain'])) throw new Error(`${at}: unknown chain ${String(o['chain'])}`)
    for (const f of ['adapter', 'token'] as const) {
      if (typeof o[f] !== 'string' || !isAddress(o[f] as string, { strict: false })) throw new Error(`${at}: ${f} is not an address`)
    }
    return {
      chain: o['chain'] as ChainKey,
      adapter: getAddress(o['adapter'] as string),
      token: getAddress(o['token'] as string),
      symbol: typeof o['symbol'] === 'string' ? o['symbol'] : '',
      addedAt: typeof o['addedAt'] === 'string' ? o['addedAt'] : '',
      note: typeof o['note'] === 'string' ? o['note'] : '',
    }
  })
}

export const REVIEWED_ADAPTERS: readonly ReviewedAdapter[] = parse()

/**
 * Is this exact adapter reviewed for this exact token on this chain?
 *
 * All three must match. `token()` is the adapter's own claim, so a listed adapter that has started
 * naming a different token is not the thing that was reviewed.
 */
export function reviewedAdapter(chain: ChainKey, adapter: string, token: string): ReviewedAdapter | undefined {
  let a: Address
  let t: Address
  try {
    a = getAddress(adapter)
    t = getAddress(token)
  } catch {
    return undefined
  }
  return REVIEWED_ADAPTERS.find((r) => r.chain === chain && r.adapter === a && r.token === t)
}

/** What §4 knows about a source-side adapter. Absent entirely when the source is a plain OFT. */
export type AdapterStanding = {
  /** On the committed list for this chain + adapter + token. The only route to green. */
  listed: boolean
  /** balanceOf(adapter) / totalSupply() in basis points, or undefined when a read failed. */
  lockedBps: number | undefined
  /** Outbound nonce summed over this adapter's peers, or undefined when a read failed. */
  outboundNonce: bigint | undefined
}

/** Locked share in basis points. `undefined` for a zero or unreadable supply — never 0. */
export function lockedBps(held: bigint, totalSupply: bigint): number | undefined {
  if (totalSupply <= 0n) return undefined
  return Number((held * 10_000n) / totalSupply)
}

/**
 * Do the indirect signals clear their floors? Only ever the difference between amber and red —
 * `listed` is what decides green, and this is not consulted for a listed adapter.
 *
 * A read that did not answer is NOT a pass: an unknown balance is not a healthy one.
 */
export function adapterSignsOk(a: AdapterStanding): boolean {
  if (a.lockedBps === undefined || a.outboundNonce === undefined) return false
  return a.lockedBps >= ADAPTER_MIN_LOCKED_BPS && a.outboundNonce >= ADAPTER_MIN_OUTBOUND_NONCE
}
