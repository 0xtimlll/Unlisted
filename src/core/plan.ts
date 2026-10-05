/**
 * Send plan (§5.3): the exact arguments that will go to the wallet, plus a
 * human-readable breakdown. Pure parts live here; the RPC composition
 * (quoteOFT/quoteSend) is added in buildSendPlan() on top of these.
 */
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem'
import { oftAbi } from './abi'
import { applyBps, ceilToStep, parseAmount, trimDust } from './amounts'
import { byEid, type EvmChainDef } from './chains'
import type { ReadClient } from './client'
import { checksum, isBytes32 } from './encoding'
import { sanitizeLabel } from './text'
import type { Recipient } from './recipient'
import type { SvmSendPlan } from './svm/plan'
import type { OftInfo } from './types'

/** Half a percent below what the contract quotes it will deliver (quoteOFT), see buildSendPlan. */
export const DEFAULT_SLIPPAGE_BPS = 50
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
  /**
   * Set when `quoteOFT` could not be read (reverted, or not implemented by a custom contract):
   * the amounts above are then the NOMINAL ones (received = sent), not the contract's word, and
   * the minimum was taken from the sent amount. Guard 9 says so (`oft_fee_unknown`), and no
   * screen may show the receive as known while this is set. The value is the decoded reason.
   */
  unavailable?: string
}

export type EvmSendPlan = {
  vm: 'evm'
  oft: Address
  srcEid: number
  dstEid: number
  /** Connected wallet. Always also the refund address. */
  sender: Address
  /** The wire value of SendParam.to: bytes32. EVM = left-padded address; Solana = full pubkey. */
  recipient: Hex
  /** Human form of `recipient` for the UI only: EIP-55 hex or base58. Never used to build calldata. */
  recipientDisplay: string
  /** VM the recipient was constructed for; guard 19 requires it to match the destination chain. */
  recipientVm: 'evm' | 'svm'
  amounts: AmountBreakdown
  slippageBps: number
  feeBufferBps: number
  extraOptions: Hex
  quote: SendQuote
  /** msg.value === fee.nativeFee, strictly. */
  value: bigint
}

/**
 * Discriminated by the SOURCE VM. Both carry the same amount/quote/recipient shape so guards and the
 * review screen read them alike; only the wire form differs (calldata vs. a Solana instruction).
 */
export type SendPlan = EvmSendPlan | SvmSendPlan

/** The fee the plan commits to, independent of VM: nativeFee == value, lzTokenFee == 0. */
export function planFee(plan: SendPlan): MessagingFee {
  return plan.vm === 'evm' ? assembleSendArgs(plan)[1] : { nativeFee: plan.value, lzTokenFee: 0n }
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
  /** Already bytes32 — the caller decides how an address becomes 32 bytes. */
  to: Hex
  amountLD: bigint
  minAmountLD: bigint
  extraOptions?: Hex
}): SendParam {
  if (!isBytes32(p.to)) throw new Error('to must be bytes32')
  return {
    dstEid: p.dstEid,
    to: p.to,
    amountLD: p.amountLD,
    minAmountLD: p.minAmountLD,
    extraOptions: p.extraOptions ?? EMPTY_BYTES,
    composeMsg: EMPTY_BYTES,
    oftCmd: EMPTY_BYTES,
  }
}

