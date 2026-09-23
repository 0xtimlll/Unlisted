/**
 * §Task 1.2: find a transaction. The selected chain first, then every other supported chain in
 * parallel — a hash pasted while the wrong network is selected is the normal case, not an error.
 *
 * An RPC that is down, throttled or slow is NOT "the transaction does not exist". The two are
 * reported separately so the UI can never say "not found" when it simply could not look.
 * IO is injected, so all of this is testable without a network.
 */
import type { ChainKey } from '../chains'
import type { TxLike } from './detect'

export type RpcErrorKind = 'rate_limited' | 'timeout' | 'unavailable'

/** Classifies a thrown RPC error. "Not found" is a fact about the chain, so it is not an error. */
export function classifyRpcError(e: unknown): RpcErrorKind {
  const msg = (e instanceof Error ? `${e.name} ${e.message}` : String(e)).toLowerCase()
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('limit exceeded')) return 'rate_limited'
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) return 'timeout'
  return 'unavailable'
}

/** Returns the transaction, or null when that chain definitely does not have it. May throw. */
export type TxFetcher = (chain: ChainKey, hash: string) => Promise<TxLike | null>

export type SearchFailure = { chain: ChainKey; reason: RpcErrorKind }

export type SearchResult =
  | { status: 'found'; chain: ChainKey; tx: TxLike; searched: ChainKey[]; failed: SearchFailure[] }
  /** Every chain we could reach said no. `failed` lists the ones we could not reach at all. */
  | { status: 'not_found'; searched: ChainKey[]; failed: SearchFailure[] }

async function attempt(fetch: TxFetcher, chain: ChainKey, hash: string): Promise<{ chain: ChainKey; tx: TxLike | null } | SearchFailure> {
  try {
    return { chain, tx: await fetch(chain, hash) }
  } catch (e) {
    return { chain, reason: classifyRpcError(e) }
  }
}

const isFailure = (r: { chain: ChainKey; tx: TxLike | null } | SearchFailure): r is SearchFailure => 'reason' in r

/**
 * `chains` is every chain worth looking at, in registry order. `selected` is tried alone first so
 * the common case costs one request and the other providers are left alone.
 */
export async function searchTx(hash: string, opts: { selected?: ChainKey | undefined; chains: readonly ChainKey[]; fetch: TxFetcher }): Promise<SearchResult> {
  const { selected, chains, fetch } = opts
  const searched: ChainKey[] = []
  const failed: SearchFailure[] = []

  if (selected && chains.includes(selected)) {
    searched.push(selected)
    const first = await attempt(fetch, selected, hash)
    if (isFailure(first)) failed.push(first)
    else if (first.tx) return { status: 'found', chain: selected, tx: first.tx, searched, failed }
  }

  const rest = chains.filter((c) => c !== selected)
  if (rest.length === 0) return { status: 'not_found', searched, failed }

  const results = await Promise.all(rest.map((c) => attempt(fetch, c, hash)))
  searched.push(...rest)
  // Registry order decides, so the answer does not depend on which provider replied first.
  for (const r of results) {
    if (isFailure(r)) failed.push(r)
    else if (r.tx) return { status: 'found', chain: r.chain, tx: r.tx, searched, failed }
  }
  return { status: 'not_found', searched, failed }
}
