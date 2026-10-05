'use client'
/**
 * The route indicator on screen: a dot, a short label, the reasons on hover, and — for red — one
 * line said without a hover. Everything longer lives in the "Details" fold the screen renders
 * underneath (IndicatorReasons and the tab's own lists).
 *
 * It renders what core/indicator.ts decided and decides nothing itself: no button is held here,
 * no amount is capped, and there is no box to tick.
 */
import type { Indicator, IndicatorLevel } from '@/core/indicator'
import { useDict, type Dict } from '@/i18n'
import { Spinner } from './ui'

const DOT: Record<IndicatorLevel, string> = {
  none: 'bg-muted',
  pending: 'bg-muted',
  green: 'bg-ok',
  yellow: 'bg-warn',
  red: 'bg-danger',
}

const TEXT: Record<IndicatorLevel, string> = {
  none: 'text-muted',
  pending: 'text-muted',
  green: 'text-ok',
  yellow: 'text-warn',
  red: 'text-danger',
}

function label(d: Dict, level: IndicatorLevel, noneText: string): string {
  switch (level) {
    case 'none':
      return noneText
    case 'pending':
      return d.indicator.checking
    case 'green':
      return d.indicator.ok
    case 'yellow':
      return d.indicator.nuances
    case 'red':
      return d.indicator.high
  }
}

export function RouteIndicator(p: {
  indicator: Indicator
  /** What the chip says while there is nothing to assess: which input is still missing. */
  noneText: string
}) {
  const d = useDict()
  const { level, reasons, headline } = p.indicator
  const tooltip = reasons.filter((r) => r.level !== 'info')
  const hasTooltip = tooltip.length > 0

  return (
    <div className="space-y-2">
      <div className="group relative flex items-center gap-3">
        <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface ${TEXT[level]}`} aria-hidden>
          {level === 'pending' ? <Spinner /> : <span className={`inline-block h-3 w-3 rounded-full ${DOT[level]}`} />}
        </span>
        <span tabIndex={hasTooltip ? 0 : -1} className={`text-sm font-semibold ${TEXT[level]}`} aria-label={hasTooltip ? tooltip.map((r) => r.text).join('. ') : undefined}>
          {label(d, level, p.noneText)}
        </span>
        {hasTooltip ? (
          <div role="tooltip" className="pointer-events-none absolute left-0 top-full z-30 mt-2 hidden w-80 rounded-2xl bg-surface p-3 text-xs text-ink shadow-lg group-hover:block group-focus-within:block">
            <ul className="space-y-1">
              {tooltip.map((r, i) => (
                <li key={`${i}-${r.code}`} className={r.level === 'red' ? 'text-danger' : 'text-warn'}>
                  ● {r.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {headline ? <p className="text-xs font-semibold text-danger">{headline.text}</p> : null}
      {p.indicator.preview ? <p className="text-xs text-muted">{reasons.find((r) => r.code === 'preview_unsimulated')?.text}</p> : null}
    </div>
  )
}

/** Every reason behind the colour, including the informational ones, for the details fold. */
export function IndicatorReasons({ indicator }: { indicator: Indicator }) {
  if (indicator.reasons.length === 0) return null
  return (
    <ul className="space-y-1 text-xs">
      {indicator.reasons.map((r, i) => (
        <li key={`${i}-${r.code}`} className={r.level === 'red' ? 'text-danger' : r.level === 'yellow' ? 'text-warn' : 'text-muted'}>
          ● {r.text}
          {r.detail ? <span className="mono block break-all pl-4 opacity-80">{r.detail}</span> : null}
        </li>
      ))}
    </ul>
  )
}
