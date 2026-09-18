'use client'
import { byEid, byKey } from '@/core/chains'
import { scanMessageUrl } from '@/core/track'
import { useDict } from '@/i18n'
import type { HistoryEntry } from '../storage'
import { Button, Card, H2 } from './ui'

export function History({ entries, onClear }: { entries: HistoryEntry[]; onClear: () => void }) {
  const d = useDict()
  if (entries.length === 0) return null
  return (
    <Card>
      <div className="flex items-center">
        <H2>{d.history.title}</H2>
        <span className="flex-1" />
        <Button className="text-xs" onClick={onClear}>
          {d.history.clear}
        </Button>
      </div>
      <ul className="space-y-1 text-xs">
        {entries.map((e) => {
          const src = byKey(e.srcChain)
          const dst = byEid(e.dstEid)
          return (
            <li key={e.txHash} className="flex flex-wrap items-center gap-2">
              <span className="opacity-60">{new Date(e.at).toLocaleString()}</span>
              <span>
                {src.name} → {dst?.name ?? e.dstEid}
              </span>
              <span className="mono">{e.oft.slice(0, 8)}…{e.oft.slice(-4)}</span>
              <a href={src.explorerTxUrl + e.txHash} target="_blank" rel="noopener noreferrer" className="mono underline decoration-dotted">
                {e.txHash.slice(0, 10)}…
              </a>
              <a href={scanMessageUrl(e.txHash)} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">
                lzscan
              </a>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
