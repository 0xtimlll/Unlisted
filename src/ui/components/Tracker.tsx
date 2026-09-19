'use client'
import type { Hash } from 'viem'
import { useWaitForTransactionReceipt } from 'wagmi'
import { byEid, type ChainDef } from '@/core/chains'
import { scanMessageUrl } from '@/core/track'
import { fmt, useDict } from '@/i18n'
import { useTrack } from '../hooks'
import { ChainIcon } from './ChainIcon'
import { Alert, Box, BoxLabel, Button, Spinner } from './ui'

export function Tracker(p: { src: ChainDef; dstEid: number; txHash: Hash; startedAt: number; onNew: () => void }) {
  const d = useDict()
  const dst = byEid(p.dstEid)
  const receipt = useWaitForTransactionReceipt({ hash: p.txHash, chainId: p.src.chainId })
  const track = useTrack(receipt.isSuccess ? p.txHash : undefined, p.startedAt)
  const s = track.data
  const phase = s?.phase ?? 'no_data'
  const minutes = Math.max(1, Math.round((p.src.srcConfirmationsHint * 12) / 60))

  const steps: { label: React.ReactNode; state: 'done' | 'active' | 'todo' | 'failed' }[] = [
    { label: <span className="inline-flex items-center gap-1"><ChainIcon chain={p.src.key} size={14} />{p.src.name}</span>, state: receipt.isSuccess ? 'done' : 'active' },
    { label: 'LayerZero', state: !receipt.isSuccess ? 'todo' : phase === 'delivered' ? 'done' : phase === 'failed' ? 'failed' : 'active' },
    { label: dst ? <span className="inline-flex items-center gap-1"><ChainIcon chain={dst.key} size={14} />{dst.name}</span> : String(p.dstEid), state: phase === 'delivered' ? 'done' : 'todo' },
  ]

  return (
    <Box>
      <BoxLabel>{d.tracker.title}</BoxLabel>
      <ol className="my-2 flex items-center gap-2">
        {steps.map((st, i) => (
          <li key={i} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                st.state === 'done' ? 'bg-ok text-white' : st.state === 'failed' ? 'bg-danger text-white' : st.state === 'active' ? 'bg-accent text-white' : 'bg-surface-2 text-muted'
              }`}
            >
              {st.state === 'done' ? '✓' : st.state === 'failed' ? '!' : st.state === 'active' ? <Spinner /> : i + 1}
            </span>
            <span className="truncate text-xs text-ink">{st.label}</span>
            {i < steps.length - 1 ? <span className="h-px flex-1 bg-line" /> : null}
          </li>
        ))}
      </ol>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">{d.tracker.status}</span>
          <span className="text-right">
            {!receipt.isSuccess ? d.tracker.waitingReceipt : d.tracker[phase]}
            {s?.raw ? <span className="mono ml-2 text-[11px] text-muted">{s.raw}</span> : null}
          </span>
        </div>
        {s?.message ? <div className="text-right text-xs text-muted">{s.message}</div> : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">{d.tracker.sourceTx}</span>
          <a href={p.src.explorerTxUrl + p.txHash} target="_blank" rel="noopener noreferrer" className="mono text-accent-ink hover:underline">
            {p.txHash.slice(0, 10)}…{p.txHash.slice(-6)}
          </a>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">{d.tracker.lzscan}</span>
          <a href={scanMessageUrl(p.txHash)} target="_blank" rel="noopener noreferrer" className="text-accent-ink hover:underline">
            layerzeroscan.com ↗
          </a>
        </div>
        {s?.dstTxHash && dst ? (
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-muted">
              <ChainIcon chain={dst.key} size={16} /> {d.tracker.destTx}
            </span>
            <a href={dst.explorerTxUrl + s.dstTxHash} target="_blank" rel="noopener noreferrer" className="mono text-accent-ink hover:underline">
              {s.dstTxHash.slice(0, 10)}…{s.dstTxHash.slice(-6)}
            </a>
          </div>
        ) : null}
      </div>
      <div className="mt-2 text-xs text-muted">{fmt(d.tracker.eta, { chain: p.src.name, minutes, confs: p.src.srcConfirmationsHint })}</div>
      {phase === 'delivered' ? (
        <div className="mt-3">
          <Alert kind="ok">{d.tracker.delivered}</Alert>
        </div>
      ) : null}
      {phase === 'failed' ? (
        <div className="mt-3">
          <Alert kind="error">{d.tracker.failed}</Alert>
        </div>
      ) : null}
      <div className="mt-4">
        <Button variant="cta" onClick={p.onNew}>
          {d.tracker.newTransfer}
        </Button>
      </div>
    </Box>
  )
}
