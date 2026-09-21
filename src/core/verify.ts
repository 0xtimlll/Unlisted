/**
 * The peer back-link: the contract on the destination that our OFT names as its peer must
 * name our OFT as *its* peer for our chain. A scammer can deploy a fake adapter that points
 * at the real OFT, but cannot make the real OFT point back at the fake.
 */
import { type Address, type Hex } from 'viem'
import { oftAbi } from './abi'
import type { ReadClient } from './client'
import { addressToBytes32, peerToAddress } from './encoding'

export type PeerBackResult =
  | { status: 'ok' }
  | { status: 'mismatch'; theirPeer: Hex }
  | { status: 'unavailable'; reason: string }

/**
 * Reads `peers(srcEid)` on the destination-side peer and compares it with our OFT.
 * `dstClient` must be a client for the (EVM) destination chain; `peer` is the raw bytes32 from
 * routes[]. A peer that is not EVM-shaped cannot be the right contract on an EVM chain.
 */
export async function checkPeerBack(dstClient: ReadClient, peer: Hex, srcEid: number, oft: Address): Promise<PeerBackResult> {
  const peerAddress = peerToAddress(peer)
  if (!peerAddress) return { status: 'mismatch', theirPeer: peer }
  let theirPeer: Hex
  try {
    theirPeer = await dstClient.readContract({ address: peerAddress, abi: oftAbi, functionName: 'peers', args: [srcEid] })
  } catch (e) {
    return { status: 'unavailable', reason: e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e) }
  }
  return theirPeer.toLowerCase() === addressToBytes32(oft).toLowerCase() ? { status: 'ok' } : { status: 'mismatch', theirPeer }
}
