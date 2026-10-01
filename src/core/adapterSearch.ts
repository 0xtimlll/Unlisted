/**
 * Finding the OFTAdapter for a plain token: paste the token, get the bridge.
 *
 * A lock/unlock token has no `peers()` of its own — the ERC-20 knows nothing about LayerZero.
 * What does know is the OFT on the OTHER chains: its `peers(srcEid)` names the contract on the
 * source chain, and for a lockbox route that contract is the adapter. Projects usually deploy the
 * OFT at the same address on every chain, so the search is: ask the same address on every other
 * EVM chain for its peer towards the source chain, then probe each distinct answer on the source
 * chain itself and keep only those that are an OFTAdapter whose `token()` is the pasted token.
 *
 * Trust-wise this is a SEARCH HINT (CLAUDE.md rule 1): `peers()` is written by whoever deployed
 * the far-side contract, so it may only say where to look. What comes back is probed exactly as a
 * pasted address — two RPC operators, the committed EndpointV2, every guard, guard 17's peer-back,
 * the route indicator. Nothing found here is trusted because it was found here.
 */
import type { Address, Hex } from 'viem'
import type { ChainKey } from './chains'
import { isZeroBytes32, peerToAddress, sameAddress } from './encoding'
import type { OftInfo } from './types'

export type AdapterCandidate = {
  /** The adapter on the source chain. */
  adapter: Address
  /** The chains whose OFT named it as the peer for the source chain. */
  foundOn: ChainKey[]
}

export type AdapterSearchDeps = {
  /** `peers(srcEid)` of the contract at `address` on `chain`; throws when it does not answer. */
  readPeer: (chain: ChainKey, address: Address, srcEid: number) => Promise<Hex>
  /** The ordinary probe on the source chain; throws when the address is not an OFT. */
  probe: (address: Address) => Promise<OftInfo>
}

export type AdapterSearch = {
  /** Adapters on the source chain that lock exactly this token, with where each was found. */
  found: AdapterCandidate[]
  /** Chains that answered with a peer towards the source, whatever it turned out to be. */
  named: ChainKey[]
  /** Chains that could not be asked (an RPC that did not answer). Said, never counted as "no". */
  failed: ChainKey[]
  /** Peers that were named but turned out not to be an adapter for this token on the source. */
  rejected: Address[]
}

/**
 * Ask every other chain, then verify every distinct answer on the source chain.
 *
 * `chains` are the chains to ask (the source itself is skipped). Asking is parallel and a chain
 * that fails is recorded, not fatal: "no adapter" and "could not ask three chains" are different
 * answers, and the screen says which one it got.
 */
export async function findAdapterForToken(
  p: { token: Address; srcChain: ChainKey; srcEid: number; chains: readonly ChainKey[] },
  deps: AdapterSearchDeps,
): Promise<AdapterSearch> {
  const asked = p.chains.filter((c) => c !== p.srcChain)
  const answers = await Promise.all(
    asked.map(async (chain): Promise<{ chain: ChainKey; peer?: Address; failed?: true }> => {
      try {
        const peer = await deps.readPeer(chain, p.token, p.srcEid)
        if (isZeroBytes32(peer)) return { chain }
        const address = peerToAddress(peer)
        return address ? { chain, peer: address } : { chain }
      } catch {
        return { chain, failed: true }
      }
    }),
  )

  const failed = answers.filter((a) => a.failed).map((a) => a.chain)
  const named = answers.filter((a) => a.peer).map((a) => a.chain)
  // Distinct candidates, each remembering every chain that named it.
  const candidates = new Map<string, AdapterCandidate>()
  for (const a of answers) {
    if (!a.peer) continue
    const key = a.peer.toLowerCase()
    const c = candidates.get(key) ?? { adapter: a.peer, foundOn: [] }
    c.foundOn.push(a.chain)
    candidates.set(key, c)
  }

  const found: AdapterCandidate[] = []
  const rejected: Address[] = []
  for (const c of candidates.values()) {
    // The token itself can never be its own adapter; a self-pointing peer is a different kind of
    // route (a plain OFT with the same address everywhere), not a lockbox for this token.
    if (sameAddress(c.adapter, p.token)) {
      rejected.push(c.adapter)
      continue
    }
    try {
      const info = await deps.probe(c.adapter)
      if (info.kind === 'OFTAdapter' && sameAddress(info.token, p.token)) found.push(c)
      else rejected.push(c.adapter)
    } catch {
      rejected.push(c.adapter)
    }
  }
  return { found, named, failed, rejected }
}
