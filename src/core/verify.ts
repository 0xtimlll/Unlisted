/**
 * Two defences against a look-alike / fake OFT contract:
 *
 * 1. A small allow-list of contracts whose addresses were taken from the projects' official
 *    sources. Anything else is usable but flagged "unverified".
 * 2. The peer back-link: the contract on the destination that our OFT names as its peer must
 *    name our OFT as *its* peer for our chain. A scammer can deploy a fake adapter that points
 *    at the real OFT, but cannot make the real OFT point back at the fake.
 */
import { type Address, type Hex } from 'viem'
import { oftAbi } from './abi'
import type { ChainKey } from './chains'
import type { ReadClient } from './client'
import { addressToBytes32, sameAddress } from './encoding'

export type VerifiedContract = { chain: ChainKey; address: Address; label: string }

/** Addresses from the token projects' official documentation. Keep this list short and reviewed. */
export const VERIFIED_CONTRACTS: readonly VerifiedContract[] = [
  { chain: 'hyperevm', address: '0xd5EE1c81fE161e985dce6b90713c965f9979cf80', label: 'TREAD (OFT)' },
  { chain: 'ethereum', address: '0xe68AD53cf0D5E49CF83FBC003672f6D0eBcAe311', label: 'TREAD (OFTAdapter)' },
  { chain: 'hyperevm', address: '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98', label: 'USDT0 (OFTAdapter)' },
]

export function findVerified(chain: ChainKey, address: string): VerifiedContract | undefined {
  return VERIFIED_CONTRACTS.find((v) => v.chain === chain && sameAddress(v.address, address))
}

export type PeerBackResult =
  | { status: 'ok' }
  | { status: 'mismatch'; theirPeer: Hex }
  | { status: 'unavailable'; reason: string }

/**
 * Reads `peers(srcEid)` on the destination-side peer and compares it with our OFT.
 * `dstClient` must be a client for the destination chain.
 */
export async function checkPeerBack(dstClient: ReadClient, peer: Address, srcEid: number, oft: Address): Promise<PeerBackResult> {
  let theirPeer: Hex
  try {
    theirPeer = await dstClient.readContract({ address: peer, abi: oftAbi, functionName: 'peers', args: [srcEid] })
  } catch (e) {
    return { status: 'unavailable', reason: e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e) }
  }
  return theirPeer.toLowerCase() === addressToBytes32(oft).toLowerCase() ? { status: 'ok' } : { status: 'mismatch', theirPeer }
}
