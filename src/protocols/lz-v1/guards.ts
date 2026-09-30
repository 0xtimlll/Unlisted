/**
 * §3: the invariants a LayerZero v1 transfer must satisfy before anything is signed.
 *
 * Numbered to match src/core/guards.ts question for question, so the OFT tab asks the same things
 * of a v1 contract that it asks of a V2 one and a reviewer can read the two side by side. Where v1
 * has no equivalent the number is still spent on the nearest real question rather than skipped,
 * and where v1 needs something V2 does not (a stuck payload on the destination) it goes in the
 * slot V2 uses for the same kind of "can this route actually deliver" check.
 *
 * Pure functions over a snapshot. Text lives in i18n; these return codes.
 */
import { verdictOf } from '../../core/severity'
import { isAddressEqual, type Address, type Hex } from 'viem'
import { aboveFeeCeiling, byKey } from '../../core/chains'
import type { SuspiciousFlag } from '../../core/types'
import { judgeAdapterParams } from './adapterParams'
import type { OftV1Info, V1PeerBack } from './detect'
import type { V1SendPlan } from './plan'
import type { V1Simulation } from './simulate'
import { formatRevert } from '../../core/sim/revert'
import type { V1SelfCheckResult } from './selfcheck'
import { riskWarningCode, type RouteRisk } from '../lz-risk/risk'

export type V1GuardCode =
  | 'wallet_not_connected'
  | 'chain_mismatch'
  | 'plan_missing'
  | 'oft_missing'
  | 'route_missing'
  | 'recipient_invalid'
  | 'recipient_unconfirmed'
  | 'recipient_lookalike'
  | 'recipient_zero'
  | 'recipient_is_contract'
  | 'amount_zero'
  | 'balance_unknown'
  | 'insufficient_balance'
  | 'not_multiple_of_rate'
  | 'min_gt_delivered'
  | 'slippage_too_high'
  | 'slippage_unsupported'
  | 'fee_mismatch'
  | 'native_balance_unknown'
  | 'insufficient_native'
  | 'oft_fee_exceeds_amount'
  | 'delivered_zero'
  | 'allowance_unknown'
  | 'needs_approve'
  | 'approve_amount_mismatch'
  | 'approve_forbidden'
  | 'approve_wrong_spender'
  | 'approve_wrong_token'
  | 'simulation_missing'
  | 'simulation_failed'
  | 'simulation_unavailable'
  | 'selfcheck_missing'
  | 'selfcheck_failed'
  | 'adapter_params_missing'
  | 'adapter_params_forbidden'
  | 'gas_below_min_dst'
  | 'dangerous_adapter_params'
  | 'trusted_remote_back_unknown'
  | 'trusted_remote_back_mismatch'
  | 'trusted_remote_back_unavailable'
  | 'recipient_vm_mismatch'
  | 'stored_payload_blocked'
  | 'stored_payload_unknown'
  | 'stored_payload_unavailable'
  | 'fee_above_ceiling'
  | 'risk_unknown'
  | 'risk_unavailable'
  | 'risk_blocked'
  | 'risk_unverified'

/** Codes that mean "not known yet", not "wrong". The UI shows them muted, same as the V2 tab. */
export const V1_PENDING: ReadonlySet<V1GuardCode> = new Set<V1GuardCode>([
  'risk_unknown',
  'plan_missing',
  'balance_unknown',
  'native_balance_unknown',
  'allowance_unknown',
  'simulation_missing',
  'selfcheck_missing',
  'trusted_remote_back_unknown',
  'stored_payload_unknown',
])

export type V1GuardResult = { id: number; ok: true } | { id: number; ok: false; code: V1GuardCode; detail?: string }

export function isV1Pending(r: V1GuardResult): boolean {
  return !r.ok && V1_PENDING.has(r.code)
}

export type V1ApproveIntentInput = { token: Address; spender: Address; amount: bigint }

/** Whether the destination endpoint is holding a stuck packet for this exact path. */
export type StoredPayloadState = { status: 'clear' } | { status: 'blocked' } | { status: 'unavailable'; reason: string }

