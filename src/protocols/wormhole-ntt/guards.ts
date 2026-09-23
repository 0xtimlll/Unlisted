/**
 * §Task 5: the invariants an NTT transfer must satisfy before the Send button does anything.
 *
 * Same discipline as core/guards.ts: pure functions over a snapshot, codes only, every one of them
 * has to pass. Two things differ from the OFT path and are worth stating out loud:
 *
 *  - An approve is ALWAYS required, in both modes. NttManager._transfer pulls the tokens with
 *    `IERC20(token).safeTransferFrom(msg.sender, address(this), amount)` before it burns or locks
 *    (evm/src/NttManager/NttManager.sol), so "burning needs no allowance" is simply not true.
 *  - The amount must already be a multiple of the trim step: the manager REVERTS with
 *    TransferAmountHasDust rather than rounding, so rounding happens in the plan, and this checks
 *    that it really did.
 */
import { isAddressEqual, type Address } from 'viem'
import { addressToBytes32, isBytes32, isZeroBytes32, sameAddress } from '../../core/encoding'
import { receivedAmount } from './amounts'
import type { NttPlan } from './plan'
import type { NttVerification } from './verify'

export type NttGuardCode =
  | 'wallet_not_connected'
  | 'chain_mismatch'
  | 'plan_missing'
  | 'manager_unverified'
  | 'recipient_invalid'
  | 'recipient_unconfirmed'
  | 'recipient_zero'
  | 'recipient_is_contract'
  | 'amount_zero'
  | 'amount_has_dust'
  | 'balance_unknown'
  | 'insufficient_balance'
  | 'over_outbound_capacity'
  | 'inbound_capacity_unknown'
  | 'over_inbound_capacity'
  | 'fee_mismatch'
  | 'native_balance_unknown'
  | 'insufficient_native'
  | 'allowance_unknown'
  | 'needs_approve'
  | 'approve_amount_mismatch'
  | 'approve_wrong_spender'
  | 'queueing_enabled'
  | 'simulation_missing'
  | 'simulation_failed'
  | 'selfcheck_missing'
  | 'selfcheck_failed'

/** Codes that mean "not known yet", shown muted rather than red. */
export const NTT_PENDING: ReadonlySet<NttGuardCode> = new Set<NttGuardCode>([
  'plan_missing',
  'balance_unknown',
  'native_balance_unknown',
  'allowance_unknown',
  'inbound_capacity_unknown',
  'simulation_missing',
  'selfcheck_missing',
])

export type NttGuardResult = { id: number; ok: true } | { id: number; ok: false; code: NttGuardCode; detail?: string }

export function isNttPending(r: NttGuardResult): boolean {
  return !r.ok && NTT_PENDING.has(r.code)
}

export type NttApproveIntent = { token: Address; spender: Address; amount: bigint }

export type NttGuardInput = {
  walletAddress: Address | undefined
  walletChainId: number | undefined
  srcChainId: number
  /** The result of the four-part gate. Anything but a pass blocks everything. */
  verification: NttVerification | undefined
  plan: NttPlan | undefined
  recipientIsCustom: boolean
  customRecipientConfirmed: boolean
  tokenBalance: bigint | undefined
  nativeBalance: bigint | undefined
  allowance: bigint | undefined
  gasCostWei: bigint | undefined
  approveIntent?: NttApproveIntent | undefined
  simulation: { ok: true } | { ok: false; reason: string } | undefined
  selfCheck: { ok: true } | { ok: false; mismatches: string[] } | undefined
}

export type NttGuardReport = { results: NttGuardResult[]; canSend: boolean }

const ok = (id: number): NttGuardResult => ({ id, ok: true })
const fail = (id: number, code: NttGuardCode, detail?: string): NttGuardResult =>
  detail === undefined ? { id, ok: false, code } : { id, ok: false, code, detail }

// 1. the wallet is on the chain we are sending from
export function n1Chain(i: NttGuardInput): NttGuardResult {
  if (i.walletAddress === undefined || i.walletChainId === undefined) return fail(1, 'wallet_not_connected')
  if (i.walletChainId !== i.srcChainId) return fail(1, 'chain_mismatch', `${i.walletChainId} != ${i.srcChainId}`)
  return ok(1)
}

// 2. the manager passed every check in verify.ts — this is what allows an approve at all
export function n2Verified(i: NttGuardInput): NttGuardResult {
  if (!i.verification) return fail(2, 'manager_unverified', 'checking')
  if (!i.verification.ok) return fail(2, 'manager_unverified', i.verification.code)
  return ok(2)
}

// 3. recipient valid; anything other than the connected wallet must be confirmed
export function n3Recipient(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(3, 'plan_missing')
  if (!isBytes32(i.plan.recipient)) return fail(3, 'recipient_invalid')
  const differs = i.walletAddress === undefined || !sameAddress(i.plan.recipient, addressToBytes32(i.walletAddress))
  if (differs && (!i.recipientIsCustom || !i.customRecipientConfirmed)) return fail(3, 'recipient_unconfirmed')
  return ok(3)
}

// 4. recipient is not zero and not one of the contracts in play
export function n4RecipientNotContract(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(4, 'plan_missing')
  const r = i.plan.recipient
  if (isZeroBytes32(r)) return fail(4, 'recipient_zero')
  for (const c of [i.plan.token, i.plan.manager, i.plan.dst.manager]) {
    if (sameAddress(r, addressToBytes32(c))) return fail(4, 'recipient_is_contract', c)
  }
  return ok(4)
}

