/**
 * Send plan (§5.3): the exact arguments that will go to the wallet, plus a
 * human-readable breakdown. Pure parts live here; the RPC composition
 * (quoteOFT/quoteSend) is added in buildSendPlan() on top of these.
 */
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem'
import { oftAbi } from './abi'
import { applyBps, ceilToStep, parseAmount, trimDust } from './amounts'
import type { ChainDef } from './chains'
import type { ReadClient } from './client'
import { addressToBytes32, checksum } from './encoding'
import type { OftInfo } from './types'

export const DEFAULT_SLIPPAGE_BPS = 0
export const DEFAULT_FEE_BUFFER_BPS = 4000 // +40%
/** Same cap as guards.MAX_SLIPPAGE_BPS (kept here to avoid an import cycle). */
export const MAX_SLIPPAGE_BPS_PLAN = 500
export const EMPTY_BYTES: Hex = '0x'

export type SendParam = {
  dstEid: number
  to: Hex
  amountLD: bigint
  minAmountLD: bigint
  extraOptions: Hex
  composeMsg: Hex
  oftCmd: Hex
}

export type MessagingFee = { nativeFee: bigint; lzTokenFee: bigint }

export type SendArgs = readonly [SendParam, MessagingFee, Address]

/** What quoteOFT / quoteSend returned for this plan. */
export type SendQuote = {
  amountSentLD: bigint
  amountReceivedLD: bigint
  limitMinLD: bigint
  limitMaxLD: bigint
  feeDetails: { amountLD: bigint; description: string }[]
  /** quoteSend().nativeFee, before buffer. */
  nativeFee: bigint
}

export type SendPlan = {
  oft: Address
  srcEid: number
  dstEid: number
  /** Connected wallet. Always also the refund address. */
  sender: Address
  recipient: Address
  amounts: AmountBreakdown
  slippageBps: number
  feeBufferBps: number
  extraOptions: Hex
  quote: SendQuote
  /** msg.value === fee.nativeFee, strictly. */
  value: bigint
}

export type AmountBreakdown = {
  /** As parsed, before dust trim. */
  amountRaw: bigint
  amountLD: bigint
  minAmountLD: bigint
  /** amountRaw - amountLD (shown to the user when > 0). */
  dustTrimmed: bigint
}

export function computeAmounts(
  amountInput: string,
  decimals: number,
  conversionRate: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): AmountBreakdown {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10000) {
    throw new Error(`bad slippageBps: ${slippageBps}`)
  }
  const amountRaw = parseAmount(amountInput, decimals)
  const amountLD = trimDust(amountRaw, conversionRate)
  const minAmountLD = trimDust(applyBps(amountLD, 10000 - slippageBps), conversionRate)
  return { amountRaw, amountLD, minAmountLD, dustTrimmed: amountRaw - amountLD }
}

/** nativeFee * (1 + buffer), rounded UP to the chain's fee step. */
export function computeValue(nativeFee: bigint, feeBufferBps: number, feeStepWei: bigint): bigint {
  if (!Number.isInteger(feeBufferBps) || feeBufferBps < 0) throw new Error(`bad feeBufferBps: ${feeBufferBps}`)
  if (nativeFee < 0n) throw new Error('nativeFee must be >= 0')
  return ceilToStep(applyBps(nativeFee, 10000 + feeBufferBps), feeStepWei)
}

export function buildSendParam(p: {
  dstEid: number
  recipient: Address
  amountLD: bigint
  minAmountLD: bigint
  extraOptions?: Hex
}): SendParam {
  return {
    dstEid: p.dstEid,
    to: addressToBytes32(p.recipient),
    amountLD: p.amountLD,
    minAmountLD: p.minAmountLD,
    extraOptions: p.extraOptions ?? EMPTY_BYTES,
    composeMsg: EMPTY_BYTES,
    oftCmd: EMPTY_BYTES,
  }
}

/** The exact tuple passed to `send(...)`. fee.nativeFee === plan.value, lzTokenFee === 0. */
export function assembleSendArgs(plan: SendPlan): SendArgs {
  const sendParam = buildSendParam({
    dstEid: plan.dstEid,
    recipient: plan.recipient,
    amountLD: plan.amounts.amountLD,
    minAmountLD: plan.amounts.minAmountLD,
    extraOptions: plan.extraOptions,
  })
  const fee: MessagingFee = { nativeFee: plan.value, lzTokenFee: 0n }
  return [sendParam, fee, checksum(plan.sender)]
}

