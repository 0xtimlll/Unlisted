/**
 * localStorage (§7): settings and public identifiers only — language, custom RPCs,
 * recent contract addresses, transfer hashes. Every read/write is guarded.
 */
import { isAddress } from 'viem'
import type { ChainKey } from '@/core/chains'
import { isProtocolId, type ProtocolId } from '@/core/protocols'
import { validateRpcUrl } from '@/core/rpcPolicy'
import { clearLastTab } from './tabs'

const KEY = 'oft-bridge-ui:v1'

/** An EVM 0x address or a Solana base58 public key. */
const isAccount = (v: unknown): v is string => typeof v === 'string' && (isAddress(v, { strict: false }) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))
/** An EVM tx hash or a Solana signature. */
const isTx = (v: unknown): v is string => typeof v === 'string' && (/^0x[0-9a-fA-F]{64}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(v))

export type HistoryEntry = {
  srcChain: ChainKey
  /**
   * LayerZero's endpoint id. Only LayerZero numbers chains this way, so protocols that do not
   * use eids write 0 here and record `dstChain` instead.
   */
  dstEid: number
  /** The destination, for protocols that have no LayerZero eid (NTT, CCIP). */
  dstChain?: ChainKey
  /**
   * Which bridge carried it. Entries written before protocols existed have none; they are all
   * LayerZero OFT, and `entryProtocol()` says so — the field is never invented on disk.
   */
  protocol?: ProtocolId
  /** The OFT contract (EVM) or OFT Store (Solana). */
  oft: string
  /** 0x hash (EVM) or base58 signature (Solana). */
  txHash: string
  /** ms since epoch */
  at: number
  /** Final LayerZero status once known; absent while in flight. */
  status?: 'delivered' | 'failed'
}

/** Two themes, no "follow the system": dark is the default and the one the app is designed in. */
export type Theme = 'light' | 'dark'
export const DEFAULT_THEME: Theme = 'dark'

export type Stored = {
  theme: Theme
  customRpc: Partial<Record<ChainKey, string>>
  recentContracts: { chain: ChainKey; address: string }[]
  history: HistoryEntry[]
  /** Transfer history collapsed to its heading. The entries themselves are untouched. */
  historyHidden: boolean
}

export const EMPTY: Stored = { theme: DEFAULT_THEME, customRpc: {}, recentContracts: [], history: [], historyHidden: false }

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
  // 'system' was a third theme once; anything but 'light' now means the default dark.
  out.theme = r['theme'] === 'light' ? 'light' : DEFAULT_THEME
  out.historyHidden = r['historyHidden'] === true
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
        if (isKey(chain) && isAccount(address)) {
          out.recentContracts.push({ chain, address })
        }
      }
      if (out.recentContracts.length >= MAX_RECENT) break
    }
  }
  if (Array.isArray(r['history'])) {
    for (const e of r['history'] as unknown[]) {
      if (e && typeof e === 'object') {
        const { srcChain, dstEid, dstChain, protocol, oft, txHash, at } = e as Record<string, unknown>
        if (isKey(srcChain) && typeof dstEid === 'number' && isAccount(oft) && isTx(txHash) && typeof at === 'number') {
          const status = (e as Record<string, unknown>)['status']
          out.history.push({
            srcChain, dstEid, oft, txHash, at,
            ...(isKey(dstChain) ? { dstChain } : {}),
            ...(isProtocolId(protocol) ? { protocol } : {}),
            ...(status === 'delivered' || status === 'failed' ? { status } : {}),
          })
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
  clearLastTab()
}

/** The protocol an entry belongs to; entries written before protocols existed are LayerZero OFT. */
export function entryProtocol(e: HistoryEntry): ProtocolId {
  return e.protocol ?? 'lz-oft'
}

export type HistoryFilter = ProtocolId | 'all'

export function filterHistory(entries: readonly HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
  return filter === 'all' ? [...entries] : entries.filter((e) => entryProtocol(e) === filter)
}

export function exportJson(): string {
  return JSON.stringify(load(), null, 2)
}

export function pushRecent(s: Stored, chain: ChainKey, address: string): Stored {
  const rest = s.recentContracts.filter((e) => !(e.chain === chain && e.address.toLowerCase() === address.toLowerCase()))
  return { ...s, recentContracts: [{ chain, address }, ...rest].slice(0, MAX_RECENT) }
}

export function pushHistory(s: Stored, e: HistoryEntry): Stored {
  const rest = s.history.filter((h) => h.txHash.toLowerCase() !== e.txHash.toLowerCase())
  return { ...s, history: [e, ...rest].slice(0, MAX_HISTORY) }
}

export function setHistoryStatus(s: Stored, txHash: string, status: 'delivered' | 'failed'): Stored {
  return { ...s, history: s.history.map((h) => (h.txHash.toLowerCase() === txHash.toLowerCase() ? { ...h, status } : h)) }
}

/**
 * A transfer worth re-opening the tracker for after a reload: recent and not yet final.
 * `protocol` scopes it to one tab — the OFT tab never re-opens a CCIP transfer.
 */
export const ACTIVE_TRANSFER_MAX_AGE_MS = 45 * 60_000
export function activeTransfer(s: Stored, protocol?: ProtocolId): HistoryEntry | undefined {
  const h = protocol === undefined ? s.history[0] : s.history.find((e) => entryProtocol(e) === protocol)
  if (!h || h.status) return undefined
  return Date.now() - h.at < ACTIVE_TRANSFER_MAX_AGE_MS ? h : undefined
}