/** The exact tuple passed to `send(...)`. fee.nativeFee === plan.value, lzTokenFee === 0. */
export function assembleSendArgs(plan: EvmSendPlan): SendArgs {
  const sendParam = buildSendParam({
    dstEid: plan.dstEid,
    to: plan.recipient,
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
  src: EvmChainDef
  dstEid: number
  amountInput: string
  sender: Address
  /** Built by evmRecipient() / svmRecipient(); its vm must equal the destination chain's vm. */
  recipient: Recipient
  slippageBps?: number
  feeBufferBps?: number
  extraOptions?: Hex
}

export class PlanError extends Error {
  constructor(
    public readonly code: 'no_route' | 'amount_zero' | 'quote_failed' | 'slippage_too_high' | 'recipient_vm_mismatch',
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
export async function buildSendPlan(client: ReadClient, p: BuildSendPlanInput): Promise<EvmSendPlan> {
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const feeBufferBps = p.feeBufferBps ?? DEFAULT_FEE_BUFFER_BPS
  const extraOptions = p.extraOptions ?? EMPTY_BYTES

  const route = p.info.routes.find((r) => r.eid === p.dstEid)
  if (!route) throw new PlanError('no_route', `no peer for eid ${p.dstEid}`)
  const dst = byEid(p.dstEid)
  if (!dst) throw new PlanError('no_route', `eid ${p.dstEid} is not in the registry`)
  // The recipient type carries the VM it was parsed for; a mismatch here means an EVM address
  // was about to be padded into a Solana pubkey (or vice versa). Refuse before any quote.
  if (p.recipient.vm !== dst.vm) throw new PlanError('recipient_vm_mismatch', `${p.recipient.vm} recipient for a ${dst.vm} destination`)
  if (slippageBps > MAX_SLIPPAGE_BPS_PLAN) throw new PlanError('slippage_too_high', `${slippageBps} bps > ${MAX_SLIPPAGE_BPS_PLAN}`)

  const provisional = computeAmounts(p.amountInput, p.info.decimals, p.info.conversionRate, slippageBps)
  if (provisional.amountLD <= 0n) throw new PlanError('amount_zero')
  const rate = p.info.conversionRate
  const to = p.recipient.to
  const param = (minAmountLD: bigint) => buildSendParam({ dstEid: p.dstEid, to, amountLD: provisional.amountLD, minAmountLD, extraOptions })

  // 1. What the contract will actually deliver. Asked with no minimum at all, so an issuer fee in
  //    `_debitView` cannot turn the question into a SlippageExceeded revert — the fee is the
  //    answer we are after, not an error to hide. A contract that cannot answer (reverts, has no
  //    quoteOFT) leaves the receive unknown; that is said (`unavailable`), never assumed to be zero.
  let quote: Omit<SendQuote, 'nativeFee'>
  try {
    const [limit, feeDetails, receipt] = await client.readContract({ address: p.info.oft, abi: oftAbi, functionName: 'quoteOFT', args: [param(0n)] })
    quote = {
      amountSentLD: receipt.amountSentLD,
      amountReceivedLD: receipt.amountReceivedLD,
      limitMinLD: limit.minAmountLD,
      limitMaxLD: limit.maxAmountLD,
      feeDetails: feeDetails.map((d) => ({ amountLD: d.feeAmountLD, description: sanitizeLabel(d.description, 64) })),
    }
  } catch (e) {
    quote = {
      amountSentLD: provisional.amountLD,
      amountReceivedLD: provisional.amountLD,
      limitMinLD: 0n,
      limitMaxLD: 2n ** 256n - 1n,
      feeDetails: [],
      unavailable: sanitizeLabel(e instanceof Error ? e.message.split('\n')[0]! : String(e), 160),
    }
  }

  // 2. The minimum is the slippage below what the contract said it delivers — so an issuer fee is
  //    accepted as quoted and shown, while a worse delivery than quoted still reverts. With no
  //    quote to lean on, the minimum stays the slippage below the sent amount (the old rule).
  const amounts: AmountBreakdown = quote.unavailable
    ? provisional
    : { ...provisional, minAmountLD: trimDust(applyBps(quote.amountReceivedLD, 10000 - slippageBps), rate) }
  const sendParam = param(amounts.minAmountLD)

  // 3. The LayerZero fee for exactly the SendParam that will be signed — the same minimum included.
  let feeQuote
  try {
    feeQuote = await client.readContract({ address: p.info.oft, abi: oftAbi, functionName: 'quoteSend', args: [sendParam, false] })
  } catch (e) {
    throw new PlanError('quote_failed', e instanceof Error ? e.message : String(e))
  }
  const fullQuote: SendQuote = { ...quote, nativeFee: feeQuote.nativeFee }

  return {
    vm: 'evm',
    oft: p.info.oft,
    srcEid: p.src.eid,
    dstEid: p.dstEid,
    sender: checksum(p.sender),
    recipient: to,
    recipientDisplay: p.recipient.display,
    recipientVm: p.recipient.vm,
    amounts,
    slippageBps,
    feeBufferBps,
    extraOptions,
    quote: fullQuote,
    value: computeValue(fullQuote.nativeFee, feeBufferBps, p.src.feeStepWei),
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
