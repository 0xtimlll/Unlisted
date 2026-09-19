'use client'
import { byEid, byKey } from '@/core/chains'
import { scanMessageUrl } from '@/core/track'
import { useDict } from '@/i18n'
import type { HistoryEntry } from '../storage'
import { ChainDot } from './ui'

export function History({ entries, onClear }: { entries: HistoryEntry[]; onClear: () => void }) {
  const d = useDict()
  if (entries.length === 0) return null
  return (
    <section className="px-1">
      <div className="mb-1 flex items-center justify-between text-sm text-muted">
        <span>{d.history.title}</span>
        <button type="button" className="text-xs hover:text-ink" onClick={onClear}>
          {d.history.clear}
        </button>
      </div>
      <ul className="divide-y divide-line rounded-card border border-line bg-surface">
        {entries.map((e) => {
          const src = byKey(e.srcChain)
          const dst = byEid(e.dstEid)
          return (
            <li key={e.txHash} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="flex items-center -space-x-1.5">
                <ChainDot name={src.name} size={20} />
                <ChainDot name={dst?.name ?? '?'} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">
                  {src.name} → {dst?.name ?? e.dstEid} <span className="mono text-muted">{e.oft.slice(0, 6)}…{e.oft.slice(-4)}</span>
                </span>
                <span className="block text-muted">{new Date(e.at).toLocaleString()}</span>
              </span>
              <a href={src.explorerTxUrl + e.txHash} target="_blank" rel="noopener noreferrer" className="mono text-accent-ink hover:underline">
                {e.txHash.slice(0, 8)}…
              </a>
              <a href={scanMessageUrl(e.txHash)} target="_blank" rel="noopener noreferrer" className="text-accent-ink hover:underline">
                lzscan ↗
              </a>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
