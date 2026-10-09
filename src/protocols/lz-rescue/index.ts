/**
 * §5: Status / Rescue — one way in.
 *
 * Give it a transaction hash and the chain it is on, and it finds the LayerZero messages in that
 * transaction, reads what the destination says about each, and says what could be done about it.
 *
 * The module's boundaries, stated once:
 *
 *   - It never touches the send path. Nothing here imports the plan, the guards or the self-check of
 *     any tab; a rescue is a different transaction with a different shape, and mixing the two would
 *     put the money path's invariants at the mercy of a screen that is not about sending.
 *   - It never consults LayerZero Scan. A rescue submits a payload, and a payload that came from an
 *     API is a payload someone else chose. Scan is a fine place to *look*, which is why the tab links
 *     to it — but the bytes come from the source chain's own logs.
 *   - NTT and CCIP rescue is not here. Both have their own redeem paths, both are a different shape
 *     of problem. Their STATUS is read by runners of their own — `wormhole-ntt/status.ts` and
 *     `ccip/status.ts`, which the tab runs beside this one — and what those must not do is borrow
 *     these four actions, which are LayerZero's.
 */
import { byKey, isEvm, type ChainKey } from '../../core/chains'
import { makeReadClient, type ReadClient } from '../../core/client'
import { diagnose, findMessages, type Diagnosis, type FoundMessage, type LogLike } from './diagnose'
import { planRescue, type RescuePlan } from './actions'

export * from './abi'
export * from './diagnose'
export * from './actions'
export { submitRescue, RescueRefused, type RescueWriter } from './send'

/** One message, what the destination says about it, and what can be done. */
export type RescueReport = {
  diagnosis: Diagnosis
  plan: RescuePlan
}

export type RescueLookup = {
  /** Never empty when the transaction contained a LayerZero message. */
  reports: RescueReport[]
  /** Messages whose destination this app does not serve, kept so the tab can say so. */
  unservedDestinations: FoundMessage[]
}

/**
 * The whole tab's work: find the messages, diagnose each, plan each.
 *
 * `dstClientFor` is injected so this is testable without a network and so the user's own RPC for the
 * destination chain is the one used — the same rule the rest of the app follows.
 */
export async function lookupRescue(
  logs: readonly LogLike[],
  srcChain: ChainKey,
  dstClientFor: (chain: ChainKey) => ReadClient | undefined,
): Promise<RescueLookup> {
  const found = findMessages(logs, srcChain)
  const reports: RescueReport[] = []
  const unservedDestinations: FoundMessage[] = []

  for (const m of found) {
    const client = m.dstChain ? dstClientFor(m.dstChain) : undefined
    if (!client) {
      unservedDestinations.push(m)
      continue
    }
    const diagnosis = await diagnose(m, client)
    const plan = await planRescue(diagnosis, client)
    reports.push({ diagnosis, plan })
  }
  return { reports, unservedDestinations }
}

/** A read client for a chain, honouring the user's own RPC. EVM only — v1 and V2 rescue both are. */
export function rescueClientFor(chain: ChainKey, customRpc: Partial<Record<ChainKey, string>>): ReadClient | undefined {
  const def = byKey(chain)
  if (!isEvm(def)) return undefined
  return makeReadClient(def, customRpc[chain])
}
