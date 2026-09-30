'use client'
/**
 * §4 in the details fold: the eight checks behind the route indicator's colour.
 *
 * Two rules from §4 are visual rules here:
 *
 *   - **Grey means not checked.** A check that could not be made is grey and carries the reason it
 *     could not, so it is never mistaken for a pass.
 *   - **A tier is not a refusal.** The list says what was found; the indicator above it says how
 *     bad it is. Nothing here disables a button or caps an amount.
 */
import { CHECK_IDS, isHard, type CheckId, type CheckState, type RouteRisk } from '@/protocols/lz-risk/risk'
import { ADAPTER_MIN_LOCKED_BPS, ADAPTER_MIN_OUTBOUND_NONCE } from '@/protocols/lz-risk/adapters'
import { fmt, useDict, type Dict } from '@/i18n'
import { Spinner } from './ui'

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
 * line in the details instead of the list — the transfer is still held to its own tab's checks.
 */
export function RiskNotAssessed({ why }: { why?: string }) {
  const d = useDict()
  return (
    <div className="text-xs text-muted">
      <div className="font-semibold">○ {d.risk.notCovered}</div>
      <p className="mt-1 opacity-90">{why ?? d.risk.notCoveredWhy}</p>
    </div>
  )
}

/** The eight checks, the adapter's numbers when the source is an adapter, and the legend. */
export function RiskChecks(p: { risk: RouteRisk | undefined; loading: boolean; error: string }) {
  const d = useDict()
  if (p.error) return <p className="text-xs text-warn">{fmt(d.risk.failed, { reason: p.error })}</p>
  if (!p.risk) {
    if (!p.loading) return null
    return (
      <div className="inline-flex items-center gap-2 text-xs text-muted">
        <Spinner /> {d.risk.running}
      </div>
    )
  }
  const r = p.risk
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted">{fmt(d.risk.checksTitle, { n: CHECK_IDS.length })}</div>
      <ul className="space-y-1">
        {CHECK_IDS.map((id) => (
          <CheckRow key={id} id={id} state={r.checks[id]} />
        ))}
      </ul>
      {r.adapter ? (
        <p className="mt-2 text-xs text-muted">
          {fmt(d.risk.adapterSigns, {
            locked: r.adapter.lockedBps === undefined ? '?' : `${r.adapter.lockedBps / 100}%`,
            floor: `${ADAPTER_MIN_LOCKED_BPS / 100}%`,
            sends: r.adapter.outboundNonce === undefined ? '?' : r.adapter.outboundNonce.toString(),
            minSends: ADAPTER_MIN_OUTBOUND_NONCE.toString(),
          })}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-faint">{d.risk.legend}</p>
    </div>
  )
}
