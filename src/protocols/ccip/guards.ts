/**
 * §Task 6: the invariants a CCIP transfer must satisfy before anything is signed.
 *
 * The approve spender is the ROUTER, and the router only ever comes from src/protocols/ccip/chains.ts
 * — never from the pool, never from the token, never from anything a user typed. Guard 9 checks
 * that at the moment of use, not at the moment of rendering.
 */
import { isAddressEqual, type Address } from 'viem'
import type { ChainKey } from '../../core/chains'
import { ccipConfig } from './chains'
import type { CcipPlan } from './plan'
import { scaleAmount } from './plan'

export type CcipGuardCode =
  | 'wallet_not_connected'
  | 'chain_mismatch'
  | 'plan_missing'
  | 'route_unsupported'
  | 'recipient_invalid'
  | 'recipient_unconfirmed'
  | 'recipient_zero'
  | 'recipient_is_contract'
  | 'amount_zero'
  | 'amount_rounds_to_zero'
  | 'balance_unknown'
  | 'insufficient_balance'
  | 'outbound_limit_unknown'
  | 'over_outbound_capacity'
  | 'inbound_limit_unknown'
  | 'over_inbound_capacity'
  | 'fee_mismatch'
  | 'native_balance_unknown'
  | 'insufficient_native'
  | 'allowance_unknown'
  | 'needs_approve'
  | 'approve_amount_mismatch'
  | 'approve_wrong_spender'
  | 'message_not_plain'
  | 'simulation_missing'
  | 'simulation_failed'
  | 'selfcheck_missing'
  | 'selfcheck_failed'

export const CCIP_PENDING: ReadonlySet<CcipGuardCode> = new Set<CcipGuardCode>([
  'plan_missing',
  'balance_unknown',
  'native_balance_unknown',
  'allowance_unknown',
  'outbound_limit_unknown',
  'inbound_limit_unknown',
  'simulation_missing',
  'selfcheck_missing',
])

export type CcipGuardResult = { id: number; ok: true } | { id: number; ok: false; code: CcipGuardCode; detail?: string }

export function isCcipPending(r: CcipGuardResult): boolean {
  return !r.ok && CCIP_PENDING.has(r.code)
}

export type CcipApproveIntent = { token: Address; spender: Address; amount: bigint }

export type CcipGuardInput = {
  walletAddress: Address | undefined
  walletChainId: number | undefined
  srcChainId: number
  srcChain: ChainKey
  plan: CcipPlan | undefined
  recipientIsCustom: boolean
  customRecipientConfirmed: boolean
  tokenBalance: bigint | undefined
  nativeBalance: bigint | undefined
  allowance: bigint | undefined
  gasCostWei: bigint | undefined
  approveIntent?: CcipApproveIntent | undefined
  simulation: { ok: true } | { ok: false; reason: string } | undefined
  selfCheck: { ok: true } | { ok: false; mismatches: string[] } | undefined
}

export type CcipGuardReport = { results: CcipGuardResult[]; canSend: boolean }

const ok = (id: number): CcipGuardResult => ({ id, ok: true })
const fail = (id: number, code: CcipGuardCode, detail?: string): CcipGuardResult =>
  detail === undefined ? { id, ok: false, code } : { id, ok: false, code, detail }

// 1. the wallet is on the chain we are sending from
export function c1Chain(i: CcipGuardInput): CcipGuardResult {
  if (i.walletAddress === undefined || i.walletChainId === undefined) return fail(1, 'wallet_not_connected')
  if (i.walletChainId !== i.srcChainId) return fail(1, 'chain_mismatch', `${i.walletChainId} != ${i.srcChainId}`)
  return ok(1)
}

// 2. the route exists in the config and the plan agrees with it
export function c2Route(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(2, 'plan_missing')
  const cfg = ccipConfig(i.plan.chain)
  const dstCfg = ccipConfig(i.plan.dst.chain)
  if (!cfg || !dstCfg) return fail(2, 'route_unsupported', `${i.plan.chain} -> ${i.plan.dst.chain}`)
  if (dstCfg.selector !== i.plan.dst.selector) return fail(2, 'route_unsupported', 'selector does not match the config')
  if (!isAddressEqual(i.plan.router, cfg.router as Address)) return fail(2, 'route_unsupported', 'router is not the configured one')
  return ok(2)
}

// 3. recipient valid; anything other than the connected wallet must be confirmed
export function c3Recipient(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(3, 'plan_missing')
  const r = i.plan.recipient
  if (!/^0x[0-9a-fA-F]{40}$/.test(r)) return fail(3, 'recipient_invalid')
  const differs = i.walletAddress === undefined || !isAddressEqual(r, i.walletAddress)
  if (differs && (!i.recipientIsCustom || !i.customRecipientConfirmed)) return fail(3, 'recipient_unconfirmed')
  return ok(3)
}

// 4. recipient is not zero and not one of the contracts in play
export function c4RecipientNotContract(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(4, 'plan_missing')
  const r = i.plan.recipient
  if (/^0x0{40}$/.test(r)) return fail(4, 'recipient_zero')
  for (const c of [i.plan.router, i.plan.token, i.plan.pool]) {
    if (isAddressEqual(r, c)) return fail(4, 'recipient_is_contract', c)
  }
  return ok(4)
}

// 5. amount > 0, covered by the balance, and still non-zero after the decimal shift
export function c5Amount(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(5, 'plan_missing')
  if (i.plan.amount <= 0n) return fail(5, 'amount_zero')
  // A token with fewer decimals on the other side can round a small amount away entirely.
  if (i.plan.dst.decimals !== undefined && i.plan.received <= 0n) return fail(5, 'amount_rounds_to_zero')
  if (i.tokenBalance === undefined) return fail(5, 'balance_unknown')
  if (i.plan.amount > i.tokenBalance) return fail(5, 'insufficient_balance', `${i.plan.amount} > ${i.tokenBalance}`)
  return ok(5)
}

