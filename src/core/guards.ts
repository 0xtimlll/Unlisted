/**
 * Security invariants (§6). Each numbered guard is a pure function over a
 * snapshot of app state. The Send button is enabled only when every guard
 * returns ok. Text lives in i18n; guards return codes only.
 */
import { type Address, type Hex } from 'viem'
import { applyBps } from './amounts'
import { byChainId } from './chains'
import { addressToBytes32, isBytes32, isZeroBytes32, sameAddress } from './encoding'
import { hasDangerousOptions } from './options'
import { assembleSendArgs, decodeSendCalldata, type SendPlan } from './plan'
import type { OftInfo, SuspiciousFlag } from './types'
import type { PeerBackResult } from './verify'

/** Hard cap on slippage: below this floor a high-fee or hostile OFT could keep most of the amount. */
export const MAX_SLIPPAGE_BPS = 500

export type GuardCode =
  | 'wallet_not_connected'
  | 'chain_mismatch'
  | 'plan_missing'
  | 'oft_missing'
  | 'peer_missing'
  | 'recipient_invalid'
  | 'recipient_unconfirmed'
  | 'recipient_zero'
  | 'recipient_is_contract'
  | 'amount_zero'
  | 'balance_unknown'
  | 'insufficient_balance'
  | 'min_gt_amount'
  | 'slippage_too_high'
  | 'not_multiple_of_rate'
  | 'fee_mismatch'
  | 'lz_token_fee_nonzero'
  | 'native_balance_unknown'
  | 'insufficient_native'
  | 'received_lt_min'
  | 'amount_out_of_limits'
  | 'allowance_unknown'
  | 'needs_approve'
  | 'approve_amount_mismatch'
  | 'approve_forbidden'
  | 'approve_wrong_spender'
  | 'simulation_missing'
  | 'simulation_failed'
  | 'selfcheck_missing'
  | 'selfcheck_failed'
  | 'no_executor_gas_unconfirmed'
  | 'peer_back_unknown'
  | 'peer_back_mismatch'
  | 'peer_back_unavailable_unconfirmed'
  | 'dangerous_options'

/** Codes that mean "not known yet" (a read is in flight), not "wrong". The UI shows them muted. */
export const PENDING_CODES: ReadonlySet<GuardCode> = new Set<GuardCode>([
  'plan_missing',
  'balance_unknown',
  'native_balance_unknown',
  'allowance_unknown',
  'simulation_missing',
  'selfcheck_missing',
  'peer_back_unknown',
])

export function isPending(r: GuardResult): boolean {
  return !r.ok && PENDING_CODES.has(r.code)
}

export type GuardResult =
  | { id: number; ok: true }
  | { id: number; ok: false; code: GuardCode; detail?: string }

export type SimulationResult = { ok: true } | { ok: false; reason: string }
export type SelfCheckResult = { ok: true } | { ok: false; mismatches: string[] }

/** An approve the UI is about to submit. Guards 10–12 validate it. */
export type ApproveIntent = { spender: Address; amount: bigint }

export type GuardInput = {
  walletAddress: Address | undefined
  walletChainId: number | undefined
  /** Chain the user selected as source. */
  srcChainId: number
  info: OftInfo | undefined
  plan: SendPlan | undefined
  /** User typed a recipient different from the wallet. */
  recipientIsCustom: boolean
  /** User ticked "sending to another address" and re-read the last 6 chars. */
  customRecipientConfirmed: boolean
  tokenBalance: bigint | undefined
  nativeBalance: bigint | undefined
  allowance: bigint | undefined
  /** Estimated gas * gas price for the send tx. */
  gasCostWei: bigint | undefined
  approveIntent?: ApproveIntent
  simulation: SimulationResult | undefined
  selfCheck: SelfCheckResult | undefined
  /** User confirmed the "executor may get no gas" warning (§6.15). */
  noExecutorGasAccepted: boolean
  flags: readonly SuspiciousFlag[]
  /** Result of checkPeerBack() for plan.dstEid, once known. */
  peerBack: PeerBackResult | undefined
  /** User accepted that the back-link could not be verified (RPC down), see guard 17. */
  peerBackUnavailableAccepted: boolean
}

export type GuardReport = {
  results: GuardResult[]
  /** Soft flags (§6.16). Shown, never block. */
  warnings: SuspiciousFlag[]
  /** True iff every result is ok. */
  canSend: boolean
  /** True iff the "no executor gas" warning applies (regardless of acceptance). */
  needsNoGasConfirmation: boolean
}

