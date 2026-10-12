/**
 * The exact `transferRemote` that will be sent over a Hyperlane warp route, and what it costs.
 *
 *   transferRemote(destination, recipient, amount)   token/libs/TokenRouter.sol, every generation
 *
 *   destination   the registry's domain for the chosen chain (chains.ts) — the router resolves the
 *                 far router itself from `routers(destination)`, nothing about the far side is
 *                 passed in
 *   recipient     the EVM address left-padded to bytes32, exactly as TypeCasts.bytes32ToAddress
 *                 will read it on the other side
 *   amount        in the token's own units; the router scales it onto the wire (abi.ts)
 *
 * What the wallet pays, by generation:
 *
 *   core 10+   `quoteTransferRemote` answers three quotes: [0] the Mailbox dispatch fee in the
 *              native coin, [1] the amount PLUS the route's own fee (`feeRecipient()`), [2] an
 *              external bridging fee. `_calculateFeesAndCharge` pulls [1] + [2] from the sender —
 *              so for a collateral route that sum, not the amount, is what the allowance has to
 *              cover, and the approve is for exactly it.
 *   5.x / 7.x  `quoteGasPayment(destination)` is the dispatch fee; the route takes nothing of its
 *              own, and the sender is charged the amount alone.
 *
 * msg.value is EXACTLY the dispatch fee (plus the amount itself on a native route), with no buffer:
 * the Mailbox's hooks refund an overpayment only to whatever refund address the route's metadata
 * names, and this app does not build that metadata. A fee that moves between the quote and the
 * send makes the Mailbox revert ("insufficient interchain gas payment"), which is the safe way to
 * be wrong; the quote is refreshed every 30 seconds while the form is open.
 *
 * A route whose dispatch fee is quoted in the token (`feeToken() != 0`, core 12+) is refused here:
 * its charge would be an allowance this app has not modelled, and an approve it cannot name
 * exactly is an approve it does not send.
 */
