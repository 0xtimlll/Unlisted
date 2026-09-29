/**
 * §Task 5: finding the NttManager.
 *
 * The official token list has no manager addresses, so the manager is discovered from the TOKEN
 * itself: an NTT token in burning mode names its manager as `minter()`. That is the same fact the
 * gate later treats as the anchor, which is the point — the manager is only ever reached through
 * something the token says, never through something a manager claims about itself.
 *
 * The list is only ever a HINT here — it narrows the search and supplies the destination
 * suggestions. A token it does not mention is still followed on chain, because `minter()` is a
 * fact about the token and the list is a fact about an API. Everything found either way goes
 * through the same gate in verify.ts, which does not consult the list at all.
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

  // Listed or not, the token is followed the same way. Listing only decides whether the
  // destination-side walk below has a catalogue to work from.
  const listed = findListedToken(tokenList, chain, addr)
  const token = listed ? listed.address : addr

  const minter = await read(() => client.readContract({ address: token, abi: nttTokenAnchorAbi, functionName: 'minter' }))
  if (minter) {
    const manager = getAddress(minter)
    // The manager must agree that it manages this token; the gate re-checks all of this anyway.
    const back = await read(() => client.readContract({ address: manager, abi: nttManagerAbi, functionName: 'token' }))
    if (back && isAddressEqual(getAddress(back), token)) return { kind: 'manager', manager, token, via: 'minter' }
  }

  // No minter here: this is most likely a locking hub. Walk in from the destination side. That
  // walk needs the catalogue to know which address the same token has over there, so it is the one
  // step the list is genuinely required for.
  const viaPeer = dst && listed ? await hubFromPeer(dst, tokenList, token) : undefined
  if (viaPeer) return { kind: 'manager', manager: viaPeer, token, via: 'peer' }

  // A contract that answers neither token() nor minter() and is not in the list is not something
  // this tab can follow — say which of the two it is, so the screen can explain it.
  if (!listed) {
    const isContract = await read(() => client.getCode({ address: addr }))
    return { kind: 'unknown', reason: !isContract || isContract === '0x' ? 'unreadable' : 'not_listed' }
  }
  return { kind: 'token_without_minter', token }
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
