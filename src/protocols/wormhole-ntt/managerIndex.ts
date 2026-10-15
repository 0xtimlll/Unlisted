/**
 * Candidate managers per token, from Wormholescan's decoded NTT operations — a SEARCH HINT.
 *
 *   GET https://api.wormholescan.io/api/v1/operations
 *       ?appId=NATIVE_TOKEN_TRANSFER&sourceChain=<wormhole chain id>&pageSize=100&page=<n>
 *
 * Every decoded transfer names the token it moved (`standarizedProperties.tokenAddress`) and the
 * manager that sent it (`content.payload.transceiverMessage.sourceNttManager`). The token list
 * (tokenList.ts) has no manager addresses at all, and a token that names no `minter()` gives the
 * search nothing to follow; this index answers the one question left — WHICH contracts to ask.
 *
 * It is a hint and nothing more (CLAUDE.md rule 1): `sourceNttManager` is written by the manager
 * itself, so one self-made transfer puts any contract in here. A candidate counts only once it
 * answers `token()` with this token on chain (discover.ts), and whether an approve may name it is
 * decided by the gate in verify.ts, which never reads this. An index that cannot be fetched is an
 * outage, not a fact about any token: the search goes on with what the chain says, and the
 * manager can always be typed in.
 *
 * The newest few hundred transfers from a chain are enough for every token that is in use there;
 * a token that has not moved in that window simply is not found this way.
 */
import { getAddress, isAddress, type Address } from 'viem'
import { WORMHOLESCAN_API } from './chains'
import type { FetchLike } from './tokenList'

/** token address (lowercase) -> managers seen sending it, most recent first. */
export type NttManagerIndex = ReadonlyMap<string, readonly Address[]>

export const NTT_INDEX_PAGE_SIZE = 100
export const NTT_INDEX_PAGES = 3

export function operationsPageUrl(srcWormholeChainId: number, page: number): string {
  if (!Number.isInteger(srcWormholeChainId) || srcWormholeChainId <= 0) throw new Error(`not a Wormhole chain id: ${srcWormholeChainId}`)
  if (!Number.isInteger(page) || page < 0) throw new Error(`not a page: ${page}`)
  return `${WORMHOLESCAN_API}/api/v1/operations?appId=NATIVE_TOKEN_TRANSFER&sourceChain=${srcWormholeChainId}&pageSize=${NTT_INDEX_PAGE_SIZE}&page=${page}`
}

export type IndexedTransfer = { token: Address; manager: Address }

const field = (o: unknown, key: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined)

/** A 32-byte Wormhole address that is really a 20-byte EVM one: twelve zero bytes, then the address. */
function evmFromBytes32(raw: unknown): Address | undefined {
  if (typeof raw !== 'string') return undefined
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw
  if (!/^[0-9a-fA-F]{64}$/.test(hex) || !/^0{24}/.test(hex)) return undefined
  try {
    return getAddress(`0x${hex.slice(24)}`)
  } catch {
    return undefined
  }
}

/**
 * Reads one page. Never throws on shape: an operation missing either address, or naming a
 * non-EVM manager, is simply not in the result. `srcWormholeChainId` is checked against the
 * operation's own `emitterChain` where it is present, so a page served for the wrong chain adds
 * nothing.
 */
export function parseOperationsPage(json: unknown, srcWormholeChainId: number): IndexedTransfer[] {
  const ops = field(json, 'operations')
  if (!Array.isArray(ops)) return []
  const out: IndexedTransfer[] = []
  for (const op of ops) {
    const emitter = field(op, 'emitterChain')
    if (typeof emitter === 'number' && emitter !== srcWormholeChainId) continue
    const content = field(op, 'content')
    const tokenRaw = field(field(content, 'standarizedProperties'), 'tokenAddress')
    if (typeof tokenRaw !== 'string' || !isAddress(tokenRaw, { strict: false })) continue
    const manager = evmFromBytes32(field(field(field(content, 'payload'), 'transceiverMessage'), 'sourceNttManager'))
    if (!manager) continue
    out.push({ token: getAddress(tokenRaw), manager })
  }
  return out
}

/** Folds pages into the index, keeping first-seen (most recent) order and dropping repeats. */
export function buildManagerIndex(transfers: readonly IndexedTransfer[]): NttManagerIndex {
  const out = new Map<string, Address[]>()
  for (const t of transfers) {
    const key = t.token.toLowerCase()
    const list = out.get(key) ?? []
    if (!list.some((m) => m.toLowerCase() === t.manager.toLowerCase())) list.push(t.manager)
    out.set(key, list)
  }
  return out
}

export class ManagerIndexError extends Error {
  constructor(public readonly code: 'unavailable') {
    super(code)
    this.name = 'ManagerIndexError'
  }
}

/**
 * The newest NTT_INDEX_PAGES pages for a source chain, fetched together. A page that fails is
 * skipped; only when none answers is the index unavailable — an outage for the screen to mention,
 * never a verdict about a token.
 */
export async function fetchNttManagerIndex(srcWormholeChainId: number, fetchImpl: FetchLike = fetch): Promise<NttManagerIndex> {
  const pages = await Promise.all(
    Array.from({ length: NTT_INDEX_PAGES }, async (_, page): Promise<IndexedTransfer[] | undefined> => {
      try {
        const res = await fetchImpl(operationsPageUrl(srcWormholeChainId, page))
        if (!res.ok) return undefined
        return parseOperationsPage(await res.json(), srcWormholeChainId)
      } catch {
        return undefined
      }
    }),
  )
  if (pages.every((p) => p === undefined)) throw new ManagerIndexError('unavailable')
  return buildManagerIndex(pages.flatMap((p) => p ?? []))
}
