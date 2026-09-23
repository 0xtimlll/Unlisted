/**
 * §Task 4: simulate what will actually happen, and say why when it will not work.
 *
 * Two things matter here beyond a plain eth_call:
 *
 *  - When an approve is still needed, simulating `send` on its own always fails on the allowance
 *    and tells the user nothing. Where the RPC supports eth_simulateV1 the approve and the send
 *    are simulated as one batch, so a real problem (no peer, paused, rate limit) is visible BEFORE
 *    anything is signed. Where it does not, we fall back and say the send could not be checked yet.
 *
 *  - A revert is decoded into a named error and a meaning (core/sim/revert.ts), not shown as hex.
 *
 * Only `approve` and `send` are ever put in the batch; the calldata is built here, from the plan,
 * with the function names written literally so the build-time whitelist can see them.
 */
import { encodeFunctionData, type Address } from 'viem'
import { simulateCalls } from 'viem/actions'
import { erc20Abi, oftAbi } from '../abi'
import type { ReadClient } from '../client'
import type { SendArgs } from '../plan'
import { decodeRevert, enrichRevert, formatRevert, revertDataFromError, type DecodedRevert } from './revert'

export type SimStep = 'approve' | 'send'

export type SimOutcome =
  | { ok: true; gas?: bigint; batched: boolean }
  | { ok: false; step: SimStep; revert: DecodedRevert; reason: string; batched: boolean }
  /** The RPC could not answer. NOT a statement that the transaction would fail. */
  | { ok: 'unknown'; reason: string }

export type SimulateInput = {
  account: Address
  oft: Address
  sendArgs: SendArgs
  value: bigint
  /** Present only when the allowance is short; the approve is for exactly this amount. */
  approve?: { token: Address; spender: Address; amount: bigint }
  /** Lets an unnamed selector be looked up in the contract's own verified ABI. */
  chainId?: number
  token?: Address
}

/** Contracts that could have produced the revert, most likely first. */
function revertCandidates(p: SimulateInput): string[] {
  return [p.oft, ...(p.token ? [p.token] : []), ...(p.approve ? [p.approve.token] : [])]
}

/** Errors that mean "this node does not implement eth_simulateV1", not "the call fails". */
function isUnsupported(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return m.includes('method not found') || m.includes('not supported') || m.includes('unsupported method') || m.includes('-32601') || m.includes('does not exist')
}

export async function simulateSend(client: ReadClient, p: SimulateInput): Promise<SimOutcome> {
  const [sendParam, fee, refundAddress] = p.sendArgs

  if (p.approve) {
    const batched = await trySimulateCalls(client, p)
    if (batched) return batched
  }

  // Plain path: one eth_call for the send, plus a gas estimate when it succeeds.
  try {
    await client.simulateContract({ address: p.oft, abi: oftAbi, functionName: 'send', args: [sendParam, fee, refundAddress], value: p.value, account: p.account })
  } catch (e) {
    const data = revertDataFromError(e)
    if (data === undefined && !looksLikeRevert(e)) return { ok: 'unknown', reason: firstLine(e) }
    const revert = await name(decodeRevert(data), p)
    return { ok: false, step: 'send', revert, reason: formatRevert(revert), batched: false }
  }
  let gas: bigint | undefined
  try {
    gas = await client.estimateContractGas({ address: p.oft, abi: oftAbi, functionName: 'send', args: [sendParam, fee, refundAddress], value: p.value, account: p.account })
  } catch {
    /* the simulation already passed; a missing estimate is not a failure */
  }
  return gas === undefined ? { ok: true, batched: false } : { ok: true, gas, batched: false }
}

/**
 * approve + send in one eth_simulateV1 block. Returns undefined when the node does not support it,
 * so the caller falls back.
 */
async function trySimulateCalls(client: ReadClient, p: SimulateInput): Promise<SimOutcome | undefined> {
  const approve = p.approve
  if (!approve) return undefined
  const [sendParam, fee, refundAddress] = p.sendArgs
  try {
    // The batch is one expression on purpose: what it contains is visible at the call site, to a
    // reader and to scripts/check-whitelist.mjs, which allows only approve and send here.
    const res = await simulateCalls(client, {
      account: p.account,
      calls: [
        { to: approve.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approve.spender, approve.amount] }) },
        { to: p.oft, data: encodeFunctionData({ abi: oftAbi, functionName: 'send', args: [sendParam, fee, refundAddress] }), value: p.value },
      ],
    })
    const [approveResult, sendResult] = res.results
    if (approveResult && approveResult.status === 'failure') {
      const revert = await name(decodeRevert(revertDataFromError(approveResult.error)), p)
      return { ok: false, step: 'approve', revert, reason: formatRevert(revert), batched: true }
    }
    if (sendResult && sendResult.status === 'failure') {
      const revert = await name(decodeRevert(revertDataFromError(sendResult.error)), p)
      return { ok: false, step: 'send', revert, reason: formatRevert(revert), batched: true }
    }
    // Raw gas, like the plain path: the caller adds its own headroom.
    const gas = sendResult?.gasUsed
    return gas === undefined ? { ok: true, batched: true } : { ok: true, gas, batched: true }
  } catch (e) {
    if (isUnsupported(e)) return undefined
    const data = revertDataFromError(e)
    if (data === undefined) return undefined // an RPC hiccup: let the plain path decide
    const revert = await name(decodeRevert(data), p)
    return { ok: false, step: 'send', revert, reason: formatRevert(revert), batched: true }
  }
}

/** Gives an unnamed selector a name from the contract's own verified ABI, when there is one. */
async function name(revert: DecodedRevert, p: SimulateInput): Promise<DecodedRevert> {
  if (revert.kind !== 'unknown' || p.chainId === undefined) return revert
  return enrichRevert(revert, { chainId: p.chainId, candidates: revertCandidates(p) })
}

function looksLikeRevert(e: unknown): boolean {
  const m = (e instanceof Error ? `${e.name} ${e.message}` : String(e)).toLowerCase()
  return m.includes('revert') || m.includes('execution reverted')
}

function firstLine(e: unknown): string {
  const anyE = e as { shortMessage?: string; details?: string; message?: string }
  return (anyE.shortMessage ?? anyE.details ?? anyE.message ?? String(e)).split('\n')[0]?.slice(0, 200) ?? ''
}