const ok = (id: number): GuardResult => ({ id, ok: true })
const fail = (id: number, code: GuardCode, detail?: string): GuardResult =>
  detail === undefined ? { id, ok: false, code } : { id, ok: false, code, detail }

// 1. wallet chain == selected source chain
export function g1Chain(i: GuardInput): GuardResult {
  if (i.walletAddress === undefined || i.walletChainId === undefined) return fail(1, 'wallet_not_connected')
  if (i.walletChainId !== i.srcChainId) return fail(1, 'chain_mismatch', `${i.walletChainId} != ${i.srcChainId}`)
  const src = byChainId(i.srcChainId)
  if (!src) return fail(1, 'chain_mismatch', `unknown chainId ${i.srcChainId}`)
  if (i.plan && i.plan.srcEid !== src.eid) return fail(1, 'chain_mismatch', `plan.srcEid ${i.plan.srcEid} != ${src.eid}`)
  return ok(1)
}

// 2. probeOft succeeded, peers(dstEid) != 0
export function g2Peer(i: GuardInput): GuardResult {
  if (!i.info) return fail(2, 'oft_missing')
  if (!i.plan) return fail(2, 'plan_missing')
  if (!sameAddress(i.plan.oft, i.info.oft)) return fail(2, 'oft_missing', 'plan.oft != info.oft')
  const route = i.info.routes.find((r) => r.eid === i.plan!.dstEid)
  if (!route || isZeroBytes32(route.peer)) return fail(2, 'peer_missing', `eid ${i.plan.dstEid}`)
  return ok(2)
}

// 3. recipient valid (bytes32); custom recipient requires explicit confirmation
export function g3Recipient(i: GuardInput): GuardResult {
  if (!i.plan) return fail(3, 'plan_missing')
  if (!isBytes32(i.plan.recipient)) return fail(3, 'recipient_invalid')
  if (i.walletAddress && !sameAddress(i.plan.recipient, addressToBytes32(i.walletAddress))) {
    // Recipient differs from wallet: must be flagged as custom AND confirmed.
    if (!i.recipientIsCustom || !i.customRecipientConfirmed) return fail(3, 'recipient_unconfirmed')
  }
  return ok(3)
}

// 4. recipient != 0 and not token/oft/endpoint (compared in bytes32 form)
export function g4RecipientNotContract(i: GuardInput): GuardResult {
  if (!i.plan) return fail(4, 'plan_missing')
  if (!i.info) return fail(4, 'oft_missing')
  const r = i.plan.recipient
  if (isZeroBytes32(r)) return fail(4, 'recipient_zero')
  for (const c of [i.info.token, i.info.oft, i.info.endpoint]) {
    if (sameAddress(r, addressToBytes32(c))) return fail(4, 'recipient_is_contract', c)
  }
  return ok(4)
}

// 5. amountLD > 0 and <= balance
export function g5Amount(i: GuardInput): GuardResult {
  if (!i.plan) return fail(5, 'plan_missing')
  const a = i.plan.amounts.amountLD
  if (a <= 0n) return fail(5, 'amount_zero')
  if (i.tokenBalance === undefined) return fail(5, 'balance_unknown')
  if (a > i.tokenBalance) return fail(5, 'insufficient_balance', `${a} > ${i.tokenBalance}`)
  return ok(5)
}

// 6. minAmountLD <= amountLD; both multiples of conversionRate
export function g6MinAmount(i: GuardInput): GuardResult {
  if (!i.plan) return fail(6, 'plan_missing')
  if (!i.info) return fail(6, 'oft_missing')
  const { amountLD, minAmountLD } = i.plan.amounts
  if (minAmountLD > amountLD) return fail(6, 'min_gt_amount')
  if (minAmountLD < applyBps(amountLD, 10000 - MAX_SLIPPAGE_BPS)) return fail(6, 'slippage_too_high')
  const rate = i.info.conversionRate
  if (rate <= 0n) return fail(6, 'not_multiple_of_rate', 'rate <= 0')
  if (amountLD % rate !== 0n) return fail(6, 'not_multiple_of_rate', 'amountLD')
  if (minAmountLD % rate !== 0n) return fail(6, 'not_multiple_of_rate', 'minAmountLD')
  return ok(6)
}

