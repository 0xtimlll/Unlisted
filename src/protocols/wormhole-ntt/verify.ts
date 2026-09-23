/**
 * §Task 5: may this NttManager be given an approve?
 *
 * The manager is the spender. A contract that merely answers `token()` with the right address is
 * trivial to deploy, so naming the token proves nothing — the TOKEN has to name the manager back.
 * All four of these must hold, and a check that cannot be completed counts as a failure:
 *
 *   1. The token is in Wormhole's official NTT token list for this chain, and
 *      manager.token() is exactly that listed address.
 *   2. A token-side anchor on at least ONE side of the pair: the listed token names the manager as
 *      its minter — minter() == manager, or hasRole(MINTER_ROLE, manager) for AccessControl tokens,
 *      with the role read from the token itself. A locking hub has no minter, so it is confirmed
 *      transitively through the burning spoke's anchor.
 *   3. Peers in both directions: source.getPeer(dst) == destination manager AND
 *      destination.getPeer(src) == source manager, read on the destination's own RPC.
 *   4. A Wormhole transceiver: it reports the Wormhole type and points at the core bridge this
 *      chain's official address, and it has automatic relaying enabled for the destination.
 *
 * Wormholescan's decoded operations are deliberately NOT evidence here: `sourceNttManager` is
 * written by the manager itself, so one self-made transfer would launder a fake. They are shown as
 * context in the details and never feed a decision.
 */
import { getAddress, isAddressEqual, type Address } from 'viem'
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { isZeroBytes32, peerToAddress } from '../../core/encoding'
import { nttManagerAbi, nttTokenAnchorAbi, WORMHOLE_TRANSCEIVER_TYPE, wormholeTransceiverAbi, nttMode, type NttMode } from './abi'
import { WORMHOLE_CHAINS, wormholeChainId } from './chains'
import { findListedToken, type NttToken } from './tokenList'

export type NttRejectionCode =
  | 'chain_unsupported'
  | 'token_not_listed'
  | 'manager_token_mismatch'
  | 'manager_wrong_chain_id'
  | 'peer_missing'
  | 'peer_not_evm'
  | 'peer_mismatch'
  | 'dst_token_not_listed'
  | 'no_token_anchor'
  | 'no_wormhole_transceiver'
  | 'transceiver_wrong_core_bridge'
  | 'manual_delivery_only'
  | 'unverifiable'

/** Which side of the pair the token vouched for the manager on. */
export type AnchorSide = 'source' | 'destination'
export type AnchorKind = 'minter' | 'role'

export type VerifiedNttManager = {
  chain: ChainKey
  manager: Address
  token: Address
  tokenSymbol: string
  mode: NttMode
  tokenDecimals: number
  dst: {
    chain: ChainKey
    wormholeChainId: number
    manager: Address
    /** The destination token's decimals, as the peer entry records them. */
    tokenDecimals: number
  }
  /** The Wormhole transceiver that will carry the message. */
  transceiver: Address
  anchor: { side: AnchorSide; kind: AnchorKind }
}

export type NttVerification = { ok: true; verified: VerifiedNttManager } | { ok: false; code: NttRejectionCode; detail?: string }

const fail = (code: NttRejectionCode, detail?: string): NttVerification => (detail === undefined ? { ok: false, code } : { ok: false, code, detail })

/** A read that must succeed. `undefined` means the provider could not answer, which blocks. */
async function read<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

export type VerifyInput = {
  srcChain: ChainKey
  dstChain: ChainKey
  manager: string
  srcClient: ReadClient
  dstClient: ReadClient
  tokenList: readonly NttToken[]
}

