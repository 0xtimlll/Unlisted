'use client'
/** Queries for the Wormhole NTT tab. Every read goes through the same clients the OFT tab uses. */
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { byKey, evmByKey, requireEvm, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import type { Recipient } from '@/core/recipient'
import { wormholeChainId } from '@/protocols/wormhole-ntt/chains'
import { discoverNtt, type NttDiscovery } from '@/protocols/wormhole-ntt/discover'
import { buildNttPlan, type NttPlan } from '@/protocols/wormhole-ntt/plan'
import { previewNttTransfer, type NttPreview } from '@/protocols/wormhole-ntt/preview'
import { fetchNttStatus } from '@/protocols/wormhole-ntt/track'
import { fetchNttTokenList, listedChains, type NttToken } from '@/protocols/wormhole-ntt/tokenList'
import { verifyNttManager, type NttVerification } from '@/protocols/wormhole-ntt/verify'

const clientFor = (chain: ChainKey, customRpc: Partial<Record<ChainKey, string>>) => makeReadClient(evmByKey(chain), customRpc[chain])

/** The official NTT token list. Cached for the session: it is a catalogue, not live state. */
export function useNttTokenList() {
  return useQuery({
    queryKey: ['nttTokenList'],
    queryFn: () => fetchNttTokenList(),
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
    queryFn: (): Promise<NttVerification> =>
      verifyNttManager({
        srcChain,
        dstChain: dstChain!,
        manager: manager!,
        srcClient: clientFor(srcChain, customRpc),
        dstClient: clientFor(dstChain!, customRpc),
        tokenList: tokenList!,
      }),
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
    queryFn: () => previewNttTransfer(clientFor(plan!.chain, customRpc), plan!),
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

/** Destinations worth offering: chains where the same token is listed, minus this one. */
export function nttDestinations(token: NttToken | undefined, chains: readonly ChainKey[], from: ChainKey): ChainKey[] {
  if (!token) return []
  return listedChains(token, chains).filter((c) => c !== from && byKey(c).vm === 'evm')
}

export { requireEvm }
