/**
 * The route indicator: one colour, the reasons behind it, and nothing else.
 *
 * A pure fold, so the rule can be read and tested without a screen. The screens hand it what they
 * know — the failed guards, the eight-check verdict where the route has one, the contract's
 * suspicious flags, the DVN count — and it answers with a level and a list of reasons, each with
 * its own weight. The colour is the worst reason. There is no arrangement of inputs in which the
 * indicator holds a button or caps an amount: it is information, and the person decides.
 *
 *   none      no destination, or no amount yet — nothing to assess
 *   pending   a read is still in flight and nothing red is known yet
 *   green     peer found and pointing back, the simulation passed, and nothing else to say
 *   yellow    nuances: a fresh adapter, a single RPC operator, a simulation that could not run,
 *             a weak DVN set, a fee above the chain's ceiling
 *   red       a recipient that would lose the money, a peer that does not point back, a route
 *             LayerZero has blocked, an NTT manager nothing on the source chain vouches for
 *
 * Red is said out loud: the first red reason is the `headline`, printed under the indicator
 * without a hover. Everything else is in the tooltip and the details.
 */
import type { RouteRisk } from '../protocols/lz-risk/risk'
import { isPendingCode, isNoteCode } from './severity'

export type IndicatorLevel = 'none' | 'pending' | 'green' | 'yellow' | 'red'
export type ReasonLevel = 'red' | 'yellow' | 'info'

export type IndicatorReason = {
  level: ReasonLevel
  /** The guard code, flag or risk check that produced it, for tests and keys. */
  code: string
  text: string
  /** The raw detail (a decoded revert, an address), shown under the sentence in the details. */
  detail?: string
}

export type Indicator = {
  level: IndicatorLevel
  /** Strongest first. Empty only for `none`, `pending` (unless something is already known) and `green`. */
  reasons: IndicatorReason[]
  /** The one line printed without a hover. Present exactly when the level is red. */
  headline: IndicatorReason | undefined
  /** The route was assessed without the funds to send: see IndicatorInput.preview. */
  preview: boolean
}

/**
 * Reads that wait for FUNDS rather than for a provider: the balance, the allowance, the exact
 * simulation and the self-check behind it. In a preview they are not "still checking" — they
 * will not happen until the tokens are there — so they neither hold the colour at grey nor
 * count as pending.
 */
const FUNDS_PENDING: ReadonlySet<string> = new Set(['balance_unknown', 'native_balance_unknown', 'allowance_unknown', 'simulation_missing', 'selfcheck_missing'])

/**
 * The guard notes that are RED: the money would go to the wrong place, or the far side is not what
 * it claims. Every other note is yellow — a nuance, said in the tooltip.
 */
const RED_NOTES: ReadonlySet<string> = new Set([
  'recipient_zero',
  'recipient_is_contract',
  'recipient_lookalike',
  // A Solana token account cannot be credited this way.
  'recipient_token_account',
  'peer_back_mismatch',
  'trusted_remote_back_mismatch',
  // NTT: nothing on the source chain vouches for the manager (at most the destination does, and we
  // only know the destination through the manager's own peer).
  'ntt_anchor_missing',
  // The contract keeps more than 3% of the amount (core/oftFee.ts): said aloud, decided by the person.
  'oft_fee_high',
  'oft_fee_extreme',
])

/** Which colour a guard note gives the indicator. */
export function noteLevel(code: string): ReasonLevel {
  return RED_NOTES.has(code) ? 'red' : 'yellow'
}

/**
 * The suspicious flags that colour the indicator yellow. The rest — a proxy, an EOA owner, source
 * not verified on the explorer, a name that mixes alphabets — are facts worth a line in the details
 * and nothing more: a proxy is how most real tokens are deployed.
 */
const YELLOW_FLAGS: ReadonlySet<string> = new Set([
  'not_cross_checked',
  'adapter_empty',
  'svm_paused',
  'svm_source_paused',
  'svm_store_unrecognised',
  'svm_store_unrecognised_delivered',
  'svm_single_provider',
  'enforced_native_drop',
  'enforced_compose',
  'enforced_over_cap',
  'enforced_malformed',
])

export function flagLevel(flag: string): ReasonLevel {
  return YELLOW_FLAGS.has(flag) ? 'yellow' : 'info'
}

/** The codes guard 22 emits; the indicator reads the verdict itself instead. */
const RISK_CODES: ReadonlySet<string> = new Set(['risk_unknown', 'risk_unavailable', 'risk_blocked', 'risk_unverified'])

