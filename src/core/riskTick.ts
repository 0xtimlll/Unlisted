/**
 * What the one tick ("I understand the risks, send") covers, as values that can be compared.
 *
 * The tick is an answer about ONE transfer — this token, over this route, this amount, to this
 * recipient, from this wallet on this chain — AND about the warnings that were on screen when it
 * was given. It used to be a boolean that four screens cleared with an effect listing whichever of
 * those they remembered — the OFT screen did not list the source chain, and a deployment address
 * that is the same on two chains (CREATE2 is common) would have carried the tick across a network
 * switch. It also left one render, after any of them changed, in which the tick was still on for a
 * transfer it had never been given for.
 *
 * So the screens keep what the tick was given for, not a boolean, and the tick counts only while
 * that is still what is on screen (ui/useRiskTick.ts). Two things can end it:
 *
 *   the transfer changed    a different scope. Nothing is cleared, so nothing can be missed: a
 *                           changed field is a different scope, and the tick does not apply to it.
 *   the warnings grew       a warning that was not there when the tick was given, or one that was
 *                           there and is heavier now. The user accepted a list; this is not that
 *                           list. A warning that DISAPPEARED does not end the tick — what is on
 *                           screen is a subset of what was accepted.
 *
 * Nothing is normalised. An address in another case is a different string, which resets the tick —
 * the safe way to be wrong — and on Solana the case IS the address.
 */
import { outweighs, warningWeight, type WarningWeight } from './severity'

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

/** One warning as the tick remembers it: its code and how loudly it was said. */
export type WarningMark = { code: string; weight: WarningWeight }

/** The warnings on screen as a comparable list: one mark per code, sorted, with its weight. */
export function warningMarks(warnings: readonly { code: string }[]): WarningMark[] {
  const codes = [...new Set(warnings.map((w) => w.code))].sort()
  return codes.map((code) => ({ code, weight: warningWeight(code) }))
}

/** What the tick was given for: the transfer, and the warnings that were shown then. */
export type TickGrant = { scope: string; warnings: readonly WarningMark[] }

/**
 * The warnings on screen now that `given` did not cover: absent then, or heavier now. Empty when
 * everything on screen was accepted — including when something accepted has since gone.
 */
export function warningsSince(given: readonly WarningMark[], now: readonly WarningMark[]): WarningMark[] {
  return now.filter((w) => {
    const then = given.find((g) => g.code === w.code)
    return !then || outweighs(w.weight, then.weight)
  })
}

/** Is the tick, given for `grant`, still an answer about what is on screen now? */
export function tickCovers(grant: TickGrant | null, scope: string | null, warnings: readonly WarningMark[]): boolean {
  if (grant === null || scope === null || grant.scope !== scope) return false
  return warningsSince(grant.warnings, warnings).length === 0
}
