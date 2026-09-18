'use client'
import type { Hash } from 'viem'
import { useWaitForTransactionReceipt } from 'wagmi'
import { byEid, type ChainDef } from '@/core/chains'
import { scanMessageUrl } from '@/core/track'
import { fmt, useDict } from '@/i18n'
import { useTrack } from '../hooks'
import { Alert, Button, Card, H2, Row, Spinner } from './ui'

export function Tracker(p: { src: ChainDef; dstEid: number; txHash: Hash; startedAt: number; onNew: () => void }) {
  const d = useDict()
  const dst = byEid(p.dstEid)
  const receipt = useWaitForTransactionReceipt({ hash: p.txHash, chainId: p.src.chainId })
  const track = useTrack(receipt.isSuccess ? p.txHash : undefined, p.startedAt)
  const s = track.data
  const phase = s?.phase ?? 'no_data'
  // ~12s per confirmation is a rough, chain-agnostic hint; the registry only carries counts.
  const minutes = Math.max(1, Math.round((p.src.srcConfirmationsHint * 12) / 60))

  return (
    <Card>
      <H2>{d.tracker.title}</H2>
      <Row label={d.tracker.sourceTx} mono>
        <a href={p.src.explorerTxUrl + p.txHash} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">
          {p.txHash.slice(0, 10)}…{p.txHash.slice(-8)}
        </a>
      </Row>
      <Row label={d.tracker.lzscan} mono>
        <a href={scanMessageUrl(p.txHash)} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">
          layerzeroscan.com
        </a>
      </Row>
      <Row label={d.tracker.status}>
        {!receipt.isSuccess ? (
          <span>
            <Spinner /> {d.tracker.waitingReceipt}
          </span>
        ) : (
          <span>
            {phase === 'pending' || phase === 'no_data' ? <Spinner /> : null} {d.tracker[phase]}
            {s?.raw ? <span className="mono ml-2 text-xs opacity-60">{s.raw}</span> : null}
            {s?.message ? <span className="block text-xs opacity-60">{s.message}</span> : null}
          </span>
        )}
      </Row>
      {s?.dstTxHash && dst ? (
        <Row label={d.tracker.destTx} mono>
          <a href={dst.explorerTxUrl + s.dstTxHash} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">
            {s.dstTxHash.slice(0, 10)}…{s.dstTxHash.slice(-8)}
          </a>
        </Row>
      ) : null}
      <div className="mt-2 text-xs opacity-60">{fmt(d.tracker.eta, { chain: p.src.name, minutes, confs: p.src.srcConfirmationsHint })}</div>
      {phase === 'delivered' ? (
        <div className="mt-2">
          <Alert kind="ok">{d.tracker.delivered}</Alert>
        </div>
      ) : null}
      {phase === 'failed' ? (
        <div className="mt-2">
          <Alert kind="error">{d.tracker.failed}</Alert>
        </div>
      ) : null}
      <div className="mt-3">
        <Button onClick={p.onNew}>{d.tracker.newTransfer}</Button>
      </div>
    </Card>
  )
}
