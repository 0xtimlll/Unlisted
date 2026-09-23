'use client'
import { useState } from 'react'
import { isAddress } from 'viem'
import { byEid, type ChainDef } from '@/core/chains'
import { formatAmount } from '@/core/amounts'
import { isTxHash } from '@/core/decodeTx'
import { isSolanaSignature, looksLikePubkey } from '@/core/svm/ids'
import { peerToAddress } from '@/core/encoding'
import type { OptionItem } from '@/core/options'
import type { SvmSourceInfo } from '@/core/svm/source'
import type { OftInfo, SourceInfo, SuspiciousFlag } from '@/core/types'
import { fmt, useDict } from '@/i18n'
import { Address } from './Address'
import { ChainIcon } from './ChainIcon'
import { Alert, Box, BoxLabel, Button, ChainDot, Row, Spinner, Tabs } from './ui'

export type TokenMode = 'address' | 'tx'

export function TokenStep(p: {
  chain: ChainDef
  mode: TokenMode
  onMode: (m: TokenMode) => void
  /** An EVM 0x address, or an OFT Store (base58) when the source is Solana. */
  onProbe: (address: string) => void
  /** An EVM tx hash, or a Solana signature (base58) when the source is Solana. */
  onDecode: (hash: string) => void
  busy: boolean
  recent: string[]
  info: SourceInfo | undefined
  flags: SuspiciousFlag[]
  error: string
  decodedHint: boolean
  /** The sample transaction failed on-chain (Solana reports this; its parameters are still a hint). */
  decodedFailed?: boolean
  droppedOptions: OptionItem[]
  optionsMalformed: boolean
}) {
  const d = useDict()
  const [value, setValue] = useState('')
  const v = value.trim()
  const svm = p.chain.vm === 'svm'
  const ok = p.mode === 'address' ? (svm ? looksLikePubkey(v) : isAddress(v, { strict: false })) : svm ? isSolanaSignature(v) : isTxHash(v)
  const go = () => {
    if (!ok) return
    if (p.mode === 'address') p.onProbe(v)
    else p.onDecode(v)
  }

  return (
    <Box>
      <BoxLabel
        right={
          <Tabs
            value={p.mode}
            onChange={(m) => {
              p.onMode(m)
              setValue('')
            }}
            items={[
              { value: 'address', label: svm ? d.ui.storeTab : d.ui.contractTab },
              { value: 'tx', label: svm ? d.ui.sigTab : d.ui.txTab },
            ]}
          />
        }
      >
        {d.ui.token}
      </BoxLabel>
      <div className="flex h-[50px] items-center rounded-full bg-surface-2 pl-4 pr-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
          placeholder={p.mode === 'address' ? (svm ? d.step1.placeholderStore : d.step1.placeholderAddress) : svm ? d.step1.placeholderSig : d.step1.placeholderTx}
          spellCheck={false}
          autoComplete="off"
          className="mono min-w-0 flex-1 bg-transparent pr-2 text-sm text-ink outline-none placeholder:text-faint"
          aria-label={p.mode === 'address' ? (svm ? d.step1.byStore : d.step1.byAddress) : svm ? d.step1.bySig : d.step1.byTx}
        />
        <Button variant="primary" className="h-9 rounded-full px-4" disabled={!ok || p.busy} onClick={go}>
          {p.busy ? <Spinner /> : p.mode === 'address' ? d.step1.probe : d.step1.decode}
        </Button>
      </div>

      {svm && !p.info && p.mode === 'address' ? <p className="mt-2 text-xs text-muted">{d.step1.storeHint}</p> : null}
      {p.recent.length > 0 && !p.info ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">{d.step1.recent}:</span>
          {p.recent.map((a) => (
            <button
              key={a}
              type="button"
              className="mono rounded-full bg-surface-2 px-2 py-0.5 text-ink hover:bg-line"
              onClick={() => {
                setValue(a)
                p.onMode('address')
                p.onProbe(a)
              }}
            >
              {a.slice(0, 6)}…{a.slice(-4)}
            </button>
          ))}
        </div>
      ) : null}

      {p.error ? (
        <div className="mt-3">
          <Alert kind="error">{p.error}</Alert>
        </div>
      ) : null}
      {p.decodedHint ? (
        <div className="mt-3">
          <Alert kind="info">{d.step1.decodedHint}</Alert>
        </div>
      ) : null}
      {p.decodedFailed ? (
        <div className="mt-2">
          <Alert kind="warn">{d.step1.decodedFailedHint}</Alert>
        </div>
      ) : null}
      {p.optionsMalformed ? (
        <div className="mt-2">
          <Alert kind="warn">{d.step3.optionsMalformed}</Alert>
        </div>
      ) : null}
      {p.droppedOptions.length > 0 ? (
        <div className="mt-2">
          <Alert kind="error">
            <div className="font-semibold">{d.step3.droppedOptions}</div>
            <ul className="list-disc pl-5">
              {p.droppedOptions.map((o, i) => (
                <li key={i} className="mono text-xs">
                  {describeOption(o, d)}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      {p.info ? (
        <div className="mt-3">
          <div className="flex items-center gap-3">
            <ChainDot name={p.info.symbol || p.info.name || 'T'} size={36} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-ink">{p.info.symbol || '—'}</span>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-ink">{p.info.kind}</span>
                {p.info.approvalRequired ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs font-semibold text-warn">approve</span> : null}
              </div>
              <div className="truncate text-xs text-muted">
                {p.info.name} · {p.info.decimals}/{p.info.sharedDecimals} · {d.ui.onChain}
              </div>
            </div>
          </div>
          {p.info.kind === 'OFTAdapter' ? <p className="mt-2 text-xs text-muted">{d.card.adapterReminder}</p> : null}
          {p.flags.length > 0 ? (
            <div className="mt-2">
              <Alert kind="warn">
                {p.flags.map((f) => (
                  <div key={f}>⚠ {d.card[`flag_${f}`]}</div>
                ))}
              </Alert>
            </div>
          ) : null}
        </div>
      ) : null}
    </Box>
  )
}

function describeOption(o: OptionItem, d: ReturnType<typeof useDict>): string {
  switch (o.kind) {
    case 'nativeDrop':
      return fmt(d.step3.opt_nativeDrop, { amount: o.amount.toString(), receiver: `0x${o.receiver.slice(-40)}` })
    case 'lzCompose':
      return d.step3.opt_lzCompose
    case 'lzReceive':
      return d.step3.opt_lzReceiveValue
    case 'dvn':
      return d.step3.opt_dvn
    default:
      return d.step3.opt_unknown
  }
}

/** Everything read from the contract, for the right-hand panel: facts first, then the peers. */
export function ContractFacts({ chain, info }: { chain: ChainDef; info: SourceInfo }) {
  return info.vm === 'evm' ? <OftDetails chain={chain} info={info} /> : <SvmOftDetails chain={chain} info={info} />
}

/** Peers per chain: a block of its own (label above, one line per chain) so long addresses never fight the label. */
function Routes({ info }: { info: SourceInfo }) {
  const d = useDict()
  const known = info.routes.filter((r) => byEid(r.eid))
  return (
    <div className="py-1.5 text-sm">
      <div className="text-muted">{d.card.routes}</div>
      {known.length === 0 ? (
        <div className="text-danger">{d.card.noRoutes}</div>
      ) : (
        <ul className="mt-1 space-y-1">
          {known.map((r) => {
            const c = byEid(r.eid)!
            const addr = peerToAddress(r.peer)
            return (
              <li key={r.eid} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 shrink-0 items-center gap-2">
                  <ChainIcon chain={c.key} size={16} />
                  <span>{c.name}</span>
                  <span className="text-xs text-muted">eid {r.eid}</span>
                </span>
                <span className="min-w-0 text-right text-xs">
                  {addr ? <Address value={addr} href={c.explorerAddrUrl + addr} short /> : <span className="mono">{r.peer.slice(0, 10)}…{r.peer.slice(-6)}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function SvmOftDetails({ chain, info }: { chain: ChainDef; info: SvmSourceInfo }) {
  const d = useDict()
  const link = (a: string) => chain.explorerAddrUrl + a
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-1">
      <Row label={d.card.approve}>{d.card.no}</Row>
      <Row label={d.card.store} mono>
        <Address value={info.oftStore} href={link(info.oftStore)} short />
      </Row>
      <Row label={d.card.program} mono>
        <Address value={info.programId} href={link(info.programId)} short />
      </Row>
      <Row label={d.card.mint} mono>
        <Address value={info.tokenMint} href={link(info.tokenMint)} short />
      </Row>
      <Row label={d.card.escrow} mono>
        <Address value={info.tokenEscrow} href={link(info.tokenEscrow)} short />
      </Row>
      <Row label={d.card.tokenProgram}>{info.tokenProgram === 'token' ? 'Token' : 'Token-2022'}</Row>
      {info.kind === 'OFTAdapter' ? (
        <Row label={d.card.tvl}>
          <span className="tnum">
            {formatAmount(info.tvlLd, info.decimals, { maxFraction: 4 })} {info.symbol}
          </span>
        </Row>
      ) : null}
      <Row label={d.card.endpoint} mono>
        <Address value={info.endpointProgram} href={link(info.endpointProgram)} short />
      </Row>
      <Routes info={info} />
    </div>
  )
}

function OftDetails({ chain, info }: { chain: ChainDef; info: OftInfo }) {
  const d = useDict()
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-1">
      <Row label={d.card.approve}>{info.approvalRequired ? d.card.yes : d.card.no}</Row>
      <Row label={d.card.oft} mono>
        <Address value={info.oft} href={chain.explorerAddrUrl + info.oft} short />
      </Row>
      {info.kind === 'OFTAdapter' ? (
        <Row label={d.card.token} mono>
          <Address value={info.token} href={chain.explorerAddrUrl + info.token} short />
        </Row>
      ) : null}
      {info.lockedInAdapter !== undefined ? (
        <Row label={d.card.locked}>
          <span className="tnum">
            {formatAmount(info.lockedInAdapter, info.decimals, { maxFraction: 4 })} {info.symbol}
          </span>
        </Row>
      ) : null}
      <Row label={d.card.endpoint} mono>
        <Address value={info.endpoint} href={chain.explorerAddrUrl + info.endpoint} short />
      </Row>
      {info.owner ? (
        <Row label={d.card.owner} mono>
          <Address value={info.owner} href={chain.explorerAddrUrl + info.owner} short />
        </Row>
      ) : null}
      <Routes info={info} />
    </div>
  )
}
