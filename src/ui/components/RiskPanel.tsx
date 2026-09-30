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
 *   - **A cap is not a warning.** When only a test amount may go, the panel says so with the limit
 *     in the token's own units and the field to change it, rather than leaving the user to discover
 *     it from a disabled button.
 */
import { formatAmount } from '@/core/amounts'
import { CHECK_IDS, isHard, OVERRIDE_WORD, type CheckId, type CheckState, type RouteRisk, type Tier } from '@/protocols/lz-risk/risk'
import { fmt, useDict, type Dict } from '@/i18n'
import { Alert, Box, BoxLabel, Disclosure, Input, Spinner } from './ui'
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
export function RiskNotAssessed({ why }: { why?: string }) {
  const d = useDict()
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
      <div className="font-semibold">○ {d.risk.notCovered}</div>
      <p className="mt-1 opacity-90">{why ?? d.risk.notCoveredWhy}</p>
    </div>
  )
}

export function RiskPanel(p: {
  risk: RouteRisk | undefined
  /** True when §4 has no runner for this route; the panel then says so instead of staying blank. */
  notCovered?: boolean
  loading: boolean
  error: string
  /** The token being moved, for the limit field's units. */
  decimals: number
  symbol: string
  /** The test-amount limit, as the user typed it, and the raw value it parsed to. */
  testLimit: string
  onTestLimit: (v: string) => void
  testLimitLD: bigint | undefined
  /** The amount this transfer would send, to say whether it is over the limit. */
  amountLD: bigint | undefined
  override: string
  onOverride: (v: string) => void
  /** §Adapter The tick under the red adapter warning. */
  adapterAccepted: boolean
  onAdapterAccepted: (v: boolean) => void
}) {
  const d = useDict()
  const [open, setOpen] = useState(false)

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
  const overLimit = p.testLimitLD !== undefined && p.amountLD !== undefined && p.amountLD > p.testLimitLD

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
          like a fake on its first day. The test amount needs nothing; the full amount needs this. */}
      {r.adapterUnproven ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <p>{d.risk.adapterUnproven}</p>
          <label className="mt-2 flex items-start gap-2 text-xs">
            <input type="checkbox" className="mt-0.5" checked={p.adapterAccepted} onChange={(e) => p.onAdapterAccepted(e.target.checked)} />
            <span>{d.risk.adapterAccept}</span>
          </label>
        </div>
      ) : null}

      {r.testLimitOnly ? (
        <Box>
          <BoxLabel>{d.risk.testLimit}</BoxLabel>
          <Input value={p.testLimit} onChange={(e) => p.onTestLimit(e.target.value)} placeholder="1" inputMode="decimal" spellCheck={false} />
          <p className="mt-1 text-xs text-muted">
            {fmt(d.risk.testLimitNote, {
              limit: p.testLimitLD === undefined ? '—' : formatAmount(p.testLimitLD, p.decimals, { maxFraction: 8 }),
              symbol: p.symbol,
            })}
          </p>
          {overLimit ? <p className="mt-1 text-xs text-danger">{d.risk.overLimit}</p> : null}
          {/* The adapter case is accepted by the tick above, not by typing a word here. */}
          {r.overridable && !r.adapterUnproven ? (
            <div className="mt-2">
              <BoxLabel>{fmt(d.risk.overrideLabel, { word: OVERRIDE_WORD })}</BoxLabel>
              <Input value={p.override} onChange={(e) => p.onOverride(e.target.value)} placeholder={OVERRIDE_WORD} spellCheck={false} />
            </div>
          ) : r.overridable ? null : (
            <p className="mt-2 text-xs text-warn">{d.risk.notOverridable}</p>
          )}
        </Box>
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
