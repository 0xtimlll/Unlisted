/**
 * §4: the route risk verdict — pure, so the rule can be read and tested without a network.
 *
 * The whole point of this file is that a colour is never a summary of a feeling. A verdict is a
 * fold over facts, each fact is one check with a state, and three rules keep it honest:
 *
 *   1. **A check that did not run is not a check that passed.** `unchecked` is its own state, with
 *      the reason it did not run, and it is counted as neither.
 *   2. **A verdict is never better than its weakest hard check.** If one of the five hard checks
 *      could not be made, the route is held at UNVERIFIED, whatever the others say. The tier is
 *      honest, and it is only a tier: the route indicator (core/indicator.ts) turns BLOCKED into
 *      red and UNVERIFIED / CAUTION into yellow, and prints the reasons. Nothing here caps an
 *      amount, holds a button or asks for a tick (CLAUDE.md rule 2).
 *   3. **No colour without reasons.** Any verdict other than OK carries at least one concrete
 *      reason, and OK carries none. Asserted, not merely intended.
 *
 * NTT and CCIP are not assessed here yet. They have their own rate limits and their own notion of
 * a peer, and the place for them is `assess()` in index.ts — this algebra is already theirs when
 * they are ready, because it only ever looks at check states.
 */

// The only import here, and it is two thresholds and a predicate over them. Everything else in
// this file stays a pure fold over facts handed to it.
import { adapterSignsOk, ADAPTER_MIN_LOCKED_BPS, ADAPTER_MIN_OUTBOUND_NONCE, type AdapterStanding } from './adapters'

/** The eight checks of §4, in the order the panel lists them. */
export const CHECK_IDS = [
  'peers',
  'path',
  'config',
  'delivery_sim',
  'adapter_liquidity',
  'limits',
  'history',
  'recent_changes',
] as const
export type CheckId = (typeof CHECK_IDS)[number]

/**
 * The five whose failure — or absence — decides whether funds can move. §4 names them: peers,
 * a clear path, the destination simulation, adapter liquidity, and pause/limits.
 */
export const HARD_CHECKS: readonly CheckId[] = ['peers', 'path', 'delivery_sim', 'adapter_liquidity', 'limits']

export function isHard(id: CheckId): boolean {
  return HARD_CHECKS.includes(id)
}

export type CheckState =
  /** Ran, and the answer was good. `note` is shown next to it when there is something to say. */
  | { status: 'pass'; note?: string }
  /** Ran, and the answer was bad. A hard check in this state puts the route at BLOCKED, the loudest tier. */
  | { status: 'fail'; reason: string }
  /**
   * Does not apply to this route — a destination that is not an adapter has no liquidity to check,
   * a contract with no `paused()` has no pause. Different from `unchecked`: nothing is missing.
   */
  | { status: 'skipped'; reason: string }
  /** Could not be run: a timeout, an RPC error, a method the contract does not have. */
  | { status: 'unchecked'; reason: string }

export type Tier = 'BLOCKED' | 'UNVERIFIED' | 'CAUTION' | 'OK'

/** One line the panel prints next to the colour. `check` is set when a check produced it. */
export type Reason = { text: string; check?: CheckId }

