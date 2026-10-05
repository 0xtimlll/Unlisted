/**
 * Security invariants (§6). Each numbered guard is a pure function over a snapshot of app state.
 * Text lives in i18n; guards return codes only. core/severity.ts says which codes hold the Send
 * button (the transaction is impossible, or the app would be building something malformed) and
 * which are notes for the route indicator (core/indicator.ts). Nothing here asks for a tick.
 */
import { verdictOf } from './severity'
import { type Address, type Hex } from 'viem'
import { applyBps, trimDust } from './amounts'
import { classifyFee, formatBps, issuerFee } from './oftFee'
import { aboveFeeCeiling, byChainId, byEid } from './chains'
import { addressToBytes32, isBytes32, isZeroBytes32, sameAddress } from './encoding'
import { hasDangerousOptions, inspectEnforcedOptions, receiveTotals, type EnforcedRisk } from './options'
import { assembleSendArgs, decodeSendCalldata, planFee, type EvmSendPlan, type SendPlan } from './plan'
import type { SourceInfo, SuspiciousFlag } from './types'
import type { SvmRecipientClass } from './svm/recipient'
import type { SvmDebitCheck } from './svm/plan'
import type { PeerBackResult } from './verify'
import { riskWarningCode, type RouteRisk } from '../protocols/lz-risk/risk'

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
  | 'recipient_lookalike'
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
  | 'oft_fee_notice'
  | 'oft_fee_high'
  | 'oft_fee_extreme'
  | 'oft_fee_unknown'
  | 'allowance_unknown'
  | 'needs_approve'
  | 'approve_amount_mismatch'
  | 'approve_forbidden'
  | 'approve_wrong_spender'
  | 'simulation_missing'
  | 'simulation_failed'
  | 'debit_mismatch'
  | 'selfcheck_missing'
  | 'selfcheck_failed'
  | 'no_executor_gas'
  | 'peer_back_unknown'
  | 'peer_back_mismatch'
  | 'peer_back_unavailable'
  | 'dangerous_options'
  | 'recipient_vm_mismatch'
  | 'recipient_class_unknown'
  | 'recipient_token_account'
  | 'recipient_pda'
  | 'no_executor_options_svm'
  | 'svm_dest_unknown'
  | 'fee_above_ceiling'
  | 'risk_unknown'
  | 'risk_unavailable'
  | 'risk_blocked'
  | 'risk_unverified'

