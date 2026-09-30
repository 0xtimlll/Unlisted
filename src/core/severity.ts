/**
 * What a failed check means: stop, or say so and let the user decide.
 *
 * Unlisted is a tool for arbitrage. It WARNS; the person decides. A verdict the app computed
 * honestly is still only the app's opinion about someone else's contract, and refusing to build a
 * transaction because of an opinion makes the tool useless for exactly the routes it exists for —
 * new tokens, thin history, an RPC that would not answer.
 *
 * So a failed check stops a transfer only when one of two things is true:
 *
 *   the loss is certain        the recipient cannot hold the token, or is a contract of this very
 *                              route, or the amount arrives as zero — send it and it is gone;
 *   the transaction cannot go  the wallet is on the wrong chain, the balance is not there, no peer
 *                              is configured, or the app would have to build something malformed.
 *
 * Everything else is a warning. One tick covers all of them (`risksAccepted`), and it opens any
 * amount — see the send screens. A tick can never lift a block, and there is no code path where it
 * lifts more than the warnings that were shown.
 *
 * THE ASSEMBLY INVARIANTS ARE NOT OPINIONS and are always blocks: calldata only as
 * abi + functionName + args, approve for exactly the amount, the spender being the route contract
 * that was verified, no approve at all when the contract says none is required, refundAddress being
 * the connected wallet, and the recipient encoded the way the destination will read it. Those are
 * the app being correct about itself, not the app judging a stranger's contract.
 *
 * Codes are named consistently across the four guard sets, so one table serves all of them.
 */

/**
 * Reads still in flight. Not a verdict at all: nothing has been judged yet, so there is nothing to
 * accept. They hold the button the same way a block does, and resolve on their own.
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
])

/**
 * The only failures a tick cannot lift. Grouped by the reason they are here, because the reason is
 * the thing to check when adding a code: "would the money certainly be lost, or would the
 * transaction certainly not go, or would we be building something malformed?"
 */
const BLOCKING: ReadonlySet<string> = new Set([
  // ── the recipient cannot receive: the money would be gone ────────────────────
  'recipient_invalid',
  'recipient_zero',
  'recipient_vm_mismatch',
  // guard 4 only names contracts OF THIS ROUTE — the token, the bridge, the adapter, the manager,
  // the router, the peer. A recipient that is merely *a* contract is a warning: exchange deposits
  // and multisigs are contracts.
  'recipient_is_contract',
  // An SPL token account cannot be credited this way; the transfer would be lost.
  'recipient_token_account',
  // Shares its first and last four characters with a saved address but is not it. This is the
  // shape of an address swap, and a user who could tick past it has already been fooled.
  'recipient_lookalike',
  // The tail confirmation. Not a risk to accept — a ten-second action, and it stays required.
  'recipient_unconfirmed',

  // ── there is no route, or the destination could not be identified ────────────
  'peer_missing',
  'route_missing',
  'route_unsupported',
  'manager_unverified',
  'svm_dest_unknown',

  // ── the amount does not survive the trip ─────────────────────────────────────
  'amount_zero',
  'amount_rounds_to_zero',
  // v1: the contract's own fee takes the whole amount, or what is left rounds to nothing.
  'delivered_zero',
  'oft_fee_exceeds_amount',
  // The NTT manager reverts on dust rather than rounding it away.
  'amount_has_dust',

  // ── the wallet cannot make this transaction ──────────────────────────────────
  'wallet_not_connected',
  'chain_mismatch',
  'insufficient_balance',
  'insufficient_native',

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
  'not_multiple_of_rate',
  'needs_approve',
  'approve_amount_mismatch',
  'approve_forbidden',
  'approve_wrong_spender',
  'approve_wrong_token',
  'selfcheck_failed',
  'dangerous_options',
  'dangerous_adapter_params',
  'message_not_plain',
])

export type GuardSeverity = 'pending' | 'block' | 'warn'

/** Unknown codes are warnings on purpose: a new check must not silently become a refusal. */
export function guardSeverity(code: string): GuardSeverity {
  if (PENDING.has(code)) return 'pending'
  return BLOCKING.has(code) ? 'block' : 'warn'
}

export const isBlockingCode = (code: string): boolean => guardSeverity(code) === 'block'
export const isWarningCode = (code: string): boolean => guardSeverity(code) === 'warn'

/**
 * How loudly a warning should be said, so the screen can sort them with the dangerous ones on top.
 * Higher is worse. Only affects presentation — every warning is covered by the same single tick.
 *
 * `loss` is for the ones where a wrong answer costs the transfer: the contract may not be what it
 * claims, or nobody could confirm that it is. `stuck` is for a transfer that arrives late or not at
 * all but is not taken by anyone. `note` is everything else.
 */
