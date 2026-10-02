'use client'
/**
 * §4 on screen: run the route checks for whatever the form currently describes.
 *
 * One hook for both protocols, because the panel that renders the answer is the same and the fold
 * behind it is the same. What differs is only which runner is asked, and `assessRoute` already
 * decides that from the subject.
 *
 * The query key is the whole route and the whole amount, so a verdict is never shown for a
 * different transfer than the one on screen — the amount matters to three of the checks (adapter
 * liquidity, the destination simulation, the limits), so a stale verdict would be a verdict about
 * someone else's amount.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { byEid, byKey, isEvm, type ChainKey, type EvmChainDef } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import type { EvmSendPlan } from '@/core/plan'
import type { OftInfo } from '@/core/types'
import type { OftV1Info } from '@/protocols/lz-v1/detect'
import type { V1SendPlan } from '@/protocols/lz-v1/plan'
import { assessRoute, dstOftOf, type RiskOutcome } from '@/protocols/lz-risk'

function clientFor(key: ChainKey | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  if (!key) return undefined
  const def = byKey(key)
  if (!isEvm(def)) return undefined
  return makeReadClient(def, customRpc[key])
}

/** The v1 tab's verdict. */
export function useV1RouteRisk(
  info: OftV1Info | undefined,
  plan: V1SendPlan | undefined,
  customRpc: Partial<Record<ChainKey, string>>,
  /** Did a second, independent operator confirm the probe? See RiskInput.linkCrossChecked. */
  linkCrossChecked: boolean,
) {
  const srcClient = useMemo(() => clientFor(info?.chain, customRpc), [info?.chain, customRpc])
  const dstClient = useMemo(() => clientFor(plan?.dst.key, customRpc), [plan?.dst.key, customRpc])
  return useQuery<RiskOutcome>({
    queryKey: ['v1risk', info?.chain, info?.oft, plan?.dst.key, plan?.amounts.amountLD.toString(), plan?.recipient, linkCrossChecked],
    queryFn: () => assessRoute({ protocol: 'lz-v1', info: info!, plan: plan!, srcClient: srcClient!, dstClient: dstClient!, linkCrossChecked }),
    enabled: !!info && !!plan && !!srcClient && !!dstClient,
    // Long enough that typing does not hammer eight checks, short enough that a route which just
    // unblocked is re-read without a reload.
    staleTime: 60_000,
    retry: false,
  })
}

/**
 * The V2 tab's verdict. Returns nothing at all for a route the indicator has no runner for — a
 * Solana source or destination — so the panel simply does not appear there rather than showing an
 * empty one, and guard 22 leaves those routes to guards 1–21.
 */
export function useV2RouteRisk(
  info: OftInfo | undefined,
  plan: EvmSendPlan | undefined,
  src: EvmChainDef | undefined,
  customRpc: Partial<Record<ChainKey, string>>,
  /** Did a second, independent operator confirm the probe? See RiskInput.linkCrossChecked. */
  linkCrossChecked: boolean,
) {
  // The destination as the registry knows it. A non-EVM destination has no runner, so everything
  // below stays disabled and the panel does not render — see guard 22's boundary.
  const dst = plan ? byEid(plan.dstEid) : undefined
  const dstKey = dst && isEvm(dst) ? dst.key : undefined
  const srcClient = useMemo(() => clientFor(src?.key, customRpc), [src?.key, customRpc])
  const dstClient = useMemo(() => clientFor(dstKey, customRpc), [dstKey, customRpc])
  const dstOft = info && plan ? dstOftOf(info, plan.dstEid) : undefined
  return useQuery<RiskOutcome>({
    queryKey: ['v2risk', src?.key, info?.oft, dstKey, plan?.amounts.amountLD.toString(), plan?.recipient, linkCrossChecked],
    queryFn: () => {
      // The peer on an EVM destination is not an address: there is no contract to run the checks
      // against. Said as an error (guard 22: `risk_unavailable`, a yellow note), not left pending
      // forever as `risk_unknown`; guard 17 already shows the peer itself in red.
      if (!dstOft) throw new Error('the peer on the destination is not an EVM contract address')
      return assessRoute({
        protocol: 'lz-oft',
        info: info!,
        plan: plan!,
        srcChain: src!.key,
        dstChain: dstKey!,
        srcClient: srcClient!,
        dstClient: dstClient!,
        dstOft,
        linkCrossChecked,
      })
    },
    enabled: !!info && !!plan && !!src && !!srcClient && !!dstClient && !!dstKey,
    staleTime: 60_000,
    retry: false,
  })
}
