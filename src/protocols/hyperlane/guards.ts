/**
 * The invariants a Hyperlane transfer must satisfy before anything is signed.
 *
 * The approve spender is the ROUTER — the pasted contract, after discover.ts has held it against
 * the registry Mailbox (chains.ts) — and only on a collateral route: a synthetic route burns from
 * the sender's own balance, a native route takes the coin from msg.value, and an approve to either
 * would be an allowance for nothing (`approve_forbidden`, the same rule guard 11 applies to an OFT
 * that answers `approvalRequired() == false`). The approve is for exactly the CHARGE — the amount
 * plus the route's own fee — because that is what `_calculateFeesAndCharge` pulls (plan.ts).
 *
 * Blocks and notes follow core/severity.ts: a failed check holds the button only when the
 * transaction is impossible or the app would be building something malformed. A far side that
 * does not point back, or names a mailbox other than the registry's, is said in red and holds
 * nothing (CLAUDE.md rule 2).
 */
import { isAddressEqual, type Address } from 'viem'
import { aboveFeeCeiling, type ChainKey } from '../../core/chains'
import { classifyFee } from '../../core/oftFee'
import { verdictOf } from '../../core/severity'
import { hyperlaneConfig } from './chains'
import type { RemoteWarp, WarpRouter } from './discover'
import { routeFeeBps, type HyperlanePlan } from './plan'

export type HyperlaneGuardCode =
  | 'wallet_not_connected'
  | 'chain_mismatch'
  | 'plan_missing'
  | 'route_unsupported'
  | 'route_missing'
  | 'recipient_invalid'
  | 'recipient_unconfirmed'
  | 'recipient_lookalike'
  | 'recipient_zero'
  | 'recipient_is_contract'
  | 'amount_zero'
  | 'amount_rounds_to_zero'
  | 'balance_unknown'
  | 'insufficient_balance'
  | 'peer_back_unknown'
  | 'peer_back_unavailable'
  | 'peer_back_mismatch'
  | 'peer_foreign_mailbox'
  | 'fee_mismatch'
  | 'native_balance_unknown'
  | 'insufficient_native'
  | 'allowance_unknown'
  | 'needs_approve'
  | 'approve_amount_mismatch'
  | 'approve_wrong_spender'
  | 'approve_forbidden'
  | 'route_fee_notice'
  | 'route_fee_high'
  | 'route_fee_extreme'
  | 'simulation_missing'
  | 'simulation_failed'
  | 'simulation_unavailable'
  | 'selfcheck_missing'
  | 'selfcheck_failed'
  | 'fee_above_ceiling'

export const HYPERLANE_PENDING: ReadonlySet<HyperlaneGuardCode> = new Set<HyperlaneGuardCode>([
  'plan_missing',
  'balance_unknown',
  'native_balance_unknown',
  'allowance_unknown',
  'peer_back_unknown',
  'simulation_missing',
  'selfcheck_missing',
])

export type HyperlaneGuardResult = { id: number; ok: true } | { id: number; ok: false; code: HyperlaneGuardCode; detail?: string }

export function isHyperlanePending(r: HyperlaneGuardResult): boolean {
  return !r.ok && HYPERLANE_PENDING.has(r.code)
}

export type HyperlaneApproveIntent = { token: Address; spender: Address; amount: bigint }

export type HyperlaneSimulation = { ok: true } | { ok: false; reason: string; unavailable?: boolean }

export type HyperlaneGuardInput = {
  walletAddress: Address | undefined
  walletChainId: number | undefined
  srcChainId: number
  srcChain: ChainKey
  plan: HyperlanePlan | undefined
  /** The far side as read on its own chain; undefined while it is still being read. */
  remote: RemoteWarp | undefined
  recipientIsCustom: boolean
  customRecipientConfirmed: boolean
  /**
   * §Address book: the recipient shares its first four and last four characters with a SAVED
   * address but is not that address. A note for the indicator, never a hold.
   */
  recipientLookalike?: boolean | undefined
  /** The ERC-20 balance; unused on a native route, whose balance is `nativeBalance`. */
  tokenBalance: bigint | undefined
  nativeBalance: bigint | undefined
  /** The allowance to the router; unused on a synthetic or native route. */
  allowance: bigint | undefined
  gasCostWei: bigint | undefined
  approveIntent?: HyperlaneApproveIntent | undefined
  simulation: HyperlaneSimulation | undefined
  selfCheck: { ok: true } | { ok: false; mismatches: string[] } | undefined
}

export type HyperlaneGuardReport = {
  /** Failures that hold the button, plus reads still in flight (core/severity.ts). */
  blocks: HyperlaneGuardResult[]
  /** Failures that colour the route indicator and hold nothing. */
  notes: HyperlaneGuardResult[]
  results: HyperlaneGuardResult[]
  canSend: boolean
}

const ok = (id: number): HyperlaneGuardResult => ({ id, ok: true })
const fail = (id: number, code: HyperlaneGuardCode, detail?: string): HyperlaneGuardResult =>
  detail === undefined ? { id, ok: false, code } : { id, ok: false, code, detail }

const ZERO = /^0x0{40}$/

