/**
 * Simulating a Hyperlane send, and decoding our own calldata back before anything is signed.
 *
 * Confined to the protocol module: `transferRemote` is the one state-changing call here, and
 * scripts/check-whitelist.mjs allows that name only in this directory and the one screen that
 * submits it.
 *
 * When an approve is still owed, simulating `transferRemote` alone always fails on the allowance
 * and says nothing. Where the node supports eth_simulateV1 the approve and the send are simulated
 * as one batch (core/sim/preview.ts does the same for an OFT), so a real problem — no router
 * enrolled, a paused route, a fee that moved — is visible before anything is signed. Only
 * `approve` and `transferRemote` are ever put in the batch, with their names written literally.
 */
import { decodeFunctionData, encodeFunctionData, isAddressEqual, size, slice, toFunctionSelector, type Address, type Hex } from 'viem'
import { simulateCalls } from 'viem/actions'
import { erc20Abi } from '../../core/abi'
import type { ReadClient } from '../../core/client'
import { decodeRevert, enrichRevert, formatRevert, revertDataFromError, type DecodedRevert } from '../../core/sim/revert'
import { sanitizeText } from '../../core/text'
import { warpRouteAbi } from './abi'
import type { HyperlaneApproveIntent, HyperlaneSimulation } from './guards'
import { assembleTransferRemoteArgs, type HyperlanePlan } from './plan'

export type HyperlaneSelfCheck = { ok: true } | { ok: false; mismatches: string[] }

export type HyperlanePreview = {
  simulation: HyperlaneSimulation
  selfCheck: HyperlaneSelfCheck
  gasCostWei: bigint | undefined
  revert?: DecodedRevert
  /** Which call reverted when the approve and the send were simulated together. */
  failedStep?: 'approve' | 'send'
  /** The approve and the send were checked as one batch. */
  batched?: boolean
  /** The RPC could not answer: the send is NOT known to fail. */
  rpcUnavailable?: string
}

/** Computed from the signature, never copied: 0x81b4e8b4. */
export const TRANSFER_REMOTE_SELECTOR: Hex = toFunctionSelector('function transferRemote(uint32 destination, bytes32 recipient, uint256 amount)')

export function encodeTransferRemote(plan: HyperlanePlan): Hex {
  const [destination, recipient, amount] = assembleTransferRemoteArgs(plan)
  return encodeFunctionData({ abi: warpRouteAbi, functionName: 'transferRemote', args: [destination, recipient, amount] })
}

/**
 * Decodes our own calldata and compares every field with the plan. Deliberately NOT through the
 * encoder's own ABI alone: the three words are also read off the raw bytes exactly as the router
 * will read them — the destination domain, the recipient as bytes32 with its upper twelve bytes
 * zero and its lower twenty equal to the address, and the amount. A recipient that does not survive
 * that reading is money delivered to an address nobody named.
 */
export function hyperlaneSelfCheck(plan: HyperlanePlan, calldata: Hex): HyperlaneSelfCheck {
  const mismatches: string[] = []
  if (size(calldata) !== 4 + 32 * 3) return { ok: false, mismatches: [`calldata is ${size(calldata)} bytes, expected ${4 + 32 * 3}`] }
  if (slice(calldata, 0, 4).toLowerCase() !== TRANSFER_REMOTE_SELECTOR.toLowerCase()) {
    return { ok: false, mismatches: [`selector ${slice(calldata, 0, 4)} is not transferRemote(uint32,bytes32,uint256)`] }
  }

  // The raw words, read the way the EVM will.
  const word = (n: number): Hex => slice(calldata, 4 + 32 * n, 4 + 32 * (n + 1))
  const destination = BigInt(word(0))
  const recipient = word(1)
  const amount = BigInt(word(2))
  if (destination !== BigInt(plan.dst.domain)) mismatches.push('destination')
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(recipient)) mismatches.push('recipient is not a left-padded address')
  else if (!isAddressEqual(`0x${recipient.slice(26)}` as Address, plan.recipient)) mismatches.push('recipient')
  if (amount !== plan.amount) mismatches.push('amount')

  // And the ABI reading must agree with the raw one.
  try {
    const decoded = decodeFunctionData({ abi: warpRouteAbi, data: calldata })
    if (decoded.functionName !== 'transferRemote') mismatches.push(`not transferRemote: ${decoded.functionName}`)
    else {
      const [d, r, a] = decoded.args
      if (Number(d) !== plan.dst.domain) mismatches.push('destination (abi)')
      if (r.toLowerCase() !== plan.recipientBytes32.toLowerCase()) mismatches.push('recipient (abi)')
      if (a !== plan.amount) mismatches.push('amount (abi)')
    }
  } catch {
    mismatches.push('decode failed')
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches }
}