export type WarningWeight = 'loss' | 'stuck' | 'note'

const LOSS: ReadonlySet<string> = new Set([
  'risk_blocked',
  'adapter_unproven',
  'ntt_anchor_missing',
  'peer_back_mismatch',
  'trusted_remote_back_mismatch',
  'peer_back_unavailable_unconfirmed',
  'trusted_remote_back_unavailable_unconfirmed',
  'not_cross_checked',
  'simulation_failed',
  'simulation_unavailable',
])

const STUCK: ReadonlySet<string> = new Set([
  'no_executor_gas_unconfirmed',
  'no_executor_options_svm',
  'gas_below_min_dst',
  'adapter_params_missing',
  'stored_payload_blocked',
  'stored_payload_unavailable_unconfirmed',
  'over_outbound_capacity',
  'over_inbound_capacity',
  'inbound_capacity_unknown',
  'outbound_limit_unknown',
  'inbound_limit_unknown',
  'amount_out_of_limits',
  'received_lt_min',
])

export function warningWeight(code: string): WarningWeight {
  if (LOSS.has(code)) return 'loss'
  return STUCK.has(code) ? 'stuck' : 'note'
}

const ORDER: Record<WarningWeight, number> = { loss: 0, stuck: 1, note: 2 }

/** Sorts warning codes strongest first, keeping the original order within a weight. */
export function sortWarnings<T extends { code: string }>(warnings: readonly T[]): T[] {
  return [...warnings].sort((a, b) => ORDER[warningWeight(a.code)] - ORDER[warningWeight(b.code)])
}

/** The shape every guard set's result already has. */
export type FailedGuard = { ok: false; code: string; detail?: string }
export type AnyGuardResult = { ok: true } | FailedGuard

export type GuardVerdict<R> = {
  /** Failures that hold the button no matter what: blocks, plus reads still in flight. */
  blocks: R[]
  /** Failures one tick covers, strongest first. */
  warnings: R[]
  /**
   * True when there is nothing to warn about, or the tick is on. Separate from `canSend` because
   * the APPROVE step needs it on its own: an allowance granted to a contract the user has not yet
   * accepted the risk of is the exploitable half of this app, and `canSend` cannot be used there —
   * it is false until the approve lands, which is what the approve is for.
   */
  warningsCleared: boolean
  /** True when nothing blocks and either nothing warns or the tick is on. */
  canSend: boolean
}

/**
 * One rule, four guard sets. `risksAccepted` is the single tick; it is consulted for warnings and
 * for nothing else, so there is no arrangement of inputs in which it lifts a block.
 */
export function verdictOf<R extends AnyGuardResult>(results: readonly R[], risksAccepted: boolean): GuardVerdict<R> {
  const blocks: R[] = []
  const warnings: R[] = []
  for (const r of results) {
    if (r.ok) continue
    if (guardSeverity(r.code) === 'warn') warnings.push(r)
    else blocks.push(r)
  }
  const sorted = sortWarnings(warnings as unknown as { code: string }[]) as unknown as R[]
  const warningsCleared = sorted.length === 0 || risksAccepted
  return { blocks, warnings: sorted, warningsCleared, canSend: blocks.length === 0 && warningsCleared }
}

/**
 * The guard reports already use `warnings` for guard 16's soft flags, which are a different thing:
 * those are shown and never hold anything. This renames the verdict's field so both can live in
 * one report without either quietly shadowing the other.
 */
export function renameWarnings<R>(v: GuardVerdict<R>): { blocks: R[]; riskWarnings: R[]; warningsCleared: boolean; canSend: boolean } {
  return { blocks: v.blocks, riskWarnings: v.warnings, warningsCleared: v.warningsCleared, canSend: v.canSend }
}

/** True while a read is still in flight: shown as "checking", never as a problem to accept. */
export const isPendingCode = (code: string): boolean => guardSeverity(code) === 'pending'

/**
 * Narrows a report's list to the failures a screen should show, dropping reads still in flight.
 * A type predicate so the screens keep `code` without a cast.
 */
export function shownFailures<R extends { ok: boolean }>(
  list: readonly R[],
  opts: { dropPending: boolean } = { dropPending: false },
): (R & FailedGuard)[] {
  return list.filter((r): r is R & FailedGuard => !r.ok && !(opts.dropPending && isPendingCode((r as unknown as FailedGuard).code)))
}
