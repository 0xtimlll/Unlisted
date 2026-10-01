/**
 * Reversing a route in one click: A → B becomes B → A.
 *
 * The contract on the other side is taken from what this side already read — the OFT's `peers()`,
 * the v1 trusted remote, the NTT manager's verified peer, the CCIP pool's remote token — and is then
 * PROBED AGAIN from scratch, exactly as if it had been pasted by hand: two RPC operators, every
 * guard, the route indicator. So a peer is a search hint here and never a reason to trust anything
 * (CLAUDE.md rule 1): a hostile peer can only produce a route that is checked like any other.
 *
 * Pure: the screens apply the result to their own state.
 */
import { hexToBytes, type Hex } from 'viem'
import { byEid, byKey, type ChainKey } from './chains'
import { isZeroBytes32, peerToAddress } from './encoding'
import { encodeBase58 } from './svm/base58'
import type { SourceInfo } from './types'

/** Where the reversed transfer starts, what to probe there, and where it goes. */
export type Reversal = {
  ok: true
  /** The new source chain: the old destination. */
  chain: ChainKey
  /** The contract to probe on it: an EVM address, or a Solana OFT Store in base58. */
  contract: string
  /** The new destination: the old source. */
  dstChain: ChainKey
  dstEid: number
}

export type ReverseRefusal = { ok: false; reason: 'no_destination' | 'unknown_chain' | 'no_peer' | 'peer_not_address' }

const refuse = (reason: ReverseRefusal['reason']): ReverseRefusal => ({ ok: false, reason })

function reversal(chain: ChainKey, contract: string, dstChain: ChainKey): Reversal {
  return { ok: true, chain, contract, dstChain, dstEid: byKey(dstChain).eid }
}

/**
 * LayerZero V2 (EVM or Solana on either side): the peer this OFT names for the destination.
 *
 *   EVM destination     the peer must be a left-padded 20-byte address; anything else is refused
 *                       rather than truncated into an address nobody named.
 *   Solana destination  the peer IS the 32-byte OFT Store, written out in base58.
 */
export function reverseOft(src: ChainKey, info: SourceInfo, dstEid: number | undefined): Reversal | ReverseRefusal {
  if (dstEid === undefined) return refuse('no_destination')
  const dst = byEid(dstEid)
  if (!dst) return refuse('unknown_chain')
  const route = info.routes.find((r) => r.eid === dstEid)
  if (!route || isZeroBytes32(route.peer)) return refuse('no_peer')
  if (dst.vm === 'svm') return reversal(dst.key, encodeBase58(hexToBytes(route.peer as Hex)), src)
  const address = peerToAddress(route.peer)
  return address ? reversal(dst.key, address, src) : refuse('peer_not_address')
}

/** LayerZero v1: the remote contract the trusted-remote path names for the destination. */
export function reverseV1(src: ChainKey, dst: { key: ChainKey; remoteAddress?: string | undefined } | undefined): Reversal | ReverseRefusal {
  if (!dst) return refuse('no_destination')
  if (!dst.remoteAddress) return refuse('no_peer')
  return reversal(dst.key, dst.remoteAddress, src)
}

/** Wormhole NTT: the manager on the destination that verification already found as the peer. */
export function reverseNtt(verified: { chain: ChainKey; dst: { chain: ChainKey; manager: string } } | undefined): Reversal | ReverseRefusal {
  if (!verified) return refuse('no_destination')
  return reversal(verified.dst.chain, verified.dst.manager, verified.chain)
}

/** Chainlink CCIP: the token on the destination, as the pool's remote side records it. */
export function reverseCcip(src: ChainKey, dstChain: ChainKey | undefined, remoteToken: string | undefined): Reversal | ReverseRefusal {
  if (!dstChain) return refuse('no_destination')
  if (!remoteToken) return refuse('no_peer')
  return reversal(dstChain, remoteToken, src)
}