/** Codes that mean "not known yet" (a read is in flight), not "wrong". The UI shows them muted. */
export const PENDING_CODES: ReadonlySet<GuardCode> = new Set<GuardCode>([
  'risk_unknown',
  'plan_missing',
  'balance_unknown',
  'native_balance_unknown',
  'allowance_unknown',
  'simulation_missing',
  'selfcheck_missing',
  'peer_back_unknown',
  'recipient_class_unknown',
  'svm_dest_unknown',
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
  /** EVM wallet (wagmi). Undefined when no EVM wallet is connected or the source is Solana. */
  walletAddress: Address | undefined
  walletChainId: number | undefined
  /** Chain the user selected as source: its chainId for EVM, or the Solana wallet for svm. */
  srcChainId: number
  /** Solana source only: the connected Solana wallet (base58). */
  svmWalletAddress?: string | undefined
  info: SourceInfo | undefined
  plan: SendPlan | undefined
  /** User typed a recipient different from the wallet. */
  recipientIsCustom: boolean
  /** User ticked "sending to another address" and re-read the last 6 chars. */
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
  /** Estimated cost of the send tx in the source chain's native unit (wei, or lamports on Solana). */
  gasCostWei: bigint | undefined
  approveIntent?: ApproveIntent
  simulation: SimulationResult | undefined
  /**
   * Solana source only: what the dry run debited, against the plan (svm/plan.ts judgeSvmDebit).
   * The program called is whatever owns the store, so this is the one check that holds it to the
   * numbers on screen. Absent on EVM, where the calldata itself fixes the amounts.
   */
  svmDebit?: SvmDebitCheck | undefined
  selfCheck: SelfCheckResult | undefined
  flags: readonly SuspiciousFlag[]
  /** Result of checkPeerBack() for plan.dstEid, once known. */
  peerBack: PeerBackResult | undefined
  /**
   * §4 The route's risk verdict, once the checks have run. Absent means they have not (guard 22
   * is pending) — unless `riskError` says the runner failed, which is a note, not a hold.
   */
  risk?: RouteRisk | undefined
  /** The route checks could not be run at all. Said in the indicator; never holds the button. */
  riskError?: string | undefined
  /** Solana destinations only: what kind of account the recipient is (svm/recipient.ts). */
  svmRecipientClass?: SvmRecipientClass | undefined
  /** Solana destinations only: discovery of the Solana side finished (mint, program, PeerConfig known). */
  svmDestinationKnown?: boolean
  /**
   * Solana destinations only: the store matched one of LayerZero's official layouts. When it did
   * not, the mint is unknown, so the recipient's account class cannot be checked — that is a
   * warning (§types.SuspiciousFlag), not a reason to refuse a route the EVM side still quotes.
   */
  svmDestinationRecognised?: boolean
}

export type GuardReport = {
  /** Failures that hold the button, plus reads still in flight (core/severity.ts). */
  blocks: GuardResult[]
  /** Failures that colour the route indicator and hold nothing. */
  notes: GuardResult[]
  results: GuardResult[]
  /** Soft flags (§6.16). Shown in the indicator, never block. */
  warnings: SuspiciousFlag[]
  /** True iff nothing blocks. */
  canSend: boolean
}

const ok = (id: number): GuardResult => ({ id, ok: true })
const fail = (id: number, code: GuardCode, detail?: string): GuardResult =>
  detail === undefined ? { id, ok: false, code } : { id, ok: false, code, detail }

/** Same OFT on both sides of the plan: the address the user checked is the one the tx names. */
function samePlanOft(plan: SendPlan, info: SourceInfo): boolean {
  if (plan.vm === 'evm') return info.vm === 'evm' && sameAddress(plan.oft, info.oft)
  return info.vm === 'svm' && plan.oftStore === info.oftStore
}

// 1. wallet chain == selected source chain (Solana: the Solana wallet is connected and is the plan's sender)
export function g1Chain(i: GuardInput): GuardResult {
  if (i.plan?.vm === 'svm' || (i.plan === undefined && i.info?.vm === 'svm')) {
    if (!i.svmWalletAddress) return fail(1, 'wallet_not_connected')
    if (i.plan && i.plan.sender !== i.svmWalletAddress) return fail(1, 'chain_mismatch', 'plan.sender != wallet')
    if (i.plan && byEid(i.plan.srcEid)?.vm !== 'svm') return fail(1, 'chain_mismatch', `plan.srcEid ${i.plan.srcEid}`)
    return ok(1)
  }
  if (i.walletAddress === undefined || i.walletChainId === undefined) return fail(1, 'wallet_not_connected')
  if (i.walletChainId !== i.srcChainId) return fail(1, 'chain_mismatch', `${i.walletChainId} != ${i.srcChainId}`)
  const src = byChainId(i.srcChainId)
  if (!src) return fail(1, 'chain_mismatch', `unknown chainId ${i.srcChainId}`)
  if (i.plan && i.plan.srcEid !== src.eid) return fail(1, 'chain_mismatch', `plan.srcEid ${i.plan.srcEid} != ${src.eid}`)
  // refundAddress is plan.sender: it must be the wallet that signs, or the refund goes to someone else.
  if (i.plan && !sameAddress(i.plan.sender, i.walletAddress)) return fail(1, 'chain_mismatch', 'plan.sender != wallet')
  return ok(1)
}

// 2. probeOft succeeded, peers(dstEid) != 0
export function g2Peer(i: GuardInput): GuardResult {
  if (!i.info) return fail(2, 'oft_missing')
  if (!i.plan) return fail(2, 'plan_missing')
  if (!samePlanOft(i.plan, i.info)) return fail(2, 'oft_missing', 'plan.oft != info.oft')
  const route = i.info.routes.find((r) => r.eid === i.plan!.dstEid)
  if (!route || isZeroBytes32(route.peer)) return fail(2, 'peer_missing', `eid ${i.plan.dstEid}`)
  return ok(2)
}

// 3. recipient valid (bytes32); custom recipient requires explicit confirmation
export function g3Recipient(i: GuardInput): GuardResult {
  if (!i.plan) return fail(3, 'plan_missing')
  if (!isBytes32(i.plan.recipient)) return fail(3, 'recipient_invalid')
  // From Solana the recipient is an EVM address: it can never be "my wallet", so it is always custom.
  // No wallet to compare against counts as "differs": this guard must not depend on guard 1 having
  // already failed to be safe. NTT and CCIP write the same line the same way.
  const differsFromWallet =
    i.plan.vm === 'svm' || i.walletAddress === undefined || !sameAddress(i.plan.recipient, addressToBytes32(i.walletAddress))
  if (differsFromWallet) {
    // Recipient differs from wallet: must be flagged as custom AND confirmed. The tail is owed
    // BEFORE the twin is noted: a look-alike is a note for the indicator, and a note must never
    // lift the one input that is still required.
    if (!i.recipientIsCustom || !i.customRecipientConfirmed) return fail(3, 'recipient_unconfirmed')
  }
  // A look-alike of a saved address: the shape of an address swap, said in red (core/indicator.ts).
  if (i.recipientLookalike) return fail(3, 'recipient_lookalike')
  return ok(3)
}

// 4. recipient != 0 and not token/oft/endpoint (compared in bytes32 form)
export function g4RecipientNotContract(i: GuardInput): GuardResult {
  if (!i.plan) return fail(4, 'plan_missing')
  if (!i.info) return fail(4, 'oft_missing')
  const r = i.plan.recipient
  if (isZeroBytes32(r)) return fail(4, 'recipient_zero')
  if (i.info.vm === 'evm') {
    for (const c of [i.info.token, i.info.oft, i.info.endpoint]) {
      if (sameAddress(r, addressToBytes32(c))) return fail(4, 'recipient_is_contract', c)
    }
  }
  // The destination-side OFT itself (the peer) is a contract on every VM.
  const route = i.info.routes.find((x) => x.eid === i.plan!.dstEid)
  if (route && sameAddress(r, route.peer)) return fail(4, 'recipient_is_contract', route.peer)
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

// 6. the minimum is at most 5% below what the contract quotes it delivers; everything aligned to the rate
export function g6MinAmount(i: GuardInput): GuardResult {
  if (!i.plan) return fail(6, 'plan_missing')
  if (!i.info) return fail(6, 'oft_missing')
  const { amountLD, minAmountLD } = i.plan.amounts
  const { quote } = i.plan
  // The minimum is derived from the quoted receive (plan.ts), which an issuer fee makes smaller
  // than the sent amount and a bonus makes larger; with no quote it is derived from the amount.
  const delivered = quote.unavailable ? amountLD : quote.amountReceivedLD
  if (minAmountLD > (delivered > amountLD ? delivered : amountLD)) return fail(6, 'min_gt_amount')
  const rate = i.info.conversionRate
  if (rate <= 0n) return fail(6, 'not_multiple_of_rate', 'rate <= 0')
  // The plan's minimum is rounded DOWN to the shared-decimals step (plan.ts), so the floor it is
  // held against has to be rounded the same way: otherwise a legitimate 5% at an amount that is
  // not a multiple of the step would read as "more than 5%" and hold the button.
  if (minAmountLD < trimDust(applyBps(delivered, 10000 - MAX_SLIPPAGE_BPS), rate)) return fail(6, 'slippage_too_high')
  if (amountLD % rate !== 0n) return fail(6, 'not_multiple_of_rate', 'amountLD')
  if (minAmountLD % rate !== 0n) return fail(6, 'not_multiple_of_rate', 'minAmountLD')
  return ok(6)
}

// 7. fee.nativeFee === value, lzTokenFee === 0
export function g7Fee(i: GuardInput): GuardResult {
  if (!i.plan) return fail(7, 'plan_missing')
  const fee = planFee(i.plan)
  if (fee.nativeFee !== i.plan.value) return fail(7, 'fee_mismatch')
  if (fee.lzTokenFee !== 0n) return fail(7, 'lz_token_fee_nonzero')
  if (i.plan.value < i.plan.quote.nativeFee) return fail(7, 'fee_mismatch', 'value < quoted nativeFee')
  return ok(7)
}

// 8. value + gas <= native balance
export function g8Native(i: GuardInput): GuardResult {
  if (!i.plan) return fail(8, 'plan_missing')
  if (i.nativeBalance === undefined) return fail(8, 'native_balance_unknown')
  // The fee alone already settles it: say so instead of waiting for a gas estimate that will never
  // arrive (the simulation an unaffordable fee makes fail is what produces the estimate).
  if (i.plan.value > i.nativeBalance) return fail(8, 'insufficient_native', `${i.plan.value} > ${i.nativeBalance}`)
  // A simulation that has already failed produces no estimate, ever: waiting for one would hold
  // the button forever behind a note. The fee fits; the gas is what the wallet will price.
  if (i.gasCostWei === undefined) return i.simulation && !i.simulation.ok ? ok(8) : fail(8, 'native_balance_unknown')
  const need = i.plan.value + i.gasCostWei
  if (need > i.nativeBalance) return fail(8, 'insufficient_native', `${need} > ${i.nativeBalance}`)
  return ok(8)
}

// 9. the contract's quote: amount within its limits, receive not below the minimum, and the issuer's
//    fee said at its size. The fee notes never hold the button (CLAUDE.md rule 2): the contract keeps
//    what it keeps, the indicator shows it, the person decides.
export function g9Quote(i: GuardInput): GuardResult {
  if (!i.plan) return fail(9, 'plan_missing')
  const { quote, amounts } = i.plan
  if (quote.unavailable) return fail(9, 'oft_fee_unknown', quote.unavailable)
  if (amounts.amountLD < quote.limitMinLD || amounts.amountLD > quote.limitMaxLD) {
    return fail(9, 'amount_out_of_limits', `[${quote.limitMinLD}, ${quote.limitMaxLD}]`)
  }
  if (quote.amountReceivedLD < amounts.minAmountLD) {
    return fail(9, 'received_lt_min', `${quote.amountReceivedLD} < ${amounts.minAmountLD}`)
  }
  const fee = issuerFee(quote)
  const detail = `${fee.feeLD} (${formatBps(fee.feeBps)})`
  switch (classifyFee(fee.feeBps)) {
    case 'extreme':
      return fail(9, 'oft_fee_extreme', detail)
    case 'high':
      return fail(9, 'oft_fee_high', detail)
    case 'notice':
      return fail(9, 'oft_fee_notice', detail)
    default:
      return ok(9)
  }
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
  if (i.approveIntent && (i.info.vm !== 'evm' || !sameAddress(i.approveIntent.spender, i.info.oft))) {
    return fail(12, 'approve_wrong_spender', i.approveIntent.spender)
  }
  return ok(12)
}

// 13. the send simulation (done in the RPC layer) succeeded
export function g13Simulation(i: GuardInput): GuardResult {
  if (!i.simulation) return fail(13, 'simulation_missing')
  if (!i.simulation.ok) return fail(13, 'simulation_failed', i.simulation.reason)
  // A run that succeeds but takes more than the plan says is not a success: it is a program doing
  // something the screen does not show, and that is a block, not a colour.
  if (i.svmDebit && !i.svmDebit.ok) return fail(13, 'debit_mismatch', i.svmDebit.reason)
  return ok(13)
}

// 14. self-check: our own calldata decodes back to the plan
export function g14SelfCheck(i: GuardInput): GuardResult {
  if (!i.selfCheck) return fail(14, 'selfcheck_missing')
  if (!i.selfCheck.ok) return fail(14, 'selfcheck_failed', i.selfCheck.mismatches.join(', '))
  return ok(14)
}

/** True when neither enforced nor extra options carry executor gas / compute units (§6.15). */
export function needsNoGasConfirmation(info: SourceInfo | undefined, plan: SendPlan | undefined): boolean {
  if (!info || !plan) return false
  const enforced: Hex = info.enforced[plan.dstEid] ?? '0x'
  return receiveTotals(enforced).gas + receiveTotals(plan.extraOptions).gas === 0n
}

// 15. no executor gas -> a note for the indicator: the message may sit undelivered until someone
//     pays for its execution. Said more loudly for Solana, where a stuck message cannot simply be
//     retried. The person decides (CLAUDE.md rule 2).
export function g15ExecutorGas(i: GuardInput): GuardResult {
  if (!i.plan) return fail(15, 'plan_missing')
  if (!i.info) return fail(15, 'oft_missing')
  if (!needsNoGasConfirmation(i.info, i.plan)) return ok(15)
  if (byEid(i.plan.dstEid)?.vm === 'svm') return fail(15, 'no_executor_options_svm')
  return fail(15, 'no_executor_gas')
}

/** inspectEnforcedOptions() risks, as the flags the review screen already knows how to print. */
const ENFORCED_FLAG: Record<EnforcedRisk, SuspiciousFlag> = {
  native_drop: 'enforced_native_drop',
  compose: 'enforced_compose',
  over_cap: 'enforced_over_cap',
  malformed: 'enforced_malformed',
}

/**
 * §6.21 The options the CONTRACT enforces for this destination, decoded.
 *
 * Guard 18 covers `extraOptions`, which this app builds itself. These are the other half: the OFT
 * appends them to every send and the sender pays for them, so an enforced `nativeDrop` quietly
 * routes native coin to a fixed address on each transfer. Warnings only — a legitimate OFT may
 * enforce something unexpected, and refusing a route that works would be the worse failure.
 */
export function enforcedOptionFlags(i: GuardInput): SuspiciousFlag[] {
  if (!i.info || !i.plan) return []
  const dstVm = byEid(i.plan.dstEid)?.vm ?? 'evm'
  return inspectEnforcedOptions(i.info.enforced[i.plan.dstEid] ?? '0x', dstVm).map((r) => ENFORCED_FLAG[r])
}

// 16. suspicious flags: never block, always surface
export function g16Suspicious(i: GuardInput): { result: GuardResult; warnings: SuspiciousFlag[] } {
  const warnings = [...i.flags]
  for (const f of enforcedOptionFlags(i)) if (!warnings.includes(f)) warnings.push(f)
  return { result: ok(16), warnings }
}

// 17. the destination peer names our OFT as its peer (defeats look-alike / fake adapters)
export function g17PeerBack(i: GuardInput): GuardResult {
  if (!i.plan) return fail(17, 'plan_missing')
  if (!i.peerBack) return fail(17, 'peer_back_unknown')
  if (i.peerBack.status === 'mismatch') return fail(17, 'peer_back_mismatch', i.peerBack.theirPeer)
  if (i.peerBack.status === 'unavailable') return fail(17, 'peer_back_unavailable', i.peerBack.reason)
  return ok(17)
}

// 18. extraOptions never carry calls or over-cap value (nativeDrop / compose / receive beyond the VM caps)
export function g18Options(i: GuardInput): GuardResult {
  if (!i.plan) return fail(18, 'plan_missing')
  if (hasDangerousOptions(i.plan.extraOptions, byEid(i.plan.dstEid)?.vm ?? 'evm')) return fail(18, 'dangerous_options')
  return ok(18)
}

// 19. recipient was built for the destination's VM; on Solana it must be a wallet, not a token account
export function g19RecipientVm(i: GuardInput): GuardResult {
  if (!i.plan) return fail(19, 'plan_missing')
  const dst = byEid(i.plan.dstEid)
  if (!dst) return fail(19, 'peer_missing', `eid ${i.plan.dstEid}`)
  if (i.plan.recipientVm !== dst.vm) return fail(19, 'recipient_vm_mismatch', `${i.plan.recipientVm} → ${dst.vm}`)
  if (dst.vm === 'svm') {
    // Nothing to classify against: the store's layout is unknown, so there is no mint to derive
    // the recipient's token account from. The user is warned instead.
    if (i.svmDestinationRecognised === false) return ok(19)
    const cls = i.svmRecipientClass
    if (cls === undefined) return fail(19, 'recipient_class_unknown')
    if (cls === 'token_account') return fail(19, 'recipient_token_account')
    if (cls === 'program_owned') return fail(19, 'recipient_pda')
  }
  return ok(19)
}

// 20. Solana destination: the on-chain discovery (program, mint, token program, PeerConfig) must
//     have completed — the plan's options and recipient checks depend on it.
export function g20SvmSend(i: GuardInput): GuardResult {
  if (!i.plan) return fail(20, 'plan_missing')
  const dst = byEid(i.plan.dstEid)
  if (dst?.vm === 'svm' && !i.svmDestinationKnown) return fail(20, 'svm_dest_unknown')
  return ok(20)
}

/**
 * True when the value this plan commits to exceeds the source chain's ceiling (core/chains.ts).
 * `value` rather than `quote.nativeFee`, because `value` is the number that actually leaves the
 * wallet once the fee buffer is applied.
 */
export function feeAboveCeiling(plan: SendPlan | undefined): boolean {
  if (!plan) return false
  const src = byEid(plan.srcEid)
  return !!src && aboveFeeCeiling(src.key, plan.value)
}

// 21. the fee is within the chain's ceiling. Nothing off-chain can verify a quote, so this is the
//     only bound on it that is not "the whole balance" (guard 8). A note, never a refusal: fees
//     are genuinely volatile, and the number is on screen.
export function g21FeeCeiling(i: GuardInput): GuardResult {
  if (!i.plan) return fail(21, 'plan_missing')
  if (!feeAboveCeiling(i.plan)) return ok(21)
  return fail(21, 'fee_above_ceiling', `${i.plan.value}`)
}

/** True when §4's risk indicator has a runner for this route: both ends EVM. */
export function riskCovers(i: GuardInput): boolean {
  if (!i.plan) return false
  if (i.plan.vm !== 'evm') return false
  return byEid(i.plan.dstEid)?.vm === 'evm'
}

/**
 * §4, guard 22: the route's verdict, carried as a note.
 *
 * It decides nothing about the amount and holds nothing. The indicator reads the verdict's own
 * reasons (core/indicator.ts); this guard only makes the verdict part of the report, so the list
 * of checks shows it and a screen cannot forget to ask for it.
 *
 * Routes the indicator has no runner for (a Solana source or destination) pass silently: there is
 * no verdict to report, and guards 1-21 are the whole rule there.
 */
export function g22Risk(i: GuardInput): GuardResult {
  if (!i.plan) return fail(22, 'plan_missing')
  // The indicator covers EVM-to-EVM LayerZero routes. A Solana source or destination has no runner
  // yet — §4 scoped itself to v1 and V2 on EVM — so there is no verdict to enforce and guards 1–21
  // are the whole rule there, exactly as they were before this guard existed. Stated as a boundary
  // rather than left as an accident: the day a Solana runner lands, this line is what changes.
  if (!riskCovers(i)) return ok(22)
  if (!i.risk) return i.riskError ? fail(22, 'risk_unavailable', i.riskError) : fail(22, 'risk_unknown')
  const code = riskWarningCode(i.risk)
  return code ? fail(22, code) : ok(22)
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
    g19RecipientVm(i),
    g20SvmSend(i),
    g21FeeCeiling(i),
    g22Risk(i),
  ]
  return { results, warnings: g16.warnings, ...verdictOf(results) }
}

/**
 * The approve this app is allowed to send, or null. Amount is EXACTLY amountLD;
 * spender is EXACTLY info.oft. Unlimited approve does not exist in this codebase.
 */
export function approvePlan(info: SourceInfo, plan: SendPlan, allowance: bigint | undefined): ApproveIntent | null {
  if (!info.approvalRequired || info.vm !== 'evm') return null
  if (allowance !== undefined && allowance >= plan.amounts.amountLD) return null
  return { spender: info.oft, amount: plan.amounts.amountLD }
}

/**
 * §6.14: decode our own `send` calldata and compare every field with the plan.
 */
export function selfCheck(plan: EvmSendPlan, calldata: Hex): SelfCheckResult {
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
