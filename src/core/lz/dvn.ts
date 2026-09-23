/**
 * §Task 4, informational: how many DVNs a project requires for the route being used.
 *
 * The endpoint names the send library for (oapp, dstEid); the library holds that OApp's ULN
 * config. One required DVN and no optional threshold means a single party can attest to a
 * message — worth saying out loud, but it is the project's choice, so it never blocks a send.
 *
 * Signatures: IMessageLibManager.getSendLibrary, UlnBase.getUlnConfig (see lz/events.ts).
 */
import type { Address } from 'viem'
import type { ReadClient } from '../client'
import { lzConfigAbi } from './events'

export type DvnConfig = {
  sendLibrary: Address
  confirmations: bigint
  requiredDVNs: readonly Address[]
  optionalDVNs: readonly Address[]
  optionalThreshold: number
  /** Fewer than two independent attestations are needed for this route. */
  weak: boolean
}

/** Best-effort: a library that does not expose getUlnConfig simply yields undefined. */
export async function readDvnConfig(client: ReadClient, endpoint: Address, oapp: Address, dstEid: number): Promise<DvnConfig | undefined> {
  try {
    const sendLibrary = await client.readContract({ address: endpoint, abi: lzConfigAbi, functionName: 'getSendLibrary', args: [oapp, dstEid] })
    if (!sendLibrary || sendLibrary === '0x0000000000000000000000000000000000000000') return undefined
    const uln = await client.readContract({ address: sendLibrary, abi: lzConfigAbi, functionName: 'getUlnConfig', args: [oapp, dstEid] })
    const requiredDVNs = uln.requiredDVNs ?? []
    const optionalDVNs = uln.optionalDVNs ?? []
    const optionalThreshold = Number(uln.optionalDVNThreshold ?? 0)
    return {
      sendLibrary,
      confirmations: uln.confirmations,
      requiredDVNs,
      optionalDVNs,
      optionalThreshold,
      weak: requiredDVNs.length + optionalThreshold < 2,
    }
  } catch {
    return undefined
  }
}
