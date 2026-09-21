/**
 * §4.2 Solana-side discovery. Input: the raw bytes32 peer from `peers(30168)` on the EVM OFT.
 * Everything else is read from the chain — no hardcoded mints, programs or stores:
 *
 *   peer (bytes32) → OFT Store pubkey → account.owner = this token's OFT program
 *   OFT Store data → tokenMint, tokenEscrow, oftType, paused, defaultFeeBps, ld2sdRate
 *   tokenMint.owner → Token or Token-2022 program (drives ATA derivation)
 *   PeerConfig PDA ["Peer", oftStore, be_u32(srcEid)] → back-link + enforced options
 */
import type { Address, Hex } from 'viem'
import { addressToBytes32 } from '../encoding'
import type { PeerBackResult } from '../verify'
import { decodeMint, decodeOftStore, decodePeerConfig, decodeTokenAccount, LayoutError, type OftStore } from './layouts'
import { findProgramAddress, PROGRAM, pubkeyFromBase58, pubkeyFromHex, pubkeyToBase58, u32be, utf8 } from './pubkey'
import type { SvmRpc } from './rpc'

import { SvmDiscoverError } from './errors'
export { SvmDiscoverError } from './errors'

export type TokenProgram = 'token' | 'token2022'

/** The svm counterpart of OftInfo. */
export type SvmOftInfo = {
  /** base58 OFT Store (== the peer). */
  oftStore: string
  /** base58 program id of this token's OFT program (account owner of the store). */
  programId: string
  oftType: 'native' | 'adapter'
  tokenMint: string
  tokenEscrow: string
  tokenProgram: TokenProgram
  decimals: number
  ld2sdRate: bigint
  paused: boolean
  defaultFeeBps: number
  tvlLd: bigint
  /** PeerConfig for the *source* chain we are bridging from (undefined = not configured). */
  peer:
    | { configured: true; address: string; peerAddress: Hex; enforcedSend: Hex; enforcedSendAndCall: Hex }
    | { configured: false; address: string }
}

const TOKEN_PROGRAMS: Record<string, TokenProgram> = { [PROGRAM.token]: 'token', [PROGRAM.token2022]: 'token2022' }

export function peerConfigAddress(oftStore: string, programId: string, remoteEid: number): string {
  const { address } = findProgramAddress([utf8('Peer'), pubkeyFromBase58(oftStore), u32be(remoteEid)], pubkeyFromBase58(programId))
  return pubkeyToBase58(address)
}

export async function discoverSvmOft(rpc: SvmRpc, peer: Hex, srcEid: number): Promise<SvmOftInfo> {
  let oftStore: string
  try {
    oftStore = pubkeyToBase58(pubkeyFromHex(peer))
  } catch {
    throw new SvmDiscoverError('bad_peer')
  }

  const store = await rpc.getAccountInfo(oftStore)
  if (!store) throw new SvmDiscoverError('store_missing', `no account at ${oftStore}`)
  let decoded: OftStore
  try {
    decoded = decodeOftStore(store.data)
  } catch (e) {
    throw new SvmDiscoverError('not_oft_store', e instanceof LayoutError ? e.message : String(e))
  }
  const programId = store.owner

  const peerConfig = peerConfigAddress(oftStore, programId, srcEid)
  const [mint, escrow, peerAcc] = await rpc.getMultipleAccounts([decoded.tokenMint, decoded.tokenEscrow, peerConfig])
  if (!mint) throw new SvmDiscoverError('mint_missing', decoded.tokenMint)
  const tokenProgram = TOKEN_PROGRAMS[mint.owner]
  if (!tokenProgram) throw new SvmDiscoverError('unknown_token_program', mint.owner)
  const { decimals } = decodeMint(mint.data)

  // The escrow must be a token account of this mint; anything else is not the store we think.
  if (escrow) {
    try {
      const esc = decodeTokenAccount(escrow.data)
      if (esc.mint !== decoded.tokenMint) throw new SvmDiscoverError('escrow_mismatch', `${esc.mint} != ${decoded.tokenMint}`)
    } catch (e) {
      if (e instanceof SvmDiscoverError) throw e
      throw new SvmDiscoverError('escrow_mismatch', String(e))
    }
  }

  let peerInfo: SvmOftInfo['peer'] = { configured: false, address: peerConfig }
  if (peerAcc && peerAcc.owner === programId) {
    const pc = decodePeerConfig(peerAcc.data)
    peerInfo = { configured: true, address: peerConfig, peerAddress: pc.peerAddress, enforcedSend: pc.enforcedSend, enforcedSendAndCall: pc.enforcedSendAndCall }
  }

  return {
    oftStore,
    programId,
    oftType: decoded.oftType,
    tokenMint: decoded.tokenMint,
    tokenEscrow: decoded.tokenEscrow,
    tokenProgram,
    decimals,
    ld2sdRate: decoded.ld2sdRate,
    paused: decoded.paused,
    defaultFeeBps: decoded.defaultFeeBps,
    tvlLd: decoded.tvlLd,
    peer: peerInfo,
  }
}

/** Guard 17 for a Solana destination: its PeerConfig for our chain must name our EVM OFT. */
export function checkPeerBackSvm(info: SvmOftInfo, srcOft: Address): PeerBackResult {
  if (!info.peer.configured) return { status: 'mismatch', theirPeer: `0x${'0'.repeat(64)}` }
  return info.peer.peerAddress.toLowerCase() === addressToBytes32(srcOft).toLowerCase()
    ? { status: 'ok' }
    : { status: 'mismatch', theirPeer: info.peer.peerAddress }
}