// 5. amount > 0, a whole multiple of the trim step, and covered by the balance
export function n5Amount(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(5, 'plan_missing')
  if (i.plan.amount <= 0n) return fail(5, 'amount_zero')
  // The manager reverts on dust instead of rounding, so the plan must have rounded already.
  if (i.plan.amount % i.plan.trim.step !== 0n) return fail(5, 'amount_has_dust', i.plan.trim.step.toString())
  if (i.tokenBalance === undefined) return fail(5, 'balance_unknown')
  if (i.plan.amount > i.tokenBalance) return fail(5, 'insufficient_balance', `${i.plan.amount} > ${i.tokenBalance}`)
  return ok(5)
}

// 6. rate limits, both directions — the inbound one read on the destination's own RPC
export function n6RateLimits(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(6, 'plan_missing')
  if (i.plan.amount > i.plan.outboundCapacity) return fail(6, 'over_outbound_capacity', i.plan.outboundCapacity.toString())
  if (i.plan.inboundCapacity === undefined) return fail(6, 'inbound_capacity_unknown')
  // Inbound capacity is denominated in the DESTINATION token, like the amount that arrives.
  const arriving = receivedAmount(i.plan.amount, i.plan.trim, i.plan.dst.tokenDecimals)
  if (arriving > i.plan.inboundCapacity) return fail(6, 'over_inbound_capacity', i.plan.inboundCapacity.toString())
  return ok(6)
}

// 7. msg.value covers the quoted delivery price (the manager refunds the rest)
export function n7Fee(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(7, 'plan_missing')
  if (i.plan.value < i.plan.fee) return fail(7, 'fee_mismatch', `${i.plan.value} < ${i.plan.fee}`)
  return ok(7)
}

// 8. native balance covers value + gas
export function n8Native(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(8, 'plan_missing')
  if (i.nativeBalance === undefined) return fail(8, 'native_balance_unknown')
  if (i.plan.value > i.nativeBalance) return fail(8, 'insufficient_native', `${i.plan.value} > ${i.nativeBalance}`)
  if (i.gasCostWei === undefined) return fail(8, 'native_balance_unknown')
  const need = i.plan.value + i.gasCostWei
  if (need > i.nativeBalance) return fail(8, 'insufficient_native', `${need} > ${i.nativeBalance}`)
  return ok(8)
}

// 9. allowance: always needed, because the manager pulls the tokens with transferFrom
export function n9Allowance(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(9, 'plan_missing')
  if (i.allowance === undefined) return fail(9, 'allowance_unknown')
  if (i.allowance < i.plan.amount) {
    if (i.approveIntent && i.approveIntent.amount !== i.plan.amount) {
      return fail(9, 'approve_amount_mismatch', `${i.approveIntent.amount} != ${i.plan.amount}`)
    }
    return fail(9, 'needs_approve')
  }
  return ok(9)
}

// 10. the approve may only ever name the VERIFIED manager, for the exact amount
export function n10Spender(i: NttGuardInput): NttGuardResult {
  if (!i.approveIntent) return ok(10)
  if (!i.plan) return fail(10, 'plan_missing')
  if (!i.verification?.ok) return fail(10, 'manager_unverified')
  const intent = i.approveIntent
  if (!isAddressEqual(intent.spender, i.verification.verified.manager)) return fail(10, 'approve_wrong_spender', intent.spender)
  if (!isAddressEqual(intent.token, i.plan.token)) return fail(10, 'approve_wrong_spender', intent.token)
  if (intent.amount !== i.plan.amount) return fail(10, 'approve_amount_mismatch', intent.amount.toString())
  return ok(10)
}

// 11. queueing is off: over the limit must revert, not queue
export function n11NoQueue(i: NttGuardInput): NttGuardResult {
  if (!i.plan) return fail(11, 'plan_missing')
  return i.plan.shouldQueue ? fail(11, 'queueing_enabled') : ok(11)
}

// 12. the simulation passed
export function n12Simulation(i: NttGuardInput): NttGuardResult {
  if (!i.simulation) return fail(12, 'simulation_missing')
  return i.simulation.ok ? ok(12) : fail(12, 'simulation_failed', i.simulation.reason)
}

// 13. our own calldata decodes back to the plan
export function n13SelfCheck(i: NttGuardInput): NttGuardResult {
  if (!i.selfCheck) return fail(13, 'selfcheck_missing')
  return i.selfCheck.ok ? ok(13) : fail(13, 'selfcheck_failed', i.selfCheck.mismatches.join(', '))
}

export function runNttGuards(i: NttGuardInput): NttGuardReport {
  const results = [
    n1Chain(i), n2Verified(i), n3Recipient(i), n4RecipientNotContract(i), n5Amount(i),
    n6RateLimits(i), n7Fee(i), n8Native(i), n9Allowance(i), n10Spender(i),
    n11NoQueue(i), n12Simulation(i), n13SelfCheck(i),
  ]
  return { results, canSend: results.every((r) => r.ok) }
}

/**
 * The approve this module is allowed to send, or null. The spender is ALWAYS the manager that
 * passed verification — never the address the user typed, never the plan's own field.
 */
export function nttApprovePlan(verification: NttVerification | undefined, plan: NttPlan | undefined, allowance: bigint | undefined): NttApproveIntent | null {
  if (!verification?.ok || !plan) return null
  if (allowance !== undefined && allowance >= plan.amount) return null
  return { token: verification.verified.token, spender: verification.verified.manager, amount: plan.amount }
}
