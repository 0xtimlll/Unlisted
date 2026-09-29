'use client'
/** Queries for the Wormhole NTT tab. Every read goes through the same clients the OFT tab uses. */
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { byKey, evmByKey, requireEvm, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { clientPair, independentSecondary } from '@/core/quorum'
import type { Recipient } from '@/core/recipient'
import { wormholeChainId } from '@/protocols/wormhole-ntt/chains'
import { discoverNtt, type NttDiscovery } from '@/protocols/wormhole-ntt/discover'
import { buildNttPlan, type NttPlan } from '@/protocols/wormhole-ntt/plan'
import { previewNttTransfer, type NttPreview } from '@/protocols/wormhole-ntt/preview'
import { fetchNttStatus } from '@/protocols/wormhole-ntt/track'
import { fetchNttTokenList, listedChains, type NttToken } from '@/protocols/wormhole-ntt/tokenList'
import { verifyNttManagerQuorum, type NttVerification, type NttVerificationQuorum } from '@/protocols/wormhole-ntt/verify'

const clientFor = (chain: ChainKey, customRpc: Partial<Record<ChainKey, string>>) => makeReadClient(evmByKey(chain), customRpc[chain])

/**
 * A second, unrelated provider for this chain, or undefined when the registry has none to spare.
 * `clientPair` excludes the primary's own URL, so the two opinions really are independent — and
 * when the user has set a custom RPC, the spare is always one of ours.
 */
const secondFor = (chain: ChainKey, customRpc: Partial<Record<ChainKey, string>>) =>
  independentSecondary(clientPair(evmByKey(chain), customRpc[chain]))

/** The official NTT token list. Cached for the session: it is a catalogue, not live state. */
/**
 * The catalogue, or an empty one.
 *
 * A failure resolves rather than rejects, because nothing downstream may be gated on it: the
 * search has an on-chain path and the verification gate never consults the list at all. If this
 * query could stay `undefined`, everything waiting on it would stall on an API outage — which is
 * exactly the dependency this tab is not allowed to have.
 */
export function useNttTokenList() {
  return useQuery({
    queryKey: ['nttTokenList'],
    queryFn: async (): Promise<{ tokens: readonly NttToken[]; unavailable: boolean }> => {
      try {
        return { tokens: await fetchNttTokenList(), unavailable: false }
      } catch {
        return { tokens: [], unavailable: true }
      }
    },
    staleTime: 30 * 60_000,
    retry: 1,
  })
}

/**
 * What the pasted address is. The destination is passed in when it is known: a locking hub has no
 * minter of its own and can only be reached from the burning side.
 */
export function useNttDiscovery(
  chain: ChainKey,
  dstChain: ChainKey | undefined,
  address: string | null,
  tokenList: readonly NttToken[] | undefined,
  customRpc: Partial<Record<ChainKey, string>>,
) {
  return useQuery({
    queryKey: ['nttDiscover', chain, dstChain ?? '', address?.toLowerCase(), !!tokenList],
    queryFn: (): Promise<NttDiscovery> => {
      const srcWormholeChainId = wormholeChainId(chain)
      const dst =
        dstChain && srcWormholeChainId !== undefined
          ? { chain: dstChain, client: clientFor(dstChain, customRpc), srcWormholeChainId }
          : undefined
      return discoverNtt(clientFor(chain, customRpc), chain, address!, tokenList!, dst)
    },
    enabled: !!address && !!tokenList,
    staleTime: 60_000,
    retry: false,
  })
}

/** The four-part gate. Nothing in this tab may be signed until it returns ok. */
export function useNttVerification(
  srcChain: ChainKey,
  dstChain: ChainKey | undefined,
  manager: Address | undefined,
  tokenList: readonly NttToken[] | undefined,
  customRpc: Partial<Record<ChainKey, string>>,
) {
  return useQuery({
    queryKey: ['nttVerify', srcChain, dstChain, manager, !!tokenList],
    queryFn: (): Promise<NttVerificationQuorum> => {
      const srcSecond = secondFor(srcChain, customRpc)
      const dstSecond = secondFor(dstChain!, customRpc)
      return verifyNttManagerQuorum(
        {
          srcChain,
          dstChain: dstChain!,
          manager: manager!,
          srcClient: clientFor(srcChain, customRpc),
          dstClient: clientFor(dstChain!, customRpc),
          tokenList: tokenList!,
        },
        srcSecond && dstSecond ? { srcClient: srcSecond, dstClient: dstSecond } : undefined,
      )
    },
    enabled: !!manager && !!dstChain && !!tokenList,
    staleTime: 60_000,
    retry: false,
  })
}

export function useNttPlan(p: {
  verification: NttVerification | undefined
  sender: Address | undefined
  recipient: Recipient | undefined
  amountRaw: bigint | undefined
  customRpc: Partial<Record<ChainKey, string>>
}) {
  const v = p.verification?.ok ? p.verification.verified : undefined
  return useQuery({
    queryKey: ['nttPlan', v?.manager, v?.dst.chain, p.sender, p.recipient?.to, p.amountRaw?.toString()],
    queryFn: (): Promise<NttPlan> =>
      buildNttPlan({
        verified: v!,
        srcClient: clientFor(v!.chain, p.customRpc),
        dstClient: clientFor(v!.dst.chain, p.customRpc),
        sender: p.sender!,
        recipient: p.recipient!,
        amountRaw: p.amountRaw!,
      }),
    enabled: !!v && !!p.sender && !!p.recipient && p.amountRaw !== undefined && p.amountRaw > 0n,
    refetchInterval: 30_000, // the fee and the capacities move
    retry: false,
  })
}

export type NttCheckResult = NttPreview

/**
 * Simulates the transfer and decodes our own calldata back. Runs only once the pure guards pass,
 * so a failure here is about the transfer itself, not about a form still being filled in.
 * The simulation lives in the protocol module (preview.ts) — this only schedules it.
 */
export function useNttCheck(plan: NttPlan | undefined, ready: boolean, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['nttCheck', plan?.manager, plan?.amount.toString(), plan?.recipient, plan?.value.toString()],
    queryFn: () => previewNttTransfer(clientFor(plan!.chain, customRpc), plan!, evmByKey(plan!.chain).chainId),
    enabled: !!plan && ready,
    staleTime: 20_000,
    retry: false,
  })
}

/** Delivery status from Wormholescan. */
export function useNttTrack(txHash: string | undefined) {
  return useQuery({
    queryKey: ['nttTrack', txHash],
    queryFn: () => fetchNttStatus(txHash!),
    enabled: !!txHash,
    refetchInterval: (q) => ((q.state.data as { phase?: string } | undefined)?.phase === 'delivered' ? false : 15_000),
    retry: false,
  })
}

/**
 * Destinations worth offering.
 *
 * With a catalogue entry this is the chains it lists the token on — a short, accurate menu. Without
 * one (the token is unlisted, or Wormholescan is down) it is every EVM chain we serve, and the
 * verification gate decides which of them actually has a peer. That is slower for the user but it
 * is the same answer: the list narrows the search, it never decides what is bridgeable.
 */
export function nttDestinations(token: NttToken | undefined, chains: readonly ChainKey[], from: ChainKey): ChainKey[] {
  const candidates = token ? listedChains(token, chains) : chains
  return candidates.filter((c) => c !== from && byKey(c).vm === 'evm')
}

export { requireEvm }
