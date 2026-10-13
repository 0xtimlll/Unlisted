/** Shared fixtures modelled on the TREAD OFT on HyperEVM -> Ethereum route (§9). */
import type { Address } from 'viem'
import { addressToBytes32 } from '@/core/encoding'
import type { GuardInput } from '@/core/guards'
import { computeAmounts, computeValue, type EvmSendPlan, type SendQuote } from '@/core/plan'
import type { OftInfo } from '@/core/types'
import { assessRisk, CHECK_IDS, emptyRiskInput, type CheckId, type CheckState, type RouteRisk } from '@/protocols/lz-risk/risk'

export const TREAD_OFT: Address = '0xd5EE1c81fE161e985dce6b90713c965f9979cf80'
export const TREAD_ADAPTER: Address = '0xe68AD53cf0D5E49CF83FBC003672f6D0eBcAe311'
export const TREAD_TOKEN_ETH: Address = '0x1111111111111111111111111111111111111111'
export const ENDPOINT_HYPER: Address = '0x1a44076050125825900e736c501f859c50fE728c'
export const OWNER: Address = '0x2222222222222222222222222222222222222222'
export const WALLET: Address = '0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9'
export const OTHER: Address = '0x3333333333333333333333333333333333333333'

export const HYPER_CHAIN_ID = 999
export const HYPER_EID = 30367
export const ETH_EID = 30101
export const HYPER_FEE_STEP = 10n ** 16n

/** Plain OFT on HyperEVM: decimals 18, shared 6, no approve. */
export function treadOftInfo(over: Partial<OftInfo> = {}): OftInfo {
  return {
    vm: 'evm',
    oft: TREAD_OFT,
    kind: 'OFT',
    token: TREAD_OFT,
    symbol: 'TREAD',
    name: 'Tread',
    decimals: 18,
    sharedDecimals: 6,
    conversionRate: 10n ** 12n,
    approvalRequired: false,
    endpoint: ENDPOINT_HYPER,
    owner: OWNER,
    routes: [{ eid: ETH_EID, peer: addressToBytes32(TREAD_ADAPTER) }],
    enforced: { [ETH_EID]: '0x0003010011010000000000000000000000000000ea60' },
    ...over,
  }
}

/** Adapter on Ethereum: approve required. */
export function treadAdapterInfo(over: Partial<OftInfo> = {}): OftInfo {
  return {
    vm: 'evm',
    oft: TREAD_ADAPTER,
    kind: 'OFTAdapter',
    token: TREAD_TOKEN_ETH,
    symbol: 'TREAD',
    name: 'Tread',
    decimals: 18,
    sharedDecimals: 6,
    conversionRate: 10n ** 12n,
    approvalRequired: true,
    endpoint: ENDPOINT_HYPER,
    owner: OWNER,
    routes: [{ eid: HYPER_EID, peer: addressToBytes32(TREAD_OFT) }],
    enforced: { [HYPER_EID]: '0x0003010011010000000000000000000000000000ea60' },
    ...over,
  }
}

export const NATIVE_FEE = 20_800000000000000n // 0.0208 HYPE

export function quoteFor(amountLD: bigint, over: Partial<SendQuote> = {}): SendQuote {
  return {
    amountSentLD: amountLD,
    amountReceivedLD: amountLD,
    limitMinLD: 0n,
    limitMaxLD: 2n ** 128n,
    feeDetails: [],
    nativeFee: NATIVE_FEE,
    ...over,
  }
}

/**
 * `over.recipient` may be given as a plain EVM address (tests read better that way);
 * it is stored the way the app stores it: bytes32 + display form.
 */
export function treadPlan(over: Partial<Omit<EvmSendPlan, 'recipient'>> & { recipient?: Address } = {}, amountInput = '19.82'): EvmSendPlan {
  const info = treadOftInfo()
  const amounts = computeAmounts(amountInput, info.decimals, info.conversionRate, 0)
  const quote = quoteFor(amounts.amountLD)
  const { recipient: recipientOver, ...rest } = over
  const recipientAddr = recipientOver ?? WALLET
  const base: EvmSendPlan = {
    vm: 'evm',
    oft: TREAD_OFT,
    srcEid: HYPER_EID,
    dstEid: ETH_EID,
    sender: WALLET,
    recipient: addressToBytes32(recipientAddr),
    recipientDisplay: recipientAddr,
    recipientVm: 'evm',
    amounts,
    slippageBps: 0,
    feeBufferBps: 4000,
    extraOptions: '0x',
    quote,
    value: computeValue(quote.nativeFee, 4000, HYPER_FEE_STEP),
    nativeAmountLD: 0n,
  }
  return { ...base, ...rest }
}

