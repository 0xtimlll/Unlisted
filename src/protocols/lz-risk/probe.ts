/**
 * §4's plumbing: run a read with a deadline, and search recent logs without lying about the window.
 *
 * Two honesty problems live here, and both are about the difference between "no" and "I could not
 * look":
 *
 *   - A read that times out is not a read that failed. `attempt()` returns the reason it did not
 *     finish, and the caller turns that into `unchecked`, never into `fail`.
 *   - A log search covers a window, not history. Public providers refuse long `eth_getLogs` ranges,
 *     and on a chain with sub-second blocks even a generous range is a few hours. So every search
 *     reports the window it actually covered, and "found nothing" is only allowed to mean "never"
 *     when the window was long enough to say so.
 */
import type { AbiEvent, Address } from 'viem'
import type { ReadClient } from '../../core/client'
import { isContractRefusal } from '../../core/rpcErrors'
import { sanitizeText } from '../../core/text'

/** §4 asks for 1–3 seconds for the whole panel, so no single read may sit longer than this. */
export const READ_TIMEOUT_MS = 2_500
/** A log search is heavier, and it is never on the critical path for a verdict. */
export const SCAN_TIMEOUT_MS = 4_000

/**
 * `refused`: the CONTRACT answered no (a revert, no data) — a fact about the route. Otherwise the
 * provider did not answer (timeout, 502, "header not found", a method it does not serve), and the
 * check was never made. Decided from the error itself (core/rpcErrors.isContractRefusal), not from
 * a list of words for outages: a list misses the outage it has not seen, and a missed outage in the
 * destination-credit simulation was a red "would not credit this transfer".
 */
export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string; refused: boolean }

const shortReason = (e: unknown): string => {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
  // Every reason the panel prints passes through here, and a revert string is the contract's text.
  return sanitizeText(m.split('\n')[0] ?? m, 160)
}

