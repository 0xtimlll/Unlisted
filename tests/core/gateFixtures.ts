/**
 * One harness per protocol, so a rule about the gate can be asserted the same way on all four.
 *
 * Everything here is a stub or a pure builder: no client makes a request. Each harness knows how to
 * run its own guards over a fully valid snapshot with fields overridden, which recipients count as
 * "a contract in play", and how to break the snapshot so that a specific code fails.
 */
import { getAddress, pad, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { addressToBytes32, ZERO_ADDRESS } from '@/core/encoding'
import { runGuards, type GuardInput } from '@/core/guards'
import { evmRecipient } from '@/core/recipient'
import { runCcipGuards, type CcipGuardInput } from '@/protocols/ccip/guards'
import { buildCcipMessage, type CcipPlan } from '@/protocols/ccip/plan'
import { ccipConfig } from '@/protocols/ccip/chains'
import type { OftV1Info, V1Route } from '@/protocols/lz-v1/detect'
import { runV1Guards, type V1GuardInput } from '@/protocols/lz-v1/guards'
import { buildV1SendPlan, type V1SendPlan } from '@/protocols/lz-v1/plan'
import { assessRisk, CHECK_IDS, emptyRiskInput, type CheckId, type CheckState, type RouteRisk } from '@/protocols/lz-risk/risk'
import { receivedAmount, trimPlan } from '@/protocols/wormhole-ntt/amounts'
import { runNttGuards, type NttGuardInput } from '@/protocols/wormhole-ntt/guards'
import { NO_TRANSCEIVER_INSTRUCTIONS, type NttPlan } from '@/protocols/wormhole-ntt/plan'
import type { NttVerification } from '@/protocols/wormhole-ntt/verify'
import { goodInput as oftGoodInput, treadOftInfo, treadPlan, ENDPOINT_HYPER, TREAD_ADAPTER, TREAD_OFT, WALLET as OFT_WALLET } from './fixtures'

/** What every guard set's report has in common. */
export type AnyReport = {
  results: readonly ({ ok: true } | { ok: false; code: string })[]
  blocks: readonly ({ ok: true } | { ok: false; code: string })[]
  riskWarnings: readonly ({ ok: true } | { ok: false; code: string })[]
  warningsCleared: boolean
  canSend: boolean
}

export type Harness = {
  name: string
  /** The good snapshot run through this protocol's guards, with fields overridden. */
  run(over?: Record<string, unknown>): AnyReport
  /** Addresses a recipient must never equal: the contracts of this very route. */
  contractsInPlay: readonly { label: string; address: Address }[]
  /** An ordinary address that is none of them, typed by the user and confirmed. */
  recipientOverride(address: Address): Record<string, unknown>
  /** The wallet the snapshot signs with. */
  wallet: Address
  /** One override per code, each of which must make exactly that failure appear in `blocks`. */
  blockers: Record<string, () => Record<string, unknown>>
}

export const codesOf = (list: readonly ({ ok: true } | { ok: false; code: string })[]): string[] => list.flatMap((r) => (r.ok ? [] : [r.code]))

// ------------------------------------------------------------------ risk ----

export function riskOf(over: Partial<Parameters<typeof assessRisk>[0]> = {}, failing?: { id: CheckId; state: CheckState }): RouteRisk {
  const checks = {} as Record<CheckId, CheckState>
  for (const id of CHECK_IDS) checks[id] = { status: 'pass' }
  if (failing) checks[failing.id] = failing.state
  return assessRisk({ ...emptyRiskInput(), checks, history: { kind: 'delivered', days: 1 }, linkCrossChecked: true, ...over })
}

// ------------------------------------------------------------- OFT (V2) ----

const oftHarness = (): Harness => {
  const run = (over: Record<string, unknown> = {}): AnyReport => runGuards(oftGoodInput(over as Partial<GuardInput>))
  const info = treadOftInfo()
  return {
    name: 'OFT V2',
    run,
    wallet: OFT_WALLET,
    contractsInPlay: [
      { label: 'token', address: info.token },
      { label: 'endpoint', address: ENDPOINT_HYPER },
      { label: 'the peer', address: TREAD_ADAPTER },
    ],
    recipientOverride: (address) => ({ plan: treadPlan({ recipient: address }), recipientIsCustom: true, customRecipientConfirmed: true }),
    blockers: {
      wallet_not_connected: () => ({ walletAddress: undefined }),
      chain_mismatch: () => ({ walletChainId: 1 }),
      peer_missing: () => ({ info: treadOftInfo({ routes: [] }) }),
      recipient_zero: () => ({ plan: treadPlan({ recipient: ZERO_ADDRESS }), recipientIsCustom: true, customRecipientConfirmed: true }),
      recipient_unconfirmed: () => ({ plan: treadPlan({ recipient: getAddress('0x3333333333333333333333333333333333333333') }) }),
      recipient_lookalike: () => ({ recipientLookalike: true }),
      insufficient_balance: () => ({ tokenBalance: 0n }),
      insufficient_native: () => ({ nativeBalance: 0n }),
      fee_mismatch: () => ({ plan: treadPlan({ value: 1n }) }),
      selfcheck_failed: () => ({ selfCheck: { ok: false, mismatches: ['to'] } }),
      approve_forbidden: () => ({ approveIntent: { spender: TREAD_OFT, amount: 1n } }),
      needs_approve: () => ({ info: treadOftInfo({ approvalRequired: true }), allowance: 0n }),
      approve_amount_mismatch: () => ({
        info: treadOftInfo({ approvalRequired: true }),
        allowance: 0n,
        approveIntent: { spender: TREAD_OFT, amount: 1n },
      }),
      approve_wrong_spender: () => ({
        info: treadOftInfo({ approvalRequired: true }),
        allowance: 0n,
        approveIntent: { spender: getAddress('0x3333333333333333333333333333333333333333'), amount: treadPlan().amounts.amountLD },
      }),
    },
  }
}

// ---------------------------------------------------------------- v1 ----

const V1_WALLET = getAddress('0x1111111111111111111111111111111111111111')
const V1_OFT = getAddress('0x4444444444444444444444444444444444444444')
const V1_TOKEN = getAddress('0x5555555555555555555555555555555555555555')
const V1_ENDPOINT = getAddress('0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675')
const V1_REMOTE = getAddress('0x7777777777777777777777777777777777777777')
const V1_STRANGER = getAddress('0x3333333333333333333333333333333333333333')

function v1Route(over: Partial<V1Route> = {}): V1Route {
  return {
    key: 'arbitrum',
    v1ChainId: 110,
    trustedRemote: `0x${V1_REMOTE.slice(2)}${V1_OFT.slice(2)}`,
    remoteAddress: V1_REMOTE,
    minDstGas: 150_000n,
    ...over,
  }
}

function v1Info(over: Partial<OftV1Info> = {}): OftV1Info {
  return {
    vm: 'evm',
    protocol: 'lz-v1',
    standard: { wire: 'bytes32', kind: 'OFT' },
    chain: 'ethereum',
    srcV1ChainId: 101,
    oft: V1_OFT,
    token: V1_TOKEN,
    symbol: 'TEST',
    name: 'Test',
    decimals: 18,
    sharedDecimals: 6,
    conversionRate: 10n ** 12n,
    endpoint: V1_ENDPOINT,
    owner: V1_STRANGER,
    approvalRequired: false,
    useCustomAdapterParams: undefined,
    adapterParamsRequired: true,
    routes: [v1Route()],
    lockedInAdapter: undefined,
    feeProbed: true,
    ...over,
  }
}

const v1Stub = (): ReadClient =>
  ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'quoteOFTFee') return 0n
      if (functionName === 'estimateSendFee') return [10n ** 15n, 0n]
      throw new Error(`unexpected read: ${functionName}`)
    },
  }) as unknown as ReadClient

