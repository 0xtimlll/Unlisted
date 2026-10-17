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

export function isNotFound(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? ''
  if (NOT_FOUND.has(name)) return true
  // viem's own wording only. A bare "not found" is also "Method not found", "header not found" and
  // an HTTP 404 — a provider that could not answer, which must land in `failed`, not in "not here".
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return /transaction (receipt )?with hash .* could not be found/.test(msg)
}

/**
 * `txFirst`: ask for the transaction alone and fetch the receipt only when the chain has it. The
 * search fans a hash out to every other chain (a hundred-odd since 2026-10), and all but one of them
 * answer "not here" — asking each for the receipt as well doubled the requests for nothing. The
 * selected chain, where the hash usually is, still asks for both at once.
 */
export async function fetchEvmTx(client: ReadClient, hash: string, opts: { txFirst?: boolean } = {}): Promise<TxLike | null> {
  const h = hash as Hash
  type Settled<T> = PromiseSettledResult<T>
  let txRes: Settled<Awaited<ReturnType<ReadClient['getTransaction']>>>
  let receiptRes: Settled<Awaited<ReturnType<ReadClient['getTransactionReceipt']>>>
  if (opts.txFirst) {
    try {
      txRes = { status: 'fulfilled', value: await client.getTransaction({ hash: h }) }
    } catch (e) {
      if (isNotFound(e)) return null
      throw e
    }
    ;[receiptRes] = await Promise.allSettled([client.getTransactionReceipt({ hash: h })])
  } else {
    ;[txRes, receiptRes] = await Promise.allSettled([client.getTransaction({ hash: h }), client.getTransactionReceipt({ hash: h })])
  }

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