export type RiskInput = {
  checks: Record<CheckId, CheckState>
  /** The contract's standard has never been exercised against a live deployment (v1 `bytes`). */
  unverifiedStandard: boolean
  /**
   * A party that verifies this route is one LayerZero has deprecated: a DVN (V2), the dead DVN, or a
   * v1 oracle/relayer. Same fact in both protocols — the messages this route needs attested are
   * attested by something its own publisher says not to rely on.
   */
  deprecatedVerifier: boolean
  /**
   * v1 only: the route's oracle or relayer is not in LayerZero's published list at all.
   *
   * Differing from the UltraLightNode's *defaults* is NOT this flag and is not a finding: plenty of
   * live OFTs run Chainlink's oracle (id `ccip`, version 1 in the committed table) or another listed
   * party, and a listed, undeprecated verifier is no reason to say anything. Only a party nobody has
   * published is, and even then the route's own delivery history is allowed to answer for it — see
   * the fold below.
   */
  unknownInfra: boolean
  /** v2: the send config on the source does not match the receive config on the destination. */
  configMismatch: boolean
  /** v2: the DVN set is not one LayerZero's published metadata knows about. */
  unknownDvnSet: boolean
  /**
   * What the history check concluded, as three distinct answers rather than a number that has to
   * carry "I could not look" as `undefined`:
   *
   *   delivered      a delivery was seen, this many days ago
   *   none_in_window  nothing was found, and the window searched reached back this many days. All
   *                   that follows is "the last delivery, if any, was longer ago than that" — a
   *                   real observation, and the most that a bounded search can support.
   *   never           the window covered the whole period that matters and found nothing.
   *   unknown         the search could not be made, or covered too little to say anything. A
   *                   provider that refuses a long `eth_getLogs` range is ordinary, and on a chain
   *                   with sub-second blocks even a generous range is hours. Never reads as "never".
   */
  history:
    | { kind: 'delivered'; days: number }
    | { kind: 'none_in_window'; days: number }
    | { kind: 'never' }
    | { kind: 'unknown'; reason: string }
  /** A peer or config change was seen on this route within the last 7 days. */
  recentChange: boolean
  /**
   * Messages already sent on this route that have not arrived, with the age of the oldest.
   *
   * Distinct from a blocked path: nothing is stuck in the endpoint, so the route works — a transfer
   * sent now simply queues behind these, because v1 and V2 both deliver in nonce order. That is a
   * delay, not a loss, so it holds the tier at UNVERIFIED rather than at BLOCKED.
   */
  delayed: { packets: number; oldestMinutes: number } | undefined
  /** The destination simulation succeeded but with little gas headroom. */
  thinGas: boolean
  /** The amount is close to a rate limit this route enforces. */
  nearLimit: boolean
  /**
   * Did a SECOND, independent operator confirm the contract↔token link this whole verdict rests on?
   *
   * Every check below is read through some RPC. If only one operator answered — because the others
   * were down, or because the reads went to a user-supplied endpoint nobody corroborated — then
   * `peers`, `path` and the rest are not eight findings, they are one provider's story told eight
   * times. A single endpoint that lies can pass all of them at once, which is exactly the fake-route
   * attack the indicator exists to catch.
   *
   * So this holds the tier at UNVERIFIED: the route is not known to be what it claims until
   * another operator answers. A nuance, said in yellow, not a refusal (see the header).
   */
  linkCrossChecked: boolean
  /**
   * §Adapter The source-side OFTAdapter's standing, when the source IS an adapter. Absent for a
   * plain OFT, which is the token and needs no lockbox to vouch for.
   *
   * See adapters.ts: an adapter that locks a real share of supply and has real delivery history
   * is an ordinary route; one that does not is a fresh adapter, held at UNVERIFIED.
   *
   * REQUIRED, with an explicit `null` for a plain OFT. Optional would mean a future runner could
   * turn the rule off by forgetting a field, which is the failure mode `linkCrossChecked` already
   * had to be defended against — an omitted check is a check that passes.
   */
  adapter: AdapterStanding | null
}

export type RouteRisk = {
  tier: Tier
  /** Never empty unless `tier` is OK. */
  reasons: Reason[]
  checks: Record<CheckId, CheckState>
  /** Hard checks that could not be run. Non-empty holds the tier at UNVERIFIED, whatever else passed. */
  hardUnchecked: CheckId[]
  /** §Adapter The source adapter's signals, when the source is an adapter, for the details panel. */
  adapter: AdapterStanding | null
}

