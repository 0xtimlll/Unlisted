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
import { sanitizeText } from '../../core/text'

/** §4 asks for 1–3 seconds for the whole panel, so no single read may sit longer than this. */
export const READ_TIMEOUT_MS = 2_500
/** A log search is heavier, and it is never on the critical path for a verdict. */
export const SCAN_TIMEOUT_MS = 4_000

export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string }

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
    return { ok: false, reason: shortReason(e) }
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
const MAX_SPAN = 50_000n
/** Tried in order: a provider that refuses the first span often serves a smaller one. */
const SPANS: readonly bigint[] = [MAX_SPAN, 10_000n, 2_000n]

function windowOf(fromBlock: bigint, toBlock: bigint): LogWindow {
  return { fromBlock, toBlock, blocks: toBlock - fromBlock }
}

/**
 * The newest log matching `event` from `address`, within a window ending at the chain head.
 *
 * Shrinking spans rather than one fixed range, because "the provider refused 50k blocks" should not
 * become "nothing was found" when 2k blocks would have been served.
 */
export async function scanNewest(
  client: ReadClient,
  p: { address: Address; event: AbiEvent; args?: Record<string, unknown> },
): Promise<Scan<{ blockNumber: bigint; log: unknown }>> {
  const head = await attempt(client.getBlockNumber(), READ_TIMEOUT_MS, 'block number')
  if (!head.ok) return { status: 'unavailable', reason: head.reason }

  let lastReason = 'no span was served'
  for (const span of SPANS) {
    const toBlock = head.value
    const fromBlock = toBlock > span ? toBlock - span : 0n
    const got = await attempt(
      client.getLogs({ address: p.address, event: p.event, ...(p.args ? { args: p.args } : {}), fromBlock, toBlock }),
      SCAN_TIMEOUT_MS,
      'log scan',
    )
    if (!got.ok) {
      lastReason = got.reason
      continue
    }
    const window = windowOf(fromBlock, toBlock)
    const logs = got.value
    if (logs.length === 0) return { status: 'none', window }
    const newest = logs.reduce((a, b) => ((b.blockNumber ?? 0n) > (a.blockNumber ?? 0n) ? b : a))
    return { status: 'found', value: { blockNumber: newest.blockNumber ?? 0n, log: newest }, window }
  }
  return { status: 'unavailable', reason: lastReason }
}

/** Days between a block and now, from that block's own timestamp. */
export async function daysSinceBlock(client: ReadClient, blockNumber: bigint): Promise<Attempt<number>> {
  const b = await attempt(client.getBlock({ blockNumber }), READ_TIMEOUT_MS, 'block')
  if (!b.ok) return b
  const seconds = Date.now() / 1000 - Number(b.value.timestamp)
  return { ok: true, value: Math.max(0, seconds / 86400) }
}


