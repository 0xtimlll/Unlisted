'use client'
/** Queries for the Hyperlane tab. */
import { useQuery } from '@tanstack/react-query'
import type { Hash, Hex } from 'viem'
import { evmByKey, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { clientPair, independentSecondary } from '@/core/quorum'
import type { Recipient } from '@/core/recipient'
import { trackPollInterval } from '@/core/track'
import {
  discoverWarpRouteQuorum,
  readRemoteWarp,
  readWarpStanding,
  type HyperlaneDiscoveryQuorum,
  type RemoteWarp,
  type WarpRouter,
  type WarpStanding,
} from '@/protocols/hyperlane/discover'
import type { HyperlaneApproveIntent } from '@/protocols/hyperlane/guards'
import { buildHyperlanePlan, type HyperlanePlan } from '@/protocols/hyperlane/plan'
import { previewHyperlaneSend, type HyperlanePreview } from '@/protocols/hyperlane/preview'
import { findHyperlaneDispatches } from '@/protocols/hyperlane/status'
import { readHyperlaneDelivery } from '@/protocols/hyperlane/track'

const clientFor = (chain: ChainKey, customRpc: Partial<Record<ChainKey, string>>) => makeReadClient(evmByKey(chain), customRpc[chain])

/** A second, unrelated provider for this chain, or undefined when the registry has none to spare. */
const secondFor = (chain: ChainKey, customRpc: Partial<Record<ChainKey, string>>) =>
  independentSecondary(clientPair(evmByKey(chain), customRpc[chain]))

/** The pasted address, held against the registry Mailbox by two providers. */
export function useWarpRoute(chain: ChainKey, address: string | null, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['warpRoute', chain, address?.toLowerCase()],
    queryFn: (): Promise<HyperlaneDiscoveryQuorum> => discoverWarpRouteQuorum(clientFor(chain, customRpc), secondFor(chain, customRpc), chain, address!),
    enabled: !!address,
    staleTime: 60_000,
    retry: false,
  })
}

/** The router on the destination, read on its own chain: does it point back, which mailbox, what arrives. */
export function useWarpRemote(chain: ChainKey, dstChain: ChainKey | undefined, router: WarpRouter | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  const route = router && dstChain ? router.routes.find((r) => r.chain === dstChain) : undefined
  return useQuery({
    queryKey: ['warpRemote', chain, dstChain, router?.router, route?.router],
    queryFn: (): Promise<RemoteWarp> => readRemoteWarp(clientFor(dstChain!, customRpc), dstChain!, route!.router, chain, router!.router),
    enabled: !!router && !!dstChain && !!route,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Locked share and dispatch history — the standing behind a collateral or native route. */
export function useWarpStanding(chain: ChainKey, router: WarpRouter | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['warpStanding', chain, router?.router, router?.warpKind, router?.token],
    queryFn: (): Promise<WarpStanding> => readWarpStanding(clientFor(chain, customRpc), chain, router!),
    enabled: !!router && router.warpKind !== 'synthetic',
    staleTime: 60_000,
    retry: false,
  })
}

export function useHyperlanePlan(p: {
  chain: ChainKey
  dstChain: ChainKey | undefined
  router: WarpRouter | undefined
  remote: RemoteWarp | undefined
  sender: `0x${string}` | undefined
  recipient: Recipient | undefined
  amount: bigint | undefined
  customRpc: Partial<Record<ChainKey, string>>
}) {
  return useQuery({
    queryKey: [
      'hyperlanePlan',
      p.chain,
      p.dstChain,
      p.router?.router,
      p.remote?.router,
      p.remote?.scale?.numerator.toString(),
      p.remote?.scale?.denominator.toString(),
      p.sender,
      p.recipient?.display,
      p.amount?.toString(),
    ],
    queryFn: (): Promise<HyperlanePlan> =>
      buildHyperlanePlan({
        chain: p.chain,
        dstChain: p.dstChain!,
        router: p.router!,
        remote: p.remote,
        sender: p.sender!,
        recipient: p.recipient!,
        amount: p.amount!,
        srcClient: clientFor(p.chain, p.customRpc),
      }),
    enabled: !!p.router && !!p.dstChain && !!p.sender && !!p.recipient && p.amount !== undefined && p.amount > 0n,
    refetchInterval: 30_000, // the interchain gas quote moves
    retry: false,
  })
}

export type HyperlaneCheckResult = HyperlanePreview

/**
 * The simulation of exactly this plan. The approve is part of the key: once the allowance lands
 * the intent disappears and the send is simulated again on its own, so a stale "allowance" revert
 * cannot outlive the approve that answered it.
 */
export function useHyperlaneCheck(plan: HyperlanePlan | undefined, ready: boolean, approve: HyperlaneApproveIntent | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: [
      'hyperlaneCheck',
      plan?.chain,
      plan?.router,
      plan?.sender,
      plan?.dst.chain,
      plan?.dst.domain,
      plan?.amount.toString(),
      plan?.recipient,
      plan?.value.toString(),
      approve?.amount.toString() ?? 'no-approve',
    ],
    queryFn: () => previewHyperlaneSend(clientFor(plan!.chain, customRpc), plan!, { approve, chainId: evmByKey(plan!.chain).chainId }),
    enabled: !!plan && ready,
    staleTime: 20_000,
    retry: false,
  })
}

export type HyperlaneDeliveryState = {
  phase: 'no_data' | 'pending' | 'delivered' | 'failed'
  messageId?: Hex
  dstChain?: ChainKey
  processedAtBlock?: bigint
  /** The source transaction reverted: nothing was dispatched. */
  sourceFailed?: boolean
  /** The transaction confirmed but carries no Hyperlane message to a chain served here. */
  noMessage?: boolean
}

/**
 * Delivery of a sent transfer, read from the two chains: the source receipt names the message
 * (its id is keccak256 of the Mailbox's own log), the destination Mailbox from our table says
 * whether that id is delivered. Polled on the LayerZero tracker's schedule (core/track.ts).
 */
export function useHyperlaneDelivery(srcChain: ChainKey, txHash: string | undefined, startedAt: number | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['hyperlaneDelivery', srcChain, txHash],
    queryFn: async (): Promise<HyperlaneDeliveryState> => {
      const src = clientFor(srcChain, customRpc)
      let receipt
      try {
        receipt = await src.getTransactionReceipt({ hash: txHash as Hash })
      } catch {
        return { phase: 'no_data' }
      }
      if (receipt.status === 'reverted') return { phase: 'failed', sourceFailed: true }
      const found = findHyperlaneDispatches(
        receipt.logs.map((l) => ({ address: l.address, topics: l.topics as readonly string[], data: l.data })),
        srcChain,
      )
      const first = found[0]
      if (!first || !first.dstChain) return { phase: 'no_data', noMessage: true }
      const delivery = await readHyperlaneDelivery(clientFor(first.dstChain, customRpc), first.dstChain, first.messageId)
      return {
        phase: delivery.phase,
        messageId: first.messageId,
        dstChain: first.dstChain,
        ...(delivery.processedAtBlock !== undefined ? { processedAtBlock: delivery.processedAtBlock } : {}),
      }
    },
    enabled: !!txHash,
    refetchInterval: (q) => {
      const s = q.state.data as HyperlaneDeliveryState | undefined
      if (s?.noMessage) return false
      return trackPollInterval(s?.phase, startedAt)
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    retry: false,
  })
}
