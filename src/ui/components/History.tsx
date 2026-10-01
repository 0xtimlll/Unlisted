'use client'
import { useState } from 'react'
import { byEid, byKey } from '@/core/chains'
import { PROTOCOL_IDS, type ProtocolId } from '@/core/protocols'
import { scanMessageUrl } from '@/core/track'
import { ccipTxUrl } from '@/protocols/ccip/track'
import { wormholescanTxUrl } from '@/protocols/wormhole-ntt/track'
import { protocolBadge, useDict } from '@/i18n'
import { entryProtocol, filterHistory, type HistoryEntry, type HistoryFilter } from '../storage'
import { ChainIcon } from './ChainIcon'
import { Shell, Tabs } from './ui'

/** Full-width list under the two columns: every transfer, whichever tab made it. */
export function History({ entries, onClear, onTrack }: { entries: HistoryEntry[]; onClear: () => void; onTrack: (e: HistoryEntry) => void }) {
  const d = useDict()
  const [filter, setFilter] = useState<HistoryFilter>('all')
  if (entries.length === 0) return null
  const shown = filterHistory(entries, filter)
  const filters: { value: HistoryFilter; label: string }[] = [
    { value: 'all', label: d.history.all },
    ...PROTOCOL_IDS.map((id) => ({ value: id as HistoryFilter, label: protocolBadge(d, id) })),
  ]

  return (
    <Shell>
      <div className="flex items-center gap-3 px-1 text-sm text-muted">
        <span className="text-xs font-semibold text-muted">{d.history.title}</span>
        <Tabs value={filter} onChange={setFilter} items={filters} />
        <button type="button" className="ml-auto rounded-full px-3 py-1 text-xs text-muted transition hover:bg-surface-2 hover:text-ink" onClick={onClear}>
          {d.history.clear}
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-card bg-surface-2 px-4 py-3 text-sm text-muted">{d.history.empty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-card bg-surface-2 px-4">
          {shown.map((e) => (
            <HistoryRow key={e.txHash} entry={e} onTrack={onTrack} />
          ))}
        </ul>
      )}
    </Shell>
  )
}

function HistoryRow({ entry: e, onTrack }: { entry: HistoryEntry; onTrack: (e: HistoryEntry) => void }) {
  const d = useDict()
  const src = byKey(e.srcChain)
  // LayerZero records an eid; the other protocols record the chain itself.
  const dst = e.dstChain ? byKey(e.dstChain) : byEid(e.dstEid)
  const protocol = entryProtocol(e)
  return (
    <li className="flex items-center gap-4 py-3 text-sm">
      <ProtocolBadge id={protocol} />
      <span className="flex items-center -space-x-1.5">
        <ChainIcon chain={src.key} size={24} className="ring-2 ring-surface-2" />
        {dst ? <ChainIcon chain={dst.key} size={24} className="ring-2 ring-surface-2" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink">
          {src.name} → {dst?.name ?? e.dstEid} <span className="mono text-muted">{e.oft.slice(0, 6)}…{e.oft.slice(-4)}</span>
        </span>
        <span className="block text-xs text-muted">
          {new Date(e.at).toLocaleString()}
          {e.status === 'delivered' ? <span className="ml-2 text-ok">✓ {d.tracker.delivered}</span> : e.status === 'failed' ? <span className="ml-2 text-danger">{d.tracker.failed}</span> : null}
        </span>
      </span>
      <button type="button" onClick={() => onTrack(e)} className="h-7 shrink-0 rounded-full bg-surface px-3 text-xs font-semibold text-ink transition hover:scale-105">
        {d.ui.track}
      </button>
      <a href={src.explorerTxUrl + e.txHash} target="_blank" rel="noopener noreferrer" className="mono shrink-0 text-xs text-accent-ink hover:underline">
        {e.txHash.slice(0, 8)}…
      </a>
      {/* Each protocol has its own explorer for the message, not just the transaction. */}
      {protocol === 'lz-oft' ? (
        <a href={scanMessageUrl(e.txHash)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-accent-ink hover:underline">
          lzscan ↗
        </a>
      ) : protocol === 'wormhole-ntt' && /^0x[0-9a-fA-F]{64}$/.test(e.txHash) ? (
        <a href={wormholescanTxUrl(e.txHash)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-accent-ink hover:underline">
          wormholescan ↗
        </a>
      ) : protocol === 'ccip' && /^0x[0-9a-fA-F]{64}$/.test(e.txHash) ? (
        <a href={ccipTxUrl(e.txHash)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-xs text-accent-ink hover:underline">
          ccip explorer ↗
        </a>
      ) : null}
    </li>
  )
}

export function ProtocolBadge({ id }: { id: ProtocolId }) {
  const d = useDict()
  return <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-ink">{protocolBadge(d, id)}</span>
}