// 6. the pool's rate limits, both directions
export function c6RateLimits(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(6, 'plan_missing')
  if (i.plan.outbound === undefined) return fail(6, 'outbound_limit_unknown')
  if (i.plan.outbound.isEnabled && i.plan.amount > i.plan.outbound.tokens) {
    return fail(6, 'over_outbound_capacity', i.plan.outbound.tokens.toString())
  }
  if (i.plan.dst.pool === undefined) {
    // No pool on the other side to ask: the inbound limit is unknown, which blocks.
    return fail(6, 'inbound_limit_unknown')
  }
  if (i.plan.inbound === undefined) return fail(6, 'inbound_limit_unknown')
  if (i.plan.inbound.isEnabled) {
    // The inbound bucket counts the destination token's own units.
    const arriving = i.plan.dst.decimals === undefined ? i.plan.amount : scaleAmount(i.plan.amount, i.plan.decimals, i.plan.dst.decimals)
    if (arriving > i.plan.inbound.tokens) return fail(6, 'over_inbound_capacity', i.plan.inbound.tokens.toString())
  }
  return ok(6)
}

// 7. msg.value is EXACTLY the quoted fee — the router keeps any excess
export function c7Fee(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(7, 'plan_missing')
  if (i.plan.value !== i.plan.fee) return fail(7, 'fee_mismatch', `${i.plan.value} != ${i.plan.fee}`)
  return ok(7)
}

// 8. native balance covers value + gas
export function c8Native(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(8, 'plan_missing')
  if (i.nativeBalance === undefined) return fail(8, 'native_balance_unknown')
  if (i.plan.value > i.nativeBalance) return fail(8, 'insufficient_native', `${i.plan.value} > ${i.nativeBalance}`)
  if (i.gasCostWei === undefined) return fail(8, 'native_balance_unknown')
  if (i.plan.value + i.gasCostWei > i.nativeBalance) return fail(8, 'insufficient_native')
  return ok(8)
}

// 9. allowance to the ROUTER, and the approve may name nothing else
export function c9Allowance(i: CcipGuardInput): CcipGuardResult {
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

// 10. the spender is the configured router, for the exact amount, on the right token
export function c10Spender(i: CcipGuardInput): CcipGuardResult {
  if (!i.approveIntent) return ok(10)
  if (!i.plan) return fail(10, 'plan_missing')
  const cfg = ccipConfig(i.srcChain)
  if (!cfg) return fail(10, 'route_unsupported', i.srcChain)
  const intent = i.approveIntent
  if (!isAddressEqual(intent.spender, cfg.router as Address)) return fail(10, 'approve_wrong_spender', intent.spender)
  if (!isAddressEqual(intent.token, i.plan.token)) return fail(10, 'approve_wrong_spender', intent.token)
  if (intent.amount !== i.plan.amount) return fail(10, 'approve_amount_mismatch', intent.amount.toString())
  return ok(10)
}

// 11. the message is a plain token transfer: no data, no gas for a callback, one token
export function c11PlainMessage(i: CcipGuardInput): CcipGuardResult {
  if (!i.plan) return fail(11, 'plan_missing')
  const m = i.plan.message
  if (m.data !== '0x') return fail(11, 'message_not_plain', 'data is not empty')
  if (m.tokenAmounts.length !== 1) return fail(11, 'message_not_plain', `${m.tokenAmounts.length} token entries`)
  const only = m.tokenAmounts[0]
  if (!only || !isAddressEqual(only.token, i.plan.token) || only.amount !== i.plan.amount) return fail(11, 'message_not_plain', 'token entry')
  if (!/^0x0{40}$/.test(m.feeToken)) return fail(11, 'message_not_plain', 'fee token is not native')
  return ok(11)
}

// 12. the simulation passed
export function c12Simulation(i: CcipGuardInput): CcipGuardResult {
  if (!i.simulation) return fail(12, 'simulation_missing')
  return i.simulation.ok ? ok(12) : fail(12, 'simulation_failed', i.simulation.reason)
}

// 13. our own calldata decodes back to the plan
export function c13SelfCheck(i: CcipGuardInput): CcipGuardResult {
  if (!i.selfCheck) return fail(13, 'selfcheck_missing')
  return i.selfCheck.ok ? ok(13) : fail(13, 'selfcheck_failed', i.selfCheck.mismatches.join(', '))
}

export function runCcipGuards(i: CcipGuardInput): CcipGuardReport {
  const results = [
    c1Chain(i), c2Route(i), c3Recipient(i), c4RecipientNotContract(i), c5Amount(i),
    c6RateLimits(i), c7Fee(i), c8Native(i), c9Allowance(i), c10Spender(i),
    c11PlainMessage(i), c12Simulation(i), c13SelfCheck(i),
  ]
  return { results, canSend: results.every((r) => r.ok) }
}

/**
 * The approve this module is allowed to send, or null. The spender is ALWAYS the router from the
 * config — re-read here rather than taken from the plan, so a tampered plan cannot redirect it.
 */
export function ccipApprovePlan(srcChain: ChainKey, plan: CcipPlan | undefined, allowance: bigint | undefined): CcipApproveIntent | null {
  const cfg = ccipConfig(srcChain)
  if (!cfg || !plan) return null
  if (allowance !== undefined && allowance >= plan.amount) return null
  return { token: plan.token, spender: cfg.router as Address, amount: plan.amount }
}