export type V1GuardInput = {
  walletAddress: Address | undefined
  walletChainId: number | undefined
  /** chainId of the chain the user picked as the source. */
  srcChainId: number
  info: OftV1Info | undefined
  plan: V1SendPlan | undefined
  recipientIsCustom: boolean
  customRecipientConfirmed: boolean
  /**
   * §Address book: the recipient shares its first four and last four characters with a SAVED
   * address but is not that address. That is what an address swap looks like, so it is a refusal
   * with no confirmation attached — a user who could tick a box here is the user already fooled.
   * Set by the screen only for a recipient that came from outside (typed or pasted), never for
   * the connected wallet's own address.
   */
  recipientLookalike?: boolean | undefined
  tokenBalance: bigint | undefined
  nativeBalance: bigint | undefined
  allowance: bigint | undefined
  gasCostWei: bigint | undefined
  approveIntent?: V1ApproveIntentInput | undefined
  simulation: V1Simulation | undefined
  selfCheck: V1SelfCheckResult | undefined
  flags: readonly SuspiciousFlag[]
  peerBack: V1PeerBack | undefined
  storedPayload: StoredPayloadState | undefined
  /**
   * §4 The route's risk verdict. Absent means the checks have not finished, which guard 22 treats
   * as pending — unless `riskError` says the runner failed, which is a note, not a hold.
   */
  risk?: RouteRisk | undefined
  riskError?: string | undefined
}

export type V1GuardReport = {
  /** Failures that hold the button, plus reads still in flight (core/severity.ts). */
  blocks: V1GuardResult[]
  /** Failures that colour the route indicator and hold nothing. */
  notes: V1GuardResult[]
  results: V1GuardResult[]
  warnings: SuspiciousFlag[]
  canSend: boolean
}

const ok = (id: number): V1GuardResult => ({ id, ok: true })
const fail = (id: number, code: V1GuardCode, detail?: string): V1GuardResult =>
  detail === undefined ? { id, ok: false, code } : { id, ok: false, code, detail }

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// 1. the wallet is connected and on the chain we are sending from
export function v1g1Chain(i: V1GuardInput): V1GuardResult {
  if (i.walletAddress === undefined || i.walletChainId === undefined) return fail(1, 'wallet_not_connected')
  if (i.walletChainId !== i.srcChainId) return fail(1, 'chain_mismatch', `${i.walletChainId} != ${i.srcChainId}`)
  if (i.plan && i.info && !eq(i.plan.oft, i.info.oft)) return fail(1, 'oft_missing', 'plan.oft != info.oft')
  if (i.plan && i.info && i.plan.srcV1ChainId !== i.info.srcV1ChainId) return fail(1, 'chain_mismatch', 'plan.srcV1ChainId')
  // The refund goes to plan.sender, so it must be the wallet that signs.
  if (i.plan && !eq(i.plan.sender, i.walletAddress)) return fail(1, 'chain_mismatch', 'plan.sender != wallet')
  return ok(1)
}

// 2. the destination has a trusted remote — v1's whole notion of a route
export function v1g2Route(i: V1GuardInput): V1GuardResult {
  if (!i.info) return fail(2, 'oft_missing')
  if (!i.plan) return fail(2, 'plan_missing')
  const route = i.info.routes.find((r) => r.key === i.plan!.dst.key)
  if (!route || route.trustedRemote === '0x') return fail(2, 'route_missing', i.plan.dst.key)
  if (route.v1ChainId !== i.plan.dst.v1ChainId) return fail(2, 'route_missing', 'chain id does not match the route')
  return ok(2)
}

// 3. the recipient is valid, and anything other than the connected wallet is confirmed by hand
export function v1g3Recipient(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(3, 'plan_missing')
  if (!/^0x[0-9a-fA-F]{40}$/.test(i.plan.recipient)) return fail(3, 'recipient_invalid')
  // No wallet to compare against counts as "differs" — this guard must be safe on its own.
  const differs = i.walletAddress === undefined || !isAddressEqual(i.plan.recipient, i.walletAddress)
  // A look-alike of a saved address is refused before anything else about the recipient is
  // considered: there is nothing to confirm when the address is already wrong.
  if (i.recipientLookalike) return fail(3, 'recipient_lookalike')
  if (differs && (!i.recipientIsCustom || !i.customRecipientConfirmed)) return fail(3, 'recipient_unconfirmed')
  return ok(3)
}