// 7. fee.nativeFee === value, lzTokenFee === 0
export function g7Fee(i: GuardInput): GuardResult {
  if (!i.plan) return fail(7, 'plan_missing')
  const [, fee] = assembleSendArgs(i.plan)
  if (fee.nativeFee !== i.plan.value) return fail(7, 'fee_mismatch')
  if (fee.lzTokenFee !== 0n) return fail(7, 'lz_token_fee_nonzero')
  if (i.plan.value < i.plan.quote.nativeFee) return fail(7, 'fee_mismatch', 'value < quoted nativeFee')
  return ok(7)
}

// 8. value + gas <= native balance
export function g8Native(i: GuardInput): GuardResult {
  if (!i.plan) return fail(8, 'plan_missing')
  if (i.nativeBalance === undefined || i.gasCostWei === undefined) return fail(8, 'native_balance_unknown')
  const need = i.plan.value + i.gasCostWei
  if (need > i.nativeBalance) return fail(8, 'insufficient_native', `${need} > ${i.nativeBalance}`)
  return ok(8)
}

// 9. quoteOFT.amountReceivedLD >= minAmountLD; amount within OFT limits
export function g9Quote(i: GuardInput): GuardResult {
  if (!i.plan) return fail(9, 'plan_missing')
  const { quote, amounts } = i.plan
  if (amounts.amountLD < quote.limitMinLD || amounts.amountLD > quote.limitMaxLD) {
    return fail(9, 'amount_out_of_limits', `[${quote.limitMinLD}, ${quote.limitMaxLD}]`)
  }
  if (quote.amountReceivedLD < amounts.minAmountLD) {
    return fail(9, 'received_lt_min', `${quote.amountReceivedLD} < ${amounts.minAmountLD}`)
  }
  return ok(9)
}

// 10. if approvalRequired: allowance >= amountLD (else approve exactly amountLD)
export function g10Allowance(i: GuardInput): GuardResult {
  if (!i.plan) return fail(10, 'plan_missing')
  if (!i.info) return fail(10, 'oft_missing')
  if (!i.info.approvalRequired) return ok(10)
  if (i.allowance === undefined) return fail(10, 'allowance_unknown')
  if (i.allowance < i.plan.amounts.amountLD) {
    if (i.approveIntent && i.approveIntent.amount !== i.plan.amounts.amountLD) {
      return fail(10, 'approve_amount_mismatch', `${i.approveIntent.amount} != ${i.plan.amounts.amountLD}`)
    }
    return fail(10, 'needs_approve')
  }
  return ok(10)
}

// 11. if approvalRequired === false: no approve may be sent at all
export function g11NoApprove(i: GuardInput): GuardResult {
  if (!i.info) return fail(11, 'oft_missing')
  if (!i.info.approvalRequired && i.approveIntent) return fail(11, 'approve_forbidden')
  return ok(11)
}

// 12. approve spender == probeOft().oft
export function g12Spender(i: GuardInput): GuardResult {
  if (!i.info) return fail(12, 'oft_missing')
  if (i.approveIntent && !sameAddress(i.approveIntent.spender, i.info.oft)) {
    return fail(12, 'approve_wrong_spender', i.approveIntent.spender)
  }
  return ok(12)
}

// 13. the send simulation (done in the RPC layer) succeeded
export function g13Simulation(i: GuardInput): GuardResult {
  if (!i.simulation) return fail(13, 'simulation_missing')
  if (!i.simulation.ok) return fail(13, 'simulation_failed', i.simulation.reason)
  return ok(13)
}

// 14. self-check: our own calldata decodes back to the plan
export function g14SelfCheck(i: GuardInput): GuardResult {
  if (!i.selfCheck) return fail(14, 'selfcheck_missing')
  if (!i.selfCheck.ok) return fail(14, 'selfcheck_failed', i.selfCheck.mismatches.join(', '))
  return ok(14)
}

/** True when neither enforced nor extra options carry executor gas (§6.15). */
export function needsNoGasConfirmation(info: OftInfo | undefined, plan: SendPlan | undefined): boolean {
  if (!info || !plan) return false
  const enforced: Hex = info.enforced[plan.dstEid] ?? '0x'
  return enforced === '0x' && plan.extraOptions === '0x'
}

// 15. no executor gas -> requires explicit confirmation
export function g15ExecutorGas(i: GuardInput): GuardResult {
  if (!i.plan) return fail(15, 'plan_missing')
  if (!i.info) return fail(15, 'oft_missing')
  if (needsNoGasConfirmation(i.info, i.plan) && !i.noExecutorGasAccepted) {
    return fail(15, 'no_executor_gas_unconfirmed')
  }
  return ok(15)
}