/**
 * Undelivered packets ahead of ours: how long is ordinary, and how long is a stoppage.
 *
 * Both thresholds are here rather than with the checks that measure them, because it is the fold
 * that acts on them and this is where a reader comes to find out what a verdict means.
 *
 *   under 30 minutes   traffic in flight. Messages take minutes to verify; a queue that young says
 *                      nothing.
 *   30 to 60 minutes   slow. The route is held at UNVERIFIED with a reason that says the route is
 *                      working and ours is simply behind a few that are still moving.
 *   over 60 minutes    packets that have sat for an hour are not moving. Verification may have
 *                      stopped on this route, and in that case a transfer sent now joins the queue
 *                      rather than passing it. Same tier, a plainer sentence; the person decides.
 */
export const INFLIGHT_GRACE_MINUTES = 30
export const STOPPED_VERIFICATION_MINUTES = 60

/** Days after which a route with no delivery is treated as unproven rather than merely quiet. */
export const STALE_DELIVERY_DAYS = 30
/** Below this, a delivery is recent enough to say nothing about. */
export const FRESH_DELIVERY_DAYS = 7

const RANK: Record<Tier, number> = { BLOCKED: 0, UNVERIFIED: 1, CAUTION: 2, OK: 3 }

/** Why an adapter is called fresh — which floor it missed, or which read failed. */
function adapterFreshReason(a: AdapterStanding): string {
  const parts: string[] = []
  if (a.lockedBps === undefined) parts.push('the share of supply it locks could not be read')
  else if (a.lockedBps < ADAPTER_MIN_LOCKED_BPS) parts.push(`it locks ${a.lockedBps / 100}% of supply, under ${ADAPTER_MIN_LOCKED_BPS / 100}%`)
  if (a.outboundNonce === undefined) parts.push('its delivery history could not be read')
  else if (a.outboundNonce < ADAPTER_MIN_OUTBOUND_NONCE) parts.push(`the endpoint records ${a.outboundNonce} sends through it, under ${ADAPTER_MIN_OUTBOUND_NONCE}`)
  return `fresh adapter: ${parts.join('; ')} — a new token, or a fake; a test amount first is advisable`
}

/** The worse of two tiers. */
function worse(a: Tier, b: Tier): Tier {
  return RANK[a] <= RANK[b] ? a : b
}

/**
 * §4: fold the checks and flags into one verdict.
 *
 * Read the order: hard failures first (nothing after them can improve the answer), then what holds
 * the tier at UNVERIFIED, then what holds it at CAUTION. Several can apply; the worst tier wins
 * because it is the stricter statement about the same route. The tier is a sentence for guard 22,
 * never a cap on the amount (see the header).
 */
