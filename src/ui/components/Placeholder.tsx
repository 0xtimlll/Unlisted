'use client'
/** A tab whose bridge is not implemented yet. It never offers a form — nothing can be signed here. */
import { byKey } from '@/core/chains'
import type { AnalysisTarget } from '@/core/analysis/result'
import type { ProtocolId } from '@/core/protocols'
import { fmt, protocolName, useDict } from '@/i18n'
import { Address } from './Address'
import { Panel, TwoColumn } from './Layout'
import { Alert, Box, Row } from './ui'

export function ComingSoon({ protocol, handoff }: { protocol: ProtocolId; handoff?: AnalysisTarget | null }) {
  const d = useDict()
  const name = protocolName(d, protocol)
  const carried = handoff && handoff.kind !== 'oft' && handoff.kind !== 'oft-store' && handoff.kind !== 'lz-oapp' ? handoff : undefined
  return (
    <TwoColumn
      left={
        <Box>
          <h1 className="text-lg font-bold text-ink">{name}</h1>
          <p className="mt-2 text-sm text-muted">{fmt(d.tabs.comingSoon, { protocol: name })}</p>
          <div className="mt-4">
            <Alert kind="info">{d.tabs.comingSoonHint}</Alert>
          </div>
        </Box>
      }
      right={
        <Panel title={d.ui.preview}>
          {carried ? (
            <>
              {/* What the analysis already found, kept so nothing has to be pasted twice. */}
              <p className="mb-2 text-sm text-muted">{d.tabs.carriedOver}</p>
              <div className="rounded-xl bg-surface-2 px-3 py-1">
                <Row label={d.step3.contract} mono>
                  <Address value={carried.address} href={byKey(carried.chain).explorerAddrUrl + carried.address} short />
                </Row>
                <Row label={d.step3.destination}>{carried.dstChain ? byKey(carried.dstChain).name : '—'}</Row>
                <Row label={d.ui.from}>{byKey(carried.chain).name}</Row>
                {carried.token ? (
                  <Row label={d.card.token} mono>
                    <Address value={carried.token} href={byKey(carried.chain).explorerAddrUrl + carried.token} short />
                  </Row>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">{d.ui.previewEmpty}</p>
          )}
        </Panel>
      }
    />
  )
}
