'use client'
/**
 * Wires core/approveFlow.ts to a wallet and a node.
 *
 * The only write here is `approve`, with the function name written literally so the build-time
 * whitelist can see it. The spender and the amount come from the intent the guards checked; the
 * clearing step (approve(0)) is the one exception to "exactly the amount", and it exists only for
 * tokens whose `approve` reverts on a non-zero allowance — see approveSequence().
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { usePublicClient, useWriteContract } from 'wagmi'
import { erc20Abi } from '@/core/abi'
import { runApproveFlow, type ApprovePhase } from '@/core/approveFlow'
import { isUserRejection, shortError } from './hooks'

export type ApproveFlowInput = {
  chainId: number | undefined
  owner: Address | undefined
  token: Address | undefined
  spender: Address | undefined
  amount: bigint | undefined
  allowance: bigint | undefined
  /** Re-reads the allowance and returns it, or undefined when the read failed. */
  refetchAllowance: () => Promise<bigint | undefined>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function useApproveFlow(i: ApproveFlowInput) {
  const client = usePublicClient({ chainId: i.chainId ?? 1 })
  const { writeContractAsync } = useWriteContract()
  const [phase, setPhase] = useState<ApprovePhase>({ kind: 'idle' })
  // A second click while a step is in flight must do nothing: the ref answers synchronously,
  // before React has re-rendered with the new phase.
  const running = useRef(false)

  // A different approve (another amount, token, spender or wallet) is a different flow.
  const key = `${i.chainId}:${i.owner}:${i.token}:${i.spender}:${i.amount?.toString()}`
  useEffect(() => {
    if (!running.current) setPhase({ kind: 'idle' })
  }, [key])

  const start = useCallback(async () => {
    if (running.current) return
    const { chainId, owner, token, spender, amount } = i
    if (chainId === undefined || !owner || !token || !spender || amount === undefined || !client) return
    running.current = true
    try {
      await runApproveFlow(
        { amount, allowance: i.allowance },
        {
          plainApproveReverts: async () => {
            try {
              await client.simulateContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account: owner })
              return false
            } catch (e) {
              const m = (e instanceof Error ? `${e.name} ${e.message}` : String(e)).toLowerCase()
              return m.includes('revert')
            }
          },
          signApprove: (stepAmount) =>
            writeContractAsync({
              address: token,
              abi: erc20Abi,
              functionName: 'approve',
              args: [spender, stepAmount],
              chainId,
            }),
          waitForReceipt: async (hash) => (await client.waitForTransactionReceipt({ hash })).status,
          refetchAllowance: i.refetchAllowance,
          isRejection: isUserRejection,
          describeError: shortError,
          sleep,
        },
        setPhase,
      )
    } finally {
      running.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client, writeContractAsync, i.allowance, i.refetchAllowance])

  const reset = useCallback(() => {
    if (!running.current) setPhase({ kind: 'idle' })
  }, [])

  return { phase, start, reset }
}