export function encodeSendCalldata(args: SendArgs): Hex {
  const [sendParam, fee, refundAddress] = args
  return encodeFunctionData({
    abi: oftAbi,
    functionName: 'send',
    args: [sendParam, fee, refundAddress],
  })
}

export type BuildSendPlanInput = {
  info: OftInfo
  src: ChainDef
  dstEid: number
  amountInput: string
  sender: Address
  recipient: Address
  slippageBps?: number
  feeBufferBps?: number
  extraOptions?: Hex
}

export class PlanError extends Error {
  constructor(
    public readonly code: 'no_route' | 'amount_zero' | 'quote_failed' | 'slippage_too_high',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'PlanError'
  }
}

/**
 * §5.3: full plan = pure amount math + quoteOFT + quoteSend + fee buffer.
 * The only RPC calls are the two view quotes.
 */
export async function buildSendPlan(client: ReadClient, p: BuildSendPlanInput): Promise<SendPlan> {
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const feeBufferBps = p.feeBufferBps ?? DEFAULT_FEE_BUFFER_BPS
  const extraOptions = p.extraOptions ?? EMPTY_BYTES

  const route = p.info.routes.find((r) => r.eid === p.dstEid)
  if (!route) throw new PlanError('no_route', `no peer for eid ${p.dstEid}`)
  if (slippageBps > MAX_SLIPPAGE_BPS_PLAN) throw new PlanError('slippage_too_high', `${slippageBps} bps > ${MAX_SLIPPAGE_BPS_PLAN}`)

  const amounts = computeAmounts(p.amountInput, p.info.decimals, p.info.conversionRate, slippageBps)
  if (amounts.amountLD <= 0n) throw new PlanError('amount_zero')

  const sendParam = buildSendParam({
    dstEid: p.dstEid,
    recipient: p.recipient,
    amountLD: amounts.amountLD,
    minAmountLD: amounts.minAmountLD,
    extraOptions,
  })

  let oftQuote, feeQuote
  try {
    ;[oftQuote, feeQuote] = await Promise.all([
      client.readContract({ address: p.info.oft, abi: oftAbi, functionName: 'quoteOFT', args: [sendParam] }),
      client.readContract({ address: p.info.oft, abi: oftAbi, functionName: 'quoteSend', args: [sendParam, false] }),
    ])
  } catch (e) {
    throw new PlanError('quote_failed', e instanceof Error ? e.message : String(e))
  }
  const [limit, feeDetails, receipt] = oftQuote

  const quote: SendQuote = {
    amountSentLD: receipt.amountSentLD,
    amountReceivedLD: receipt.amountReceivedLD,
    limitMinLD: limit.minAmountLD,
    limitMaxLD: limit.maxAmountLD,
    feeDetails: feeDetails.map((d) => ({ amountLD: d.feeAmountLD, description: d.description.slice(0, 64) })),
    nativeFee: feeQuote.nativeFee,
  }

  return {
    oft: p.info.oft,
    srcEid: p.src.eid,
    dstEid: p.dstEid,
    sender: checksum(p.sender),
    recipient: checksum(p.recipient),
    amounts,
    slippageBps,
    feeBufferBps,
    extraOptions,
    quote,
    value: computeValue(quote.nativeFee, feeBufferBps, p.src.feeStepWei),
  }
}

export type DecodedSend = {
  functionName: 'send'
  sendParam: SendParam
  fee: MessagingFee
  refundAddress: Address
}

/** Decodes `send(...)` calldata. Throws if the selector is not `send`. */
export function decodeSendCalldata(data: Hex): DecodedSend {
  let decoded: ReturnType<typeof decodeFunctionData<typeof oftAbi>>
  try {
    decoded = decodeFunctionData({ abi: oftAbi, data })
  } catch {
    throw new Error(`not a send() call: unknown selector ${data.slice(0, 10)}`)
  }
  if (decoded.functionName !== 'send') {
    throw new Error(`not a send() call: ${decoded.functionName}`)
  }
  const [sp, fee, refund] = decoded.args
  return {
    functionName: 'send',
    sendParam: {
      dstEid: sp.dstEid,
      to: sp.to,
      amountLD: sp.amountLD,
      minAmountLD: sp.minAmountLD,
      extraOptions: sp.extraOptions,
      composeMsg: sp.composeMsg,
      oftCmd: sp.oftCmd,
    },
    fee: { nativeFee: fee.nativeFee, lzTokenFee: fee.lzTokenFee },
    refundAddress: checksum(refund),
  }
}