const v1Plan = (info: OftV1Info, recipient: Address = V1_WALLET, amount = '1'): Promise<V1SendPlan> =>
  buildV1SendPlan({ info, dstKey: 'arbitrum', amountInput: amount, sender: V1_WALLET, recipient: evmRecipient(recipient), client: v1Stub() })

async function v1Harness(): Promise<Harness> {
  const info = v1Info()
  const plan = await v1Plan(info)
  const base = (over: Record<string, unknown> = {}): V1GuardInput => ({
    walletAddress: V1_WALLET,
    walletChainId: 1,
    srcChainId: 1,
    info,
    plan,
    recipientIsCustom: false,
    customRecipientConfirmed: false,
    tokenBalance: 10n ** 24n,
    nativeBalance: 10n ** 18n,
    allowance: 0n,
    gasCostWei: 10n ** 14n,
    simulation: { status: 'ok', gas: 300_000n },
    selfCheck: { ok: true },
    flags: [],
    peerBack: { status: 'ok' },
    peerBackUnavailableAccepted: false,
    storedPayload: { status: 'clear' },
    storedPayloadUnavailableAccepted: false,
    risk: riskOf(),
    ...(over as Partial<V1GuardInput>),
  })
  const stranger = await v1Plan(info, V1_STRANGER)
  const zero = { ...plan, recipient: ZERO_ADDRESS }
  const adapterInfo = v1Info({ approvalRequired: true })
  return {
    name: 'OFT v1',
    run: (over) => runV1Guards(base(over)),
    wallet: V1_WALLET,
    contractsInPlay: [
      { label: 'oft', address: V1_OFT },
      { label: 'token', address: V1_TOKEN },
      { label: 'endpoint', address: V1_ENDPOINT },
      { label: 'the remote OFT', address: V1_REMOTE },
    ],
    recipientOverride: (address) => ({
      plan: { ...plan, recipient: getAddress(address), toWire: addressToBytes32(address) },
      recipientIsCustom: true,
      customRecipientConfirmed: true,
    }),
    blockers: {
      wallet_not_connected: () => ({ walletAddress: undefined }),
      chain_mismatch: () => ({ walletChainId: 137 }),
      route_missing: () => ({ info: v1Info({ routes: [] }) }),
      recipient_zero: () => ({ plan: zero, recipientIsCustom: true, customRecipientConfirmed: true }),
      recipient_unconfirmed: () => ({ plan: stranger }),
      recipient_lookalike: () => ({ recipientLookalike: true }),
      insufficient_balance: () => ({ tokenBalance: 0n }),
      insufficient_native: () => ({ nativeBalance: 0n }),
      fee_mismatch: () => ({ plan: { ...plan, value: 1n } }),
      selfcheck_failed: () => ({ selfCheck: { ok: false, mismatches: ['to'] } }),
      approve_forbidden: () => ({ approveIntent: { token: V1_TOKEN, spender: V1_OFT, amount: 1n } }),
      needs_approve: () => ({ info: adapterInfo, allowance: 0n }),
      approve_wrong_spender: () => ({
        info: adapterInfo,
        allowance: 0n,
        approveIntent: { token: V1_TOKEN, spender: V1_STRANGER, amount: plan.amounts.amountLD },
      }),
      approve_wrong_token: () => ({
        info: adapterInfo,
        allowance: 0n,
        approveIntent: { token: V1_STRANGER, spender: V1_OFT, amount: plan.amounts.amountLD },
      }),
    },
  }
}

