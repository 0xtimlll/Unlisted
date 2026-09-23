/**
 * §Task 5: finding the NttManager.
 *
 * The official token list has no manager addresses, so the manager is discovered from the TOKEN
 * itself: an NTT token in burning mode names its manager as `minter()`. That is the same fact the
 * gate later treats as the anchor, which is the point — the manager is only ever reached through
 * something the token says, never through something a manager claims about itself.
 *
 * A locking hub's token has no minter — by design, since nothing is minted there. For those the
 * search goes the other way round: the token on the DESTINATION chain names its own (burning)
 * manager, and that manager's peer for this chain is the hub. Both ends of that walk are still
 * token-side facts, and whatever comes out of it goes through the full gate anyway.
 */
import { getAddress, isAddressEqual, type Address } from 'viem'
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { nttManagerAbi, nttTokenAnchorAbi } from './abi'
import { isZeroBytes32, peerToAddress } from '../../core/encoding'
import { COINGECKO_PLATFORM, findListedToken, type NttToken } from './tokenList'

export type NttDiscovery =
  | { kind: 'manager'; manager: Address; token: Address; via: 'minter' | 'given' | 'peer' }
  /** The address is a listed NTT token, but no manager could be reached from either side. */
  | { kind: 'token_without_minter'; token: Address }
  /** Not an NTT token on this chain, and not a manager for one either. */
  | { kind: 'unknown'; reason: 'not_listed' | 'unreadable' }

const read = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/**
 * Works out what the pasted address is. An address that answers `token()` is treated as a manager;
 * otherwise it is looked up in the official token list and its `minter()` is followed.
 */
export async function discoverNtt(
  client: ReadClient,
  chain: ChainKey,
  address: string,
  tokenList: readonly NttToken[],
  /**
   * The chosen destination, when there is one: a locking hub is found through it.
   * `srcWormholeChainId` is OUR chain's Wormhole id — the key the destination manager's peer for
   * this chain is stored under.
   */
  dst?: { chain: ChainKey; client: ReadClient; srcWormholeChainId: number } | undefined,
): Promise<NttDiscovery> {
  let addr: Address
  try {
    addr = getAddress(address)
  } catch {
    return { kind: 'unknown', reason: 'unreadable' }
  }

  // A manager answers token(); a token does not.
  const asManagerToken = await read(() => client.readContract({ address: addr, abi: nttManagerAbi, functionName: 'token' }))
  if (asManagerToken) {
    return { kind: 'manager', manager: addr, token: getAddress(asManagerToken), via: 'given' }
  }

  const listed = findListedToken(tokenList, chain, addr)
  if (!listed) return { kind: 'unknown', reason: 'not_listed' }

  const minter = await read(() => client.readContract({ address: listed.address, abi: nttTokenAnchorAbi, functionName: 'minter' }))
  if (minter) {
    const manager = getAddress(minter)
    // The manager must agree that it manages this token; the gate re-checks all of this anyway.
    const back = await read(() => client.readContract({ address: manager, abi: nttManagerAbi, functionName: 'token' }))
    if (back && isAddressEqual(getAddress(back), listed.address)) return { kind: 'manager', manager, token: listed.address, via: 'minter' }
  }

  // No minter here: this is most likely a locking hub. Walk in from the destination side.
  const viaPeer = dst ? await hubFromPeer(dst, tokenList, listed.address) : undefined
  if (viaPeer) return { kind: 'manager', manager: viaPeer, token: listed.address, via: 'peer' }

  return { kind: 'token_without_minter', token: listed.address }
}

/**
 * The destination token names its own manager as minter; that manager's peer for our chain is the
 * hub we are looking for. Returns a candidate only — verify.ts still has to accept it.
 */
async function hubFromPeer(
  dst: { chain: ChainKey; client: ReadClient; srcWormholeChainId: number },
  tokenList: readonly NttToken[],
  srcToken: Address,
): Promise<Address | undefined> {
  const entry = tokenList.find((t) => Object.values(t.platforms).some((a) => a.toLowerCase() === srcToken.toLowerCase()))
  if (!entry) return undefined
  const dstListed = listedAddressOn(entry, dst.chain)
  if (!dstListed) return undefined

  const dstMinter = await read(() => dst.client.readContract({ address: dstListed, abi: nttTokenAnchorAbi, functionName: 'minter' }))
  if (!dstMinter) return undefined
  const dstManager = getAddress(dstMinter)

  // The destination manager's peer FOR OUR CHAIN is the hub.
  const peer = await read(() => dst.client.readContract({ address: dstManager, abi: nttManagerAbi, functionName: 'getPeer', args: [dst.srcWormholeChainId] }))
  if (!peer) return undefined
  const hub = peerToAddress(peer.peerAddress)
  return hub && !isZeroBytes32(peer.peerAddress) ? hub : undefined
}

function listedAddressOn(token: NttToken, chain: ChainKey): Address | undefined {
  const platform = COINGECKO_PLATFORM[chain]
  const raw = platform ? token.platforms[platform] : undefined
  if (!raw) return undefined
  try {
    return getAddress(raw)
  } catch {
    return undefined
  }
}
