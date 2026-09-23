/**
 * Fetching one transaction for analysis: the call (for `to` and the selector) and the receipt
 * (for the logs, which is where the bridges actually are).
 *
 * "Not on this chain" returns null. Anything else throws, so search.ts can tell a chain that said
 * no from a provider that could not answer.
 */
import type { Hash } from 'viem'
import type { ReadClient } from '../client'
import type { TxLike } from './detect'

/** viem's own names for "this chain does not have it". */
const NOT_FOUND = new Set(['TransactionNotFoundError', 'TransactionReceiptNotFoundError'])

function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? ''
  if (NOT_FOUND.has(name)) return true
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return msg.includes('could not be found') || msg.includes('not found')
}

export async function fetchEvmTx(client: ReadClient, hash: string): Promise<TxLike | null> {
  const h = hash as Hash
  const [txRes, receiptRes] = await Promise.allSettled([client.getTransaction({ hash: h }), client.getTransactionReceipt({ hash: h })])

  if (txRes.status === 'rejected' && !isNotFound(txRes.reason)) throw txRes.reason
  if (receiptRes.status === 'rejected' && !isNotFound(receiptRes.reason)) throw receiptRes.reason
  if (txRes.status === 'rejected' && receiptRes.status === 'rejected') return null

  const tx = txRes.status === 'fulfilled' ? txRes.value : undefined
  const receipt = receiptRes.status === 'fulfilled' ? receiptRes.value : undefined
  if (!tx && !receipt) return null

  return {
    hash,
    ...(tx?.from ? { from: tx.from } : {}),
    to: tx?.to ?? receipt?.to ?? null,
    ...(tx?.input ? { input: tx.input } : {}),
    logs: (receipt?.logs ?? []).map((l) => ({ address: l.address, topics: l.topics as readonly string[], data: l.data })),
  }
}
