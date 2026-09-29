/**
 * §4: a route a test transfer actually arrived on, remembered for 24 hours.
 *
 * This is the only thing that lifts the amount cap when a hard check could not be made. It is also
 * the only piece of the risk verdict that is not read from a chain, so it is kept deliberately
 * small and deliberately fragile-proof:
 *
 *   - Its own localStorage key, separate from the app's settings blob, so a corrupt entry here can
 *     never take the wallet's RPC configuration with it.
 *   - Every read and write in try/catch. With storage blocked, unavailable or cleared, the
 *     functions return "not verified" and the app works — a route simply stays capped.
 *   - Time-boxed to 24 hours and re-checked on read, so a stale note can never keep a cap lifted.
 *   - Written only after a delivery confirmed **on chain**, never after a transaction was merely
 *     submitted. A send that was signed proves nothing about arrival, which is the whole point.
 *
 * What it can and cannot do is worth being plain about: an entry here is a record that this route
 * carried a transfer, not a promise about the next one. It lifts a cap; it never turns a BLOCKED
 * route into a permitted one, and `assessRisk` is where that is enforced.
 */

const KEY = 'oft-bridge-ui:verified-routes:v1'
export const VERIFIED_TTL_MS = 24 * 60 * 60 * 1000

/** Everything that makes a route a route: the protocol, both chains, and the contract. */
export type RouteId = { protocol: 'lz-oft' | 'lz-v1'; srcChain: string; oft: string; dstChain: string }

export function routeKey(r: RouteId): string {
  return `${r.protocol}:${r.srcChain}:${r.oft.toLowerCase()}:${r.dstChain}`
}

type Table = Record<string, number>

function read(): Table {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Table = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Only a plain finite timestamp is kept; anything else is someone else's data or damage.
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function write(t: Table): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(t))
  } catch {
    /* storage unavailable: the cap simply stays on */
  }
}

/** Records that a transfer on this route was confirmed delivered, now. */
export function markRouteVerified(r: RouteId, now = Date.now()): void {
  const t = read()
  t[routeKey(r)] = now
  write(prune(t, now))
}

/** True when this route carried a confirmed delivery within the TTL. */
export function isRouteVerified(r: RouteId, now = Date.now()): boolean {
  const at = read()[routeKey(r)]
  return at !== undefined && now - at < VERIFIED_TTL_MS
}

/** When it was verified, for the panel to say how long ago. */
export function routeVerifiedAt(r: RouteId, now = Date.now()): number | undefined {
  const at = read()[routeKey(r)]
  return at !== undefined && now - at < VERIFIED_TTL_MS ? at : undefined
}

/** Drops entries past the TTL, so the table cannot grow without bound. */
function prune(t: Table, now: number): Table {
  const out: Table = {}
  for (const [k, at] of Object.entries(t)) if (now - at < VERIFIED_TTL_MS) out[k] = at
  return out
}

/** For tests and for a user who wants to start from nothing. */
export function forgetVerifiedRoutes(): void {
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* nothing to do */
  }
}
