/**
 * §Task 5: the exact arguments an NTT transfer will be sent with, and what it costs.
 *
 * Two decisions are made here and nowhere else:
 *
 *  - `shouldQueue` is always FALSE. Over the rate limit, the transfer must revert so the user sees
 *    it, never sit in a queue they did not ask for and cannot watch.
 *  - `transceiverInstructions` is `0x00` — "zero instructions", exactly what
 *    TransceiverStructs.encodeTransceiverInstructions([]) produces. Every registered transceiver
 *    then gets an empty instruction, and WormholeTransceiver.parseWormholeTransceiverInstruction
 *    documents the empty case as `shouldSkipRelayerSend = false`, i.e. automatic delivery. The same
 *    bytes go to quoteDeliveryPrice and to transfer, so the quote cannot drift from the send.
 */
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { ceilToStep, applyBps } from '../../core/amounts'
import { byKey, requireEvm, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { addressToBytes32, isZeroBytes32 } from '../../core/encoding'
import type { Recipient } from '../../core/recipient'
import { nttManagerAbi } from './abi'
import { wormholeChainId } from './chains'
import { checkAmount, receivedAmount, trimPlan, type TrimPlan } from './amounts'
import type { VerifiedNttManager } from './verify'

/** `encodeTransceiverInstructions([])`: one length byte, zero instructions. */
export const NO_TRANSCEIVER_INSTRUCTIONS: Hex = '0x00'

/** Over the rate limit the transfer must revert, not queue. */
export const SHOULD_QUEUE = false

/** The same buffer discipline as the OFT path: the manager refunds the excess to the sender. */
export const DEFAULT_FEE_BUFFER_BPS = 2000 // +20%

export type NttPlan = {
  protocol: 'wormhole-ntt'
  chain: ChainKey
  manager: Address
  token: Address
  tokenSymbol: string
  mode: VerifiedNttManager['mode']
  sender: Address
  /** What goes on the wire, already rounded down to something the manager accepts. */
  amount: bigint
  /** As typed, before rounding. */
  amountRaw: bigint
  /** amountRaw - amount; > 0 means the input had more precision than the hop carries. */
  dust: bigint
  /** What lands on the other side, in the DESTINATION token's smallest unit. */
  received: bigint
  trim: TrimPlan
  dst: VerifiedNttManager['dst']
  /** bytes32 recipient on the destination chain. */
  recipient: Hex
  recipientDisplay: string
  /** bytes32 of the sender: where the manager refunds the excess fee. */
  refundAddress: Hex
  transceiverInstructions: Hex
  shouldQueue: boolean
  /** quoteDeliveryPrice total, before the buffer. */
  fee: bigint
  /** msg.value: fee + buffer, rounded up to the chain's step. The excess comes back. */
  value: bigint
  /** Rate limits at quote time. */
  outboundCapacity: bigint
  inboundCapacity: bigint | undefined
}

export class NttPlanError extends Error {
  constructor(
    public readonly code: 'amount_zero' | 'amount_too_large' | 'quote_failed' | 'recipient_vm_mismatch',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'NttPlanError'
  }
}

export type BuildNttPlanInput = {
  verified: VerifiedNttManager
  srcClient: ReadClient
  dstClient: ReadClient
  sender: Address
  /** Must have been built for an EVM destination: this stage bridges EVM to EVM only. */
  recipient: Recipient
  /** The raw amount in the source token's smallest unit. */
  amountRaw: bigint
  feeBufferBps?: number
}

export async function buildNttPlan(p: BuildNttPlanInput): Promise<NttPlan> {
  const v = p.verified
  if (p.recipient.vm !== 'evm') throw new NttPlanError('recipient_vm_mismatch', p.recipient.vm)

  const trim = trimPlan(v.tokenDecimals, v.dst.tokenDecimals)
  const amount = checkAmount(p.amountRaw, trim)
  if (!amount.ok) throw new NttPlanError(amount.reason === 'zero' ? 'amount_zero' : 'amount_too_large', `max ${amount.max}`)

  const base = { address: v.manager, abi: nttManagerAbi } as const
  let fee: bigint
  let outboundCapacity: bigint
  try {
    const [quote, capacity] = await Promise.all([
      p.srcClient.readContract({ ...base, functionName: 'quoteDeliveryPrice', args: [v.dst.wormholeChainId, NO_TRANSCEIVER_INSTRUCTIONS] }),
      p.srcClient.readContract({ ...base, functionName: 'getCurrentOutboundCapacity' }),
    ])
    fee = quote[1]
    outboundCapacity = capacity
  } catch (e) {
    throw new NttPlanError('quote_failed', e instanceof Error ? e.message.split('\n')[0] : String(e))
  }

  const srcWormholeChainId = wormholeChainId(v.chain)
  if (srcWormholeChainId === undefined) throw new NttPlanError('quote_failed', `no Wormhole chain id for ${v.chain}`)

  // Read-only on the destination's own RPC: what the other side will still accept right now.
  let inboundCapacity: bigint | undefined
  try {
    inboundCapacity = await p.dstClient.readContract({
      address: v.dst.manager,
      abi: nttManagerAbi,
      functionName: 'getCurrentInboundCapacity',
      args: [srcWormholeChainId],
    })
  } catch {
    inboundCapacity = undefined // reported as "unknown", which blocks in guards
  }

  const src = requireEvm(byKey(v.chain))
  const bufferBps = p.feeBufferBps ?? DEFAULT_FEE_BUFFER_BPS
  return {
    protocol: 'wormhole-ntt',
    chain: v.chain,
    manager: v.manager,
    token: v.token,
    tokenSymbol: v.tokenSymbol,
    mode: v.mode,
    sender: getAddress(p.sender),
    amount: amount.amount,
    amountRaw: p.amountRaw,
    dust: amount.dust,
    received: receivedAmount(amount.amount, trim, v.dst.tokenDecimals),
    trim,
    dst: v.dst,
    recipient: p.recipient.to,
    recipientDisplay: p.recipient.display,
    refundAddress: addressToBytes32(p.sender),
    transceiverInstructions: NO_TRANSCEIVER_INSTRUCTIONS,
    shouldQueue: SHOULD_QUEUE,
    fee,
    value: ceilToStep(applyBps(fee, 10000 + bufferBps), src.feeStepWei),
    outboundCapacity,
    inboundCapacity,
  }
}

/** The transfer arguments, in the order the ABI declares them. */
export type NttTransferArgs = readonly [bigint, number, Hex, Hex, boolean, Hex]

export function assembleNttTransferArgs(plan: NttPlan): NttTransferArgs {
  return [plan.amount, plan.dst.wormholeChainId, plan.recipient, plan.refundAddress, plan.shouldQueue, plan.transceiverInstructions]
}

/** Decodes our own `transfer(...)` calldata. Throws if the selector is not `transfer`. */
export function decodeNttTransferCalldata(data: Hex): NttTransferArgs {
  let decoded
  try {
    decoded = decodeFunctionData({ abi: nttManagerAbi, data })
  } catch {
    throw new Error(`not an NTT transfer: unknown selector ${data.slice(0, 10)}`)
  }
  if (decoded.functionName !== 'transfer') throw new Error(`not an NTT transfer: ${decoded.functionName}`)
  const [amount, recipientChain, recipient, refundAddress, shouldQueue, instructions] = decoded.args
  return [amount, recipientChain, recipient, refundAddress, shouldQueue, instructions]
}

export type NttSelfCheck = { ok: true } | { ok: false; mismatches: string[] }

/**
 * §6.14 for NTT: decode the calldata that is about to be signed and compare every field with the
 * plan on screen. The two that matter most are `shouldQueue` (must be false) and the recipient.
 */
export function nttSelfCheck(plan: NttPlan, calldata: Hex): NttSelfCheck {
  const mismatches: string[] = []
  let got: NttTransferArgs
  try {
    got = decodeNttTransferCalldata(calldata)
  } catch (e) {
    return { ok: false, mismatches: [`decode: ${e instanceof Error ? e.message : String(e)}`] }
  }
  const want = assembleNttTransferArgs(plan)
  if (got[0] !== want[0]) mismatches.push('amount')
  if (got[1] !== want[1]) mismatches.push('recipientChain')
  if (got[2].toLowerCase() !== want[2].toLowerCase()) mismatches.push('recipient')
  if (got[3].toLowerCase() !== want[3].toLowerCase()) mismatches.push('refundAddress')
  if (got[4] !== false) mismatches.push('shouldQueue must be false')
  if (got[5].toLowerCase() !== want[5].toLowerCase()) mismatches.push('transceiverInstructions')
  if (isZeroBytes32(got[2])) mismatches.push('recipient is zero')
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches }
}