export async function verifyNttManager(p: VerifyInput): Promise<NttVerification> {
  const srcWh = wormholeChainId(p.srcChain)
  const dstWh = wormholeChainId(p.dstChain)
  if (srcWh === undefined || dstWh === undefined) return fail('chain_unsupported', `${p.srcChain} -> ${p.dstChain}`)

  let manager: Address
  try {
    manager = getAddress(p.manager)
  } catch {
    return fail('unverifiable', 'not an address')
  }
  const base = { address: manager, abi: nttManagerAbi } as const

  // ---- 1. the manager's own answers, and the official token list ------------
  const token = await read(() => p.srcClient.readContract({ ...base, functionName: 'token' }))
  if (!token) return fail('unverifiable', 'manager.token()')
  const listed = findListedToken(p.tokenList, p.srcChain, token)
  if (!listed) return fail('token_not_listed', token)
  if (!isAddressEqual(getAddress(token), listed.address)) return fail('manager_token_mismatch', token)

  const chainIdOnChain = await read(() => p.srcClient.readContract({ ...base, functionName: 'chainId' }))
  if (chainIdOnChain === undefined) return fail('unverifiable', 'manager.chainId()')
  if (Number(chainIdOnChain) !== srcWh) return fail('manager_wrong_chain_id', `${chainIdOnChain} != ${srcWh}`)

  const modeRaw = await read(() => p.srcClient.readContract({ ...base, functionName: 'getMode' }))
  if (modeRaw === undefined) return fail('unverifiable', 'manager.getMode()')
  const mode = nttMode(Number(modeRaw))
  if (!mode) return fail('unverifiable', `unknown mode ${modeRaw}`)

  const tokenDecimals = await read(() => p.srcClient.readContract({ ...base, functionName: 'tokenDecimals' }))
  if (tokenDecimals === undefined) return fail('unverifiable', 'manager.tokenDecimals()')

  // ---- 3. peers, both directions -------------------------------------------
  const peer = await read(() => p.srcClient.readContract({ ...base, functionName: 'getPeer', args: [dstWh] }))
  if (!peer) return fail('unverifiable', 'manager.getPeer()')
  if (isZeroBytes32(peer.peerAddress)) return fail('peer_missing', p.dstChain)
  const dstManager = peerToAddress(peer.peerAddress)
  if (!dstManager) return fail('peer_not_evm', peer.peerAddress)
  if (peer.tokenDecimals === 0) return fail('unverifiable', 'peer decimals are zero')

  const dstBase = { address: dstManager, abi: nttManagerAbi } as const
  const backPeer = await read(() => p.dstClient.readContract({ ...dstBase, functionName: 'getPeer', args: [srcWh] }))
  if (!backPeer) return fail('unverifiable', 'destination getPeer()')
  const backAddress = peerToAddress(backPeer.peerAddress)
  if (!backAddress || !isAddressEqual(backAddress, manager)) return fail('peer_mismatch', backPeer.peerAddress)

  const dstToken = await read(() => p.dstClient.readContract({ ...dstBase, functionName: 'token' }))
  if (!dstToken) return fail('unverifiable', 'destination token()')
  const dstListed = findListedToken(p.tokenList, p.dstChain, dstToken)
  if (!dstListed) return fail('dst_token_not_listed', dstToken)

  // ---- 2. the token-side anchor, on either side -----------------------------
  const srcAnchor = await tokenAnchors(p.srcClient, listed.address, manager)
  const dstAnchor = srcAnchor ? undefined : await tokenAnchors(p.dstClient, dstListed.address, dstManager)
  const anchor = srcAnchor ? ({ side: 'source' as const, kind: srcAnchor }) : dstAnchor ? ({ side: 'destination' as const, kind: dstAnchor }) : undefined
  if (!anchor) return fail('no_token_anchor', `${listed.address} / ${dstListed.address}`)

  // ---- 4. a Wormhole transceiver with automatic delivery --------------------
  const transceivers = await read(() => p.srcClient.readContract({ ...base, functionName: 'getTransceivers' }))
  if (!transceivers) return fail('unverifiable', 'manager.getTransceivers()')
  const coreBridge = WORMHOLE_CHAINS[p.srcChain]?.coreBridge
  if (!coreBridge) return fail('chain_unsupported', `no core bridge for ${p.srcChain}`)

  let wormholeTransceiver: Address | undefined
  let sawWormholeType = false
  let wrongCoreBridge = false
  for (const t of transceivers) {
    const type = await read(() => p.srcClient.readContract({ address: t, abi: wormholeTransceiverAbi, functionName: 'getTransceiverType' }))
    if (type !== WORMHOLE_TRANSCEIVER_TYPE) continue
    sawWormholeType = true
    const core = await read(() => p.srcClient.readContract({ address: t, abi: wormholeTransceiverAbi, functionName: 'wormhole' }))
    if (!core || !isAddressEqual(getAddress(core), getAddress(coreBridge))) {
      wrongCoreBridge = true
      continue
    }
    wormholeTransceiver = t
    break
  }
  if (!wormholeTransceiver) {
    if (wrongCoreBridge) return fail('transceiver_wrong_core_bridge', coreBridge)
    return fail('no_wormhole_transceiver', sawWormholeType ? 'core bridge unreadable' : `${transceivers.length} transceiver(s)`)
  }

  // Automatic delivery only. A transfer that would need a manual redeem is refused, and a build
  // that does not expose these getters counts as "cannot confirm" — which is also a refusal.
  const [viaRelayer, viaSpecial] = await Promise.all([
    read(() => p.srcClient.readContract({ address: wormholeTransceiver!, abi: wormholeTransceiverAbi, functionName: 'isWormholeRelayingEnabled', args: [dstWh] })),
    read(() => p.srcClient.readContract({ address: wormholeTransceiver!, abi: wormholeTransceiverAbi, functionName: 'isSpecialRelayingEnabled', args: [dstWh] })),
  ])
  if (viaRelayer === undefined && viaSpecial === undefined) return fail('unverifiable', 'relaying getters unavailable')
  if (viaRelayer !== true && viaSpecial !== true) return fail('manual_delivery_only', p.dstChain)

  return {
    ok: true,
    verified: {
      chain: p.srcChain,
      manager,
      token: listed.address,
      tokenSymbol: listed.token.symbol,
      mode,
      tokenDecimals: Number(tokenDecimals),
      dst: { chain: p.dstChain, wormholeChainId: dstWh, manager: dstManager, tokenDecimals: peer.tokenDecimals },
      transceiver: wormholeTransceiver,
      anchor,
    },
  }
}

/**
 * Does this token name the manager as its minter? `minter()` first (the reference NTT token), then
 * AccessControl, with MINTER_ROLE read from the token so no role hash is assumed here.
 */
async function tokenAnchors(client: ReadClient, token: Address, manager: Address): Promise<AnchorKind | undefined> {
  const minter = await read(() => client.readContract({ address: token, abi: nttTokenAnchorAbi, functionName: 'minter' }))
  if (minter && isAddressEqual(getAddress(minter), manager)) return 'minter'

  const role = await read(() => client.readContract({ address: token, abi: nttTokenAnchorAbi, functionName: 'MINTER_ROLE' }))
  if (!role) return undefined
  const has = await read(() => client.readContract({ address: token, abi: nttTokenAnchorAbi, functionName: 'hasRole', args: [role, manager] }))
  return has === true ? 'role' : undefined
}
