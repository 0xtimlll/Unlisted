'use client'
/**
 * Solana-as-source hooks (§6). Every heavy module (the LayerZero SDK, umi, ed25519) is imported on
 * demand inside a query so the EVM-only path never downloads it. Mirrors hooks.ts one for one:
 * probe → balances → plan → check → send → confirmation.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import type { SelfCheckResult, SimulationResult } from '@/core/guards'
import type { Recipient } from '@/core/recipient'
import type { SvmDecodeResult } from '@/core/svm/decode'
import type { SvmSendPlan } from '@/core/svm/plan'
import type { SvmSendContext, SvmSigner } from '@/core/svm/send'
import type { SvmSourceInfo } from '@/core/svm/source'
import type { SuspiciousFlag } from '@/core/types'
import { svmRpcUrls } from '@/core/svm/urls'
import { useDebounced, shortError } from './hooks'

export type SvmProbe = { info: SvmSourceInfo; flags: SuspiciousFlag[] }

/** Step 1 for a Solana source: read the OFT Store and everything hanging off it. */
export function useSvmProbe(enabled: boolean, store: string | null, customRpc: string | undefined) {
  return useQuery({
    queryKey: ['svmProbe', store, customRpc ?? ''],
    queryFn: async (): Promise<SvmProbe> => {
      const [{ SvmRpc }, { probeSvmOft }] = await Promise.all([import('@/core/svm/rpc'), import('@/core/svm/source')])
      const r = await probeSvmOft(new SvmRpc(svmRpcUrls(customRpc)), store!)
      const flags: SuspiciousFlag[] = []
      if (r.info.paused) flags.push('svm_source_paused')
      if (r.info.defaultFeeBps > 0) flags.push('svm_fee')
      if (!customRpc) flags.push('svm_single_provider')
      else if (!r.crossChecked) flags.push('not_cross_checked')
      return { info: r.info, flags }
    },
    enabled: enabled && !!store,
    staleTime: 60_000,
    retry: false,
  })
}

/** Step 1 by sample transaction (§5.4 for Solana): OFT Store + destination + sanitized options. */
export function useSvmDecode(enabled: boolean, signature: string | null, customRpc: string | undefined) {
  return useQuery({
    queryKey: ['svmDecode', signature, customRpc ?? ''],
    queryFn: async (): Promise<SvmDecodeResult> => {
      const [{ SvmRpc }, { decodeSvmTx }] = await Promise.all([import('@/core/svm/rpc'), import('@/core/svm/decode')])
      return decodeSvmTx(new SvmRpc(svmRpcUrls(customRpc)), signature!)
    },
    enabled: enabled && !!signature,
    staleTime: Infinity,
    retry: false,
  })
}

/** Token balance = the sender's associated token account (a missing ATA is a balance of 0). */
export function useSvmTokenBalance(info: SvmSourceInfo | undefined, wallet: string | undefined, customRpc: string | undefined) {
  return useQuery({
    queryKey: ['svmBalance', info?.tokenMint, info?.tokenProgram, wallet, customRpc ?? ''],
    queryFn: async (): Promise<bigint> => {
      const [{ SvmRpc }, { ataFor }, { decodeTokenAccount }] = await Promise.all([import('@/core/svm/rpc'), import('@/core/svm/recipient'), import('@/core/svm/layouts')])
      const rpc = new SvmRpc(svmRpcUrls(customRpc))
      const acc = await rpc.getAccountInfo(ataFor(wallet!, info!.tokenMint, info!.tokenProgram))
      return acc ? decodeTokenAccount(acc.data).amount : 0n
    },
    enabled: !!info && !!wallet,
    refetchInterval: 15_000,
    retry: 1,
  })
}

export function useSvmNativeBalance(wallet: string | undefined, customRpc: string | undefined) {
  return useQuery({
    queryKey: ['svmNative', wallet, customRpc ?? ''],
    queryFn: async (): Promise<bigint> => {
      const { SvmRpc } = await import('@/core/svm/rpc')
      return new SvmRpc(svmRpcUrls(customRpc)).getBalance(wallet!)
    },
    enabled: !!wallet,
    refetchInterval: 15_000,
    retry: 1,
  })
}

/** The SDK context (umi + lookup table), created once per RPC set. */
export function useSvmContext(enabled: boolean, customRpc: string | undefined) {
  return useQuery({
    queryKey: ['svmCtx', customRpc ?? ''],
    queryFn: async (): Promise<SvmSendContext> => {
      const { createSvmSendContext } = await import('@/core/svm/send')
      return createSvmSendContext(svmRpcUrls(customRpc))
    },
    enabled,
    staleTime: Infinity,
    retry: 1,
  })
}

