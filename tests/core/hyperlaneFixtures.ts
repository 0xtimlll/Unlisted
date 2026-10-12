/**
 * Hyperlane fixtures: a Mailbox message built the way Message.sol packs it, and the stub plans and
 * guard inputs the gate tests run the real guards over. Nothing here touches the network.
 */
import { encodePacked, getAddress, pad, type Address, type Hex } from 'viem'
import { evmAddressToBytes32 } from '@/protocols/hyperlane/abi'
import { hyperlaneConfig } from '@/protocols/hyperlane/chains'
import { UNSCALED, type RemoteWarp, type WarpRouter } from '@/protocols/hyperlane/discover'
import type { HyperlaneGuardInput } from '@/protocols/hyperlane/guards'
import type { HyperlanePlan } from '@/protocols/hyperlane/plan'

export const HL = {
  ROUTER: getAddress('0x1111111111111111111111111111111111111111'),
  TOKEN: getAddress('0x2222222222222222222222222222222222222222'),
  DST_ROUTER: getAddress('0x3333333333333333333333333333333333333333'),
  DST_TOKEN: getAddress('0x4444444444444444444444444444444444444444'),
  WALLET: getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9'),
  OTHER: getAddress('0x5555555555555555555555555555555555555555'),
  MAILBOX_ETH: getAddress(hyperlaneConfig('ethereum')!.mailbox),
  MAILBOX_BASE: getAddress(hyperlaneConfig('base')!.mailbox),
}

/** version u8 | nonce u32 | origin u32 | sender b32 | destination u32 | recipient b32 | body */
export function hyperlaneMessageBytes(p: {
  version?: number
  nonce?: number
  origin: number
  sender: Address
  destination: number
  recipient: Address
  body: { recipient: Address; amount: bigint; metadata?: Hex } | Hex
}): Hex {
  const body: Hex =
    typeof p.body === 'string'
      ? p.body
      : (`${encodePacked(['bytes32', 'uint256'], [pad(p.body.recipient, { size: 32 }), p.body.amount])}${(p.body.metadata ?? '0x').slice(2)}` as Hex)
  return encodePacked(
    ['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [p.version ?? 3, p.nonce ?? 7, p.origin, pad(p.sender, { size: 32 }), p.destination, pad(p.recipient, { size: 32 }), body],
  )
}

/** A collateral route on Ethereum to Base, every claim consistent. */
export function warpRouter(over: Partial<WarpRouter> = {}): WarpRouter {
  return {
    kind: 'router',
    router: HL.ROUTER,
    warpKind: 'collateral',
    token: HL.TOKEN,
    decimals: 18,
    symbol: 'TKN',
    mailbox: HL.MAILBOX_ETH,
    domain: 1,
    scale: UNSCALED,
    feeRecipient: undefined,
    feeTokenIsNative: true,
    version: '7.1.0',
    owner: HL.OTHER,
    hook: undefined,
    ism: undefined,
    routes: [{ chain: 'base', domain: 8453, router: HL.DST_ROUTER }],
    ...over,
  }
}

export function remoteWarp(over: Partial<RemoteWarp> = {}): RemoteWarp {
  return {
    chain: 'base',
    domain: 8453,
    router: HL.DST_ROUTER,
    readable: true,
    mailboxOk: true,
    pointsBack: true,
    warpKind: 'synthetic',
    token: HL.DST_ROUTER,
    decimals: 18,
    symbol: 'TKN',
    scale: UNSCALED,
    ...over,
  }
}

export function hyperlanePlan(over: Partial<HyperlanePlan> = {}): HyperlanePlan {
  const amount = 10n ** 18n
  const recipient = over.recipient ?? HL.WALLET
  return {
    protocol: 'hyperlane',
    chain: 'ethereum',
    router: HL.ROUTER,
    warpKind: 'collateral',
    token: HL.TOKEN,
    tokenSymbol: 'TKN',
    decimals: 18,
    mailbox: HL.MAILBOX_ETH,
    sender: HL.WALLET,
    amount,
    routeFee: 0n,
    charge: amount,
    messageAmount: amount,
    received: amount,
    dst: { chain: 'base', domain: 8453, router: HL.DST_ROUTER, token: HL.DST_ROUTER, decimals: 18, symbol: 'TKN' },
    recipient,
    recipientBytes32: evmAddressToBytes32(recipient),
    fee: 10n ** 15n,
    value: 10n ** 15n,
    quoteSource: 'quoteGasPayment',
    destinationGas: 64_000n,
    ...over,
  }
}

export function hyperlaneInput(over: Partial<HyperlaneGuardInput> = {}): HyperlaneGuardInput {
  const plan = hyperlanePlan()
  return {
    walletAddress: HL.WALLET,
    walletChainId: 1,
    srcChainId: 1,
    srcChain: 'ethereum',
    plan,
    remote: remoteWarp(),
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
