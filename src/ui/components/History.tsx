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
import { EyeIcon, EyeOffIcon } from './icons'

/**
 * Full-width list under the two columns: every transfer, whichever tab made it.
 *
 * Hiding and clearing are two different things. Hidden collapses the list to its heading and is
 * remembered across reloads; the entries are still there, and Show brings them back untouched.
 */
export function History({
  entries,
  hidden,
  onHidden,
  onClear,
  onTrack,
}: {
  entries: HistoryEntry[]
  hidden: boolean
  onHidden: (v: boolean) => void
  onClear: () => void
  onTrack: (e: HistoryEntry) => void
}) {
  const d = useDict()
  const [filter, setFilter] = useState<HistoryFilter>('all')
  if (entries.length === 0) return null
  const shown = filterHistory(entries, filter)
  const filters: { value: HistoryFilter; label: string }[] = [
    { value: 'all', label: d.history.all },
    ...PROTOCOL_IDS.map((id) => ({ value: id as HistoryFilter, label: protocolBadge(d, id) })),
  ]

  return (
    <section>
      <div className="mb-2 flex items-center gap-3 text-sm text-muted">
        <span className="font-semibold text-ink">{d.history.title}</span>
        <span className="tnum rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-muted">{entries.length}</span>
        {hidden ? null : (
          <div className="flex items-center gap-1 rounded-xl bg-surface-2 p-1">
            {filters.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={`h-8 rounded-lg px-3 text-xs font-semibold transition ${filter === f.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="ml-auto inline-flex items-center gap-1.5 text-xs transition hover:text-ink" onClick={() => onHidden(!hidden)} aria-expanded={!hidden}>
          {hidden ? <EyeIcon className="h-4 w-4" /> : <EyeOffIcon className="h-4 w-4" />}
          {hidden ? d.history.show : d.history.hide}
        </button>
        {hidden ? null : (
          <button type="button" className="text-xs transition hover:text-ink" onClick={onClear}>
            {d.history.clear}
          </button>
        )}
      </div>
      {/* Collapsed, not unmounted: the rows are still here, just at zero height. */}
      <div className="collapse" data-hidden={hidden} aria-hidden={hidden}>
        <div>
          {shown.length === 0 ? (
            <p className="rounded-card border border-line bg-surface px-4 py-3 text-sm text-muted">{d.history.empty}</p>
          ) : (
            <ul className="divide-y divide-line rounded-card border border-line bg-surface">
              {shown.map((e) => (
                <HistoryRow key={e.txHash} entry={e} onTrack={onTrack} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

function HistoryRow({ entry: e, onTrack }: { entry: HistoryEntry; onTrack: (e: HistoryEntry) => void }) {
  const d = useDict()
  const src = byKey(e.srcChain)
  // LayerZero records an eid; the other protocols record the chain itself.
  const dst = e.dstChain ? byKey(e.dstChain) : byEid(e.dstEid)
  const protocol = entryProtocol(e)
  return (
    <li className="flex items-center gap-4 px-4 py-2.5 text-sm">
      <ProtocolBadge id={protocol} />
      <span className="flex items-center -space-x-1.5">
        <ChainIcon chain={src.key} size={22} className="rounded-full ring-2 ring-surface" />
        {dst ? <ChainIcon chain={dst.key} size={22} className="rounded-full ring-2 ring-surface" /> : null}
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
      <button type="button" onClick={() => onTrack(e)} className="shrink-0 rounded-full bg-surface-2 px-3 py-1 text-xs text-ink hover:bg-line">
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
  return <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-bold text-accent-ink">{protocolBadge(d, id)}</span>
}
