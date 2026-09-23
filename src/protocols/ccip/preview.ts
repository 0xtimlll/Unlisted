/**
 * Simulating a CCIP send, and decoding our own calldata back before anything is signed.
 *
 * Confined to the protocol module for the same reason as NTT: `ccipSend` is the one state-changing
 * call here, and scripts/check-whitelist.mjs allows that name only in this directory and the one
 * screen that submits it.
 */
import { decodeFunctionData, encodeFunctionData, isAddressEqual, type Hex } from 'viem'
import type { ReadClient } from '../../core/client'
import { decodeRevert, formatRevert, revertDataFromError, type DecodedRevert } from '../../core/sim/revert'
import { ccipRouterAbi } from './abi'
import { assembleCcipSendArgs, type CcipPlan } from './plan'

export type CcipSelfCheck = { ok: true } | { ok: false; mismatches: string[] }

export type CcipPreview = {
  simulation: { ok: true } | { ok: false; reason: string }
  selfCheck: CcipSelfCheck
  gasCostWei: bigint | undefined
  revert?: DecodedRevert
  /** The RPC could not answer: the send is NOT known to fail. */
  rpcUnavailable?: string
}

export function encodeCcipSend(plan: CcipPlan): Hex {
  const [selector, message] = assembleCcipSendArgs(plan)
  return encodeFunctionData({ abi: ccipRouterAbi, functionName: 'ccipSend', args: [selector, message] })
}

/**
 * Decodes our own calldata and compares every field with the plan. The ones that matter are the
 * destination selector, the single token entry, the recipient inside `receiver`, and that `data`
 * is still empty — an unnoticed payload would turn a transfer into a call on the other side.
 */
export function ccipSelfCheck(plan: CcipPlan, calldata: Hex): CcipSelfCheck {
  const mismatches: string[] = []
  let decoded
  try {
    decoded = decodeFunctionData({ abi: ccipRouterAbi, data: calldata })
  } catch {
    return { ok: false, mismatches: [`decode: unknown selector ${calldata.slice(0, 10)}`] }
  }
  if (decoded.functionName !== 'ccipSend') return { ok: false, mismatches: [`not ccipSend: ${decoded.functionName}`] }
  const [selector, message] = decoded.args

  if (selector !== plan.dst.selector) mismatches.push('destChainSelector')
  if (message.data !== '0x') mismatches.push('data must be empty')
  if (message.extraArgs.toLowerCase() !== plan.message.extraArgs.toLowerCase()) mismatches.push('extraArgs')
  if (!isAddressEqual(message.feeToken, plan.message.feeToken)) mismatches.push('feeToken')
  if (message.receiver.toLowerCase() !== plan.message.receiver.toLowerCase()) mismatches.push('receiver')
  if (message.tokenAmounts.length !== 1) mismatches.push('tokenAmounts length')
  else {
    const t = message.tokenAmounts[0]!
    if (!isAddressEqual(t.token, plan.token)) mismatches.push('token')
    if (t.amount !== plan.amount) mismatches.push('amount')
  }
  // The recipient must survive the abi encoding round trip.
  if (!message.receiver.toLowerCase().endsWith(plan.recipient.slice(2).toLowerCase())) mismatches.push('recipient')
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches }
}

export async function previewCcipSend(client: ReadClient, plan: CcipPlan): Promise<CcipPreview> {
  const selfCheck = ccipSelfCheck(plan, encodeCcipSend(plan))
  const [selector, message] = assembleCcipSendArgs(plan)

  try {
    await client.simulateContract({
      address: plan.router,
      abi: ccipRouterAbi,
      functionName: 'ccipSend',
      args: [selector, message],
      value: plan.value,
      account: plan.sender,
    })
  } catch (e) {
    const data = revertDataFromError(e)
    const looksReverted = /revert/i.test(e instanceof Error ? e.message : String(e))
    if (data === undefined && !looksReverted) {
      const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0]?.slice(0, 200) ?? ''
      return { simulation: { ok: false, reason }, selfCheck, gasCostWei: undefined, rpcUnavailable: reason }
    }
    const revert = decodeRevert(data)
    return { simulation: { ok: false, reason: formatRevert(revert) }, selfCheck, gasCostWei: undefined, revert }
  }

  let gasCostWei: bigint | undefined
  try {
    const [gas, price] = await Promise.all([
      client.estimateContractGas({
        address: plan.router,
        abi: ccipRouterAbi,
        functionName: 'ccipSend',
        args: [selector, message],
        value: plan.value,
        account: plan.sender,
      }),
      client.getGasPrice(),
    ])
    gasCostWei = (gas * price * 12n) / 10n // +20% headroom, same as every other path
  } catch {
    /* the simulation already passed; a missing estimate only leaves the native-balance check pending */
  }
  return { simulation: { ok: true }, selfCheck, gasCostWei }
}
