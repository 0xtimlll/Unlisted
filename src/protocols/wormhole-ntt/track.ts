/**
 * §Task 5: where a sent NTT transfer can be watched, and what state it is in.
 *
 * The explorer route is `path:"/tx/:txHash"`, read from Wormholescan's own route table (its
 * published bundle at wormholescan.io), and the app uses hash routing — hence `/#/tx/…`.
 * Status comes from the documented operations API. A network failure means "no data yet",
 * never "failed": the same rule the LayerZero tracker follows.
 */
import { WORMHOLESCAN_API, type FetchLike } from './tokenList'

export const WORMHOLESCAN_UI = 'https://wormholescan.io'

const isEvmHash = (v: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(v)

export function wormholescanTxUrl(txHash: string): string {
  if (!isEvmHash(txHash)) throw new Error('not a transaction hash')
  return `${WORMHOLESCAN_UI}/#/tx/${txHash}`
}

export function wormholescanApiUrl(txHash: string): string {
  if (!isEvmHash(txHash)) throw new Error('not a transaction hash')
  return `${WORMHOLESCAN_API}/api/v1/operations?txHash=${txHash}`
}

export type NttPhase = 'no_data' | 'pending' | 'delivered' | 'failed'

export type NttTrackState = {
  phase: NttPhase
  /** The digest / VAA id, when the indexer has one. */
  id?: string
  sourceTxHash?: string
  destinationTxHash?: string
  /** Manager addresses as Wormholescan decoded them — context only, never a decision. */
  sourceNttManager?: string
  recipientNttManager?: string
}

const str = (v: unknown, max = 128): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** Pure parser. Everything is untrusted data. */
export function parseNttOperations(json: unknown): NttTrackState {
  const ops = (json as { operations?: unknown })?.operations
  if (!Array.isArray(ops) || ops.length === 0) return { phase: 'no_data' }
  const op = ops[0] as Record<string, unknown>
  const source = op['sourceChain'] as Record<string, unknown> | undefined
  const target = op['targetChain'] as Record<string, unknown> | undefined
  const srcTx = (source?.['transaction'] as Record<string, unknown> | undefined)?.['txHash']
  const dstTx = (target?.['transaction'] as Record<string, unknown> | undefined)?.['txHash']
  const payload = (op['content'] as Record<string, unknown> | undefined)?.['payload'] as Record<string, unknown> | undefined
  const transceiver = payload?.['transceiverMessage'] as Record<string, unknown> | undefined

  const out: NttTrackState = { phase: dstTx ? 'delivered' : 'pending' }
  const id = str(op['id'])
  if (id) out.id = id
  const s = str(srcTx)
  if (s) out.sourceTxHash = s
  const d = str(dstTx)
  if (d) out.destinationTxHash = d
  const sm = str(transceiver?.['sourceNttManager'], 66)
  if (sm) out.sourceNttManager = sm
  const rm = str(transceiver?.['recipientNttManager'], 66)
  if (rm) out.recipientNttManager = rm
  return out
}

export async function fetchNttStatus(txHash: string, fetchImpl: FetchLike = fetch): Promise<NttTrackState> {
  try {
    const r = await fetchImpl(wormholescanApiUrl(txHash))
    if (!r.ok) return { phase: 'no_data' }
    return parseNttOperations(await r.json())
  } catch {
    return { phase: 'no_data' }
  }
}
