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
}

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
const RISK_CODES: ReadonlySet<string> = new Set(['risk_unknown', 'risk_blocked', 'risk_unverified'])

export type IndicatorInput = {
  /** Nothing to assess until a destination is chosen. */
  hasDestination: boolean
  /** Nothing to assess until there is a plan (an amount, a recipient, a quote). */
  hasPlan: boolean
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
  /** LayerZero V2: only one party attests to messages on this route. */
  dvnWeak?: boolean
  dvnWeakText?: string
}

const RANK: Record<ReasonLevel, number> = { red: 0, yellow: 1, info: 2 }

export function assessIndicator(i: IndicatorInput): Indicator {
  if (!i.hasDestination || !i.hasPlan) return { level: 'none', reasons: [], headline: undefined }

  const reasons: IndicatorReason[] = []
  let pending = false

  for (const r of i.results) {
    if (r.ok) continue
    if (RISK_CODES.has(r.code)) continue
    if (isPendingCode(r.code)) {
      pending = true
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

  reasons.sort((a, b) => RANK[a.level] - RANK[b.level])
  const headline = reasons.find((r) => r.level === 'red')
  const level: IndicatorLevel = headline ? 'red' : pending ? 'pending' : reasons.some((r) => r.level === 'yellow') ? 'yellow' : 'green'
  return { level, reasons, headline }
}