// ---------------------------------------------------------------- NTT ----

export const NTT = {
  MANAGER: getAddress('0xaaaaaaa000000000000000000000000000000001'),
  DST_MANAGER: getAddress('0xbbbbbbb000000000000000000000000000000002'),
  TOKEN: getAddress('0xccccccc000000000000000000000000000000003'),
  DST_TOKEN: getAddress('0x1111111111111111111111111111111111111111'),
  TRANSCEIVER: getAddress('0x6c55f346c20ca2b0c62e30790907f0a41c978ccc'),
  WALLET: getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9'),
}

export const nttVerified = (anchor: Extract<NttVerification, { ok: true }>['verified']['anchor'] = { side: 'source', kind: 'minter' }): NttVerification => ({
  ok: true,
  verified: {
    chain: 'ethereum',
    manager: NTT.MANAGER,
    token: NTT.TOKEN,
    tokenSymbol: 'W',
    listed: true,
    alsoOnDestination: true,
    mode: 'burning',
    tokenDecimals: 18,
    dst: { chain: 'bsc', wormholeChainId: 4, manager: NTT.DST_MANAGER, token: NTT.DST_TOKEN, tokenDecimals: 18 },
    transceiver: NTT.TRANSCEIVER,
    anchor,
  },
})

export function nttPlan(over: Partial<NttPlan> = {}): NttPlan {
  const trim = trimPlan(18, 18)
  const amount = 5n * trim.step
  return {
    protocol: 'wormhole-ntt',
    chain: 'ethereum',
    manager: NTT.MANAGER,
    token: NTT.TOKEN,
    tokenSymbol: 'W',
    mode: 'burning',
    sender: NTT.WALLET,
    amount,
    amountRaw: amount,
    dust: 0n,
    received: receivedAmount(amount, trim, 18),
    trim,
    dst: { chain: 'bsc', wormholeChainId: 4, manager: NTT.DST_MANAGER, token: NTT.DST_TOKEN, tokenDecimals: 18 },
    recipient: pad(NTT.WALLET.toLowerCase() as Address, { size: 32 }),
    recipientDisplay: NTT.WALLET,
    refundAddress: pad(NTT.WALLET.toLowerCase() as Address, { size: 32 }),
    transceiverInstructions: NO_TRANSCEIVER_INSTRUCTIONS,
    shouldQueue: false,
    fee: 10n ** 15n,
    value: 12n * 10n ** 14n,
    outboundCapacity: amount * 10n,
    inboundCapacity: amount * 10n,
    ...over,
  }
}

