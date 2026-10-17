/**
 * §Task 5: finding the NttManager, and where it can send.
 *
 * Wormhole's token list has no manager addresses, so the manager is discovered from the TOKEN
 * itself where it can be: an NTT token in burning mode usually names its manager as `minter()`.
 * That is the same fact the gate later treats as the anchor, which is the point — the manager is
 * reached through something the token says, never through something a manager claims about itself.
 *
 * Not every token has such a getter. OpenZeppelin MinterRole tokens answer only `isMinter(address)`
 * — a question, not a lookup — and a locking hub's token names nothing at all, because nothing is
 * minted there. For those the search needs CANDIDATES, contracts to ask, and two hints supply them:
 *
 *  - Wormholescan's decoded NTT operations for this source chain (managerIndex.ts): every transfer
 *    names its `sourceNttManager`. The field is written by the manager itself, so it narrows the
 *    search and proves nothing — a candidate counts only after it answers `token()` with this token
 *    ON CHAIN, and the gate in verify.ts decides the rest (CLAUDE.md rule 1: an external API may
 *    narrow a search, never raise trust);
 *  - the token list, once a destination is chosen: the token on the DESTINATION chain names its own
 *    (burning) manager, and that manager's peer for this chain is the hub. Both ends of that walk
 *    are token-side facts.
 *
 * A manager no hint reaches is typed in by hand — the screen says so — and goes through exactly the
 * same gate as one that was found. Whatever found it, the destinations come from the manager's own
 * `getPeer()` for every chain we serve (readNttPeers), never from a catalogue.
 */
import { getAddress, isAddressEqual, type Address } from 'viem'
import { evmChains, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { erc20Abi } from '../../core/abi'
import { isZeroBytes32, peerToAddress } from '../../core/encoding'
import { isContractRefusal } from '../../core/rpcErrors'
import { nttManagerAbi, nttTokenAnchorAbi } from './abi'
import { nttServed, wormholeChainId } from './chains'
import { COINGECKO_PLATFORM, findListedToken, type NttToken } from './tokenList'
import { tokenAnchor } from './verify'

export type NttDiscovery =
  | {
      kind: 'manager'
      manager: Address
      token: Address
      /**
       * How it was reached: the token's own `minter()`; typed in (`given`); the destination token's
       * manager naming it as peer; or Wormholescan's transfer index, confirmed by `token()` on chain.
       */
      via: 'minter' | 'given' | 'peer' | 'index'
    }
  /** A listed NTT token, but no hint reached a manager for it: the screen asks for the address. */
  | { kind: 'token_without_minter'; token: Address }
  /** Not an NTT token on this chain, and not a manager for one either. */
  | { kind: 'unknown'; reason: 'not_listed' | 'unreadable' }

/**
 * A read whose refusal is an answer ("this contract has no such function") and whose outage is not.
 * The outage is thrown, so the tab shows "could not read — try again" (ReadFailed) instead of the
 * red "this address does not answer as an NttManager" that one 502 in the middle of the walk used to
 * produce.
 */
const read = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn()
  } catch (e) {
    if (isContractRefusal(e)) return undefined
    throw e
  }
}

/** For ranking only: a failed read counts as "no", whatever the reason. */
const readSoft = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/** How many index candidates are asked `token()` for one search. The index is newest-first. */
export const MAX_MANAGER_CANDIDATES = 8

