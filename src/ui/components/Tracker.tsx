'use client'
import { useEffect, useState } from 'react'
import type { Hash } from 'viem'
import { byEid, isEvm, type ChainDef } from '@/core/chains'
import { scanMessageUrl, type TrackPhase } from '@/core/track'
import { fmt, useDict } from '@/i18n'
import { useSourceReceipt, useTrack } from '../hooks'
import { useSvmSignatureStatus } from '../svmHooks'
import { ChainIcon } from './ChainIcon'
import { CheckIcon } from './icons'
import { Alert, Box, BoxLabel, Button, Spinner } from './ui'

function useElapsed(since: number, running: boolean): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function Tracker(p: {
  src: ChainDef
  dstEid: number
  /** 0x hash (EVM source) or base58 signature (Solana source). */
  txHash: string
  startedAt: number
  restored: boolean
  customRpc: string | undefined
  onFinal: (phase: 'delivered' | 'failed') => void
  onNew: () => void
}) {
  const d = useDict()
  const dst = byEid(p.dstEid)
  const evm = isEvm(p.src)
  // Source-chain confirmation: a receipt on EVM, a signature status on Solana. Scan is asked in
  // parallel from the start: it only ever indexes a mined transaction, so a Scan answer is a
  // confirmation in itself, and a receipt poll that lags behind can no longer hold the tracker.
  const track = useTrack(p.txHash, p.startedAt)
  const s = track.data
  // Once Scan has the final word there is nothing left for the source chain to add.
  const scanFinal = s?.phase === 'delivered' || s?.phase === 'failed'
  const receipt = useSourceReceipt(isEvm(p.src) ? p.src : undefined, evm ? (p.txHash as Hash) : undefined, scanFinal)
  const sig = useSvmSignatureStatus(evm ? undefined : p.txHash, p.customRpc)
  const scanSawIt = s !== undefined && s.phase !== 'no_data'
  const confirmed = scanSawIt || (evm ? receipt.data?.status === 'success' : sig.data === 'confirmed')
  const sourceFailed = evm ? receipt.data?.status === 'reverted' : sig.data === 'failed'
  const phase: TrackPhase = sourceFailed ? 'failed' : (s?.phase ?? 'no_data')
  const refresh = () => {
    void track.refetch()
    if (evm) void receipt.refetch()
    else void sig.refetch()
  }
  const final = phase === 'delivered' || phase === 'failed'
  const elapsed = useElapsed(p.startedAt, !final)
  // Confirmations are counted in blocks, so the block time has to come from the chain: 20 of them
  // is four minutes on Ethereum and two seconds on a chain that produces one every 100ms.
  const minutes = Math.max(1, Math.round((p.src.srcConfirmationsHint * (p.src.blockTimeSec ?? 12)) / 60))

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
      state: confirmed ? 'done' : sourceFailed ? 'failed' : 'active',
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

  const statusText = sourceFailed
    ? d.tracker.sourceFailed
    : !confirmed
    ? d.tracker.waitingReceipt
    : phase === 'no_data' || phase === 'pending'
      ? fmt(d.tracker.confirmedWaitingScan, { chain: p.src.name })
      : d.tracker[phase]

  return (
    <Box>
      <BoxLabel
        right={
          !final ? (
            <span className="inline-flex items-center gap-2">
              <span className="mono text-xs">{fmt(d.tracker.elapsed, { mm: elapsed.slice(0, 2), ss: elapsed.slice(3) })}</span>
              <button type="button" className="text-xs text-accent-ink hover:underline disabled:opacity-50" disabled={track.isFetching} onClick={refresh}>
                {track.isFetching ? d.tracker.refreshing : d.tracker.refresh}
              </button>
            </span>
          ) : null
        }
      >
        {d.tracker.title}
      </BoxLabel>
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
                st.state === 'done' ? 'bg-ok text-solid-ink' : st.state === 'failed' ? 'bg-danger text-solid-ink' : st.state === 'active' ? 'bg-accent text-page' : 'bg-surface-2 text-muted'
              }`}
            >
              {st.state === 'done' ? <CheckIcon className="h-4 w-4" /> : st.state === 'failed' ? <span className="text-sm">!</span> : st.state === 'active' ? <Spinner /> : i + 1}
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
            {s?.raw ? <span className="mono ml-2 text-xs text-muted">{s.raw}</span> : null}
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
          <Alert kind="ok">
            <span className="inline-flex items-center gap-2">
              <CheckIcon className="h-4 w-4" /> {d.tracker.delivered}
            </span>
          </Alert>
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