export function nttInput(over: Partial<NttGuardInput> = {}): NttGuardInput {
  const plan = nttPlan()
  return {
    walletAddress: NTT.WALLET,
    walletChainId: 1,
    srcChainId: 1,
    verification: nttVerified(),
    plan,
    recipientIsCustom: false,
    customRecipientConfirmed: false,
    tokenBalance: plan.amount * 2n,
    nativeBalance: 10n ** 18n,
    allowance: plan.amount,
    gasCostWei: 10n ** 14n,
    simulation: { ok: true },
    selfCheck: { ok: true },
    ...over,
  }
}

const asBytes32 = (a: Address) => pad(a.toLowerCase() as Address, { size: 32 })

const nttHarness = (): Harness => ({
  name: 'NTT',
  run: (over) => runNttGuards(nttInput(over as Partial<NttGuardInput>)),
  wallet: NTT.WALLET,
  contractsInPlay: [
    { label: 'token', address: NTT.TOKEN },
    { label: 'manager', address: NTT.MANAGER },
    { label: 'destination manager', address: NTT.DST_MANAGER },
    { label: 'destination token', address: NTT.DST_TOKEN },
  ],
  recipientOverride: (address) => ({ plan: nttPlan({ recipient: asBytes32(address), recipientDisplay: address }), recipientIsCustom: true, customRecipientConfirmed: true }),
  blockers: {
    wallet_not_connected: () => ({ walletAddress: undefined }),
    chain_mismatch: () => ({ walletChainId: 56 }),
    manager_unverified: () => ({ verification: { ok: false, code: 'manager_unverified' as never } }),
    recipient_zero: () => ({ plan: nttPlan({ recipient: asBytes32(ZERO_ADDRESS) }), recipientIsCustom: true, customRecipientConfirmed: true }),
    recipient_unconfirmed: () => ({ plan: nttPlan({ recipient: asBytes32(getAddress('0x3333333333333333333333333333333333333333')) }) }),
    recipient_lookalike: () => ({ recipientLookalike: true }),
    amount_has_dust: () => ({ plan: nttPlan({ amount: nttPlan().amount + 1n }) }),
    insufficient_balance: () => ({ tokenBalance: 0n }),
    insufficient_native: () => ({ nativeBalance: 0n }),
    fee_mismatch: () => ({ plan: nttPlan({ value: 1n }) }),
    selfcheck_failed: () => ({ selfCheck: { ok: false, mismatches: ['recipient'] } }),
    needs_approve: () => ({ allowance: 0n }),
    approve_wrong_spender: () => ({
      allowance: 0n,
      approveIntent: { token: NTT.TOKEN, spender: getAddress('0x3333333333333333333333333333333333333333'), amount: nttPlan().amount },
    }),
    approve_amount_mismatch: () => ({ allowance: 0n, approveIntent: { token: NTT.TOKEN, spender: NTT.MANAGER, amount: 1n } }),
  },
})

// --------------------------------------------------------------- CCIP ----

const CCIP_ROUTER = getAddress(ccipConfig('ethereum')!.router)
const CCIP_TOKEN = getAddress('0x1111111111111111111111111111111111111111')
const CCIP_POOL = getAddress('0x2222222222222222222222222222222222222222')
const CCIP_DST_POOL = getAddress('0x3333333333333333333333333333333333333333')
const CCIP_WALLET = getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9')