// 4. the recipient is not zero and not one of the contracts in play
export function v1g4RecipientNotContract(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(4, 'plan_missing')
  if (!i.info) return fail(4, 'oft_missing')
  const r = i.plan.recipient
  if (/^0x0{40}$/.test(r)) return fail(4, 'recipient_zero')
  for (const c of [i.info.oft, i.info.token, i.info.endpoint]) {
    if (eq(r, c)) return fail(4, 'recipient_is_contract', c)
  }
  const route = i.info.routes.find((x) => x.key === i.plan!.dst.key)
  if (route?.remoteAddress && eq(r, route.remoteAddress)) return fail(4, 'recipient_is_contract', route.remoteAddress)
  return ok(4)
}

// 5. amount > 0 and within the wallet's balance
export function v1g5Amount(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(5, 'plan_missing')
  const a = i.plan.amounts.amountLD
  if (a <= 0n) return fail(5, 'amount_zero')
  if (i.tokenBalance === undefined) return fail(5, 'balance_unknown')
  if (a > i.tokenBalance) return fail(5, 'insufficient_balance', `${a} > ${i.tokenBalance}`)
  return ok(5)
}

/** The highest slippage this tab will encode, matching the V2 tab's cap. */
export const MAX_V1_SLIPPAGE_BPS = 500

// 6. the amount survives the contract's own arithmetic: dust, and the minimum where one exists
export function v1g6Amounts(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(6, 'plan_missing')
  if (!i.info) return fail(6, 'oft_missing')
  const { amounts, standard, slippageBps } = i.plan
  const rate = i.info.conversionRate
  if (rate <= 0n) return fail(6, 'not_multiple_of_rate', 'rate <= 0')
  if (amounts.delivered <= 0n) return fail(6, 'delivered_zero')
  // What the contract will actually move must be a whole number of shared-decimal units.
  if (amounts.delivered % rate !== 0n) return fail(6, 'not_multiple_of_rate', 'delivered')
  if (standard.wire !== 'bytes32_fee') {
    // Neither of these `sendFrom`s takes a minimum, so a slippage setting would be unenforceable.
    if (slippageBps !== 0) return fail(6, 'slippage_unsupported', standard.wire)
    if (amounts.minAmountLD !== undefined) return fail(6, 'slippage_unsupported', 'minAmount on a standard without one')
    // `_amount` is the post-dust number for these two: the contract sends exactly what it is given.
    if (amounts.amountLD !== amounts.delivered) return fail(6, 'not_multiple_of_rate', 'amountLD != delivered')
    return ok(6)
  }
  if (slippageBps < 0 || slippageBps > MAX_V1_SLIPPAGE_BPS) return fail(6, 'slippage_too_high', `${slippageBps}`)
  if (amounts.minAmountLD === undefined) return fail(6, 'min_gt_delivered', 'no minimum on a standard that requires one')
  if (amounts.minAmountLD > amounts.delivered) return fail(6, 'min_gt_delivered', `${amounts.minAmountLD} > ${amounts.delivered}`)
  return ok(6)
}

// 7. msg.value covers the quote and nothing in the plan contradicts it
export function v1g7Fee(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(7, 'plan_missing')
  if (i.plan.value < i.plan.quote.nativeFee) return fail(7, 'fee_mismatch', 'value < quoted nativeFee')
  if (i.plan.quote.nativeFee <= 0n) return fail(7, 'fee_mismatch', 'the quote is zero')
  return ok(7)
}

// 8. the fee plus gas fits in the native balance
export function v1g8Native(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(8, 'plan_missing')
  if (i.nativeBalance === undefined) return fail(8, 'native_balance_unknown')
  if (i.plan.value > i.nativeBalance) return fail(8, 'insufficient_native', `${i.plan.value} > ${i.nativeBalance}`)
  // A simulation that reverted or could not run produces no estimate, ever: waiting for one would
  // hold the button forever behind a note. The fee fits; the gas is what the wallet will price.
  if (i.gasCostWei === undefined) return i.simulation && i.simulation.status !== 'ok' ? ok(8) : fail(8, 'native_balance_unknown')
  const need = i.plan.value + i.gasCostWei
  if (need > i.nativeBalance) return fail(8, 'insufficient_native', `${need} > ${i.nativeBalance}`)
  return ok(8)
}

