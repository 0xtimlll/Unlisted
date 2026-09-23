/**
 * §Task 6: the exact CCIP message that will be sent, and what it costs.
 *
 * The message is the one the Chainlink tutorial builds for a token-only transfer to an EOA
 * (docs.chain.link/ccip/tutorials/evm/transfer-tokens-from-contract):
 *
 *   receiver: abi.encode(recipient)      an address, encoded as bytes for non-EVM destinations
 *   data:     ""                         nothing is called on the other side
 *   tokenAmounts: [{ token, amount }]
 *   feeToken: address(0)                 the native coin
 *   extraArgs: _argsToBytes(EVMExtraArgsV2({ gasLimit: 0, allowOutOfOrderExecution: true }))
 *                                        gasLimit 0 because there is no ccipReceive to pay for
 *
 * msg.value is EXACTLY the quoted fee, with no buffer, because Router.ccipSend says:
 *
 *   // Note we take the whole msg.value regardless if its larger.
 *   feeTokenAmount = msg.value;
 *
 * — anything extra is kept, not refunded. If the fee moves between the quote and the send the
 * transaction reverts with InsufficientFeeTokenAmount, which is the safe direction.
 */
import { encodeAbiParameters, getAddress, type Address, type Hex } from 'viem'
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import type { Recipient } from '../../core/recipient'
import { ccipRouterAbi, tokenPoolAbi, EVM_EXTRA_ARGS_V2_TAG } from './abi'
import { ccipConfig } from './chains'
import type { RemoteSide } from './discover'

/** address(0) as the fee token means "pay in the chain's native coin". */
export const NATIVE_FEE_TOKEN: Address = `0x${'0'.repeat(40)}`

/** No ccipReceive on the other side, so no gas to buy for one. */
export const GAS_LIMIT_FOR_EOA = 0n
export const ALLOW_OUT_OF_ORDER = true

/** `_argsToBytes(EVMExtraArgsV2)` = tag ++ abi.encode(gasLimit, allowOutOfOrderExecution). */
export function encodeExtraArgsV2(gasLimit: bigint, allowOutOfOrderExecution: boolean): Hex {
  const body = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }],
    [gasLimit, allowOutOfOrderExecution],
  )
  return `${EVM_EXTRA_ARGS_V2_TAG}${body.slice(2)}`
}

export type CcipMessage = {
  receiver: Hex
  data: Hex
  tokenAmounts: readonly { token: Address; amount: bigint }[]
  feeToken: Address
  extraArgs: Hex
}

/** The message for a plain token transfer to an address. Nothing else is ever built here. */
export function buildCcipMessage(p: { recipient: Address; token: Address; amount: bigint }): CcipMessage {
  return {
    receiver: encodeAbiParameters([{ type: 'address' }], [p.recipient]),
    data: '0x',
    tokenAmounts: [{ token: p.token, amount: p.amount }],
    feeToken: NATIVE_FEE_TOKEN,
    extraArgs: encodeExtraArgsV2(GAS_LIMIT_FOR_EOA, ALLOW_OUT_OF_ORDER),
  }
}

export type RateLimitState = { tokens: bigint; capacity: bigint; isEnabled: boolean }

export type CcipPlan = {
  protocol: 'ccip'
  chain: ChainKey
  /** The official router from the config. The only allowed approve spender. */
  router: Address
  token: Address
  tokenSymbol: string
  decimals: number
  pool: Address
  sender: Address
  amount: bigint
  /** What arrives, in the DESTINATION token's own units (its decimals may differ). */
  received: bigint
  dst: { chain: ChainKey; selector: bigint; token?: Address; decimals?: number; pool?: Address }
  recipient: Address
  message: CcipMessage
  /** getFee(), in the native coin. */
  fee: bigint
  /** msg.value === fee, exactly: the router keeps whatever is sent. */
  value: bigint
  outbound: RateLimitState | undefined
  inbound: RateLimitState | undefined
}