export function ccipPlan(over: Partial<CcipPlan> = {}): CcipPlan {
  const amount = 10n ** 18n
  return {
    protocol: 'ccip',
    chain: 'ethereum',
    router: CCIP_ROUTER,
    token: CCIP_TOKEN,
    tokenSymbol: 'TKN',
    decimals: 18,
    pool: CCIP_POOL,
    sender: CCIP_WALLET,
    amount,
    received: amount,
    dst: { chain: 'base', selector: ccipConfig('base')!.selector, token: CCIP_TOKEN, decimals: 18, pool: CCIP_DST_POOL },
    recipient: CCIP_WALLET,
    message: buildCcipMessage({ recipient: CCIP_WALLET, token: CCIP_TOKEN, amount }),
    fee: 10n ** 15n,
    value: 10n ** 15n,
    outbound: { tokens: amount * 10n, capacity: amount * 100n, isEnabled: true },
    inbound: { tokens: amount * 10n, capacity: amount * 100n, isEnabled: true },
    ...over,
  }
}

export function ccipInput(over: Partial<CcipGuardInput> = {}): CcipGuardInput {
  const plan = ccipPlan()
  return {
    walletAddress: CCIP_WALLET,
    walletChainId: 1,
    srcChainId: 1,
    srcChain: 'ethereum',
    plan,
    recipientIsCustom: false,
    customRecipientConfirmed: false,
    tokenBalance: plan.amount * 2n,
    nativeBalance: 10n ** 18n,
    allowance: plan.amount,
    gasCostWei: 10n ** 14n,
    simulation: { ok: true },
    selfCheck: { ok: true },
    ...over,
  }
}

const ccipTo = (recipient: Address) => ccipPlan({ recipient, message: buildCcipMessage({ recipient, token: CCIP_TOKEN, amount: 10n ** 18n }) })

const ccipHarness = (): Harness => ({
  name: 'CCIP',
  run: (over) => runCcipGuards(ccipInput(over as Partial<CcipGuardInput>)),
  wallet: CCIP_WALLET,
  contractsInPlay: [
    { label: 'router', address: CCIP_ROUTER },
    { label: 'token', address: CCIP_TOKEN },
    { label: 'pool', address: CCIP_POOL },
  ],
  recipientOverride: (address) => ({ plan: ccipTo(address), recipientIsCustom: true, customRecipientConfirmed: true }),
  blockers: {
    wallet_not_connected: () => ({ walletAddress: undefined }),
    chain_mismatch: () => ({ walletChainId: 8453 }),
    route_unsupported: () => ({ plan: ccipPlan({ router: getAddress('0x3333333333333333333333333333333333333333') }) }),
    recipient_zero: () => ({ plan: ccipTo(ZERO_ADDRESS), recipientIsCustom: true, customRecipientConfirmed: true }),
    recipient_unconfirmed: () => ({ plan: ccipTo(getAddress('0x3333333333333333333333333333333333333333')) }),
    recipient_lookalike: () => ({ recipientLookalike: true }),
    amount_rounds_to_zero: () => ({ plan: ccipPlan({ received: 0n }) }),
    insufficient_balance: () => ({ tokenBalance: 0n }),
    insufficient_native: () => ({ nativeBalance: 0n }),
    fee_mismatch: () => ({ plan: ccipPlan({ value: 1n }) }),
    selfcheck_failed: () => ({ selfCheck: { ok: false, mismatches: ['receiver'] } }),
    message_not_plain: () => ({ plan: ccipPlan({ message: { ...ccipPlan().message, data: '0x1234' } }) }),
    needs_approve: () => ({ allowance: 0n }),
    approve_wrong_spender: () => ({
      allowance: 0n,
      approveIntent: { token: CCIP_TOKEN, spender: getAddress('0x3333333333333333333333333333333333333333'), amount: ccipPlan().amount },
    }),
    approve_amount_mismatch: () => ({ allowance: 0n, approveIntent: { token: CCIP_TOKEN, spender: CCIP_ROUTER, amount: 1n } }),
  },
})

// ------------------------------------------------------------------ all ----

export async function harnesses(): Promise<Harness[]> {
  return [oftHarness(), await v1Harness(), nttHarness(), ccipHarness()]
}
