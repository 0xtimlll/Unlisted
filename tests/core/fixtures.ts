/** Shared fixtures modelled on the TREAD OFT on HyperEVM -> Ethereum route (§9). */
import type { Address } from 'viem'
import type { GuardInput } from '@/core/guards'
import { computeAmounts, computeValue, type SendPlan, type SendQuote } from '@/core/plan'
import type { OftInfo } from '@/core/types'

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
    routes: [{ eid: ETH_EID, peer: TREAD_ADAPTER }],
    enforced: { [ETH_EID]: '0x0003010011010000000000000000000000000000ea60' },
    ...over,
  }
}

/** Adapter on Ethereum: approve required. */
export function treadAdapterInfo(over: Partial<OftInfo> = {}): OftInfo {
  return {
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
    routes: [{ eid: HYPER_EID, peer: TREAD_OFT }],
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

export function treadPlan(over: Partial<SendPlan> = {}, amountInput = '19.82'): SendPlan {
  const info = treadOftInfo()
  const amounts = computeAmounts(amountInput, info.decimals, info.conversionRate, 0)
  const quote = quoteFor(amounts.amountLD)
  const base: SendPlan = {
    oft: TREAD_OFT,
    srcEid: HYPER_EID,
    dstEid: ETH_EID,
    sender: WALLET,
    recipient: WALLET,
    amounts,
    slippageBps: 0,
    feeBufferBps: 4000,
    extraOptions: '0x',
    quote,
    value: computeValue(quote.nativeFee, 4000, HYPER_FEE_STEP),
  }
  return { ...base, ...over }
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
    noExecutorGasAccepted: false,
    flags: [],
    peerBack: { status: 'ok' },
    peerBackUnavailableAccepted: false,
    ...over,
  }
}