export class CcipPlanError extends Error {
  constructor(
    public readonly code: 'chain_unsupported' | 'amount_zero' | 'recipient_vm_mismatch' | 'fee_failed' | 'route_unsupported',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'CcipPlanError'
  }
}

export type BuildCcipPlanInput = {
  chain: ChainKey
  dstChain: ChainKey
  dstSelector: bigint
  token: Address
  tokenSymbol: string
  decimals: number
  pool: Address
  remote: RemoteSide
  sender: Address
  recipient: Recipient
  amount: bigint
  srcClient: ReadClient
  dstClient: ReadClient
}

/** Scales an amount between two token decimals. Exact by construction; no floats. */
export function scaleAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals === fromDecimals) return amount
  return toDecimals > fromDecimals
    ? amount * 10n ** BigInt(toDecimals - fromDecimals)
    : amount / 10n ** BigInt(fromDecimals - toDecimals)
}

export async function buildCcipPlan(p: BuildCcipPlanInput): Promise<CcipPlan> {
  const cfg = ccipConfig(p.chain)
  if (!cfg) throw new CcipPlanError('chain_unsupported', p.chain)
  if (p.recipient.vm !== 'evm') throw new CcipPlanError('recipient_vm_mismatch', p.recipient.vm)
  if (p.amount <= 0n) throw new CcipPlanError('amount_zero')

  const router = getAddress(cfg.router)
  const srcSelector = cfg.selector

  const recipient = p.recipient.display as Address
  const message = buildCcipMessage({ recipient, token: p.token, amount: p.amount })

  let fee: bigint
  try {
    fee = await p.srcClient.readContract({
      address: router,
      abi: ccipRouterAbi,
      functionName: 'getFee',
      args: [p.dstSelector, message],
    })
  } catch (e) {
    throw new CcipPlanError('fee_failed', e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e))
  }

  // Outbound is this pool's bucket for the destination; inbound is the DESTINATION pool's bucket
  // for us, read on its own chain. Two different functions, not the same one twice.
  const [outbound, inbound] = await Promise.all([
    readOutboundLimit(p.srcClient, p.pool, p.dstSelector),
    p.remote.pool ? readInboundLimit(p.dstClient, p.remote.pool, srcSelector) : Promise.resolve(undefined),
  ])

  return {
    protocol: 'ccip',
    chain: p.chain,
    router,
    token: p.token,
    tokenSymbol: p.tokenSymbol,
    decimals: p.decimals,
    pool: p.pool,
    sender: p.sender,
    amount: p.amount,
    received: p.remote.decimals === undefined ? p.amount : scaleAmount(p.amount, p.decimals, p.remote.decimals),
    dst: {
      chain: p.dstChain,
      selector: p.dstSelector,
      ...(p.remote.token ? { token: p.remote.token } : {}),
      ...(p.remote.decimals !== undefined ? { decimals: p.remote.decimals } : {}),
      ...(p.remote.pool ? { pool: p.remote.pool } : {}),
    },
    recipient,
    message,
    fee,
    value: fee,
    outbound,
    inbound,
  }
}

export async function readOutboundLimit(client: ReadClient, pool: Address, selector: bigint): Promise<RateLimitState | undefined> {
  try {
    const b = await client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getCurrentOutboundRateLimiterState', args: [selector] })
    return { tokens: b.tokens, capacity: b.capacity, isEnabled: b.isEnabled }
  } catch {
    return undefined
  }
}

/** The inbound bucket on the destination pool, for the chain we are sending from. */
export async function readInboundLimit(client: ReadClient, pool: Address, srcSelector: bigint): Promise<RateLimitState | undefined> {
  try {
    const b = await client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getCurrentInboundRateLimiterState', args: [srcSelector] })
    return { tokens: b.tokens, capacity: b.capacity, isEnabled: b.isEnabled }
  } catch {
    return undefined
  }
}

export type CcipSendArgs = readonly [bigint, CcipMessage]

export function assembleCcipSendArgs(plan: CcipPlan): CcipSendArgs {
  return [plan.dst.selector, plan.message]
}
