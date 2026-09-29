/**
 * §3: the exact `sendFrom` a v1 OFT will be asked to run, and what it costs.
 *
 * Three wire shapes, three different argument lists — and the differences are all on the money
 * path, so none of them is papered over here:
 *
 *   bytes        `_toAddress` is 20 raw bytes. No minimum amount exists on the wire at all, so
 *                slippage is not a setting that means anything; the contract sends what it debits.
 *   bytes32      `_toAddress` is a left-padded address. `_removeDust` runs on the contract, so the
 *                amount is trimmed to a multiple of 10^(decimals-sharedDecimals) here first and
 *                the dust is shown, exactly as the V2 tab does it.
 *   bytes32_fee  the contract takes its own cut FIRST (`_payOFTFee`), then removes dust, then
 *                enforces `_minAmount` on what is left. All three steps are computed here so the
 *                number on screen is the number that arrives.
 *
 * `msg.value` is the quoted native fee plus the user's buffer. v1 refunds the excess to
 * `_refundAddress` (UltraLightNodeV2 does the refund), which is always the sender.
 * `_zroPaymentAddress` is always the zero address and `_useZro` is always false: paying in ZRO is
 * a second token this app never touches.
 */
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { applyBps, ceilToStep, parseAmount, trimDust } from '../../core/amounts'
import { byKey, requireEvm, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { checksum, ZERO_ADDRESS } from '../../core/encoding'
import type { Recipient } from '../../core/recipient'
import { abiOfWire, oftWithFeeAbi, type V1Standard, type V1Wire } from './abi'
import { encodeAdapterParamsType1, EMPTY_ADAPTER_PARAMS, judgeAdapterParams } from './adapterParams'
import { lzV1 } from './chains'
import type { OftV1Info, V1Route } from './detect'

/** v1 has no ZRO path in this app: both of these are constants, never inputs. */
export const USE_ZRO = false
export const ZRO_PAYMENT_ADDRESS: Address = ZERO_ADDRESS

/** Only `bytes32_fee` carries a minimum on the wire; the other two have nowhere to put one. */
export const MAX_V1_SLIPPAGE_BPS = 500

/**
 * The gas floor asked for when the contract demands custom adapter params but its own
 * `minDstGasLookup` is the only number available. Stage 4's destination simulation raises this
 * through `dstGasEstimate`; until then the contract's own minimum is what is bought.
 */
export const DST_GAS_SAFETY_BPS = 3000 // ×1.3

export type V1Amounts = {
  /** As typed. */
  amountRaw: bigint
  /** What `_amount` in the calldata will be. */
  amountLD: bigint
  /** quoteOFTFee for this amount — `bytes32_fee` only, else 0n. */
  oftFee: bigint
  /** What the contract will actually move after its fee and dust removal. */
  delivered: bigint
  /** `_minAmount` in the calldata — `bytes32_fee` only, else undefined. */
  minAmountLD: bigint | undefined
  /** amountRaw − amountLD − oftFee − (dust): what stays with the sender. */
  dustTrimmed: bigint
}

export type V1Quote = { nativeFee: bigint; zroFee: bigint }

export type V1SendPlan = {
  protocol: 'lz-v1'
  standard: V1Standard
  chain: ChainKey
  oft: Address
  /** ERC-20 to approve, when the contract is an adapter. */
  token: Address
  decimals: number
  symbol: string
  srcV1ChainId: number
  dst: { key: ChainKey; v1ChainId: number }
  sender: Address
  /** EIP-55 recipient. v1 is EVM-only: there is no LayerZero v1 on Solana. */
  recipient: Address
  /** `_toAddress` exactly as it goes on the wire — 20 bytes, or 32 left-padded. */
  toWire: Hex
  amounts: V1Amounts
  slippageBps: number
  feeBufferBps: number
  adapterParams: Hex
  quote: V1Quote
  /** msg.value — the quoted fee plus the buffer, rounded to the chain's step. */
  value: bigint
}

export class V1PlanError extends Error {
  constructor(
    public readonly code:
      | 'no_route'
      | 'amount_zero'
      | 'quote_failed'
      | 'slippage_too_high'
      | 'slippage_unsupported'
      | 'recipient_vm_mismatch'
      | 'adapter_params_refused'
      | 'no_min_dst_gas'
      | 'fee_exceeds_amount',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'V1PlanError'
  }
}

/**
 * `_toAddress` on the wire.
 *
 * The two shapes are not interchangeable and the failure mode is the reason this app exists: a
 * v1 OFT's destination reads the FIRST 20 bytes of `bytes`, so handing it a 32-byte left-padded
 * address delivers to `0x0000000000000000000000` — twelve zero bytes read as an address, and the
 * tokens are gone. The self-check re-reads this value with independent code before anything is
 * signed (see selfcheck.ts).
 */
export function toWireRecipient(recipient: Address, wire: V1Wire): Hex {
  const a = getAddress(recipient).slice(2).toLowerCase()
  return wire === 'bytes' ? (`0x${a}` as Hex) : (`0x${'0'.repeat(24)}${a}` as Hex)
}

/** The adapter params this plan will send, or a reason it cannot build any. */
export function planAdapterParams(info: OftV1Info, route: V1Route, dstGasEstimate?: bigint): { params: Hex } | { error: V1PlanError } {
  if (!info.adapterParamsRequired) return { params: EMPTY_ADAPTER_PARAMS }
  // LzApp._checkGasLimit: `require(minGasLimit > 0)`. With custom params required and no minimum
  // configured, every send on this route reverts — say so instead of building a doomed call.
  if (route.minDstGas <= 0n) {
    return { error: new V1PlanError('no_min_dst_gas', `minDstGasLookup(${route.v1ChainId}, 0) is 0`) }
  }
  const simulated = dstGasEstimate === undefined ? 0n : applyBps(dstGasEstimate, 10000 + DST_GAS_SAFETY_BPS)
  const gas = simulated > route.minDstGas ? simulated : route.minDstGas
  try {
    return { params: encodeAdapterParamsType1(gas) }
  } catch (e) {
    return { error: new V1PlanError('adapter_params_refused', e instanceof Error ? e.message : String(e)) }
  }
}

export type BuildV1PlanInput = {
  info: OftV1Info
  dstKey: ChainKey
  amountInput: string
  sender: Address
  recipient: Recipient
  slippageBps?: number
  feeBufferBps?: number
  /** Stage 4's destination gas simulation, when it has run. */
  dstGasEstimate?: bigint
  client: ReadClient
}

export async function buildV1SendPlan(p: BuildV1PlanInput): Promise<V1SendPlan> {
  const { info } = p
  const route = info.routes.find((r) => r.key === p.dstKey)
  if (!route) throw new V1PlanError('no_route', `no trusted remote for ${p.dstKey}`)
  const dst = lzV1(p.dstKey)
  if (!dst) throw new V1PlanError('no_route', `${p.dstKey} has no LayerZero v1 deployment`)
  // There is no LayerZero v1 on Solana, so a non-EVM recipient can only be a mistake.
  if (p.recipient.vm !== 'evm') throw new V1PlanError('recipient_vm_mismatch', p.recipient.vm)

  const wire = info.standard.wire
  const slippageBps = p.slippageBps ?? 0
  if (slippageBps < 0 || slippageBps > MAX_V1_SLIPPAGE_BPS) throw new V1PlanError('slippage_too_high', `${slippageBps} bps`)
  if (slippageBps > 0 && wire !== 'bytes32_fee') {
    // Refusing loudly beats pretending: these two `sendFrom`s have no `_minAmount` argument, so a
    // slippage setting could not be enforced by anything.
    throw new V1PlanError('slippage_unsupported', `${wire} has no _minAmount`)
  }

  const feeBufferBps = p.feeBufferBps ?? 0
  const recipient = checksum(p.recipient.display)
  const toWire = toWireRecipient(recipient, wire)

  const amountRaw = parseAmount(p.amountInput, info.decimals)
  if (amountRaw <= 0n) throw new V1PlanError('amount_zero')

  const ap = planAdapterParams(info, route, p.dstGasEstimate)
  if ('error' in ap) throw ap.error
  const adapterParams = ap.params
  // Belt and braces: whatever produced these bytes, they are judged by the same rule a copied
  // sample would be. Nothing with a native drop in it is ever signed.
  const verdict = judgeAdapterParams(adapterParams)
  if (verdict.kind === 'refused') throw new V1PlanError('adapter_params_refused', `${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''}`)

  // What the contract will do to the amount, in the contract's own order.
  let oftFee = 0n
  if (wire === 'bytes32_fee') {
    try {
      oftFee = await p.client.readContract({
        address: info.oft,
        abi: oftWithFeeAbi,
        functionName: 'quoteOFTFee',
        args: [dst.v1ChainId, amountRaw],
      })
    } catch (e) {
      throw new V1PlanError('quote_failed', `quoteOFTFee: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
    if (oftFee >= amountRaw) throw new V1PlanError('fee_exceeds_amount', `${oftFee} >= ${amountRaw}`)
  }
  const afterFee = amountRaw - oftFee
  const delivered = trimDust(afterFee, info.conversionRate)
  if (delivered <= 0n) throw new V1PlanError('amount_zero', 'nothing left after the fee and dust')

  // `_amount` is what the calldata carries. The fee variant is handed the gross amount, because
  // the contract subtracts its own cut; the other two are handed the already-dust-free amount.
  const amountLD = wire === 'bytes32_fee' ? amountRaw : delivered
  const minAmountLD = wire === 'bytes32_fee' ? applyBps(delivered, 10000 - slippageBps) : undefined

  let quote: V1Quote
  try {
    const abi = abiOfWire(wire)
    const [nativeFee, zroFee] = (await p.client.readContract({
      address: info.oft,
      abi,
      functionName: 'estimateSendFee',
      // Same arguments the send will carry, so the number quoted is the number owed.
      args: [dst.v1ChainId, toWire, amountLD, USE_ZRO, adapterParams],
    })) as readonly [bigint, bigint]
    quote = { nativeFee, zroFee }
  } catch (e) {
    throw new V1PlanError('quote_failed', e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e))
  }

  const src = requireEvm(byKey(info.chain))
  return {
    protocol: 'lz-v1',
    standard: info.standard,
    chain: info.chain,
    oft: info.oft,
    token: info.token,
    decimals: info.decimals,
    symbol: info.symbol,
    srcV1ChainId: info.srcV1ChainId,
    dst: { key: dst.key, v1ChainId: dst.v1ChainId },
    sender: checksum(p.sender),
    recipient,
    toWire,
    amounts: { amountRaw, amountLD, oftFee, delivered, minAmountLD, dustTrimmed: afterFee - delivered },
    slippageBps,
    feeBufferBps,
    adapterParams,
    quote,
    value: ceilToStep(applyBps(quote.nativeFee, 10000 + feeBufferBps), src.feeStepWei),
  }
}

/** `LzCallParams` — the struct the bytes32 standards wrap their three trailing arguments in. */
export type LzCallParams = { refundAddress: Address; zroPaymentAddress: Address; adapterParams: Hex }

export function callParamsOf(plan: V1SendPlan): LzCallParams {
  return { refundAddress: plan.sender, zroPaymentAddress: ZRO_PAYMENT_ADDRESS, adapterParams: plan.adapterParams }
}

/**
 * The argument tuple for this plan's `sendFrom`, typed by wire shape so a caller cannot hand the
 * fee variant's list to the plain one.
 */
export type V1SendArgs =
  | { wire: 'bytes'; args: readonly [Address, number, Hex, bigint, Address, Address, Hex] }
  | { wire: 'bytes32'; args: readonly [Address, number, Hex, bigint, LzCallParams] }
  | { wire: 'bytes32_fee'; args: readonly [Address, number, Hex, bigint, bigint, LzCallParams] }

export function assembleV1SendArgs(plan: V1SendPlan): V1SendArgs {
  const { standard, dst, toWire, amounts, sender } = plan
  if (standard.wire === 'bytes') {
    return {
      wire: 'bytes',
      args: [sender, dst.v1ChainId, toWire, amounts.amountLD, sender, ZRO_PAYMENT_ADDRESS, plan.adapterParams],
    }
  }
  if (standard.wire === 'bytes32') {
    return { wire: 'bytes32', args: [sender, dst.v1ChainId, toWire, amounts.amountLD, callParamsOf(plan)] }
  }
  if (amounts.minAmountLD === undefined) throw new V1PlanError('slippage_unsupported', 'fee standard without a minimum')
  return { wire: 'bytes32_fee', args: [sender, dst.v1ChainId, toWire, amounts.amountLD, amounts.minAmountLD, callParamsOf(plan)] }
}

export function encodeV1SendCalldata(plan: V1SendPlan): Hex {
  const a = assembleV1SendArgs(plan)
  return encodeFunctionData({ abi: abiOfWire(a.wire), functionName: 'sendFrom', args: a.args as never })
}