export type SvmPlanParams = {
  ctx: SvmSendContext | undefined
  info: SvmSourceInfo | undefined
  dstEid: number | undefined
  amountInput: string
  sender: string | undefined
  recipient: Recipient | undefined
  slippageBps: number
  feeBufferBps: number
  extraOptions: Hex
}

export function useSvmPlan(p: SvmPlanParams) {
  const amount = useDebounced(p.amountInput, 350)
  const enabled = !!p.ctx && !!p.info && p.dstEid !== undefined && !!p.sender && !!p.recipient && amount.trim() !== ''
  return useQuery({
    queryKey: ['svmPlan', p.info?.oftStore, p.dstEid, amount, p.sender, p.recipient?.vm, p.recipient?.to, p.slippageBps, p.feeBufferBps, p.extraOptions, p.ctx?.endpoint],
    queryFn: async (): Promise<SvmSendPlan> => {
      const { buildSvmSendPlan } = await import('@/core/svm/send')
      return buildSvmSendPlan(p.ctx!, {
        info: p.info!,
        dstEid: p.dstEid!,
        amountInput: amount,
        sender: p.sender!,
        recipient: p.recipient!,
        slippageBps: p.slippageBps,
        feeBufferBps: p.feeBufferBps,
        extraOptions: p.extraOptions,
      })
    },
    enabled,
    refetchInterval: 30_000, // fees move
    retry: false,
  })
}

export type SvmCheckResult = { simulation: SimulationResult; selfCheck: SelfCheckResult; gasCostWei: bigint }

/**
 * §6.13 + §6.14 for Solana: assemble the exact transaction, decode it back (SDK-free) and dry-run
 * it. Runs once the pure guards pass, like useCheck().
 */
export function useSvmCheck(ctx: SvmSendContext | undefined, plan: SvmSendPlan | undefined, ready: boolean) {
  return useQuery({
    queryKey: ['svmCheck', plan?.oftStore, plan?.sender, plan?.amounts.amountLD.toString(), plan?.value.toString(), plan?.dstEid, plan?.recipient, plan?.extraOptions, plan?.computeUnitLimit, plan?.computeUnitPrice.toString()],
    queryFn: async (): Promise<SvmCheckResult> => {
      const [{ assembleSvmTransaction, simulateSvm, svmTxFeeLamports }, { selfCheckSvm }] = await Promise.all([import('@/core/svm/send'), import('@/core/svm/plan')])
      const { tx, view } = await assembleSvmTransaction(ctx!, plan!)
      const selfCheck = selfCheckSvm(plan!, view)
      let simulation: SimulationResult
      try {
        const sim = await simulateSvm(ctx!, tx)
        simulation = sim.err === null ? { ok: true } : { ok: false, reason: describeSimError(sim.err, sim.logs) }
      } catch (e) {
        simulation = { ok: false, reason: shortError(e) }
      }
      return { simulation, selfCheck, gasCostWei: svmTxFeeLamports(plan!) }
    },
    enabled: !!ctx && !!plan && ready,
    staleTime: 20_000,
    retry: false,
  })
}

function describeSimError(err: unknown, logs: string[]): string {
  const last = [...logs].reverse().find((l) => /Error|failed|insufficient/i.test(l))
  return `${JSON.stringify(err)}${last ? ` — ${last}` : ''}`.slice(0, 200)
}

/** The send itself: sign in the wallet, submit through the SDK builder (core/svm/send.ts). */
export function useSvmSend() {
  return useMutation({
    mutationFn: async (p: { ctx: SvmSendContext; plan: SvmSendPlan; signer: SvmSigner }): Promise<string> => {
      const { submitSvm } = await import('@/core/svm/send')
      return submitSvm(p.ctx, p.plan, p.signer)
    },
  })
}

export type SvmConfirmation = 'pending' | 'confirmed' | 'failed'

/** Source-chain confirmation of a signature (the Solana form of waiting for a receipt). */
export function useSvmSignatureStatus(signature: string | undefined, customRpc: string | undefined) {
  return useQuery({
    queryKey: ['svmSig', signature, customRpc ?? ''],
    queryFn: async (): Promise<SvmConfirmation> => {
      const { SvmRpc } = await import('@/core/svm/rpc')
      const s = await new SvmRpc(svmRpcUrls(customRpc)).getSignatureStatus(signature!)
      if (!s) return 'pending'
      if (s.err !== null) return 'failed'
      return s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' ? 'confirmed' : 'pending'
    },
    enabled: !!signature,
    refetchInterval: (q) => (q.state.data === 'confirmed' || q.state.data === 'failed' ? false : 3_000),
    retry: 1,
  })
}