// 9. the contract's own fee does not eat the transfer
export function v1g9OftFee(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(9, 'plan_missing')
  const { oftFee, amountRaw, delivered } = i.plan.amounts
  if (oftFee < 0n) return fail(9, 'oft_fee_exceeds_amount', 'negative fee')
  if (oftFee >= amountRaw) return fail(9, 'oft_fee_exceeds_amount', `${oftFee} >= ${amountRaw}`)
  if (delivered <= 0n) return fail(9, 'delivered_zero')
  return ok(9)
}

// 10. an adapter needs its allowance — for exactly the amount in the calldata
export function v1g10Allowance(i: V1GuardInput): V1GuardResult {
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

// 11. a plain OFT burns from the sender: no approve may be sent at all
export function v1g11NoApprove(i: V1GuardInput): V1GuardResult {
  if (!i.info) return fail(11, 'oft_missing')
  if (!i.info.approvalRequired && i.approveIntent) return fail(11, 'approve_forbidden')
  return ok(11)
}

// 12. the approve names the OFT as spender and the token the contract itself declared
export function v1g12Spender(i: V1GuardInput): V1GuardResult {
  if (!i.info) return fail(12, 'oft_missing')
  if (!i.approveIntent) return ok(12)
  if (!eq(i.approveIntent.spender, i.info.oft)) return fail(12, 'approve_wrong_spender', i.approveIntent.spender)
  if (!eq(i.approveIntent.token, i.info.token)) return fail(12, 'approve_wrong_token', i.approveIntent.token)
  return ok(12)
}

// 13. the exact transaction was executed against the chain and did not revert.
//     A revert is a warning, not a block (core/severity.ts): the reverts that are certain — no peer,
//     no balance, an amount that arrives as zero — are caught by their own blocking guards, and what
//     is left is often the RPC's state, not the chain's. The decoded reason travels as `detail` so
//     the warning can say what the node said.
export function v1g13Simulation(i: V1GuardInput): V1GuardResult {
  if (!i.simulation) return fail(13, 'simulation_missing')
  if (i.simulation.status === 'reverted') return fail(13, 'simulation_failed', formatRevert(i.simulation.revert))
  if (i.simulation.status === 'unavailable') return fail(13, 'simulation_unavailable', i.simulation.reason)
  return ok(13)
}

// 14. our own calldata decodes back to the plan, read by independent code
export function v1g14SelfCheck(i: V1GuardInput): V1GuardResult {
  if (!i.selfCheck) return fail(14, 'selfcheck_missing')
  if (!i.selfCheck.ok) return fail(14, 'selfcheck_failed', i.selfCheck.mismatches.join(', '))
  return ok(14)
}

// 15. adapter params match what the contract demands — empty when it forbids them, and enough
//     destination gas when it requires them (LzApp._checkGasLimit would revert otherwise)
export function v1g15AdapterParams(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(15, 'plan_missing')
  if (!i.info) return fail(15, 'oft_missing')
  const route = i.info.routes.find((r) => r.key === i.plan!.dst.key)
  const params = i.plan.adapterParams
  if (!i.info.adapterParamsRequired) {
    // OFTCore._checkAdapterParams: `require(_adapterParams.length == 0)`.
    return params === '0x' ? ok(15) : fail(15, 'adapter_params_forbidden')
  }
  if (params === '0x') return fail(15, 'adapter_params_missing')
  const v = judgeAdapterParams(params)
  if (v.kind !== 'ok') return fail(15, 'dangerous_adapter_params', v.kind === 'refused' ? v.reason : 'empty')
  const min = route?.minDstGas ?? 0n
  if (min <= 0n) return fail(15, 'gas_below_min_dst', 'the contract sets no minimum, so every send reverts')
  if (v.params.extraGas < min) return fail(15, 'gas_below_min_dst', `${v.params.extraGas} < ${min}`)
  return ok(15)
}

// 16. soft flags: shown, never blocking
export function v1g16Suspicious(i: V1GuardInput): { result: V1GuardResult; warnings: SuspiciousFlag[] } {
  return { result: ok(16), warnings: [...i.flags] }
}

// 17. the destination contract trusts us back (a look-alike cannot make the real one point at it)
export function v1g17TrustedRemoteBack(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(17, 'plan_missing')
  if (!i.peerBack) return fail(17, 'trusted_remote_back_unknown')
  if (i.peerBack.status === 'mismatch') return fail(17, 'trusted_remote_back_mismatch', i.peerBack.theirRemote)
  if (i.peerBack.status === 'unavailable') return fail(17, 'trusted_remote_back_unavailable', i.peerBack.reason)
  return ok(17)
}

// 18. the adapter params carry no native drop — the v1 spelling of the options rule
export function v1g18NoNativeDrop(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(18, 'plan_missing')
  const v = judgeAdapterParams(i.plan.adapterParams)
  if (v.kind === 'refused') return fail(18, 'dangerous_adapter_params', v.reason)
  return ok(18)
}

// 19. v1 is EVM-only, so the recipient is an EVM address and the destination is an EVM chain
export function v1g19RecipientVm(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(19, 'plan_missing')
  const dst = byKey(i.plan.dst.key)
  if (dst.vm !== 'evm') return fail(19, 'recipient_vm_mismatch', `${i.plan.dst.key} is not an EVM chain`)
  return ok(19)
}

// 20. the destination endpoint is not already holding a stuck packet for this path — a send into
//     a blocked path is queued behind it and arrives only if someone clears the first one
export function v1g20StoredPayload(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(20, 'plan_missing')
  if (!i.storedPayload) return fail(20, 'stored_payload_unknown')
  if (i.storedPayload.status === 'blocked') return fail(20, 'stored_payload_blocked')
  if (i.storedPayload.status === 'unavailable') return fail(20, 'stored_payload_unavailable', i.storedPayload.reason)
  return ok(20)
}

/** True when this plan's value is above the source chain's ceiling (core/chains.ts). */
export function v1FeeAboveCeiling(plan: V1SendPlan | undefined): boolean {
  return !!plan && aboveFeeCeiling(plan.chain, plan.value)
}

// 21. the fee is within the chain's ceiling — otherwise a note for the indicator, never a refusal
export function v1g21FeeCeiling(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(21, 'plan_missing')
  if (!v1FeeAboveCeiling(i.plan)) return ok(21)
  return fail(21, 'fee_above_ceiling', `${i.plan.value}`)
}

/**
 * §4, guard 22: the route's verdict, carried as a note. The v1 side of the same rule the V2 tab
 * applies: the indicator reads the verdict's own reasons (core/indicator.ts), and nothing here
 * holds the button.
 */
export function v1g22Risk(i: V1GuardInput): V1GuardResult {
  if (!i.plan) return fail(22, 'plan_missing')
  if (!i.risk) return i.riskError ? fail(22, 'risk_unavailable', i.riskError) : fail(22, 'risk_unknown')
  const code = riskWarningCode(i.risk)
  return code ? fail(22, code) : ok(22)
}

export function runV1Guards(i: V1GuardInput): V1GuardReport {
  const g16 = v1g16Suspicious(i)
  const results: V1GuardResult[] = [
    v1g1Chain(i),
    v1g2Route(i),
    v1g3Recipient(i),
    v1g4RecipientNotContract(i),
    v1g5Amount(i),
    v1g6Amounts(i),
    v1g7Fee(i),
    v1g8Native(i),
    v1g9OftFee(i),
    v1g10Allowance(i),
    v1g11NoApprove(i),
    v1g12Spender(i),
    v1g13Simulation(i),
    v1g14SelfCheck(i),
    v1g15AdapterParams(i),
    g16.result,
    v1g17TrustedRemoteBack(i),
    v1g18NoNativeDrop(i),
    v1g19RecipientVm(i),
    v1g20StoredPayload(i),
    v1g21FeeCeiling(i),
    v1g22Risk(i),
  ]
  return { results, warnings: g16.warnings, ...verdictOf(results) }
}

/** The calldata's own adapter params, for the review screen. */
export function v1AdapterParamsSummary(params: Hex): { empty: boolean; gas: bigint; refused: string | undefined } {
  const v = judgeAdapterParams(params)
  if (v.kind === 'empty') return { empty: true, gas: 0n, refused: undefined }
  if (v.kind === 'ok') return { empty: false, gas: v.params.extraGas, refused: undefined }
  return { empty: false, gas: 0n, refused: v.reason }
}
