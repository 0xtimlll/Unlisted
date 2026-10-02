/**
 * What a failed check means: the button stays down, or the indicator changes colour.
 *
 * Unlisted is a tool for arbitrage. It INFORMS; the person decides. The app never asks for a tick,
 * never caps an amount, and never refuses a transfer because of its opinion about someone else's
 * contract. A failed check holds the button in exactly one case: the transaction is IMPOSSIBLE —
 *
 *   no wallet, or the wallet is on another chain;
 *   the token or the native coin is not there;
 *   there is no route (no peer, no trusted remote, the manager did not verify);
 *   the amount is zero once dust and fees are taken;
 *   the recipient cannot be encoded for the destination's VM at all.
 *
 * Everything else is a reason for the route indicator (core/indicator.ts): a colour, a sentence,
 * and the details underneath. A recipient that is the zero address or one of the route's own
 * contracts, a look-alike of a saved address, a peer that does not point back, a route LayerZero
 * has blocked — all of these are RED, said in one visible line, and none of them holds the button.
 *
 * THE ASSEMBLY INVARIANTS ARE NOT OPINIONS and are always blocks: calldata only as
 * abi + functionName + args, approve for exactly the amount, the spender being the route contract
 * that was verified, no approve at all when the contract says none is required, refundAddress being
 * the connected wallet, and the recipient encoded the way the destination will read it. Those are
 * the app being correct about itself, not the app judging a stranger's contract. They are not shown
 * as restrictions: if one of them ever fires, it is a bug in this app, and the button simply stays
 * down with the code in the line under it.
 *
 * Codes are named consistently across the four guard sets, so one table serves all of them.
 */

/**
 * Reads still in flight. Not a verdict at all: nothing has been judged yet. They hold the button
 * the same way a block does, and resolve on their own.
 */
const PENDING: ReadonlySet<string> = new Set([
  'plan_missing',
  'oft_missing',
  'balance_unknown',
  'native_balance_unknown',
  'allowance_unknown',
  'simulation_missing',
  'selfcheck_missing',
  'peer_back_unknown',
  'trusted_remote_back_unknown',
  'stored_payload_unknown',
  'recipient_class_unknown',
  'risk_unknown',
  'svm_dest_unknown',
])

/**
 * The only failures that hold the button. Grouped by the reason they are here, because the reason
 * is the thing to check when adding a code: "is the transaction physically impossible, or would we
 * be building something malformed?"
 */
const BLOCKING: ReadonlySet<string> = new Set([
  // ── the wallet cannot make this transaction ──────────────────────────────────
  'wallet_not_connected',
  'chain_mismatch',
  'insufficient_balance',
  'insufficient_native',

  // ── there is no route ────────────────────────────────────────────────────────
  'peer_missing',
  'route_missing',
  'route_unsupported',
  'manager_unverified',
  // An NTT manager neither the token nor a share of its supply vouches for: the approve would
  // name a spender nothing on this chain can account for (owner's decision 2026-10-02; the
  // fake-manager-for-a-real-token case from the audit).
  'ntt_unvouched',

  // ── the amount does not survive the trip ─────────────────────────────────────
  'amount_zero',
  'amount_rounds_to_zero',
  // v1: the contract's own fee takes the whole amount, or what is left rounds to nothing.
  'delivered_zero',
  'oft_fee_exceeds_amount',
  // The NTT manager reverts on dust rather than rounding it away.
  'amount_has_dust',

  // ── the recipient cannot be encoded for the destination ──────────────────────
  'recipient_invalid',
  'recipient_vm_mismatch',
  // The tail confirmation is INPUT, not a tick: a new or imported address is typed once against
  // its source (core/recipient.ts, core/addressBook.ts). Until then the recipient is not entered.
  'recipient_unconfirmed',

  // ── the next step, not a problem (see STEP) ──────────────────────────────────
  'needs_approve',

  // ── assembly invariants: the app being correct about itself ──────────────────
  'fee_mismatch',
  'lz_token_fee_nonzero',
  'min_gt_amount',
  'min_gt_delivered',
  'slippage_too_high',
  // v1 standards with no minimum in `sendFrom`: a slippage setting would be one nothing enforces.
  'slippage_unsupported',
  // NTT: the plan is always built with shouldQueue=false, so a plan that says otherwise is not ours.
  'queueing_enabled',
  // OFTCore._checkAdapterParams requires them empty; anything else reverts.
  'adapter_params_forbidden',
  'adapter_params_missing',
  'not_multiple_of_rate',
  // OFTCore._debitView reverts with SlippageExceeded when the quoted receive is below the minimum.
  'received_lt_min',
  'approve_amount_mismatch',
  'approve_forbidden',
  'approve_wrong_spender',
  'approve_wrong_token',
  'selfcheck_failed',
  // Solana: the dry run debits something the plan does not name.
  'debit_mismatch',
  'dangerous_options',
  'dangerous_adapter_params',
  'message_not_plain',
])

