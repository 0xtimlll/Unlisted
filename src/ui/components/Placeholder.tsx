'use client'
/** A tab whose bridge is not implemented yet. It never offers a form — nothing can be signed here. */
import type { ProtocolId } from '@/core/protocols'
import { fmt, protocolName, useDict } from '@/i18n'
import { TwoColumn, Panel } from './Layout'
import { Alert, Box } from './ui'

export function ComingSoon({ protocol }: { protocol: ProtocolId }) {
  const d = useDict()
  const name = protocolName(d, protocol)
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
          <p className="text-sm text-muted">{d.ui.previewEmpty}</p>
        </Panel>
      }
    />
  )
}
