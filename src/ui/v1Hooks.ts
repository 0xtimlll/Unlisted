'use client'
/**
 * React-Query wrappers for the LayerZero v1 path (§3).
 *
 * The one rule that shapes this file: the v1 probe runs ONLY after the V2 probe has already
 * failed with `not_oft`. The V2 path keeps its order, its cache key and its behaviour; v1 is a
 * second question asked about a contract V2 has finished declining, never a race with it.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Address } from 'viem'
import { byKey, isEvm, type ChainKey, type EvmChainDef } from '@/core/chains'
import { makeReadClient, type ReadClient } from '@/core/client'
import { clientPair, probeOftV1Quorum } from '@/core/quorum'
import type { Recipient } from '@/core/recipient'
import {
  checkV1TrustedRemoteBack,
  hasStoredPayloadOnDst,
  pathOnDestination,
  type OftV1Info,
  type V1PeerBack,
} from '@/protocols/lz-v1/detect'
import { lzV1 } from '@/protocols/lz-v1/chains'
import type { StoredPayloadState } from '@/protocols/lz-v1/guards'
import { buildV1SendPlan, type V1SendPlan } from '@/protocols/lz-v1/plan'
import { simulateV1Send, type V1Simulation } from '@/protocols/lz-v1/simulate'
import { useDebounced, useReadClient } from './hooks'

/**
 * The v1 probe, cross-checked on independent providers (core/quorum.ts).
 *
 * `enabled` is the caller's decision, and the caller only enables it once the V2 probe has
 * returned `not_oft`.
 */
export function useProbeV1(chain: EvmChainDef | undefined, address: string | null, customRpc: string | undefined, enabled: boolean) {
  const pair = useMemo(() => (chain ? clientPair(chain, customRpc) : undefined), [chain, customRpc])
  return useQuery({
    queryKey: ['probeV1', chain?.key, address?.toLowerCase(), customRpc ?? ''],
    queryFn: async () => {
      const r = await probeOftV1Quorum(pair!, chain!.key, address!)
      const flags = [...r.flags]
      if (!r.crossChecked) flags.push('not_cross_checked')
      return { ...r, flags }
    },
    enabled: enabled && !!pair && !!chain && !!address,
    staleTime: 60_000,
    retry: false,
  })
}

export type V1PlanParams = {
  info: OftV1Info | undefined
  dstKey: ChainKey | undefined
  amountInput: string
  sender: Address | undefined
  recipient: Recipient | undefined
  slippageBps: number
  feeBufferBps: number
  dstGasEstimate: bigint | undefined
}

export function useV1Plan(p: V1PlanParams) {
  const src = p.info ? byKey(p.info.chain) : undefined
  const client = useReadClient(src && isEvm(src) ? src : undefined)
  const amount = useDebounced(p.amountInput, 350)
  const enabled = !!client && !!p.info && !!p.dstKey && !!p.sender && !!p.recipient && amount.trim() !== ''
  return useQuery({
    queryKey: [
      'v1plan',
      p.info?.chain,
      p.info?.oft,
      p.dstKey,
      amount,
      p.sender,
      p.recipient?.to,
      p.slippageBps,
      p.feeBufferBps,
      (p.dstGasEstimate ?? 0n).toString(),
    ],
    queryFn: () =>
      buildV1SendPlan({
        info: p.info!,
        dstKey: p.dstKey!,
        amountInput: amount,
        sender: p.sender!,
        recipient: p.recipient!,
        slippageBps: p.slippageBps,
        feeBufferBps: p.feeBufferBps,
        ...(p.dstGasEstimate !== undefined ? { dstGasEstimate: p.dstGasEstimate } : {}),
        client: client!,
      }),
    enabled,
    staleTime: 20_000,
    retry: false,
  })
}

/**
 * The transaction that is about to be signed, run against the chain first.
 *
 * `allowance` is in the key so the simulation is re-run the moment an approve lands: before it,
 * an adapter's `transferFrom` reverts, and that revert is a true answer about the state at the
 * time, not a defect to hide.
 */
export function useV1Simulation(plan: V1SendPlan | undefined, allowance: bigint | undefined, customRpc: string | undefined) {
  const src = plan ? byKey(plan.chain) : undefined
  const client = useMemo(() => (src && isEvm(src) ? makeReadClient(src, customRpc) : undefined), [src, customRpc])
  return useQuery<V1Simulation>({
    queryKey: ['v1sim', plan?.chain, plan?.oft, plan?.dst.key, plan?.amounts.amountLD.toString(), plan?.recipient, plan?.value.toString(), (allowance ?? 0n).toString()],
    queryFn: () => simulateV1Send(client as ReadClient, plan!),
    enabled: !!client && !!plan,
    staleTime: 15_000,
    retry: false,
  })
}

/** Guard 17's v1 form: does the contract on the destination name ours as its trusted remote? */
export function useV1PeerBack(info: OftV1Info | undefined, dstKey: ChainKey | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  const route = info?.routes.find((r) => r.key === dstKey)
  const dst = dstKey ? byKey(dstKey) : undefined
  const pair = useMemo(() => (dst && isEvm(dst) ? clientPair(dst, customRpc[dst.key]) : undefined), [dst, customRpc])
  return useQuery<V1PeerBack>({
    queryKey: ['v1peerBack', info?.chain, info?.oft, dstKey, route?.remoteAddress],
    queryFn: async () => {
      const all = await Promise.all(
        [pair!.primary, ...pair!.secondaries].map((c) => checkV1TrustedRemoteBack(c, route!.remoteAddress!, info!.srcV1ChainId, info!.oft)),
      )
      // A mismatch anywhere wins, then any definite "ok", else "unavailable".
      return all.find((r) => r.status === 'mismatch') ?? all.find((r) => r.status === 'ok') ?? all[0]!
    },
    enabled: !!pair && !!info && !!route?.remoteAddress,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

/**
 * Guard 20: is the destination endpoint already holding a packet for this exact path?
 *
 * The path bytes are read from the DESTINATION contract's own `trustedRemoteLookup`, because that
 * is the key the endpoint stored the payload under. Rebuilding those bytes from two addresses
 * would be a guess; reading them is not.
 */
export function useV1StoredPayload(info: OftV1Info | undefined, dstKey: ChainKey | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  const route = info?.routes.find((r) => r.key === dstKey)
  const dst = dstKey ? byKey(dstKey) : undefined
  const client = useMemo(() => (dst && isEvm(dst) ? makeReadClient(dst, customRpc[dst.key]) : undefined), [dst, customRpc])
  return useQuery<StoredPayloadState>({
    queryKey: ['v1stored', info?.chain, info?.oft, dstKey, route?.remoteAddress],
    queryFn: async () => {
      const dstV1 = lzV1(dstKey!)
      if (!dstV1) return { status: 'unavailable', reason: 'no v1 endpoint on the destination' }
      const path = await pathOnDestination(client as ReadClient, route!.remoteAddress!, info!.srcV1ChainId)
      if (!path) return { status: 'unavailable', reason: 'the destination did not answer trustedRemoteLookup' }
      const stuck = await hasStoredPayloadOnDst(client as ReadClient, dstV1.endpoint, info!.srcV1ChainId, path)
      if (stuck === undefined) return { status: 'unavailable', reason: 'the destination endpoint did not answer' }
      return stuck ? { status: 'blocked' } : { status: 'clear' }
    },
    enabled: !!client && !!info && !!route?.remoteAddress,
    staleTime: 60_000,
    retry: 1,
  })
}
