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
import { decodeAnyOftStore, decodeAnyPeer, decodeMint, decodeTokenAccount } from './layouts'
import { findProgramAddress, PROGRAM, pubkeyFromBase58, pubkeyFromHex, pubkeyToBase58, u32be, utf8 } from './pubkey'
import type { SvmRpc } from './rpc'

import { SvmDiscoverError } from './errors'
export { SvmDiscoverError } from './errors'

export type TokenProgram = 'token' | 'token2022'

/**
 * How well we could read the Solana side.
 *
 *   OFTStore / OftConfig — one of LayerZero's two official store layouts, fully read
 *   unknown              — the account exists and is owned by a program, but is neither; we can
 *                          say nothing about the mint, so the UI warns instead of blocking
 */
export type SvmStoreLayout = 'OFTStore' | 'OftConfig' | 'unknown'

/** The svm counterpart of OftInfo. */
export type SvmOftInfo = {
  /** base58 OFT Store (== the peer). */
  oftStore: string
  /** base58 program id of this token's OFT program (account owner of the store). */
  programId: string
  /** Which official layout the store turned out to be. */
  layout: SvmStoreLayout
  /** True when the store owner is an executable program account. */
  ownerIsProgram: boolean
  oftType: 'native' | 'adapter'
  tokenMint: string
  /** Absent for a native OFT of the earlier generation, which holds no escrow. */
  tokenEscrow?: string
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

/**
 * The store exists but matches neither official layout. Everything that depends on the mint is
 * unavailable, so the caller warns and lets the user decide — it does not block, because the route
 * itself may be perfectly good (the EVM side's own quote is what actually proves that).
 */
export type SvmUnknownStore = {
  oftStore: string
  programId: string
  layout: 'unknown'
  ownerIsProgram: boolean
  /** Why it was not recognised, for the details block. */
  reason: string
  dataLength: number
  /**
   * Both official programs derive the peer account from the same seeds and put the remote address
   * first, so the back-link is still worth attempting. Absent when it could not be read — which is
   * reported as "unverified", never as a match.
   */
  peerAddress?: Hex
}

export type SvmDestination = { recognised: true; info: SvmOftInfo } | { recognised: false; store: SvmUnknownStore }

const TOKEN_PROGRAMS: Record<string, TokenProgram> = { [PROGRAM.token]: 'token', [PROGRAM.token2022]: 'token2022' }

export function peerConfigAddress(oftStore: string, programId: string, remoteEid: number): string {
  const { address } = findProgramAddress([utf8('Peer'), pubkeyFromBase58(oftStore), u32be(remoteEid)], pubkeyFromBase58(programId))
  return pubkeyToBase58(address)
}

/**
 * §The Solana side, in tiers.
 *
 *   no account at the peer address        -> throw (there is nothing to send to)
 *   a store in either official layout     -> fully read, no warnings
 *   an account we cannot parse            -> `recognised: false`; the caller warns, does not block
 *
 * The data length is never checked against a fixed number: layouts differ between generations and
 * grow with optional fields, so only the discriminator and the fields themselves decide.
 */
export async function discoverSvmOft(rpc: SvmRpc, peer: Hex, srcEid: number): Promise<SvmDestination> {
  let oftStore: string
  try {
    oftStore = pubkeyToBase58(pubkeyFromHex(peer))
  } catch {
    throw new SvmDiscoverError('bad_peer')
  }

  const store = await rpc.getAccountInfo(oftStore)
  if (!store) throw new SvmDiscoverError('store_missing', `no account at ${oftStore}`)
  const programId = store.owner

  // Is the owner a real program? Used only to describe the account, never to accept or refuse it.
  const ownerAcc = await rpc.getAccountInfo(programId).catch(() => null)
  const ownerIsProgram = ownerAcc?.executable === true

  const unknown = async (reason: string): Promise<SvmDestination> => {
    // A best-effort back-link: same seeds, same leading 32 bytes in both official programs.
    let peerAddress: Hex | undefined
    try {
      const acc = await rpc.getAccountInfo(peerConfigAddress(oftStore, programId, srcEid))
      if (acc && acc.owner === programId) peerAddress = decodeAnyPeer(acc.data).peerAddress
    } catch {
      /* not readable: reported as unverified */
    }
    return {
      recognised: false,
      store: { oftStore, programId, layout: 'unknown', ownerIsProgram, reason, dataLength: store.data.length, ...(peerAddress ? { peerAddress } : {}) },
    }
  }

  let decoded
  try {
    decoded = decodeAnyOftStore(store.data)
  } catch (e) {
    return await unknown(e instanceof Error ? e.message : String(e))
  }

  const tokenMint = decoded.store.tokenMint
  const escrowAddress = decoded.layout === 'OFTStore' ? decoded.store.tokenEscrow : decoded.store.tokenEscrow
  const peerConfig = peerConfigAddress(oftStore, programId, srcEid)
  const keys = [tokenMint, ...(escrowAddress ? [escrowAddress] : []), peerConfig]
  const accounts = await rpc.getMultipleAccounts(keys)
  const mint = accounts[0]
  const escrow = escrowAddress ? accounts[1] : undefined
  const peerAcc = accounts[escrowAddress ? 2 : 1]

  if (!mint) throw new SvmDiscoverError('mint_missing', tokenMint)
  const tokenProgram = TOKEN_PROGRAMS[mint.owner]
  if (!tokenProgram) throw new SvmDiscoverError('unknown_token_program', mint.owner)
  // The earlier layout records the token program itself; if it disagrees with the mint's real
  // owner, the bytes were not what we thought and nothing here can be trusted.
  if (decoded.layout === 'OftConfig' && decoded.store.tokenProgram !== mint.owner) {
    return await unknown(`token program ${decoded.store.tokenProgram} != mint owner ${mint.owner}`)
  }
  const { decimals } = decodeMint(mint.data)

  // The escrow must be a token account of this mint; anything else is not the store we think.
  if (escrow) {
    try {
      const esc = decodeTokenAccount(escrow.data)
      if (esc.mint !== tokenMint) throw new SvmDiscoverError('escrow_mismatch', `${esc.mint} != ${tokenMint}`)
    } catch (e) {
      if (e instanceof SvmDiscoverError) throw e
      throw new SvmDiscoverError('escrow_mismatch', String(e))
    }
  }

  let peerInfo: SvmOftInfo['peer'] = { configured: false, address: peerConfig }
  if (peerAcc && peerAcc.owner === programId) {
    try {
      const pc = decodeAnyPeer(peerAcc.data)
      peerInfo = { configured: true, address: peerConfig, peerAddress: pc.peerAddress, enforcedSend: pc.enforcedSend, enforcedSendAndCall: pc.enforcedSendAndCall }
    } catch {
      /* an account we cannot parse at the peer address: treated as "not configured" */
    }
  }

  const common = {
    oftStore,
    programId,
    layout: decoded.layout,
    ownerIsProgram,
    tokenMint,
    tokenProgram,
    decimals,
    peer: peerInfo,
    ...(escrowAddress ? { tokenEscrow: escrowAddress } : {}),
  }

  const info: SvmOftInfo =
    decoded.layout === 'OFTStore'
      ? {
          ...common,
          oftType: decoded.store.oftType,
          ld2sdRate: decoded.store.ld2sdRate,
          paused: decoded.store.paused,
          defaultFeeBps: decoded.store.defaultFeeBps,
          tvlLd: decoded.store.tvlLd,
        }
      : {
          ...common,
          oftType: decoded.store.oftType,
          ld2sdRate: decoded.store.ld2sdRate,
          // The earlier layout has no TVL, fee or pause flag at all — reported as absent, not guessed.
          paused: false,
          defaultFeeBps: 0,
          tvlLd: 0n,
        }
  return { recognised: true, info }
}

/** Guard 17 for a Solana destination: its PeerConfig for our chain must name our EVM OFT. */
export function checkPeerBackSvm(info: SvmOftInfo, srcOft: Address): PeerBackResult {
  if (!info.peer.configured) return { status: 'mismatch', theirPeer: `0x${'0'.repeat(64)}` }
  return info.peer.peerAddress.toLowerCase() === addressToBytes32(srcOft).toLowerCase()
    ? { status: 'ok' }
    : { status: 'mismatch', theirPeer: info.peer.peerAddress }
}

/**
 * The same check for a store we could not parse. A peer we managed to read is compared exactly as
 * above; one we could not read is `unavailable`, which the UI asks the user to acknowledge — it is
 * never silently treated as a match.
 */
export function checkPeerBackUnknown(store: SvmUnknownStore, srcOft: Address): PeerBackResult {
  if (!store.peerAddress) return { status: 'unavailable', reason: 'the peer account could not be read on this program' }
  return store.peerAddress.toLowerCase() === addressToBytes32(srcOft).toLowerCase()
    ? { status: 'ok' }
    : { status: 'mismatch', theirPeer: store.peerAddress }
}
