/**
 * §4: one way in. Give it a route and it answers with a verdict and the reasons behind it.
 *
 * The dispatch is here so a screen never has to know which protocol's check runner it wants, and
 * so the two that are not done yet have an obvious place to arrive: `wormhole-ntt` and `ccip` each
 * have their own notion of a peer and their own rate limits, and their tabs already read those for
 * their own guards. What they do not have is this fold, and they will not need a different one —
 * `assessRisk` only ever looks at check states, so adding them is writing a runner, not a rule.
 */
import { parseAmount } from '../../core/amounts'
import type { ChainKey } from '../../core/chains'
import { assessRisk, type RouteRisk } from './risk'
import { assessV1Route, type V1RiskContext } from './v1'
import { assessV2Route, type V2RiskContext } from './v2'
import { isRouteVerified, type RouteId } from './verified'

export * from './risk'
export { dvnInfo, dvnLabel, judgeDvns, DVN_SOURCE, DVN_GENERATED } from './dvns'
export { assessV1Route, v1Payload } from './v1'
export { assessV2Route, dstChainOf, dstOftOf, v2Message, compareUlnShape } from './v2'
export * from './verified'
export * from './testLimit'

export type RiskSubject =
  | ({ protocol: 'lz-v1' } & V1RiskContext)
  | ({ protocol: 'lz-oft' } & V2RiskContext)

export type RiskOutcome = {
  risk: RouteRisk
  /**
   * The destination gas the simulation measured, when it ran. §3 feeds this back into v1's adapter
   * params as `max(minDstGasLookup, estimate × 1.3)`, which is the one place a risk check changes
   * what gets signed — and it can only ever raise the gas bought, never lower it.
   */
  dstGasEstimate: bigint | undefined
}

/** The route as the verified-routes table keys it. */
export function routeIdOf(s: RiskSubject): RouteId {
  return s.protocol === 'lz-v1'
    ? { protocol: 'lz-v1', srcChain: s.info.chain, oft: s.info.oft, dstChain: s.plan.dst.key }
    : { protocol: 'lz-oft', srcChain: s.srcChain, oft: s.info.oft, dstChain: s.dstChain }
}

/**
 * Runs every check for this route and folds them into a verdict.
 *
 * `now` is injectable so a test can age a verified route without waiting a day.
 */
export async function assessRoute(s: RiskSubject, now = Date.now()): Promise<RiskOutcome> {
  const testVerified = isRouteVerified(routeIdOf(s), now)
  if (s.protocol === 'lz-v1') {
    const { input, dstGasEstimate } = await assessV1Route(s)
    return { risk: assessRisk({ ...input, testVerified }), dstGasEstimate }
  }
  const input = await assessV2Route(s)
  return { risk: assessRisk({ ...input, testVerified }), dstGasEstimate: undefined }
}

/**
 * The limit as a raw amount, or undefined when nothing usable has been typed.
 *
 * There is no default on purpose: see testLimit.ts. Undefined here means an unverified route sends
 * nothing, which is the intended behaviour — guard 22 says so with its own code rather than
 * pretending a limit was chosen.
 */
export function testLimitLD(input: string, decimals: number): bigint | undefined {
  const s = input.trim()
  if (s === '') return undefined
  try {
    const v = parseAmount(s, decimals)
    return v > 0n ? v : undefined
  } catch {
    return undefined
  }
}

/** Shown next to the indicator so the chain names read as the user's own route. */
export function routeLabel(src: ChainKey, dst: ChainKey): string {
  return `${src} → ${dst}`
}
