/**
 * localStorage (§7): settings and public identifiers only — language, custom RPCs,
 * recent contract addresses, transfer hashes. Every read/write is guarded.
 */
import { isAddress, type Address, type Hash } from 'viem'
import type { ChainKey } from '@/core/chains'
import { validateRpcUrl } from '@/core/chains'
import { isLang, type Lang } from '@/i18n'

const KEY = 'oft-bridge-ui:v1'

export type HistoryEntry = {
  srcChain: ChainKey
  dstEid: number
  oft: Address
  txHash: Hash
  /** ms since epoch */
  at: number
}

export type Stored = {
  lang: Lang
  customRpc: Partial<Record<ChainKey, string>>
  recentContracts: { chain: ChainKey; address: Address }[]
  history: HistoryEntry[]
}

export const EMPTY: Stored = { lang: 'en', customRpc: {}, recentContracts: [], history: [] }

const MAX_RECENT = 8
const MAX_HISTORY = 20

function isKey(s: unknown): s is ChainKey {
  return typeof s === 'string' && /^[a-z]+$/.test(s)
}

/** Parses untrusted JSON into a well-formed Stored; anything odd is dropped. */
export function sanitize(raw: unknown): Stored {
  const out: Stored = { ...EMPTY, customRpc: {}, recentContracts: [], history: [] }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (isLang(r['lang'])) out.lang = r['lang']
  const rpc = r['customRpc']
  if (rpc && typeof rpc === 'object') {
    for (const [k, v] of Object.entries(rpc as Record<string, unknown>)) {
      if (isKey(k) && typeof v === 'string') {
        const ok = validateRpcUrl(v)
        if (ok.ok) out.customRpc[k] = ok.url
      }
    }
  }
  if (Array.isArray(r['recentContracts'])) {
    for (const e of r['recentContracts'] as unknown[]) {
      if (e && typeof e === 'object') {
        const { chain, address } = e as Record<string, unknown>
        if (isKey(chain) && typeof address === 'string' && isAddress(address)) {
          out.recentContracts.push({ chain, address })
        }
      }
      if (out.recentContracts.length >= MAX_RECENT) break
    }
  }
  if (Array.isArray(r['history'])) {
    for (const e of r['history'] as unknown[]) {
      if (e && typeof e === 'object') {
        const { srcChain, dstEid, oft, txHash, at } = e as Record<string, unknown>
        if (
          isKey(srcChain) && typeof dstEid === 'number' && typeof oft === 'string' && isAddress(oft)
          && typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash) && typeof at === 'number'
        ) {
          out.history.push({ srcChain, dstEid, oft, txHash: txHash as Hash, at })
        }
      }
      if (out.history.length >= MAX_HISTORY) break
    }
  }
  return out
}

export function load(): Stored {
  try {
    const s = globalThis.localStorage?.getItem(KEY)
    return s ? sanitize(JSON.parse(s)) : { ...EMPTY }
  } catch {
    return { ...EMPTY }
  }
}

export function save(s: Stored): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(sanitize(s)))
  } catch {
    /* private mode / quota — settings just don't persist */
  }
}

export function clearAll(): void {
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function exportJson(): string {
  return JSON.stringify(load(), null, 2)
}

export function pushRecent(s: Stored, chain: ChainKey, address: Address): Stored {
  const rest = s.recentContracts.filter((e) => !(e.chain === chain && e.address.toLowerCase() === address.toLowerCase()))
  return { ...s, recentContracts: [{ chain, address }, ...rest].slice(0, MAX_RECENT) }
}

export function pushHistory(s: Stored, e: HistoryEntry): Stored {
  const rest = s.history.filter((h) => h.txHash.toLowerCase() !== e.txHash.toLowerCase())
  return { ...s, history: [e, ...rest].slice(0, MAX_HISTORY) }
}