/** Errors that mean "this node does not implement eth_simulateV1", not "the call fails". */
function isUnsupported(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return m.includes('method not found') || m.includes('not supported') || m.includes('unsupported method') || m.includes('-32601') || m.includes('does not exist')
}

function firstLine(e: unknown): string {
  const anyE = e as { shortMessage?: string; details?: string; message?: string }
  return sanitizeText((anyE.shortMessage ?? anyE.details ?? anyE.message ?? String(e)).split('\n')[0], 200)
}

async function named(revert: DecodedRevert, plan: HyperlanePlan, chainId: number | undefined): Promise<DecodedRevert> {
  if (revert.kind !== 'unknown' || chainId === undefined) return revert
  return enrichRevert(revert, { chainId, candidates: [plan.router, ...(plan.token ? [plan.token] : []), plan.mailbox] })
}

export async function previewHyperlaneSend(
  client: ReadClient,
  plan: HyperlanePlan,
  opts: { approve?: HyperlaneApproveIntent | undefined; chainId?: number | undefined } = {},
): Promise<HyperlanePreview> {
  const selfCheck = hyperlaneSelfCheck(plan, encodeTransferRemote(plan))
  const [destination, recipient, amount] = assembleTransferRemoteArgs(plan)

  // approve + transferRemote in one eth_simulateV1 block, when an approve is owed and the node can.
  if (opts.approve) {
    const approve = opts.approve
    try {
      // The batch is one expression on purpose: what it contains is visible at the call site, to a
      // reader and to scripts/check-whitelist.mjs, which allows only approve and transferRemote here.
      const res = await simulateCalls(client, {
        account: plan.sender,
        calls: [
          { to: approve.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approve.spender, approve.amount] }) },
          { to: plan.router, data: encodeFunctionData({ abi: warpRouteAbi, functionName: 'transferRemote', args: [destination, recipient, amount] }), value: plan.value },
        ],
      })
      const [approveResult, sendResult] = res.results
      if (approveResult && approveResult.status === 'failure') {
        const revert = await named(decodeRevert(revertDataFromError(approveResult.error)), plan, opts.chainId)
        return { simulation: { ok: false, reason: formatRevert(revert) }, selfCheck, gasCostWei: undefined, revert, failedStep: 'approve', batched: true }
      }
      if (sendResult && sendResult.status === 'failure') {
        const revert = await named(decodeRevert(revertDataFromError(sendResult.error)), plan, opts.chainId)
        return { simulation: { ok: false, reason: formatRevert(revert) }, selfCheck, gasCostWei: undefined, revert, failedStep: 'send', batched: true }
      }
      let gasCostWei: bigint | undefined
      const gas = sendResult?.gasUsed
      if (gas !== undefined) {
        try {
          gasCostWei = (gas * (await client.getGasPrice()) * 12n) / 10n
        } catch {
          /* the simulation passed; the estimate is only for the native-balance check */
        }
      }
      return { simulation: { ok: true }, selfCheck, gasCostWei, batched: true }
    } catch (e) {
      if (!isUnsupported(e) && revertDataFromError(e) !== undefined) {
        const revert = await named(decodeRevert(revertDataFromError(e)), plan, opts.chainId)
        return { simulation: { ok: false, reason: formatRevert(revert) }, selfCheck, gasCostWei: undefined, revert, failedStep: 'send', batched: true }
      }
      /* unsupported, or an RPC hiccup: the plain path below decides */
    }
  }

  try {
    await client.simulateContract({
      address: plan.router,
      abi: warpRouteAbi,
      functionName: 'transferRemote',
      args: [destination, recipient, amount],
      value: plan.value,
      account: plan.sender,
    })
  } catch (e) {
    const data = revertDataFromError(e)
    const looksReverted = /revert/i.test(e instanceof Error ? e.message : String(e))
    if (data === undefined && !looksReverted) {
      const reason = firstLine(e)
      return { simulation: { ok: false, reason, unavailable: true }, selfCheck, gasCostWei: undefined, rpcUnavailable: reason }
    }
    const revert = await named(decodeRevert(data), plan, opts.chainId)
    return { simulation: { ok: false, reason: formatRevert(revert) }, selfCheck, gasCostWei: undefined, revert, failedStep: 'send', batched: false }
  }

  let gasCostWei: bigint | undefined
  try {
    const [gas, price] = await Promise.all([
      client.estimateContractGas({
        address: plan.router,
        abi: warpRouteAbi,
        functionName: 'transferRemote',
        args: [destination, recipient, amount],
        value: plan.value,
        account: plan.sender,
      }),
      client.getGasPrice(),
    ])
    gasCostWei = (gas * price * 12n) / 10n // +20% headroom, same as every other path
  } catch {
    /* the simulation already passed; a missing estimate only leaves the native-balance check pending */
  }
  return { simulation: { ok: true }, selfCheck, gasCostWei, batched: false }
}
