/**
 * Simulating an NTT transfer, and decoding our own calldata back before anything is signed.
 *
 * This lives inside the protocol module on purpose: `transfer` is the one state-changing call this
 * module may make, and scripts/check-whitelist.mjs allows that name only here, so every place it
 * appears is in one directory a reviewer can read end to end.
 */
import { encodeFunctionData, type Hex } from 'viem'
import type { ReadClient } from '../../core/client'
import { decodeRevert, formatRevert, revertDataFromError, type DecodedRevert } from '../../core/sim/revert'
import { nttManagerAbi } from './abi'
import { assembleNttTransferArgs, nttSelfCheck, type NttPlan, type NttSelfCheck } from './plan'

export type NttPreview = {
  simulation: { ok: true } | { ok: false; reason: string }
  selfCheck: NttSelfCheck
  gasCostWei: bigint | undefined
  revert?: DecodedRevert
  /** The RPC could not answer: the transfer is NOT known to fail. */
  rpcUnavailable?: string
}

/** The calldata that will go to the wallet, built from the plan. */
export function encodeNttTransfer(plan: NttPlan): Hex {
  const a = assembleNttTransferArgs(plan)
  return encodeFunctionData({ abi: nttManagerAbi, functionName: 'transfer', args: [a[0], a[1], a[2], a[3], a[4], a[5]] })
}

export async function previewNttTransfer(client: ReadClient, plan: NttPlan): Promise<NttPreview> {
  const selfCheck = nttSelfCheck(plan, encodeNttTransfer(plan))
  const a = assembleNttTransferArgs(plan)

  // The call is spelled out at each site on purpose: scripts/check-whitelist.mjs reads the literal
  // `functionName` next to every simulate/estimate, so what is being called stays visible here.
  try {
    await client.simulateContract({
      address: plan.manager,
      abi: nttManagerAbi,
      functionName: 'transfer',
      args: [a[0], a[1], a[2], a[3], a[4], a[5]],
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
        address: plan.manager,
        abi: nttManagerAbi,
        functionName: 'transfer',
        args: [a[0], a[1], a[2], a[3], a[4], a[5]],
        value: plan.value,
        account: plan.sender,
      }),
      client.getGasPrice(),
    ])
    gasCostWei = (gas * price * 12n) / 10n // +20% headroom, same as the OFT path
  } catch {
    /* the simulation already passed; a missing estimate only leaves the native-balance check pending */
  }
  return { simulation: { ok: true }, selfCheck, gasCostWei }
}