import { isAddressEqual, type Address, type Hex } from 'viem'
import { type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { ZERO_ADDRESS } from '../../core/encoding'
import { readOptional, UnreadableError } from '../../core/rpcErrors'
import type { Recipient } from '../../core/recipient'
import { evmAddressToBytes32, warpRouteAbi } from './abi'
import { hyperlaneConfig } from './chains'
import type { RemoteWarp, WarpKind, WarpRouter, WarpScale } from './discover'

export type HyperlanePlan = {
  protocol: 'hyperlane'
  chain: ChainKey
  /** The warp route. The only allowed approve spender, and only for a collateral route. */
  router: Address
  warpKind: WarpKind
  /** The ERC-20 that leaves the wallet; undefined on a native route (the coin leaves as value). */
  token: Address | undefined
  tokenSymbol: string
  decimals: number
  /** The registry Mailbox the router was verified against. */
  mailbox: Address
  sender: Address
  /** What the person typed: what is bridged, before the route's own fee. */
  amount: bigint
  /** The route's own fee on top of `amount` (core 10+ `feeRecipient()`); 0 on older routes. */
  routeFee: bigint
  /** amount + routeFee (+ external fee): what the router pulls, burns, or takes from msg.value. */
  charge: bigint
  /** `amount` scaled onto the wire by this router (abi.ts). */
  messageAmount: bigint
  /** What arrives, in the DESTINATION token's own units, after the far router's inverse scale. */
  received: bigint
  dst: {
    chain: ChainKey
    domain: number
    /** The far router, as THIS router names it (routers(domain)). */
    router: Address
    token?: Address
    decimals?: number
    symbol?: string
  }
  recipient: Address
  /** `recipient`, encoded the way the far router will read it. */
  recipientBytes32: Hex
  /** The Mailbox dispatch fee, in the native coin. */
  fee: bigint
  /** msg.value: the fee, plus `charge` on a native route. Exactly, never more. */
  value: bigint
  quoteSource: 'quoteTransferRemote' | 'quoteGasPayment'
  /** The gas the route will buy on the destination (GasRouter.destinationGas), when readable. */
  destinationGas: bigint | undefined
}

export class HyperlanePlanError extends Error {
  constructor(
    public readonly code: 'chain_unsupported' | 'amount_zero' | 'recipient_vm_mismatch' | 'route_missing' | 'fee_failed' | 'fee_token_unsupported',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'HyperlanePlanError'
  }
}

export type BuildHyperlanePlanInput = {
  chain: ChainKey
  dstChain: ChainKey
  router: WarpRouter
  /** The far side, when it has been read; its scale decides what arrives. */
  remote: RemoteWarp | undefined
  sender: Address
  recipient: Recipient
  amount: bigint
  srcClient: ReadClient
}

/** messageAmount = amount × numerator / denominator, rounded down (TokenRouter._outboundAmount). */
export function scaleOut(amount: bigint, scale: WarpScale): bigint {
  return (amount * scale.numerator) / scale.denominator
}

/** localAmount = messageAmount × denominator / numerator, rounded down (TokenRouter._inboundAmount). */
export function scaleIn(messageAmount: bigint, scale: WarpScale): bigint {
  return (messageAmount * scale.denominator) / scale.numerator
}

/** The route's own fee as a share of the amount, in basis points. 0 when there is no fee. */
export function routeFeeBps(plan: Pick<HyperlanePlan, 'amount' | 'routeFee'>): bigint {
  if (plan.amount <= 0n || plan.routeFee <= 0n) return 0n
  return (plan.routeFee * 10_000n) / plan.amount
}

const read = <T,>(fn: () => Promise<T>): Promise<T | undefined> => readOptional('Hyperlane quote', fn)

export async function buildHyperlanePlan(p: BuildHyperlanePlanInput): Promise<HyperlanePlan> {
  const cfg = hyperlaneConfig(p.chain)
  const dstCfg = hyperlaneConfig(p.dstChain)
  if (!cfg || !dstCfg) throw new HyperlanePlanError('chain_unsupported', `${p.chain} -> ${p.dstChain}`)
  if (p.recipient.vm !== 'evm') throw new HyperlanePlanError('recipient_vm_mismatch', p.recipient.vm)
  if (p.amount <= 0n) throw new HyperlanePlanError('amount_zero')
  const route = p.router.routes.find((r) => r.chain === p.dstChain && r.domain === dstCfg.domain)
  if (!route) throw new HyperlanePlanError('route_missing', p.dstChain)
  if (!p.router.feeTokenIsNative) throw new HyperlanePlanError('fee_token_unsupported')

  const recipient = p.recipient.display as Address
  const recipientBytes32 = evmAddressToBytes32(recipient)
  const call = { address: p.router.router, abi: warpRouteAbi } as const

  // The quote, by generation. A refusal of the newer function is an answer ("not this
  // generation"); a provider that does not answer at all is a failed quote, not a cheaper one.
  let fee: bigint
  let charge: bigint
  let quoteSource: HyperlanePlan['quoteSource']
  try {
    const quotes = await read(() => p.srcClient.readContract({ ...call, functionName: 'quoteTransferRemote', args: [dstCfg.domain, recipientBytes32, p.amount] }))
    if (quotes !== undefined && quotes.length >= 1) {
      const [dispatch, bridged, external] = quotes
      if (!dispatch || !isAddressEqual(dispatch.token, ZERO_ADDRESS)) throw new HyperlanePlanError('fee_token_unsupported')
      const expectToken = p.router.token ?? ZERO_ADDRESS
      if (bridged && !isAddressEqual(bridged.token, expectToken)) throw new HyperlanePlanError('fee_failed', 'the route quotes its fee in a token it does not move')
      if (external && !isAddressEqual(external.token, expectToken)) throw new HyperlanePlanError('fee_failed', 'the route quotes an external fee in a token it does not move')
      fee = dispatch.amount
      charge = (bridged?.amount ?? p.amount) + (external?.amount ?? 0n)
      if (charge < p.amount) throw new HyperlanePlanError('fee_failed', 'the route quotes a charge below the amount')
      quoteSource = 'quoteTransferRemote'
    } else {
      const gas = await read(() => p.srcClient.readContract({ ...call, functionName: 'quoteGasPayment', args: [dstCfg.domain] }))
      if (gas === undefined) throw new HyperlanePlanError('fee_failed', 'the route answered neither quoteTransferRemote nor quoteGasPayment')
      fee = gas
      charge = p.amount
      quoteSource = 'quoteGasPayment'
    }
  } catch (e) {
    if (e instanceof HyperlanePlanError) throw e
    if (e instanceof UnreadableError) throw new HyperlanePlanError('fee_failed', e.message)
    throw new HyperlanePlanError('fee_failed', e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e))
  }

  const destinationGas = await read(() => p.srcClient.readContract({ ...call, functionName: 'destinationGas', args: [dstCfg.domain] }))

  const messageAmount = scaleOut(p.amount, p.router.scale)
  const received = p.remote?.scale ? scaleIn(messageAmount, p.remote.scale) : messageAmount
  const native = p.router.warpKind === 'native'

  return {
    protocol: 'hyperlane',
    chain: p.chain,
    router: p.router.router,
    warpKind: p.router.warpKind,
    token: p.router.token,
    tokenSymbol: p.router.symbol,
    decimals: p.router.decimals,
    mailbox: p.router.mailbox,
    sender: p.sender,
    amount: p.amount,
    routeFee: charge - p.amount,
    charge,
    messageAmount,
    received,
    dst: {
      chain: p.dstChain,
      domain: dstCfg.domain,
      router: route.router,
      ...(p.remote?.token ? { token: p.remote.token } : {}),
      ...(p.remote?.decimals !== undefined ? { decimals: p.remote.decimals } : {}),
      ...(p.remote?.symbol !== undefined ? { symbol: p.remote.symbol } : {}),
    },
    recipient,
    recipientBytes32,
    fee,
    value: native ? fee + charge : fee,
    quoteSource,
    destinationGas,
  }
}

export type TransferRemoteArgs = readonly [number, Hex, bigint]

/** The three arguments, from the plan and nothing else. */
export function assembleTransferRemoteArgs(plan: HyperlanePlan): TransferRemoteArgs {
  return [plan.dst.domain, plan.recipientBytes32, plan.amount]
}