/** Runs `p` with a deadline. A rejection and a timeout both come back as a reason, never a throw. */
export async function attempt<T>(p: Promise<T>, ms = READ_TIMEOUT_MS, label = 'read'): Promise<Attempt<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
    return { ok: true, value }
  } catch (e) {
    return { ok: false, reason: shortReason(e), refused: isContractRefusal(e) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * An event from a parsed ABI, by name.
 *
 * By name rather than by position: `parseAbi` drops struct declarations from the array it returns,
 * so an index is a number that quietly moves when a signature is added above it — and the thing it
 * would move onto is a filter for the wrong event.
 */
export function pickEvent(abi: readonly unknown[], name: string): AbiEvent {
  const e = abi.find((x) => {
    const y = x as AbiEvent
    return y?.type === 'event' && y.name === name
  })
  if (!e) throw new Error(`lz-risk: no event named ${name} in that abi`)
  return e as AbiEvent
}

/**
 * Was this failure the network, or the contract?
 *
 * The difference decides between `unchecked` and `skipped`, and getting it wrong is the one way a
 * hard check can quietly pass: "the contract has no `paused()`" and "nobody answered when I asked
 * about `paused()`" look identical from a rejected promise, and only the first is a fact about the
 * route. A transport failure names itself; a revert names the function.
 */
export function isTransportFailure(reason: string): boolean {
  return /timed out|fetch failed|HTTP request failed|socket|network|ECONN|rate limit|429|too many requests/i.test(reason)
}

/**
 * A provider declining the SIZE of a log query — the block range or the response — as opposed to
 * being down. Positive identification from the providers' own words (bnbchain "limit exceeded",
 * publicnode "Archive requests require a personal token", thirdweb "Log response size exceeded …
 * requested blocks", drpc "ranges over 10000 blocks are not supported on free plan", the usual
 * "block range" / "too many blocks"), which the /rpc relay passes on for every node it asked.
 */
export function isRangeRefusal(reason: string): boolean {
  return /block range|range (is )?too|too many blocks|requested blocks|blocks? range|response size|limit exceeded|archive|free plan|exceed(s|ed)? (the )?max/i.test(reason)
}

export type LogWindow = {
  fromBlock: bigint
  toBlock: bigint
  blocks: bigint
}

/**
 * How far back a window really reaches, measured from `fromBlock`'s own timestamp.
 *
 * Deliberately not computed from a seconds-per-block figure. The registry carries `blockTimeSec`
 * for one chain only and defaults the rest to 12, which overstates a window on an L2 by an order of
 * magnitude — 50 000 Arbitrum blocks is hours, not a week. A window's length is the one number the
 * honesty of check 7 rests on, so it is read from the chain rather than assumed.
 */
export async function windowDays(client: ReadClient, window: LogWindow): Promise<Attempt<number>> {
  return daysSinceBlock(client, window.fromBlock)
}

export type Scan<T> =
  /** Searched, and here is the newest match. */
  | { status: 'found'; value: T; window: LogWindow }
  /** Searched the whole window and found nothing. What that means depends on `window`. */
  | { status: 'none'; window: LogWindow }
  /** Could not search. Never to be reported as "nothing happened". */
  | { status: 'unavailable'; reason: string }

/** The widest range a public provider will usually serve in one request. */
/**
 * Log windows, NEWEST FIRST (2026-10-17). The question is always "what is the newest event" or
 * "are there at least N", so the most recent blocks are read first and the window only widens while
 * the answer is still open — each step reads just the blocks not yet covered. The old order
 * (50 000, then 10 000, then 2 000) asked every provider for the widest range first: on BNB Chain
 * (0.45 s blocks) all three refuse 50 000 and 10 000 ("limit exceeded", "archive request", "too
 * many blocks"), and one route's checks spent ~8 s collecting refusals before the 2 000-block
 * window that was always going to answer.
 *
 * The first window is FIRST_SPAN. Where the providers refuse even that (X Layer: every operator
 * "block range greater than 100 max"), it steps DOWN the ladder before giving up, and the chain's
 * ceiling is remembered so the next scan starts below it.
 */
export const SPANS: readonly bigint[] = [100n, 500n, 2_000n, 10_000n, 50_000n]
export const FIRST_SPAN = 2_000n

/**
 * The smallest span the providers REFUSED on this chain (isRangeRefusal, not a timeout), so a
 * later scan on the same chain does not ask for it again. Per page session; a refusal is a
 * provider's policy and rarely changes, and forgetting it on reload costs one refused request.
 */
const refusedSpan = new Map<string, bigint>()
const chainKeyOf = (client: ReadClient): string => String(client.chain?.id ?? client.uid ?? 'unknown')

function windowOf(fromBlock: bigint, toBlock: bigint): LogWindow {
  return { fromBlock, toBlock, blocks: toBlock - fromBlock }
}

export type Widened<L> = { status: 'ok'; logs: L[]; window: LogWindow } | { status: 'unavailable'; reason: string }

/**
 * Reads `query` over widening windows ending at the head until `enough(logs)` holds, the widest span
 * has been read, or a provider will not serve a wider one. `window` is what was actually covered.
 * A failure of the narrowest window the chain serves is `unavailable`; a refusal further out ends
 * the widening with what was read — the same honest "none in this window" the panel has always shown.
 */
export async function scanWidening<L>(
  client: ReadClient,
  query: (fromBlock: bigint, toBlock: bigint) => Promise<L[]>,
  enough: (logs: L[]) => boolean,
): Promise<Widened<L>> {
  const head = await attempt(client.getBlockNumber(), READ_TIMEOUT_MS, 'block number')
  if (!head.ok) return { status: 'unavailable', reason: head.reason }
  const key = chainKeyOf(client)
  const refuse = (span: bigint) => {
    const cap = refusedSpan.get(key)
    if (cap === undefined || span < cap) refusedSpan.set(key, span)
  }
  const fromOf = (span: bigint) => (head.value > span ? head.value - span : 0n)

  // The first window: FIRST_SPAN, or the largest span below what this chain refused before; on a
  // range refusal, the next smaller one.
  const cap = refusedSpan.get(key)
  let i = SPANS.indexOf(FIRST_SPAN)
  while (i > 0 && cap !== undefined && SPANS[i]! >= cap) i--
  let first: L[] | undefined
  for (; i >= 0; i--) {
    const got = await attempt(query(fromOf(SPANS[i]!), head.value), SCAN_TIMEOUT_MS, 'log scan')
    if (got.ok) {
      first = got.value
      break
    }
    if (!isRangeRefusal(got.reason) || i === 0) return { status: 'unavailable', reason: got.reason }
    refuse(SPANS[i]!)
  }
  if (first === undefined) return { status: 'unavailable', reason: 'no span was served' }

  const logs: L[] = [...first]
  let covered = windowOf(fromOf(SPANS[i]!), head.value)
  for (let j = i + 1; j < SPANS.length && !enough(logs) && covered.fromBlock > 0n; j++) {
    const span = SPANS[j]!
    const known = refusedSpan.get(key)
    if (known !== undefined && span >= known) break
    if (span < FIRST_SPAN) continue // the small rungs are only for stepping down
    const fromBlock = fromOf(span)
    const got = await attempt(query(fromBlock, covered.fromBlock - 1n), SCAN_TIMEOUT_MS, 'log scan')
    if (!got.ok) {
      if (isRangeRefusal(got.reason)) refuse(span)
      break
    }
    logs.push(...got.value)
    covered = windowOf(fromBlock, head.value)
  }
  return { status: 'ok', logs, window: covered }
}

/** Visible for tests: forget the spans providers refused. */
export function resetRefusedSpans(): void {
  refusedSpan.clear()
}

export async function scanNewest(
  client: ReadClient,
  p: { address: Address; event: AbiEvent; args?: Record<string, unknown> },
): Promise<Scan<{ blockNumber: bigint; log: unknown }>> {
  const got = await scanWidening(
    client,
    (fromBlock, toBlock) => client.getLogs({ address: p.address, event: p.event, ...(p.args ? { args: p.args } : {}), fromBlock, toBlock }),
    (logs) => logs.length > 0,
  )
  if (got.status === 'unavailable') return got
  if (got.logs.length === 0) return { status: 'none', window: got.window }
  const newest = got.logs.reduce((a, b) => ((b.blockNumber ?? 0n) > (a.blockNumber ?? 0n) ? b : a))
  return { status: 'found', value: { blockNumber: newest.blockNumber ?? 0n, log: newest }, window: got.window }
}

/** Days between a block and now, from that block's own timestamp. */
export async function daysSinceBlock(client: ReadClient, blockNumber: bigint): Promise<Attempt<number>> {
  const b = await attempt(client.getBlock({ blockNumber }), READ_TIMEOUT_MS, 'block')
  if (!b.ok) return b
  const seconds = Date.now() / 1000 - Number(b.value.timestamp)
  return { ok: true, value: Math.max(0, seconds / 86400) }
}


