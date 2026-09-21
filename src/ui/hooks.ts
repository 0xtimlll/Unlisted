'use client'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { encodeFunctionData, type Address, type Hash, type Hex } from 'viem'
import { useBalance, usePublicClient, useReadContract } from 'wagmi'
import { erc20Abi, oftAbi } from '@/core/abi'
import { byEid, isEvm, type ChainKey, type EvmChainDef } from '@/core/chains'
import type { ReadClient } from '@/core/client'
import { selfCheck, type SelfCheckResult, type SimulationResult } from '@/core/guards'
import { assembleSendArgs, buildSendPlan, type SendPlan } from '@/core/plan'
import { clientPair, decodeTxQuorum, probeOftQuorum } from '@/core/quorum'
import { fetchStatus, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, type TrackState } from '@/core/track'
import type { OftInfo } from '@/core/types'
import { checkPeerBack } from '@/core/verify'

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** wagmi's client for the source chain, typed as our read client. */
export function useReadClient(chain: EvmChainDef): ReadClient | undefined {
  return usePublicClient({ chainId: chain.chainId }) as ReadClient | undefined
}

/**
 * Probe on independent RPCs (core/quorum). Adds the "not cross-checked" flag so the UI can
 * show it next to the other yellow flags.
 */
export function useProbe(chain: EvmChainDef, address: string | null, customRpc: string | undefined) {
  const pair = useMemo(() => clientPair(chain, customRpc), [chain, customRpc])
  return useQuery({
    queryKey: ['probe', chain.key, address?.toLowerCase(), customRpc ?? ''],
    queryFn: async () => {
      const r = await probeOftQuorum(pair, address!)
      const flags = [...r.flags]
      if (!r.crossChecked) flags.push('not_cross_checked')
      return { ...r, flags }
    },
    enabled: !!address,
    staleTime: 60_000,
    retry: false,
  })
}

export function useDecode(chain: EvmChainDef, hash: string | null, customRpc: string | undefined) {
  const pair = useMemo(() => clientPair(chain, customRpc), [chain, customRpc])
  return useQuery({
    queryKey: ['decode', chain.key, hash?.toLowerCase(), customRpc ?? ''],
    queryFn: () => decodeTxQuorum(pair, hash!),
    enabled: !!hash,
    staleTime: Infinity,
    retry: false,
  })
}