// 1. the wallet is on the chain we are sending from
export function h1Chain(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (i.walletAddress === undefined || i.walletChainId === undefined) return fail(1, 'wallet_not_connected')
  if (i.walletChainId !== i.srcChainId) return fail(1, 'chain_mismatch', `${i.walletChainId} != ${i.srcChainId}`)
  if (i.plan && !isAddressEqual(i.plan.sender, i.walletAddress)) return fail(1, 'chain_mismatch', 'plan.sender != wallet')
  return ok(1)
}

// 2. both chains are in the config, the plan's domain and mailbox are the registry's, and the
//    router names a far router for the destination
export function h2Route(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(2, 'plan_missing')
  const cfg = hyperlaneConfig(i.plan.chain)
  const dstCfg = hyperlaneConfig(i.plan.dst.chain)
  if (!cfg || !dstCfg) return fail(2, 'route_unsupported', `${i.plan.chain} -> ${i.plan.dst.chain}`)
  if (dstCfg.domain !== i.plan.dst.domain) return fail(2, 'route_unsupported', 'domain does not match the config')
  if (!isAddressEqual(i.plan.mailbox, cfg.mailbox as Address)) return fail(2, 'route_unsupported', 'mailbox is not the registry one')
  if (ZERO.test(i.plan.dst.router)) return fail(2, 'route_missing', i.plan.dst.chain)
  return ok(2)
}

// 3. recipient valid; anything other than the connected wallet must be confirmed
export function h3Recipient(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(3, 'plan_missing')
  const r = i.plan.recipient
  if (!/^0x[0-9a-fA-F]{40}$/.test(r)) return fail(3, 'recipient_invalid')
  // The encoding the far side reads must be this address, left-padded — nothing else.
  if (i.plan.recipientBytes32.toLowerCase() !== `0x${'0'.repeat(24)}${r.slice(2).toLowerCase()}`) return fail(3, 'recipient_invalid', 'bytes32 encoding')
  const differs = i.walletAddress === undefined || !isAddressEqual(r, i.walletAddress)
  // The tail is owed BEFORE the twin is noted: a look-alike is a note for the indicator, and a
  // note must never lift the one input that is still required.
  if (differs && (!i.recipientIsCustom || !i.customRecipientConfirmed)) return fail(3, 'recipient_unconfirmed')
  if (i.recipientLookalike) return fail(3, 'recipient_lookalike')
  return ok(3)
}

// 4. recipient is not zero and not one of the contracts in play, on either side
export function h4RecipientNotContract(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(4, 'plan_missing')
  const r = i.plan.recipient
  if (ZERO.test(r)) return fail(4, 'recipient_zero')
  const contracts: (Address | undefined)[] = [i.plan.router, i.plan.token, i.plan.mailbox, i.plan.dst.router, i.plan.dst.token]
  for (const c of contracts) {
    if (c && isAddressEqual(r, c)) return fail(4, 'recipient_is_contract', c)
  }
  return ok(4)
}

// 5. amount > 0, survives both scales, and the wallet holds the CHARGE (amount + route fee)
export function h5Amount(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(5, 'plan_missing')
  if (i.plan.amount <= 0n) return fail(5, 'amount_zero')
  if (i.plan.messageAmount <= 0n || i.plan.received <= 0n) return fail(5, 'amount_rounds_to_zero')
  const balance = i.plan.warpKind === 'native' ? i.nativeBalance : i.tokenBalance
  if (balance === undefined) return fail(5, 'balance_unknown')
  if (i.plan.charge > balance) return fail(5, 'insufficient_balance', `${i.plan.charge} > ${balance}`)
  return ok(5)
}

// 6. the far router, read on its own chain, names the registry mailbox and points back here.
//    Red notes, never holds: the route is the deployer's to misconfigure, and the person decides.
export function h6PeerBack(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(6, 'plan_missing')
  if (i.remote === undefined) return fail(6, 'peer_back_unknown')
  if (!i.remote.readable) return fail(6, 'peer_back_unavailable')
  if (!isAddressEqual(i.remote.router, i.plan.dst.router)) return fail(6, 'peer_back_unknown')
  if (i.remote.mailboxOk === false) return fail(6, 'peer_foreign_mailbox', i.remote.router)
  if (i.remote.pointsBack === false) return fail(6, 'peer_back_mismatch', i.remote.router)
  if (i.remote.mailboxOk === undefined || i.remote.pointsBack === undefined) return fail(6, 'peer_back_unavailable')
  return ok(6)
}

// 7. msg.value is EXACTLY the fee, plus the charge on a native route — never a buffer
export function h7Fee(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(7, 'plan_missing')
  const expected = i.plan.warpKind === 'native' ? i.plan.fee + i.plan.charge : i.plan.fee
  if (i.plan.value !== expected) return fail(7, 'fee_mismatch', `${i.plan.value} != ${expected}`)
  return ok(7)
}