export function assessRisk(i: RiskInput): RouteRisk {
  const reasons: Reason[] = []
  const blocking: Reason[] = []

  // ---- BLOCKED: facts, and only facts ---------------------------------------
  for (const id of CHECK_IDS) {
    const c = i.checks[id]
    if (c.status === 'fail' && isHard(id)) blocking.push({ text: c.reason, check: id })
  }
  if (i.deprecatedVerifier) {
    blocking.push({ text: 'a party that verifies this route is one LayerZero has deprecated', check: 'config' })
  }
  if (i.configMismatch) blocking.push({ text: 'the send config on the source does not match the receive config on the destination', check: 'config' })
  if (blocking.length > 0) {
    return { tier: 'BLOCKED', reasons: blocking, checks: i.checks, hardUnchecked: hardUncheckedOf(i), adapter: i.adapter }
  }

  // A soft check failing is a warning, not a block — that is what makes it soft. A soft check that
  // did not run says nothing at all: §4 makes only the five hard ones capable of withholding OK,
  // and the panel still shows it grey, so the silence here is visible rather than hidden.
  for (const id of CHECK_IDS) {
    const c = i.checks[id]
    if (c.status === 'fail' && !isHard(id)) reasons.push({ text: c.reason, check: id })
  }

  let tier: Tier = 'OK'

  // ---- what holds the tier at UNVERIFIED ---------------------------------------
  const hardUnchecked = hardUncheckedOf(i)
  if (hardUnchecked.length > 0) {
    for (const id of hardUnchecked) {
      const c = i.checks[id]
      reasons.push({ text: `not checked: ${c.status === 'unchecked' ? c.reason : 'no answer'}`, check: id })
    }
    tier = worse(tier, 'UNVERIFIED')
  }
  // No independent operator stood behind the contract↔token link, so none of the checks here mean
  // more than the single endpoint that answered them. A nuance, not a refusal.
  if (!i.linkCrossChecked) {
    reasons.push({
      text: 'no second, independent RPC operator confirmed this contract and its peers — one endpoint answering alone cannot establish that this route is what it claims to be',
      check: 'peers',
    })
    tier = worse(tier, 'UNVERIFIED')
  }
  // §Adapter An adapter that locks a real share of supply and has real history is an ordinary
  // route. One that does not is fresh — a new token's adapter is indistinguishable from a fake on
  // day one — and that is said in yellow, with the numbers, and the decision is the person's.
  if (i.adapter && !adapterSignsOk(i.adapter)) {
    reasons.push({ text: adapterFreshReason(i.adapter), check: 'adapter_liquidity' })
    tier = worse(tier, 'UNVERIFIED')
  }
  if (i.unverifiedStandard) {
    reasons.push({ text: 'this contract’s standard has never been verified against a live deployment by this app — a test amount first is advisable' })
    tier = worse(tier, 'UNVERIFIED')
  }
  if (i.delayed) {
    const { packets, oldestMinutes } = i.delayed
    const stopped = oldestMinutes > STOPPED_VERIFICATION_MINUTES
    reasons.push({
      text: stopped
        ? `${packets} packet(s) on this route have been waiting more than an hour (the oldest ${Math.floor(oldestMinutes)} minutes) — verification may have stopped, and a transfer sent now would queue behind them`
        : `${packets} packet(s) sent on this route have not been delivered, the oldest ${Math.floor(oldestMinutes)} minutes ago — a transfer sent now queues behind them`,
      check: 'path',
    })
    tier = worse(tier, 'UNVERIFIED')
    // An hour of no movement is not "slow", it is evidence that nothing is moving; the sentence
    // above says so, and the decision is the person's (CLAUDE.md rule 2).
  }
  const h = i.history
  if (h.kind === 'never') {
    reasons.push({ text: 'nothing has ever been delivered on this route', check: 'history' })
    tier = worse(tier, 'UNVERIFIED')
  } else if (h.kind === 'none_in_window') {
    // What was observed, stated as what was observed: nothing arrived in the days we could search.
    const days = Math.floor(h.days)
    if (h.days > STALE_DELIVERY_DAYS) {
      reasons.push({ text: `nothing has been delivered on this route in the last ${days} days`, check: 'history' })
      tier = worse(tier, 'UNVERIFIED')
    } else if (h.days >= FRESH_DELIVERY_DAYS) {
      reasons.push({ text: `nothing has been delivered on this route in the last ${days} days`, check: 'history' })
      tier = worse(tier, 'CAUTION')
    }
    // A window shorter than a week supports no claim at all, so it makes none.
  } else if (h.kind === 'delivered' && h.days > STALE_DELIVERY_DAYS) {
    reasons.push({ text: `the last delivery on this route was ${Math.floor(h.days)} days ago`, check: 'history' })
    tier = worse(tier, 'UNVERIFIED')
  } else if (h.kind === 'delivered' && h.days > FRESH_DELIVERY_DAYS) {
    reasons.push({ text: `the last delivery on this route was ${Math.floor(h.days)} days ago`, check: 'history' })
    tier = worse(tier, 'CAUTION')
  }
  // `unknown` deliberately adds nothing: it is shown grey in the list, and inventing a warning out
  // of a window that was too short would be exactly the false information §4 forbids.

  // A verifier nobody has published is worth saying, and the route's own history decides how
  // loudly: something that has actually been delivered through that verifier is evidence the
  // infrastructure works, which is more than a name in a list would have told us. Nothing arriving
  // in a window we did search is the case with no such evidence, and only that holds the tier at
  // UNVERIFIED. A window we could not search says neither, so it does not — §4's first rule.
  if (i.unknownInfra) {
    const delivered = h.kind === 'delivered'
    const searchedAndFoundNothing = h.kind === 'never' || h.kind === 'none_in_window'
    reasons.push({
      text: delivered
        ? 'this route’s oracle or relayer is not in LayerZero’s published list, though deliveries have gone through it'
        : 'this route’s oracle or relayer is not in LayerZero’s published list',
      check: 'config',
    })
    tier = worse(tier, searchedAndFoundNothing ? 'UNVERIFIED' : 'CAUTION')
  }

  // ---- warnings: send allowed --------------------------------------------------
  if (i.recentChange) {
    reasons.push({ text: 'a peer or config change was made on this route in the last 7 days', check: 'recent_changes' })
    tier = worse(tier, 'CAUTION')
  }
  if (i.thinGas) {
    reasons.push({ text: 'the destination simulation left little gas headroom', check: 'delivery_sim' })
    tier = worse(tier, 'CAUTION')
  }
  if (i.nearLimit) {
    reasons.push({ text: 'the amount is close to a limit this route enforces', check: 'limits' })
    tier = worse(tier, 'CAUTION')
  }
  if (i.unknownDvnSet) {
    // §4 is explicit that this is at most a warning, and that a DVN LayerZero's own metadata knows
    // and has not deprecated is not a warning at all — the set being unusual is the project's
    // choice, not a defect.
    reasons.push({ text: 'this route uses a DVN set LayerZero’s published list does not describe', check: 'config' })
    tier = worse(tier, 'CAUTION')
  }
  // A soft check that outright failed cannot leave the verdict at OK either.
  if (reasons.length > 0) tier = worse(tier, 'CAUTION')

  // Rule 3, enforced rather than trusted: a colour with nothing to say is a colour we do not show.
  if (tier !== 'OK' && reasons.length === 0) {
    throw new Error(`lz-risk: tier ${tier} with no reasons`)
  }
  if (tier === 'OK' && reasons.length > 0) {
    throw new Error('lz-risk: OK with reasons')
  }
  return { tier, reasons, checks: i.checks, hardUnchecked, adapter: i.adapter }
}

