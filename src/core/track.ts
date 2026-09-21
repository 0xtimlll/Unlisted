/**
 * §5.5: delivery status from LayerZero Scan. Read-only, no addresses sent
 * anywhere except the tx hash itself. Network errors mean "no data yet", not failure.
 */
import type { Hash, Hex } from 'viem'

export const LZ_SCAN_API = 'https://scan.layerzero-api.com'
export const LZ_SCAN_UI = 'https://layerzeroscan.com'

export const POLL_INTERVAL_MS = 12_000
export const POLL_TIMEOUT_MS = 20 * 60_000

/** Status names LayerZero Scan reports. Anything else is kept verbatim in `raw`. */
export type LzStatusName =
  | 'INFLIGHT'
  | 'CONFIRMING'
  | 'DELIVERED'
  | 'FAILED'
  | 'BLOCKED'
  | 'PAYLOAD_STORED'
  | 'APPLICATION_BURNED'
  | 'APPLICATION_SKIPPED'
  | 'UNRESOLVABLE_COMMAND'
  | 'MALFORMED_COMMAND'

export type TrackPhase = 'no_data' | 'pending' | 'delivered' | 'failed'

export type TrackState = {
  phase: TrackPhase
  /** Raw status name from the API, if any. */
  raw?: string
  message?: string
  guid?: Hex
  srcEid?: number
  dstEid?: number
  srcTxHash?: Hash
  /** 0x-hex on EVM destinations, a base58 signature on Solana. */
  dstTxHash?: string
  /** ISO timestamp from the API. */
  updated?: string
}

const PENDING: ReadonlySet<string> = new Set(['INFLIGHT', 'CONFIRMING'])
const FAILED: ReadonlySet<string> = new Set([
  'FAILED', 'BLOCKED', 'PAYLOAD_STORED', 'APPLICATION_BURNED', 'APPLICATION_SKIPPED',
  'UNRESOLVABLE_COMMAND', 'MALFORMED_COMMAND',
])

export function scanMessageUrl(txHash: Hash): string {
  return `${LZ_SCAN_UI}/tx/${txHash}`
}

export function scanApiUrl(txHash: Hash): string {
  return `${LZ_SCAN_API}/v1/messages/tx/${txHash}`
}

const isHash = (v: unknown): v is Hash => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
/** A Solana transaction signature: 64 bytes in base58 (87–88 chars). */
const isSolanaSig = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(v)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.slice(0, 256) : undefined)

/**
 * Pure parser for the Scan API response. Treats everything as untrusted data.
 * Returns `no_data` when the shape is not what we expect.
 */
export function parseScanResponse(json: unknown): TrackState {
  if (!json || typeof json !== 'object') return { phase: 'no_data' }
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return { phase: 'no_data' }
  const m = data[0] as Record<string, unknown>
  if (!m || typeof m !== 'object') return { phase: 'no_data' }

  const status = m['status'] as Record<string, unknown> | undefined
  const rawName = str(status?.['name'])?.toUpperCase()
  const pathway = m['pathway'] as Record<string, unknown> | undefined
  const source = m['source'] as Record<string, unknown> | undefined
  const destination = m['destination'] as Record<string, unknown> | undefined
  const srcTx = source?.['tx'] as Record<string, unknown> | undefined
  const dstTx = destination?.['tx'] as Record<string, unknown> | undefined

  let phase: TrackPhase = 'pending'
  if (rawName === 'DELIVERED') phase = 'delivered'
  else if (rawName && FAILED.has(rawName)) phase = 'failed'
  else if (rawName && PENDING.has(rawName)) phase = 'pending'
  else if (!rawName) phase = 'no_data'

  const out: TrackState = { phase }
  if (rawName) out.raw = rawName
  const message = str(status?.['message'])
  if (message) out.message = message
  const guid = str(m['guid'])
  if (guid && /^0x[0-9a-fA-F]{64}$/.test(guid)) out.guid = guid as Hex
  const srcEid = num(pathway?.['srcEid'])
  if (srcEid !== undefined) out.srcEid = srcEid
  const dstEid = num(pathway?.['dstEid'])
  if (dstEid !== undefined) out.dstEid = dstEid
  const srcHash = srcTx?.['txHash']
  if (isHash(srcHash)) out.srcTxHash = srcHash
  const dstHash = dstTx?.['txHash']
  if (isHash(dstHash) || isSolanaSig(dstHash)) out.dstTxHash = dstHash
  const updated = str(m['updated'])
  if (updated) out.updated = updated
  return out
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** One request. Network / HTTP errors -> no_data (never "failed"). */
export async function fetchStatus(txHash: Hash, fetchImpl: FetchLike = fetch): Promise<TrackState> {
  try {
    const r = await fetchImpl(scanApiUrl(txHash))
    if (!r.ok) return { phase: 'no_data' }
    return parseScanResponse(await r.json())
  } catch {
    return { phase: 'no_data' }
  }
}

export type PollOptions = {
  intervalMs?: number
  timeoutMs?: number
  fetchImpl?: FetchLike
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  onUpdate?: (s: TrackState) => void
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    }, { once: true })
  })

/**
 * Polls until delivered/failed, timeout, or abort. Resolves with the last state.
 * A timeout is reported as the last known state (usually `pending`), not as failure.
 */
export async function pollMessage(txHash: Hash, opts: PollOptions = {}): Promise<TrackState> {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS
  const timeout = opts.timeoutMs ?? POLL_TIMEOUT_MS
  const sleep = opts.sleep ?? defaultSleep
  const start = Date.now()
  let last: TrackState = { phase: 'no_data' }
  for (;;) {
    last = await fetchStatus(txHash, opts.fetchImpl)
    opts.onUpdate?.(last)
    if (last.phase === 'delivered' || last.phase === 'failed') return last
    await sleep(interval, opts.signal)
    if (opts.signal?.aborted || Date.now() - start >= timeout) return last
  }
}
