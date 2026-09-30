/**
 * What the one tick ("I understand the risks, send") covers, as a value that can be compared.
 *
 * The tick is an answer about ONE transfer: this token, over this route, this amount, to this
 * recipient, from this wallet on this chain. It used to be a boolean that four screens cleared with
 * an effect listing whichever of those they remembered — the OFT screen did not list the source
 * chain, and a deployment address that is the same on two chains (CREATE2 is common) would have
 * carried the tick across a network switch. It also left one render, after any of them changed, in
 * which the tick was still on for a transfer it had never been given for.
 *
 * So the screens keep the scope the tick was given for, not a boolean, and the tick counts only
 * while the scope on screen is that scope. Nothing is cleared, so nothing can be missed: a changed
 * field is a different scope, and the tick simply does not apply to it.
 *
 * Nothing is normalised. An address in another case is a different string, which resets the tick —
 * the safe way to be wrong — and on Solana the case IS the address.
 */

export type TickScope = {
  /** The chain the transfer leaves from. */
  chain: string | undefined
  /** The contract that will be called (and the token behind it, where the two differ). */
  contract: string | undefined
  /** The destination, in whatever the tab calls it (eid, chain key). */
  destination: string | number | undefined
  /** The amount that goes on the wire. */
  amount: bigint | undefined
  /** The recipient as the plan carries it. */
  recipient: string | undefined
  /** The wallet that signs. */
  sender: string | undefined
}

/**
 * The scope of a transfer, or null while any part of it is unknown. A null scope is never covered:
 * a tick cannot be given for something that has not been fully described yet.
 */
export function riskTickScope(s: TickScope): string | null {
  const parts = [s.chain, s.contract, s.destination, s.amount?.toString(), s.recipient, s.sender]
  if (parts.some((p) => p === undefined || p === '')) return null
  return JSON.stringify(parts)
}

/** Is the tick, given for `tickedFor`, still an answer about what is on screen now? */
export function tickCovers(tickedFor: string | null, scope: string | null): boolean {
  return tickedFor !== null && scope !== null && tickedFor === scope
}
