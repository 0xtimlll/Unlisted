'use client'
/**
 * §4 on screen: the verdict, the reasons for it, and the eight checks behind them.
 *
 * Three rules from §4 are visual rules here, not just rules in the fold:
 *
 *   - **No colour without reasons.** The tier chip is rendered only alongside its reason list, and
 *     the fold guarantees that list is non-empty for anything other than OK.
 *   - **Grey means not checked.** A check that could not be made is grey and carries the reason it
 *     could not, so it is never mistaken for a pass. That is the whole point of the colour scheme.
 *   - **A tier is not a refusal.** The panel says what was found and how bad it is; guard 22 turns
 *     the tier into a warning, and the single tick under the warnings list is what sends (CLAUDE.md
 *     rule 2). Nothing here disables a button or caps an amount.
 */
import { CHECK_IDS, isHard, type CheckId, type CheckState, type RouteRisk, type Tier } from '@/protocols/lz-risk/risk'
import { fmt, useDict, type Dict } from '@/i18n'
import { Alert, Disclosure, Spinner } from './ui'
import { useState } from 'react'

const TIER_STYLE: Record<Tier, string> = {
  BLOCKED: 'border-danger/40 bg-danger/10 text-danger',
  UNVERIFIED: 'border-warn/40 bg-warn/10 text-warn',
  CAUTION: 'border-warn/30 bg-warn/5 text-warn',
  OK: 'border-ok/30 bg-ok/10 text-ok',
}
const TIER_GLYPH: Record<Tier, string> = { BLOCKED: '✗', UNVERIFIED: '!', CAUTION: '⚠', OK: '✓' }

function tierLabel(d: Dict, t: Tier): string {
  return t === 'BLOCKED' ? d.risk.tier_blocked : t === 'UNVERIFIED' ? d.risk.tier_unverified : t === 'CAUTION' ? d.risk.tier_caution : d.risk.tier_ok
}

function checkLabel(d: Dict, id: CheckId): string {
  return (d.risk.checks as Record<string, string>)[id] ?? id
}

/** One row of the check list. Grey is "not checked", and it says why. */
function CheckRow({ id, state }: { id: CheckId; state: CheckState }) {
  const d = useDict()
  const tone =
    state.status === 'pass'
      ? 'text-ok'
      : state.status === 'fail'
        ? 'text-danger'
        : state.status === 'skipped'
          ? 'text-faint'
          : 'text-muted'
  const glyph = state.status === 'pass' ? '✓' : state.status === 'fail' ? '✗' : state.status === 'skipped' ? '–' : '○'
  const detail = state.status === 'pass' ? state.note : state.reason
  return (
    <li className={`${tone} text-xs`}>
      {glyph} {checkLabel(d, id)}
      {isHard(id) ? <span className="ml-1 text-faint">{d.risk.hard}</span> : null}
      {state.status === 'unchecked' ? <span className="ml-1 text-muted">{d.risk.notChecked}</span> : null}
      {detail ? <span className="mono block pl-4 opacity-80">{detail}</span> : null}
    </li>
  )
}

/**
 * §4 does not assess every route: a Solana leg, an NTT transfer, a CCIP transfer. Those get this
 * instead of the panel — grey, and saying plainly that no verdict was formed. Not green, not a tick,
 * and not nothing: an absent verdict is a thing the user should be able to see, or the OK on the
 * next route means less than it should.
 */
export function RiskNotAssessed({ why, title }: { why?: string; title?: string }) {
  const d = useDict()
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
      <div className="font-semibold">○ {title ?? d.risk.notCovered}</div>
      {why === '' ? null : <p className="mt-1 opacity-90">{why ?? d.risk.notCoveredWhy}</p>}
    </div>
  )
}

export function RiskPanel(p: {
  risk: RouteRisk | undefined
  /**
   * No destination chosen yet. There is no route to assess, and saying "not covered" here would
   * be wrong — the route may well be covered once it exists — so the panel asks for the network.
   */
  awaitingDestination?: boolean
  /** True when §4 has no runner for this route; the panel then says so instead of staying blank. */
  notCovered?: boolean
  loading: boolean
  error: string
}) {
  const d = useDict()
  const [open, setOpen] = useState(false)

  if (p.awaitingDestination) return <RiskNotAssessed title={d.risk.chooseDestination} why="" />
  if (p.notCovered) return <RiskNotAssessed />
  if (p.error) return <Alert kind="warn">{fmt(d.risk.failed, { reason: p.error })}</Alert>
  if (!p.risk) {
    // Nothing to say and nothing in flight: the checks have not been asked for yet.
    if (!p.loading) return null
    return (
      <div className="inline-flex items-center gap-2 text-xs text-muted">
        <Spinner /> {d.risk.running}
      </div>
    )
  }
  const r = p.risk

  return (
    <div className="space-y-2">
      <div className={`rounded-lg border px-3 py-2 text-xs ${TIER_STYLE[r.tier]}`}>
        <div className="font-semibold">
          {TIER_GLYPH[r.tier]} {tierLabel(d, r.tier)}
        </div>
        {r.reasons.length > 0 ? (
          <ul className="mt-1 space-y-0.5 opacity-90">
            {r.reasons.map((reason, i) => (
              <li key={i}>· {reason.text}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {r.tier === 'BLOCKED' ? <Alert kind="error">{d.risk.blockedNote}</Alert> : null}

      {/* §Adapter An unproven adapter is red but not refused: a new token's lockbox looks exactly
          like a fake on its first day. Guard 22 carries it as a warning the single tick covers. */}
      {r.adapterUnproven ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <p>{d.risk.adapterUnproven}</p>
        </div>
      ) : null}


      <Disclosure
        title={
          <span className="text-xs text-muted">
            {p.loading ? (
              <span className="inline-flex items-center gap-2">
                <Spinner /> {d.risk.running}
              </span>
            ) : (
              fmt(d.risk.checksTitle, { n: CHECK_IDS.length })
            )}
          </span>
        }
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <ul className="space-y-1">
          {CHECK_IDS.map((id) => (
            <CheckRow key={id} id={id} state={r.checks[id]} />
          ))}
        </ul>
        <p className="mt-2 text-xs text-faint">{d.risk.legend}</p>
      </Disclosure>
    </div>
  )
}
