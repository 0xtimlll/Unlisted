'use client'
/**
 * The route indicator on screen: a dot, a short label, the reasons on hover, and — for red — one
 * line said without a hover. Everything longer lives in the "Details" fold the screen passes in.
 *
 * It renders what core/indicator.ts decided and decides nothing itself: no button is held here,
 * no amount is capped, and there is no box to tick.
 */
import { useState, type ReactNode } from 'react'
import type { Indicator, IndicatorLevel } from '@/core/indicator'
import { useDict, type Dict } from '@/i18n'
import { Disclosure, Spinner } from './ui'

const DOT: Record<IndicatorLevel, string> = {
  none: 'bg-faint',
  pending: 'bg-faint',
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
  /** The long form: the eight checks, the guard list, the flags. Folded by default. */
  children?: ReactNode
}) {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const { level, reasons, headline } = p.indicator
  const tooltip = reasons.filter((r) => r.level !== 'info')
  const hasTooltip = tooltip.length > 0

  return (
    <div className="space-y-1">
      <div className="group relative inline-block">
        <span
          tabIndex={hasTooltip ? 0 : -1}
          className={`inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-semibold ${TEXT[level]}`}
          aria-label={hasTooltip ? tooltip.map((r) => r.text).join('. ') : undefined}
        >
          {level === 'pending' ? <Spinner /> : <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[level]}`} aria-hidden />}
          {label(d, level, p.noneText)}
        </span>
        {hasTooltip ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-80 rounded-xl border border-line bg-surface p-3 text-xs text-ink shadow-xl group-hover:block group-focus-within:block"
          >
            <ul className="space-y-1">
              {tooltip.map((r) => (
                <li key={r.code} className={r.level === 'red' ? 'text-danger' : 'text-warn'}>
                  {r.level === 'red' ? '●' : '●'} {r.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {headline ? <p className="text-xs font-semibold text-danger">{headline.text}</p> : null}
      {p.children ? (
        <Disclosure title={<span className="text-xs">{d.indicator.details}</span>} open={open} onToggle={() => setOpen(!open)}>
          <div className="space-y-3">
            {reasons.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {reasons.map((r) => (
                  <li key={r.code} className={r.level === 'red' ? 'text-danger' : r.level === 'yellow' ? 'text-warn' : 'text-muted'}>
                    ● {r.text}
                    {r.detail ? <span className="mono block break-all pl-4 opacity-80">{r.detail}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {p.children}
          </div>
        </Disclosure>
      ) : null}
    </div>
  )
}