/**
 * The blocks an approve is FOR, or waits on: the allowance it is about to grant, and the reads that
 * cannot finish before it lands (the simulation of a send needs the allowance; the gas estimate
 * needs the simulation). Any other block — a wallet on the wrong chain, a manager that did not
 * verify — means the transfer this approve is for cannot happen, so no allowance is granted for it.
 */
const APPROVE_STEP: ReadonlySet<string> = new Set([
  'needs_approve',
  'allowance_unknown',
  'simulation_missing',
  'selfcheck_missing',
  'native_balance_unknown',
])

/**
 * Blocks that are a STEP, not a problem: the send cannot go yet, but nothing is wrong. The one
 * member is the allowance. It holds `canSend` like any block (the send would revert without it),
 * but a screen must not show it as something to fix: the approve is what the user does NEXT.
 */
const STEP: ReadonlySet<string> = new Set(['needs_approve'])

export type GuardSeverity = 'pending' | 'block' | 'note'

/**
 * Unknown codes are notes on purpose: a new check must not silently become a refusal. The colour
 * a note gives the indicator is decided in core/indicator.ts.
 */
export function guardSeverity(code: string): GuardSeverity {
  if (PENDING.has(code)) return 'pending'
  return BLOCKING.has(code) ? 'block' : 'note'
}

export const isBlockingCode = (code: string): boolean => guardSeverity(code) === 'block'
export const isNoteCode = (code: string): boolean => guardSeverity(code) === 'note'
/** True while a read is still in flight: shown as "checking", never as a problem. */
export const isPendingCode = (code: string): boolean => guardSeverity(code) === 'pending'
/** A block that is the next step rather than a problem — see `STEP`. Always also a block. */
export const isStepCode = (code: string): boolean => STEP.has(code)

/**
 * Do these blocks consist only of the approve step and the reads that wait on it? True means the
 * approve is the right button to show: nothing else stands in the way of this transfer.
 */
export function waitsOnlyForApprove(blocks: readonly AnyGuardResult[]): boolean {
  return blocks.every((b) => b.ok || APPROVE_STEP.has(b.code))
}

/** The shape every guard set's result already has. */
export type FailedGuard = { ok: false; code: string; detail?: string }
export type AnyGuardResult = { ok: true } | FailedGuard

export type GuardVerdict<R> = {
  /** Failures that hold the button: blocks, plus reads still in flight. */
  blocks: R[]
  /** Failures that colour the indicator and hold nothing. */
  notes: R[]
  /** True when nothing blocks. Notes never enter into it. */
  canSend: boolean
}

/** One rule, four guard sets. There is no input that can turn a block into a note. */
export function verdictOf<R extends AnyGuardResult>(results: readonly R[]): GuardVerdict<R> {
  const blocks: R[] = []
  const notes: R[] = []
  for (const r of results) {
    if (r.ok) continue
    if (guardSeverity(r.code) === 'note') notes.push(r)
    else blocks.push(r)
  }
  return { blocks, notes, canSend: blocks.length === 0 }
}

/**
 * Narrows a report's list to the failures a screen should show, dropping reads still in flight
 * and, for the line under the button, the approve step (`dropSteps`). A type predicate so the
 * screens keep `code` without a cast.
 */
export function shownFailures<R extends { ok: boolean }>(
  list: readonly R[],
  opts: { dropPending?: boolean; dropSteps?: boolean } = {},
): (R & FailedGuard)[] {
  return list.filter((r): r is R & FailedGuard => {
    if (r.ok) return false
    const code = (r as unknown as FailedGuard).code
    if (opts.dropPending && isPendingCode(code)) return false
    if (opts.dropSteps && isStepCode(code)) return false
    return true
  })
}
