/**
 * The last thing before the button appears: run the transaction that is about to be signed.
 *
 * Not "a" send — THE send. Same `to`, same calldata, same `from`, same `value`. Anything less is
 * a different transaction and would prove nothing about this one. `eth_call` at the latest block
 * executes the whole path (debit, trusted remote lookup, adapter-param check, relayer pricing) and
 * reverts for the same reasons the real transaction would.
 *
 * A revert is returned, never thrown away: the CTA is hidden and the reason is shown by name.
 * A revert this app cannot name is still a revert — it is reported as unknown, not as success.
 * An RPC that could not be reached is a third answer, distinct from both, so a node being down can
 * never look like a passing check.
 */
import type { Address, Hex } from 'viem'
import type { ReadClient } from '../../core/client'
import { decodeRevert, revertDataFromError, type DecodedRevert } from '../../core/sim/revert'
import { erc20Abi } from '../../core/abi'
import { encodeV1SendCalldata, type V1SendPlan } from './plan'

export type V1Simulation =
  | { status: 'ok'; gas: bigint | undefined }
  | { status: 'reverted'; revert: DecodedRevert }
  /** The node did not answer. Not a pass and not a failure. */
  | { status: 'unavailable'; reason: string }

/**
 * `eth_call` of the exact `sendFrom` this plan encodes.
 *
 * An adapter needs its allowance in place before this can succeed, so the caller is expected to
 * run it after the approve — the same order the V2 tab already uses. A missing allowance shows up
 * here as the token's own `ERC20InsufficientAllowance`, decoded by name.
 */
export async function simulateV1Send(client: ReadClient, plan: V1SendPlan): Promise<V1Simulation> {
  const data = encodeV1SendCalldata(plan)
  const call = { account: plan.sender, to: plan.oft, data, value: plan.value } as const
  try {
    await client.call(call)
  } catch (e) {
    const revert = revertDataFromError(e)
    if (revert === undefined) {
      return { status: 'unavailable', reason: e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e) }
    }
    // The token's own ABI names allowance and balance failures that the shared list cannot.
    return { status: 'reverted', revert: decodeRevert(revert, erc20Abi as never) }
  }
  let gas: bigint | undefined
  try {
    gas = await client.estimateGas(call)
  } catch {
    // The call itself already succeeded; a missing estimate only costs guard 8 its gas figure.
    gas = undefined
  }
  return { status: 'ok', gas }
}

/**
 * The approve this plan needs, or null. Exactly the amount in the calldata, spender exactly the
 * OFT the user was shown — an adapter pulls with `transferFrom`, a plain OFT burns and needs
 * nothing at all.
 */
export type V1ApproveIntent = { token: Address; spender: Address; amount: bigint }

export function v1ApprovePlan(plan: V1SendPlan, approvalRequired: boolean, allowance: bigint | undefined): V1ApproveIntent | null {
  if (!approvalRequired) return null
  if (allowance !== undefined && allowance >= plan.amounts.amountLD) return null
  return { token: plan.token, spender: plan.oft, amount: plan.amounts.amountLD }
}

/** The calldata the wallet will be handed, for the review screen to print in full. */
export function v1Calldata(plan: V1SendPlan): Hex {
  return encodeV1SendCalldata(plan)
}