function hardUncheckedOf(i: RiskInput): CheckId[] {
  return HARD_CHECKS.filter((id) => i.checks[id].status === 'unchecked')
}

/** Every check `unchecked` with the same reason — the shape to start from before anything has run. */
export function allUnchecked(reason: string): Record<CheckId, CheckState> {
  const out = {} as Record<CheckId, CheckState>
  for (const id of CHECK_IDS) out[id] = { status: 'unchecked', reason }
  return out
}

/** The neutral input: nothing known, nothing claimed. Callers override what they have learned. */
export function emptyRiskInput(reason = 'not run yet'): RiskInput {
  return {
    checks: allUnchecked(reason),
    unverifiedStandard: false,
    deprecatedVerifier: false,
    unknownInfra: false,
    configMismatch: false,
    unknownDvnSet: false,
    history: { kind: 'unknown', reason },
    recentChange: false,
    // Nothing known means nothing corroborated, which is the blocking answer, not the neutral one.
    linkCrossChecked: false,
    // No source contract to speak of, so no adapter question. Stated, not omitted.
    adapter: null,
    delayed: undefined,
    thinGas: false,
    nearLimit: false,
  }
}


/**
 * The verdict, as the one thing guard 22 needs from it: a note code, or nothing. There is no
 * amount in this and no permission: the indicator prints the reasons, the person decides.
 */
export function riskWarningCode(risk: RouteRisk): 'risk_blocked' | 'risk_unverified' | undefined {
  if (risk.tier === 'BLOCKED') return 'risk_blocked'
  return risk.tier === 'UNVERIFIED' ? 'risk_unverified' : undefined
}