// 16. suspicious flags: never block, always surface
export function g16Suspicious(i: GuardInput): { result: GuardResult; warnings: SuspiciousFlag[] } {
  return { result: ok(16), warnings: [...i.flags] }
}

// 17. the destination peer names our OFT as its peer (defeats look-alike / fake adapters)
export function g17PeerBack(i: GuardInput): GuardResult {
  if (!i.plan) return fail(17, 'plan_missing')
  if (!i.peerBack) return fail(17, 'peer_back_unknown')
  if (i.peerBack.status === 'mismatch') return fail(17, 'peer_back_mismatch', i.peerBack.theirPeer)
  if (i.peerBack.status === 'unavailable' && !i.peerBackUnavailableAccepted) {
    return fail(17, 'peer_back_unavailable_unconfirmed', i.peerBack.reason)
  }
  return ok(17)
}

// 18. extraOptions never carry value or calls (nativeDrop / compose / receive value)
export function g18Options(i: GuardInput): GuardResult {
  if (!i.plan) return fail(18, 'plan_missing')
  if (hasDangerousOptions(i.plan.extraOptions)) return fail(18, 'dangerous_options')
  return ok(18)
}

export function runGuards(i: GuardInput): GuardReport {
  const g16 = g16Suspicious(i)
  const results: GuardResult[] = [
    g1Chain(i),
    g2Peer(i),
    g3Recipient(i),
    g4RecipientNotContract(i),
    g5Amount(i),
    g6MinAmount(i),
    g7Fee(i),
    g8Native(i),
    g9Quote(i),
    g10Allowance(i),
    g11NoApprove(i),
    g12Spender(i),
    g13Simulation(i),
    g14SelfCheck(i),
    g15ExecutorGas(i),
    g16.result,
    g17PeerBack(i),
    g18Options(i),
  ]
  return {
    results,
    warnings: g16.warnings,
    canSend: results.every((r) => r.ok),
    needsNoGasConfirmation: needsNoGasConfirmation(i.info, i.plan),
  }
}

/**
 * The approve this app is allowed to send, or null. Amount is EXACTLY amountLD;
 * spender is EXACTLY info.oft. Unlimited approve does not exist in this codebase.
 */
export function approvePlan(info: OftInfo, plan: SendPlan, allowance: bigint | undefined): ApproveIntent | null {
  if (!info.approvalRequired) return null
  if (allowance !== undefined && allowance >= plan.amounts.amountLD) return null
  return { spender: info.oft, amount: plan.amounts.amountLD }
}

/**
 * §6.14: decode our own `send` calldata and compare every field with the plan.
 */
export function selfCheck(plan: SendPlan, calldata: Hex): SelfCheckResult {
  const mismatches: string[] = []
  let decoded
  try {
    decoded = decodeSendCalldata(calldata)
  } catch (e) {
    return { ok: false, mismatches: [`decode: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const [expected, expectedFee, expectedRefund] = assembleSendArgs(plan)
  const sp = decoded.sendParam
  if (sp.dstEid !== expected.dstEid) mismatches.push('dstEid')
  if (sp.to.toLowerCase() !== expected.to.toLowerCase()) mismatches.push('to')
  if (sp.amountLD !== expected.amountLD) mismatches.push('amountLD')
  if (sp.minAmountLD !== expected.minAmountLD) mismatches.push('minAmountLD')
  if (sp.extraOptions.toLowerCase() !== expected.extraOptions.toLowerCase()) mismatches.push('extraOptions')
  if (sp.composeMsg !== '0x') mismatches.push('composeMsg')
  if (sp.oftCmd !== '0x') mismatches.push('oftCmd')
  if (decoded.fee.nativeFee !== expectedFee.nativeFee) mismatches.push('fee.nativeFee')
  if (decoded.fee.nativeFee !== plan.value) mismatches.push('fee.nativeFee != value')
  if (decoded.fee.lzTokenFee !== 0n) mismatches.push('fee.lzTokenFee')
  if (!sameAddress(decoded.refundAddress, expectedRefund)) mismatches.push('refundAddress')
  if (!sameAddress(decoded.refundAddress, plan.sender)) mismatches.push('refundAddress != sender')
  if (isZeroBytes32(sp.to)) mismatches.push('to is zero')
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches }
}