// 8. native balance covers value + gas
export function h8Native(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(8, 'plan_missing')
  if (i.nativeBalance === undefined) return fail(8, 'native_balance_unknown')
  if (i.plan.value > i.nativeBalance) return fail(8, 'insufficient_native', `${i.plan.value} > ${i.nativeBalance}`)
  // A simulation that has already failed produces no estimate, ever: waiting for one would hold
  // the button forever behind a note. The fee fits; the gas is what the wallet will price.
  if (i.gasCostWei === undefined) return i.simulation && !i.simulation.ok ? ok(8) : fail(8, 'native_balance_unknown')
  if (i.plan.value + i.gasCostWei > i.nativeBalance) return fail(8, 'insufficient_native')
  return ok(8)
}

// 9. allowance to the router for the charge — on a collateral route only
export function h9Allowance(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(9, 'plan_missing')
  if (i.plan.warpKind !== 'collateral') return ok(9)
  if (i.allowance === undefined) return fail(9, 'allowance_unknown')
  if (i.allowance < i.plan.charge) {
    if (i.approveIntent && i.approveIntent.amount !== i.plan.charge) {
      return fail(9, 'approve_amount_mismatch', `${i.approveIntent.amount} != ${i.plan.charge}`)
    }
    return fail(9, 'needs_approve')
  }
  return ok(9)
}

// 10. the approve names the router, the right token and exactly the charge — and exists only on a
//     collateral route
export function h10Spender(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.approveIntent) return ok(10)
  if (!i.plan) return fail(10, 'plan_missing')
  if (i.plan.warpKind !== 'collateral' || !i.plan.token) return fail(10, 'approve_forbidden', i.plan.warpKind)
  const intent = i.approveIntent
  if (!isAddressEqual(intent.spender, i.plan.router)) return fail(10, 'approve_wrong_spender', intent.spender)
  if (!isAddressEqual(intent.token, i.plan.token)) return fail(10, 'approve_wrong_spender', intent.token)
  if (intent.amount !== i.plan.charge) return fail(10, 'approve_amount_mismatch', intent.amount.toString())
  return ok(10)
}

// 11. the route's own fee, said at its size (core/oftFee.ts thresholds): a note, never a hold
export function h11RouteFee(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(11, 'plan_missing')
  const bps = routeFeeBps(i.plan)
  const cls = classifyFee(bps)
  const detail = `${i.plan.routeFee} (${bps} bps)`
  if (cls === 'notice') return fail(11, 'route_fee_notice', detail)
  if (cls === 'high') return fail(11, 'route_fee_high', detail)
  if (cls === 'extreme') return fail(11, 'route_fee_extreme', detail)
  return ok(11)
}

// 12. the simulation passed. A provider that could not run it is "not checked", not "fails".
export function h12Simulation(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.simulation) return fail(12, 'simulation_missing')
  if (i.simulation.ok) return ok(12)
  return i.simulation.unavailable ? fail(12, 'simulation_unavailable', i.simulation.reason) : fail(12, 'simulation_failed', i.simulation.reason)
}

// 13. our own calldata decodes back to the plan
export function h13SelfCheck(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.selfCheck) return fail(13, 'selfcheck_missing')
  return i.selfCheck.ok ? ok(13) : fail(13, 'selfcheck_failed', i.selfCheck.mismatches.join(', '))
}

/** True when the dispatch fee exceeds the source chain's ceiling (core/chains.ts). */
export function hyperlaneFeeAboveCeiling(plan: HyperlanePlan | undefined): boolean {
  return !!plan && aboveFeeCeiling(plan.chain, plan.fee)
}

// 14. the dispatch fee is within the chain's ceiling — the amount itself on a native route is not
//     a fee and does not count. A note for the indicator, never a refusal.
export function h14FeeCeiling(i: HyperlaneGuardInput): HyperlaneGuardResult {
  if (!i.plan) return fail(14, 'plan_missing')
  if (!hyperlaneFeeAboveCeiling(i.plan)) return ok(14)
  return fail(14, 'fee_above_ceiling', `${i.plan.fee}`)
}

export function runHyperlaneGuards(i: HyperlaneGuardInput): HyperlaneGuardReport {
  const results = [
    h1Chain(i), h2Route(i), h3Recipient(i), h4RecipientNotContract(i), h5Amount(i),
    h6PeerBack(i), h7Fee(i), h8Native(i), h9Allowance(i), h10Spender(i),
    h11RouteFee(i), h12Simulation(i), h13SelfCheck(i), h14FeeCeiling(i),
  ]
  return { results, ...verdictOf(results) }
}

/**
 * The approve this module is allowed to send, or null. Only a collateral route takes one; the
 * spender is the router the DISCOVERY verified against the registry Mailbox — re-checked here
 * against the plan, so a plan carrying some other router cannot turn into an approve.
 */
export function hyperlaneApprovePlan(router: WarpRouter | undefined, plan: HyperlanePlan | undefined, allowance: bigint | undefined): HyperlaneApproveIntent | null {
  if (!router || !plan) return null
  if (router.warpKind !== 'collateral' || !router.token || !plan.token) return null
  if (!isAddressEqual(router.router, plan.router) || !isAddressEqual(router.token, plan.token)) return null
  if (allowance !== undefined && allowance >= plan.charge) return null
  return { token: router.token, spender: router.router, amount: plan.charge }
}
