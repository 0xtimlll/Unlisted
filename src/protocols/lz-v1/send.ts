/**
 * The only place in this codebase that may submit a LayerZero v1 `sendFrom`.
 *
 * It takes the wallet writer as an argument instead of being a hook, so the screen that calls it
 * never names the function being written and this file stays the single auditable boundary — the
 * same arrangement `src/core/svm/send.ts` has for Solana. scripts/check-whitelist.mjs enforces it:
 * `sendFrom` is allowed only under `src/protocols/lz-v1/`.
 *
 * Two things happen here before the wallet is asked for anything, in this order:
 *
 *   1. the calldata is encoded and then decoded back by independent code (selfcheck.ts) and
 *      compared with the plan the user is looking at;
 *   2. `value` is checked against the quote the plan committed to.
 *
 * Only then is the transaction handed over — as `abi + functionName + args`, so wagmi re-encodes
 * exactly what was just verified rather than being trusted with raw bytes.
 *
 * The three standards are submitted in three separate branches rather than through one widened
 * call. That is not ceremony: each `sendFrom` has its own argument list, and writing them out is
 * what lets the compiler check each tuple against the ABI that will encode it.
 */
import type { Hash, Hex } from 'viem'
// Type-only: no wagmi code is imported into this module, only the shape of its writer.
import type { useWriteContract } from 'wagmi'
import { oftV1Abi, oftV2OnV1Abi, oftWithFeeAbi } from './abi'
import { assembleV1SendArgs, encodeV1SendCalldata, type V1SendPlan } from './plan'
import { v1SelfCheck } from './selfcheck'

/** Whatever can submit the transaction — in the app, wagmi's `useWriteContract()` result. */
export type V1Writer = Pick<ReturnType<typeof useWriteContract>, 'writeContractAsync'>

export class V1SendRefused extends Error {
  constructor(
    public readonly code: 'selfcheck_failed' | 'value_mismatch',
    public readonly mismatches: string[] = [],
  ) {
    super(code)
    this.name = 'V1SendRefused'
  }
}

/**
 * Submits the plan's `sendFrom`, or throws V1SendRefused without asking the wallet for anything.
 *
 * `chainId` is the source chain, passed explicitly so a wallet that silently switched networks
 * cannot have the transaction land somewhere else.
 */
export async function submitV1Send(writer: V1Writer, plan: V1SendPlan, chainId: number): Promise<Hash> {
  const calldata: Hex = encodeV1SendCalldata(plan)
  const check = v1SelfCheck(plan, calldata)
  if (!check.ok) throw new V1SendRefused('selfcheck_failed', check.mismatches)
  if (plan.value < plan.quote.nativeFee) throw new V1SendRefused('value_mismatch', ['value < quoted nativeFee'])

  const a = assembleV1SendArgs(plan)
  const common = { address: plan.oft, value: plan.value, chainId } as const

  if (a.wire === 'bytes') {
    return writer.writeContractAsync({ ...common, abi: oftV1Abi, functionName: 'sendFrom', args: a.args })
  }
  if (a.wire === 'bytes32') {
    return writer.writeContractAsync({ ...common, abi: oftV2OnV1Abi, functionName: 'sendFrom', args: a.args })
  }
  return writer.writeContractAsync({ ...common, abi: oftWithFeeAbi, functionName: 'sendFrom', args: a.args })
}
