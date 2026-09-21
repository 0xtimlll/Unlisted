'use client'
import { useEffect, useState } from 'react'
import type { Hash } from 'viem'
import { useWaitForTransactionReceipt } from 'wagmi'
import { byEid, type EvmChainDef } from '@/core/chains'
import { scanMessageUrl, type TrackPhase } from '@/core/track'
import { fmt, useDict } from '@/i18n'
import { useTrack } from '../hooks'
import { ChainIcon } from './ChainIcon'
import { Alert, Box, BoxLabel, Button, Spinner } from './ui'

function useElapsed(since: number): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function Tracker(p: {
  src: EvmChainDef
  dstEid: number
  txHash: Hash
  startedAt: number
  restored: boolean
  onFinal: (phase: 'delivered' | 'failed') => void
  onNew: () => void
}) {
  const d = useDict()
  const dst = byEid(p.dstEid)
  const receipt = useWaitForTransactionReceipt({ hash: p.txHash, chainId: p.src.chainId })
  const confirmed = receipt.isSuccess
  const track = useTrack(confirmed ? p.txHash : undefined, p.startedAt)
  const s = track.data
  const phase: TrackPhase = s?.phase ?? 'no_data'
  const final = phase === 'delivered' || phase === 'failed'
  const elapsed = useElapsed(p.startedAt)
  const minutes = Math.max(1, Math.round((p.src.srcConfirmationsHint * 12) / 60))

  useEffect(() => {
    if (phase === 'delivered' || phase === 'failed') p.onFinal(phase)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const steps: { label: React.ReactNode; state: 'done' | 'active' | 'todo' | 'failed' }[] = [
    {
      label: (
        <span className="inline-flex items-center gap-1">
          <ChainIcon chain={p.src.key} size={14} />
          {p.src.name}
        </span>
      ),
      state: confirmed ? 'done' : 'active',
    },
    { label: 'LayerZero', state: !confirmed ? 'todo' : phase === 'delivered' ? 'done' : phase === 'failed' ? 'failed' : 'active' },
    {
      label: dst ? (
        <span className="inline-flex items-center gap-1">
          <ChainIcon chain={dst.key} size={14} />
          {dst.name}
        </span>
      ) : (
        String(p.dstEid)
      ),
      state: phase === 'delivered' ? 'done' : 'todo',
    },
  ]

  const statusText = !confirmed
    ? d.tracker.waitingReceipt
    : phase === 'no_data' || phase === 'pending'
      ? fmt(d.tracker.confirmedWaitingScan, { chain: p.src.name })
      : d.tracker[phase]

  return (
    <Box>
      <BoxLabel right={!final ? <span className="mono text-xs">{fmt(d.tracker.elapsed, { mm: elapsed.slice(0, 2), ss: elapsed.slice(3) })}</span> : null}>{d.tracker.title}</BoxLabel>
      {p.restored ? (
        <div className="mb-2">
          <Alert kind="info">{d.tracker.restored}</Alert>
        </div>
      ) : null}
      <ol className="my-2 flex items-center gap-2">
        {steps.map((st, i) => (
          <li key={i} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                st.state === 'done' ? 'bg-ok text-white' : st.state === 'failed' ? 'bg-danger text-white' : st.state === 'active' ? 'bg-accent text-page' : 'bg-surface-2 text-muted'
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
        <div className="flex items-start justify-between gap-3">
          <span className="shrink-0 text-muted">{d.tracker.status}</span>
          <span className="text-right">
            {!final ? (
              <span className="mr-1.5 inline-block align-middle">
                <Spinner />
              </span>
            ) : null}
            {statusText}
            {s?.raw ? <span className="mono ml-2 text-[11px] text-muted">{s.raw}</span> : null}
          </span>
        </div>
        {s?.message ? <div className="text-right text-xs text-muted">{s.message}</div> : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">{d.tracker.sourceTx}</span>
          <a href={p.src.explorerTxUrl + p.txHash} target="_blank" rel="noopener noreferrer" className="mono text-accent-ink hover:underline">
            {p.txHash.slice(0, 10)}…{p.txHash.slice(-6)} ↗
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
              {s.dstTxHash.slice(0, 10)}…{s.dstTxHash.slice(-6)} ↗
            </a>
          </div>
        ) : null}
      </div>
      {!final ? <div className="mt-2 text-xs text-muted">{fmt(d.tracker.eta, { chain: p.src.name, minutes, confs: p.src.srcConfirmationsHint })}</div> : null}
      {phase === 'delivered' ? (
        <div className="mt-3">
          <Alert kind="ok">✓ {d.tracker.delivered}</Alert>
        </div>
      ) : null}
      {phase === 'failed' ? (
        <div className="mt-3">
          <Alert kind="error">{d.tracker.failed}</Alert>
        </div>
      ) : null}
      <div className="mt-4">
        <Button variant={final ? 'cta' : 'secondary'} className={final ? '' : 'w-full'} onClick={p.onNew}>
          {d.tracker.newTransfer}
        </Button>
      </div>
    </Box>
  )
}