/**
 * Works out what the pasted address is. An address that answers `token()` is treated as a manager;
 * otherwise it is a token, and its manager is looked for from the token's `minter()`, then among
 * `candidates` (Wormholescan's index for this chain, see managerIndex.ts), then — with a
 * destination — from the destination token's own manager.
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
  /** Managers Wormholescan has seen sending this token from this chain. A hint; each is checked. */
  candidates?: readonly Address[] | undefined,
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

  // No minter getter: ask the contracts Wormholescan has seen sending this token. Each has to name
  // the token back on chain; the one the token vouches for comes first, then the one holding most.
  const viaIndex = candidates && candidates.length > 0 ? await managerFromCandidates(client, token, candidates) : undefined
  if (viaIndex) return { kind: 'manager', manager: viaIndex, token, via: 'index' }

  // Still nothing: this may be a locking hub. Walk in from the destination side. That walk needs the
  // catalogue to know which address the same token has over there, so it is the one step the list
  // is genuinely required for.
  const viaPeer = dst && listed ? await hubFromPeer(dst, tokenList, token) : undefined
  if (viaPeer) return { kind: 'manager', manager: viaPeer, token, via: 'peer' }

  // A contract that answers neither token() nor minter(), that no index names and that is not in
  // the list is not something this tab can follow on its own — say which of the two it is, so the
  // screen can explain it and ask for the manager's address.
  if (!listed) {
    const isContract = await read(() => client.getCode({ address: addr }))
    return { kind: 'unknown', reason: !isContract || isContract === '0x' ? 'unreadable' : 'not_listed' }
  }
  return { kind: 'token_without_minter', token }
}

/**
 * The candidates that name this token, ranked: one the token vouches for first (the anchor the
 * gate will accept), then by the share of the token each holds — a hub holds what circulates on
 * its spokes, a fake holds nothing. Reads that fail count as "no" for the ranking only; the gate
 * reads everything again with the outage/refusal distinction it needs. A candidate whose `token()`
 * the provider could not answer is skipped, and if no other candidate matched, the outage is thrown
 * rather than reported as "no manager".
 */
async function managerFromCandidates(client: ReadClient, token: Address, candidates: readonly Address[]): Promise<Address | undefined> {
  const seen = new Set<string>()
  const scored: { manager: Address; anchored: boolean; held: bigint }[] = []
  let outage: unknown
  for (const raw of candidates) {
    let manager: Address
    try {
      manager = getAddress(raw)
    } catch {
      continue
    }
    const key = manager.toLowerCase()
    if (seen.has(key)) continue
    if (seen.size >= MAX_MANAGER_CANDIDATES) break
    seen.add(key)

    let named: Address | undefined
    try {
      named = await read(() => client.readContract({ address: manager, abi: nttManagerAbi, functionName: 'token' }))
    } catch (e) {
      // One candidate the provider could not answer for does not end the search; it only means
      // "none found" may not be said if nothing else matches.
      outage ??= e
      continue
    }
    if (!named || !isAddressEqual(getAddress(named), token)) continue
    const anchored = (await readSoft(() => tokenAnchor(client, token, manager))) !== undefined
    const held = (await readSoft(() => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [manager] }))) ?? 0n
    scored.push({ manager, anchored, held })
  }
  if (scored.length === 0 && outage !== undefined) throw outage
  scored.sort((a, b) => (a.anchored !== b.anchored ? (a.anchored ? -1 : 1) : a.held > b.held ? -1 : a.held < b.held ? 1 : 0))
  return scored[0]?.manager
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

// ------------------------------------------------------------------- peers ----

export type NttPeers = {
  /** The chains this manager names an EVM peer on, in registry order. */
  chains: ChainKey[]
  /** False when at least one `getPeer` could not be read: the list may be short, not wrong. */
  complete: boolean
}

/**
 * Where this manager can send: `getPeer(id)` for every EVM chain Wormhole serves in our registry,
 * except the source. The reads go out together — the client batches them into one Multicall3
 * call where the chain has it — and a chain whose read fails is left out with `complete: false`,
 * so the screen can offer every chain and let the gate decide rather than hide a route.
 */
export async function readNttPeers(client: ReadClient, manager: Address, src: ChainKey): Promise<NttPeers> {
  const targets = evmChains().filter((c) => c.key !== src && nttServed(c.key))
  const found = new Set<ChainKey>()
  let complete = true
  await Promise.all(
    targets.map(async (c) => {
      const id = wormholeChainId(c.key)
      if (id === undefined) return
      try {
        const peer = await client.readContract({ address: manager, abi: nttManagerAbi, functionName: 'getPeer', args: [id] })
        if (!isZeroBytes32(peer.peerAddress) && peerToAddress(peer.peerAddress)) found.add(c.key)
      } catch {
        complete = false
      }
    }),
  )
  return { chains: targets.map((c) => c.key).filter((k) => found.has(k)), complete }
}
