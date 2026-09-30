/**
 * §4: one way in. Give it a route and it answers with a verdict and the reasons behind it.
 *
 * The dispatch is here so a screen never has to know which protocol's check runner it wants, and
 * so the two that are not done yet have an obvious place to arrive: `wormhole-ntt` and `ccip` each
 * have their own notion of a peer and their own rate limits, and their tabs already read those for
 * their own guards. What they do not have is this fold, and they will not need a different one —
 * `assessRisk` only ever looks at check states, so adding them is writing a runner, not a rule.
 */
import type { ChainKey } from '../../core/chains'
import { assessRisk, type RouteRisk } from './risk'
import { assessV1Route, type V1RiskContext } from './v1'
import { assessV2Route, type V2RiskContext } from './v2'

export * from './risk'
export { dvnInfo, dvnLabel, judgeDvns, DVN_SOURCE, DVN_GENERATED } from './dvns'
export { assessV1Route, v1Payload } from './v1'
export { assessV2Route, dstChainOf, dstOftOf, v2Message, compareUlnShape } from './v2'

export type RiskSubject = (({ protocol: 'lz-v1' } & V1RiskContext) | ({ protocol: 'lz-oft' } & V2RiskContext)) & {
  /**
   * Whether an operator other than the one that answered first confirmed the contract probe.
   * The screens read it off the probe's own `crossChecked`; see RiskInput.linkCrossChecked.
   */
  linkCrossChecked: boolean
}

export type RiskOutcome = {
  risk: RouteRisk
  /**
   * The destination gas the simulation measured, when it ran. §3 feeds this back into v1's adapter
   * params as `max(minDstGasLookup, estimate × 1.3)`, which is the one place a risk check changes
   * what gets signed — and it can only ever raise the gas bought, never lower it.
   */
  dstGasEstimate: bigint | undefined
}


/** Runs every check for this route and folds them into a verdict. */
export async function assessRoute(s: RiskSubject): Promise<RiskOutcome> {
  if (s.protocol === 'lz-v1') {
    const { input, dstGasEstimate } = await assessV1Route(s)
    return { risk: assessRisk({ ...input, linkCrossChecked: s.linkCrossChecked }), dstGasEstimate }
  }
  const input = await assessV2Route(s)
  return { risk: assessRisk({ ...input, linkCrossChecked: s.linkCrossChecked }), dstGasEstimate: undefined }
}


/** Shown next to the indicator so the chain names read as the user's own route. */
export function routeLabel(src: ChainKey, dst: ChainKey): string {
  return `${src} → ${dst}`
}