/** The XPL NativeOFTAdapter on Plasma (0x405F…26b0): token() is zero, nothing is approved. */
export const XPL_ADAPTER: Address = '0x405FBc9004D857903bFD6b3357792D71a50726b0'
export const ENDPOINT_PLASMA: Address = '0x6F475642a6e85809B1c36Fa62763669b1b48DD5B'
export const PLASMA_CHAIN_ID = 9745
export const PLASMA_EID = 30383
export const BSC_EID = 30102

export function xplNativeInfo(over: Partial<OftInfo> = {}): OftInfo {
  return {
    vm: 'evm',
    oft: XPL_ADAPTER,
    kind: 'NativeOFTAdapter',
    token: '0x0000000000000000000000000000000000000000',
    symbol: 'XPL',
    name: 'XPL',
    decimals: 18,
    sharedDecimals: 6,
    conversionRate: 10n ** 12n,
    approvalRequired: false,
    endpoint: ENDPOINT_PLASMA,
    owner: OWNER,
    routes: [{ eid: BSC_EID, peer: addressToBytes32(XPL_ADAPTER) }],
    enforced: { [BSC_EID]: '0x' },
    lockedInAdapter: 264_871_655n * 10n ** 18n,
    ...over,
  }
}

/** A send of 1 XPL from the native adapter: the amount travels in msg.value next to the fee. */
export function xplPlan(over: Partial<Omit<EvmSendPlan, 'recipient'>> & { recipient?: Address } = {}, amountInput = '1'): EvmSendPlan {
  const info = xplNativeInfo()
  const amounts = computeAmounts(amountInput, info.decimals, info.conversionRate, 0)
  const quote = quoteFor(amounts.amountLD)
  const { recipient: recipientOver, ...rest } = over
  const recipientAddr = recipientOver ?? WALLET
  const base: EvmSendPlan = {
    vm: 'evm',
    oft: XPL_ADAPTER,
    srcEid: PLASMA_EID,
    dstEid: BSC_EID,
    sender: WALLET,
    recipient: addressToBytes32(recipientAddr),
    recipientDisplay: recipientAddr,
    recipientVm: 'evm',
    amounts,
    slippageBps: 0,
    feeBufferBps: 4000,
    extraOptions: '0x',
    quote,
    value: computeValue(quote.nativeFee, 4000, 10n ** 16n),
    nativeAmountLD: amounts.amountLD,
  }
  return { ...base, ...rest }
}

/** A fully valid snapshot: every guard passes. */
export function goodInput(over: Partial<GuardInput> = {}): GuardInput {
  const plan = treadPlan()
  return {
    walletAddress: WALLET,
    walletChainId: HYPER_CHAIN_ID,
    srcChainId: HYPER_CHAIN_ID,
    info: treadOftInfo(),
    plan,
    recipientIsCustom: false,
    customRecipientConfirmed: false,
    tokenBalance: 100n * 10n ** 18n,
    nativeBalance: 10n ** 18n,
    allowance: 0n,
    gasCostWei: 10n ** 15n,
    simulation: { ok: true },
    selfCheck: { ok: true },
    flags: [],
    peerBack: { status: 'ok' },
    // §4 guard 22: a clean verdict, so a test about guards 1-21 is not also a test about the risk
    // panel. The risk rule has its own tests in lzRisk.test.ts.
    risk: cleanRisk(),
    ...over,
  }
}

/** Every check ran and passed, nothing flagged: OK, uncapped. */
export function cleanRisk(): RouteRisk {
  const checks = {} as Record<CheckId, CheckState>
  for (const id of CHECK_IDS) checks[id] = { status: 'pass' }
  return assessRisk({ ...emptyRiskInput(), checks, history: { kind: 'delivered', days: 1 }, linkCrossChecked: true })
}