export type IndicatorInput = {
  /** Nothing to assess until a destination is chosen. */
  hasDestination: boolean
  /** Nothing to assess until there is a plan (an amount, a recipient, a quote). */
  hasPlan: boolean
  /**
   * The quote failed (the contract refused `quoteSend`, the RPC did not answer): there is no plan,
   * but that is a finding about this route, not an input still missing — said in red, with the
   * decoded reason, instead of a grey "enter an amount".
   */
  planError?: string | undefined
  /** Every guard result of the tab, ok or not; the fold picks what it needs. */
  results: readonly ({ ok: true } | { ok: false; code: string; detail?: string })[]
  /** The tab's own guard dictionary, since each protocol names its codes separately. */
  label: (code: string) => string
  /** The contract's suspicious flags (core/types.ts). */
  flags: readonly string[]
  flagLabel: (flag: string) => string
  /** The eight-check verdict, when the route has a runner and it has answered. */
  risk?: RouteRisk | undefined
  /** True when the route has a runner: a LayerZero route between two EVM chains. */
  riskCovered: boolean
  /** The runner is still reading. */
  riskPending: boolean
  /** The runner threw: said as a yellow reason, never as a block. */
  riskError?: string | undefined
  /**
   * Something holds the button (no balance, wrong chain…). The simulation and the gas estimate
   * never run behind a hold, so a pending read is not "still checking" — the route is simply not
   * assessed until the transfer is possible. Red reasons already known are still said.
   */
  held?: boolean
  /** LayerZero V2: only one party attests to messages on this route. */
  dvnWeak?: boolean
  dvnWeakText?: string
  /**
   * The assessment is a PREVIEW: the plan was built for a probe amount, a placeholder sender, or
   * the transfer is held by something the route cannot answer for (no balance, no wallet, wrong
   * chain). Everything that does not need the funds — peers, DVNs, the eight checks, the contract's
   * fee, the quote — is judged as usual; the exact simulation is not, and that is said as a yellow
   * reason (this text), so a preview is never green. A person deciding whether to BUY the token can
   * see red before holding any of it.
   */
  preview?: string | undefined
}

const RANK: Record<ReasonLevel, number> = { red: 0, yellow: 1, info: 2 }

export function assessIndicator(i: IndicatorInput): Indicator {
  const preview = i.preview !== undefined
  if (!i.hasDestination) return { level: 'none', reasons: [], headline: undefined, preview: false }
  if (!i.hasPlan) {
    if (!i.planError) return { level: 'none', reasons: [], headline: undefined, preview: false }
    const reason: IndicatorReason = { level: 'red', code: 'quote_failed', text: i.planError }
    return { level: 'red', reasons: [reason], headline: reason, preview }
  }

  const reasons: IndicatorReason[] = []
  let pending = false

  for (const r of i.results) {
    if (r.ok) continue
    if (RISK_CODES.has(r.code)) continue
    if (isPendingCode(r.code)) {
      if (!(preview && FUNDS_PENDING.has(r.code))) pending = true
      continue
    }
    if (!isNoteCode(r.code)) continue // a block is said under the button, not here
    reasons.push({ level: noteLevel(r.code), code: r.code, text: i.label(r.code), ...(r.detail ? { detail: r.detail } : {}) })
  }

  if (i.riskCovered) {
    if (i.risk) {
      const level: ReasonLevel = i.risk.tier === 'BLOCKED' ? 'red' : i.risk.tier === 'OK' ? 'info' : 'yellow'
      for (const reason of i.risk.reasons) {
        reasons.push({ level, code: reason.check ? `risk_${reason.check}` : 'risk', text: reason.text })
      }
    } else if (i.riskError) {
      reasons.push({ level: 'yellow', code: 'risk_error', text: i.riskError })
    } else if (i.riskPending) {
      pending = true
    }
  }

  if (i.dvnWeak && i.dvnWeakText) reasons.push({ level: 'yellow', code: 'dvn_weak', text: i.dvnWeakText })

  for (const f of i.flags) reasons.push({ level: flagLevel(f), code: `flag_${f}`, text: i.flagLabel(f) })

  // A preview says so, in yellow: the one thing it could not do is the exact simulation.
  if (preview) reasons.push({ level: 'yellow', code: 'preview_unsimulated', text: i.preview! })

  reasons.sort((a, b) => RANK[a.level] - RANK[b.level])
  const headline = reasons.find((r) => r.level === 'red')
  const held = i.held && !preview
  const level: IndicatorLevel = headline ? 'red' : pending ? (held ? 'none' : 'pending') : reasons.some((r) => r.level === 'yellow') ? 'yellow' : 'green'
  return { level, reasons, headline, preview }
}
