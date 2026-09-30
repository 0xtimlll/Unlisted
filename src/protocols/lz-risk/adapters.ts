/**
 * The two indirect signals that stand behind an OFTAdapter lockbox, and their floors.
 *
 * ── Why an adapter is judged differently from a plain OFT ──
 *
 * A plain OFT *is* the token, so approving it is approving the token to itself and there is nothing
 * to confuse. An OFTAdapter is a lockbox: it holds a real token that knows nothing about it. The
 * token grants it no role, sets no minter, and has no opinion on it whatsoever — so there is no
 * `minter()`-shaped fact on the source side that could vouch for it, the way NTT's burning managers
 * have one (wormhole-ntt/verify.ts). Everything else a user could look at is written by whoever
 * deployed the adapter: `token()` is its claim about which token it locks, `peers(dstEid)` its
 * claim about the far side, and the far side's answer is only reachable through that claim.
 *
 * ── Which adapters this applies to ──
 *
 * Only those that take an allowance (`approvalRequired === true`). An adapter that answers false
 * never calls `transferFrom`, so guard 11 forbids approving it and an impersonator would have
 * nothing to spend; such an adapter also holds no reserve by design, so the locked share would
 * refuse a working bridge over a number that cannot apply to it. USDT0 on HyperEVM is exactly
 * that shape: 0% of supply locked across more than twenty thousand deliveries.
 *
 * ── What the signals are worth ──
 *
 * Two facts are available that the adapter's deployer does not write:
 *
 *   locked   `token.balanceOf(adapter) / token.totalSupply()`, both read from the REAL token
 *            contract. An adapter that is genuinely in use holds the supply bridged out through it.
 *   history  the outbound nonce the verified EndpointV2 records for this adapter, summed over its
 *            peers. Honest only because probeOft refuses an OFT that names a foreign endpoint
 *            (core/probe.ts) — otherwise the "endpoint" would be the adapter's own contract.
 *
 * Neither proves anything. The owner of a fake adapter can deposit real tokens, pass the check and
 * withdraw afterwards, and can pay for twenty real sends. What the two do is raise the cost of the
 * attack from "deploy a contract" to "tie up capital and pay fees". An adapter that clears both
 * floors is shown green; one that does not is a yellow "fresh adapter" nuance in the indicator.
 * The person decides either way (CLAUDE.md rule 2).
 */

/**
 * Thresholds for the indirect signals, in one place so they are argued about once.
 *
 * `MIN_LOCKED_BPS` is 10 (0.1% of supply). 0.5% of a large token's supply is a very high bar: an
 * OFTAdapter holds exactly what has been bridged out through it, so a real but modestly used
 * lockbox on a big token sits well below that. 0.1% still costs an attacker real capital while
 * being reachable by adapters that are genuinely in service.
 *
 * `MIN_OUTBOUND_NONCE` is 20. Twenty deliveries recorded by the real EndpointV2 are twenty
 * LayerZero fees an attacker would have to pay before the route looked used, and unlike the
 * balance they cannot be withdrawn afterwards.
 */
export const ADAPTER_MIN_LOCKED_BPS = 10
export const ADAPTER_MIN_OUTBOUND_NONCE = 20n

/** What §4 knows about a source-side adapter. Absent entirely when the source is a plain OFT. */
export type AdapterStanding = {
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
 * Do the indirect signals clear their floors? A read that did not answer is NOT a pass: an unknown
 * balance is not a healthy one.
 */
export function adapterSignsOk(a: AdapterStanding): boolean {
  if (a.lockedBps === undefined || a.outboundNonce === undefined) return false
  return a.lockedBps >= ADAPTER_MIN_LOCKED_BPS && a.outboundNonce >= ADAPTER_MIN_OUTBOUND_NONCE
}
