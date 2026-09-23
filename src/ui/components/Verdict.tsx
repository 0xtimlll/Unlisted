'use client'
/**
 * §Task 3, on screen: one verdict, in colour, with the reason in a sentence, the one thing to do
 * next, and the raw material behind a disclosure so a wrong verdict can still be argued with.
 */
import { useState } from 'react'
import { byKey } from '@/core/chains'
import { isForeignProtocol, type AnalysisAction, type AnalysisResult, type AnyProtocolId } from '@/core/analysis/result'
import { fmt, protocolName, useDict, type Dict } from '@/i18n'
import { Address } from './Address'
import { ProtocolBadge } from './History'
import { Button, Disclosure, Row } from './ui'

const VERDICT_STYLE = {
  can_bridge: 'border-ok/30 bg-ok/10 text-ok',
  cannot_bridge: 'border-danger/30 bg-danger/10 text-danger',
  unknown: 'border-line bg-surface-2 text-muted',
} as const

const VERDICT_GLYPH = { can_bridge: '✓', cannot_bridge: '✗', unknown: '?' } as const

/** Display name for any protocol, ours or not. */
export function anyProtocolName(d: Dict, id: AnyProtocolId, vars: Record<string, string>): string {
  if (!isForeignProtocol(id)) return protocolName(d, id)
  switch (id) {
    case 'wormhole-portal':
      return d.analysis.name_wormhole_portal
    case 'wormhole-other':
      return d.analysis.name_wormhole_other
    case 'axelar':
      return d.analysis.name_axelar
    case 'axelar-its':
      return d.analysis.name_axelar_its
    case 'cctp':
      return d.analysis.name_cctp
    case 'hyperlane':
      return d.analysis.name_hyperlane
    case 'native-bridge':
      return fmt(d.analysis.name_native_bridge, { bridge: vars['bridge'] ?? '' })
  }
}

function text(d: Dict, r: AnalysisResult): { title: string; reason: string } {
  const vars = { ...r.vars, protocol: r.protocol ? anyProtocolName(d, r.protocol, r.vars) : '' }
  const key = r.code
  return {
    title: fmt(d.analysis[`title_${key}`], vars),
    reason: fmt(d.analysis[`reason_${key}`], vars),
  }
}

function actionLabel(d: Dict, a: AnalysisAction): string {
  switch (a.kind) {
    case 'switch_chain':
      return fmt(d.analysis.act_switch_chain, { chain: byKey(a.chain).name })
    case 'open_tab':
      return fmt(d.analysis.act_open_tab, { protocol: protocolName(d, a.protocol) })
    case 'use_address':
      return d.analysis.act_use_address
    case 'open_url':
      return d.analysis.act_open_url
    case 'choose':
      return d.analysis.act_choose
  }
}

export function VerdictCard({ result: r, onAction }: { result: AnalysisResult; onAction: (a: AnalysisAction) => void }) {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const { title, reason } = text(d, r)
  const chain = r.details.chain
  const explorer = chain ? byKey(chain).explorerAddrUrl : undefined

  return (
    <div className="space-y-3">
      <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold ${VERDICT_STYLE[r.verdict]}`}>
        <span aria-hidden>{VERDICT_GLYPH[r.verdict]}</span>
        <span>{d.analysis[`verdict_${r.verdict}`]}</span>
        {r.protocol && !isForeignProtocol(r.protocol) ? <ProtocolBadge id={r.protocol} /> : null}
      </div>

      <div>
        <div className="text-base font-bold text-ink">{title}</div>
        <p className="mt-1 text-sm text-muted">{reason}</p>
      </div>

      {r.details.indirect && r.details.to ? (
        <p className="text-xs text-muted">
          {fmt(d.analysis.viaContract, { address: shorten(r.details.to), bridge: shorten(r.target?.address ?? '') })}
        </p>
      ) : null}

      {r.action ? (
        r.action.kind === 'open_url' ? (
          <a
            href={r.action.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2"
          >
            {actionLabel(d, r.action)}
          </a>
        ) : (
          <Button variant="primary" onClick={() => onAction(r.action!)}>
            {actionLabel(d, r.action)}
          </Button>
        )
      ) : null}

      <Disclosure title={d.analysis.raw} open={open} onToggle={() => setOpen(!open)}>
        <div className="rounded-xl bg-surface-2 px-3 py-1">
          {r.details.txHash ? (
            <Row label="tx" mono>
              {shorten(r.details.txHash)}
            </Row>
          ) : null}
          {r.details.to ? (
            <Row label="to" mono>
              <Address value={r.details.to} href={explorer ? explorer + r.details.to : undefined} short />
            </Row>
          ) : null}
          {r.details.selector ? <Row label="selector" mono>{r.details.selector}</Row> : null}
          {Object.entries(r.details.fields ?? {}).map(([k, v]) => (
            <Row key={k} label={k} mono>
              {shorten(v)}
            </Row>
          ))}
          {r.details.logEmitters?.length ? (
            <Row label="log emitters" mono>
              <ul>
                {r.details.logEmitters.map((a) => (
                  <li key={a}>
                    <Address value={a} href={explorer ? explorer + a : undefined} short />
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
        </div>
      </Disclosure>
    </div>
  )
}

function shorten(v: string): string {
  return v.length > 24 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v
}
