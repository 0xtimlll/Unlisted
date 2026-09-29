/**
 * The only place a rescue may be submitted.
 *
 * Same arrangement as `src/protocols/lz-v1/send.ts`: the screen passes wagmi's write hook in and
 * never names what is being written, so this file is the single auditable boundary and
 * scripts/check-whitelist.mjs can hold the four rescue functions to it.
 *
 * What happens here before the wallet is asked:
 *
 *   1. the call is rebuilt from the plan, and its `value` is asserted to be 0;
 *   2. its `to` is asserted to be the address the plan named — not a parameter this function takes;
 *   3. the call is `eth_call`ed one more time, as the wallet that will send it.
 *
 * The third is not redundant with the panel's own simulation: between the panel rendering and the
 * click, somebody else may have retried the same message. A rescue that has become unnecessary
 * should cost nothing, not a reverted transaction.
 */
import type { Address, Hash } from 'viem'
// Type-only: no wagmi code is imported here, only the shape of its writer.
import type { useWriteContract } from 'wagmi'
import type { ReadClient } from '../../core/client'
import { simulateRescue, type RescueCall } from './actions'
import { endpointV1RescueAbi, endpointV2RescueAbi, lzAppRescueAbi, receiveUlnRescueAbi } from './abi'

/** Whatever can submit the transaction — in the app, wagmi's `useWriteContract()` result. */
export type RescueWriter = Pick<ReturnType<typeof useWriteContract>, 'writeContractAsync'>

export class RescueRefused extends Error {
  constructor(
    public readonly code: 'value_not_zero' | 'reverts' | 'unavailable',
    public readonly detail = '',
  ) {
    super(code)
    this.name = 'RescueRefused'
  }
}

/**
 * Submits one rescue call, or throws RescueRefused without asking the wallet for anything.
 *
 * Four branches, one per whitelisted function, each handing the wallet the ABI that belongs to it
 * with the argument tuple the plan built. Verbose on purpose: it is what lets the compiler check
 * each tuple, and what keeps the submitted call readable next to the function's own signature.
 */
export async function submitRescue(
  writer: RescueWriter,
  call: RescueCall,
  p: { chainId: number; from: Address; client: ReadClient },
): Promise<Hash> {
  // A rescue never carries value. Asserted here as well as typed, because this is the last gate.
  if (call.value !== 0n) throw new RescueRefused('value_not_zero', String(call.value))

  // Between the panel rendering and this click somebody else may have retried the same message. A
  // rescue that has become unnecessary should cost nothing, not a reverted transaction.
  const sim = await simulateRescue(p.client, call, p.from)
  if (sim.status === 'unavailable') throw new RescueRefused('unavailable', sim.reason)
  if (sim.status === 'reverted') throw new RescueRefused('reverts', sim.raw)

  // `value` is omitted for the two non-payable functions and 0n for the two payable ones. Not a
  // formality: `Endpoint.retryPayload` and `ReceiveUln302.commitVerification` are `nonpayable`, so a
  // `value` field on those calls is a type error — which is the compiler saying the same thing this
  // module does, that a rescue carries nothing.
  const common = { address: call.to, chainId: p.chainId } as const
  switch (call.write) {
    case 'retryPayload':
      return writer.writeContractAsync({ ...common, abi: endpointV1RescueAbi, functionName: 'retryPayload', args: call.args })
    case 'commitVerification':
      return writer.writeContractAsync({ ...common, abi: receiveUlnRescueAbi, functionName: 'commitVerification', args: call.args })
    case 'retryMessage':
      return writer.writeContractAsync({ ...common, value: 0n, abi: lzAppRescueAbi, functionName: 'retryMessage', args: call.args })
    case 'lzReceive':
      return writer.writeContractAsync({ ...common, value: 0n, abi: endpointV2RescueAbi, functionName: 'lzReceive', args: call.args })
  }
}