/** Guard 17: does the destination-side peer name our OFT back? Read on the destination chain. */
export function usePeerBack(srcEid: number, oft: Address | undefined, dstEid: number | undefined, peer: Hex | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  const dst = dstEid !== undefined ? byEid(dstEid) : undefined
  // Only EVM destinations can be verified this way; other VMs get their own check later.
  const pair = useMemo(() => (dst && isEvm(dst) ? clientPair(dst, customRpc[dst.key]) : undefined), [dst, customRpc])
  return useQuery({
    queryKey: ['peerBack', srcEid, oft, dstEid, peer],
    queryFn: async () => {
      // Ask every provider; a mismatch anywhere wins, then any definite "ok", else unavailable.
      const all = await Promise.all([pair!.primary, ...pair!.secondaries].map((c) => checkPeerBack(c, peer!, srcEid, oft!)))
      return all.find((r) => r.status === 'mismatch') ?? all.find((r) => r.status === 'ok') ?? all[0]!
    },
    enabled: !!pair && !!oft && !!peer && dstEid !== undefined,
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

export type PlanParams = {
  info: OftInfo | undefined
  src: EvmChainDef
  dstEid: number | undefined
  amountInput: string
  sender: Address | undefined
  recipient: Address | undefined
  slippageBps: number
  feeBufferBps: number
  extraOptions: `0x${string}`
}

export function usePlan(p: PlanParams) {
  const client = useReadClient(p.src)
  const amount = useDebounced(p.amountInput, 350)
  const enabled = !!client && !!p.info && p.dstEid !== undefined && !!p.sender && !!p.recipient && amount.trim() !== ''
  return useQuery({
    queryKey: [
      'plan', p.src.key, p.info?.oft, p.dstEid, amount, p.sender, p.recipient, p.slippageBps, p.feeBufferBps, p.extraOptions,
    ],
    queryFn: () =>
      buildSendPlan(client!, {
        info: p.info!,
        src: p.src,
        dstEid: p.dstEid!,
        amountInput: amount,
        sender: p.sender!,
        recipient: p.recipient!,
        slippageBps: p.slippageBps,
        feeBufferBps: p.feeBufferBps,
        extraOptions: p.extraOptions,
      }),
    enabled,
    refetchInterval: 30_000, // fees move
    retry: false,
  })
}

export type CheckResult = {
  simulation: SimulationResult
  selfCheck: SelfCheckResult
  gasCostWei: bigint | undefined
}

/**
 * §6.13 + §6.14: simulate `send` and decode our own calldata back. Only runs once the
 * pure guards (chain, peer, balance, allowance…) already pass, so failures here are real.
 */
export function useCheck(src: EvmChainDef, plan: SendPlan | undefined, ready: boolean) {
  const client = useReadClient(src)
  return useQuery({
    queryKey: ['check', src.key, plan?.oft, plan?.sender, plan?.amounts.amountLD.toString(), plan?.value.toString(), plan?.dstEid, plan?.recipient, plan?.extraOptions],
    queryFn: async (): Promise<CheckResult> => {
      const args = assembleSendArgs(plan!)
      const calldata = encodeFunctionData({ abi: oftAbi, functionName: 'send', args: [args[0], args[1], args[2]] })
      const sc = selfCheck(plan!, calldata)
      let simulation: SimulationResult
      let gasCostWei: bigint | undefined
      try {
        await client!.simulateContract({
          address: plan!.oft,
          abi: oftAbi,
          functionName: 'send',
          args: [args[0], args[1], args[2]],
          value: plan!.value,
          account: plan!.sender,
        })
        simulation = { ok: true }
        const [gas, price] = await Promise.all([
          client!.estimateContractGas({
            address: plan!.oft,
            abi: oftAbi,
            functionName: 'send',
            args: [args[0], args[1], args[2]],
            value: plan!.value,
            account: plan!.sender,
          }),
          client!.getGasPrice(),
        ])
        gasCostWei = (gas * price * 12n) / 10n // +20% headroom
      } catch (e) {
        simulation = { ok: false, reason: shortError(e) }
      }
      return { simulation, selfCheck: sc, gasCostWei }
    },
    enabled: !!client && !!plan && ready,
    staleTime: 20_000,
    retry: false,
  })
}

export function useTokenBalance(chain: EvmChainDef, token: Address | undefined, owner: Address | undefined) {
  return useReadContract({
    abi: erc20Abi,
    address: token,
    functionName: 'balanceOf',
    args: owner ? [owner] : undefined,
    chainId: chain.chainId,
    query: { enabled: !!token && !!owner, refetchInterval: 15_000 },
  })
}

export function useAllowance(chain: EvmChainDef, token: Address | undefined, owner: Address | undefined, spender: Address | undefined) {
  return useReadContract({
    abi: erc20Abi,
    address: token,
    functionName: 'allowance',
    args: owner && spender ? [owner, spender] : undefined,
    chainId: chain.chainId,
    query: { enabled: !!token && !!owner && !!spender, refetchInterval: 15_000 },
  })
}

export function useNativeBalance(chain: EvmChainDef, owner: Address | undefined) {
  return useBalance({ address: owner, chainId: chain.chainId, query: { enabled: !!owner, refetchInterval: 15_000 } })
}

/** §5.5 via react-query: poll LayerZero Scan every 12s until terminal or 20 min. */
export function useTrack(hash: Hash | undefined, startedAt: number | undefined) {
  return useQuery({
    queryKey: ['track', hash],
    queryFn: () => fetchStatus(hash!),
    enabled: !!hash,
    refetchInterval: (q) => {
      const s = q.state.data as TrackState | undefined
      if (s && (s.phase === 'delivered' || s.phase === 'failed')) return false
      if (startedAt && Date.now() - startedAt > POLL_TIMEOUT_MS) return false
      return POLL_INTERVAL_MS
    },
    retry: false,
  })
}

/** First meaningful line of a viem/wallet error, capped. Never rendered as HTML. */
export function shortError(e: unknown): string {
  if (!e) return ''
  const anyE = e as { shortMessage?: string; details?: string; message?: string }
  const s = anyE.shortMessage ?? anyE.details ?? anyE.message ?? String(e)
  return s.split('\n')[0]?.slice(0, 200) ?? ''
}

export function isUserRejection(e: unknown): boolean {
  const s = shortError(e).toLowerCase()
  return s.includes('rejected') || s.includes('denied') || (e as { code?: number })?.code === 4001
}
