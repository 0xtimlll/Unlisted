'use client'
import { useState } from 'react'
import { isAddress } from 'viem'
import { byEid, type ChainDef } from '@/core/chains'
import { formatAmount } from '@/core/amounts'
import { isTxHash } from '@/core/decodeTx'
import { peerToAddress } from '@/core/encoding'
import type { OptionItem } from '@/core/options'
import type { SvmSourceInfo } from '@/core/svm/source'
import type { OftInfo, SourceInfo, SuspiciousFlag } from '@/core/types'
import { fmt, useDict } from '@/i18n'
import { Address } from './Address'
import { ChainIcon } from './ChainIcon'
import { Alert, Box, BoxLabel, Button, ChainDot, Disclosure, Row, Spinner, Tabs } from './ui'

export type TokenMode = 'address' | 'tx'

/** Shape check only; the chain decides whether it is an OFT (base58 32-byte keys are 32–44 chars). */
const looksLikePubkey = (v: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)

export function TokenStep(p: {
  chain: ChainDef
  mode: TokenMode
  onMode: (m: TokenMode) => void
  /** An EVM 0x address, or an OFT Store (base58) when the source is Solana. */
  onProbe: (address: string) => void
  onDecode: (hash: `0x${string}`) => void
  busy: boolean
  recent: string[]
  info: SourceInfo | undefined
  flags: SuspiciousFlag[]
  error: string
  decodedHint: boolean
  droppedOptions: OptionItem[]
  optionsMalformed: boolean
}) {
  const d = useDict()
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const v = value.trim()
  const svm = p.chain.vm === 'svm'
  const ok = p.mode === 'address' ? (svm ? looksLikePubkey(v) : isAddress(v, { strict: false })) : isTxHash(v)
  const go = () => {
    if (!ok) return
    if (p.mode === 'address') p.onProbe(v)
    else p.onDecode(v as `0x${string}`)
  }

  return (
    <Box>
      <BoxLabel
        right={
          // Decoding a sample transaction on Solana arrives with the last stage; until then the tab is hidden.
          svm ? null : (
            <Tabs
              value={p.mode}
              onChange={(m) => {
                p.onMode(m)
                setValue('')
              }}
              items={[
                { value: 'address', label: d.ui.contractTab },
                { value: 'tx', label: d.ui.txTab },
              ]}
            />
          )
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
          placeholder={p.mode === 'address' ? (svm ? d.step1.placeholderStore : d.step1.placeholderAddress) : d.step1.placeholderTx}
          spellCheck={false}
          autoComplete="off"
          className="mono min-w-0 flex-1 bg-transparent pr-2 text-sm text-ink outline-none placeholder:text-faint"
          aria-label={p.mode === 'address' ? (svm ? d.step1.byStore : d.step1.byAddress) : d.step1.byTx}
        />
        <Button variant="primary" className="h-9 rounded-full px-4" disabled={!ok || p.busy} onClick={go}>
          {p.busy ? <Spinner /> : p.mode === 'address' ? d.step1.probe : d.step1.decode}
        </Button>
      </div>

      {svm && !p.info ? <p className="mt-2 text-xs text-muted">{d.step1.storeHint}</p> : null}
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
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">{p.info.kind}</span>
                {p.info.approvalRequired ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-semibold text-warn">approve</span> : null}
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
          <div className="mt-2">
            <Disclosure title={d.ui.details} open={open} onToggle={() => setOpen(!open)}>
              {p.info.vm === 'evm' ? <OftDetails chain={p.chain} info={p.info} /> : <SvmOftDetails chain={p.chain} info={p.info} />}
            </Disclosure>
          </div>
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

function Routes({ info }: { info: SourceInfo }) {
  const d = useDict()
  const known = info.routes.filter((r) => byEid(r.eid))
  return (
    <Row label={d.card.routes}>
      {known.length === 0 ? (
        <span className="text-danger">{d.card.noRoutes}</span>
      ) : (
        <ul className="space-y-0.5">
          {known.map((r) => {
            const c = byEid(r.eid)!
            const addr = peerToAddress(r.peer)
            return (
              <li key={r.eid} className="flex items-center justify-end gap-2 whitespace-nowrap">
                <ChainIcon chain={c.key} size={16} />
                <span>{c.name}</span>
                <span className="text-xs text-muted">eid {r.eid}</span>
                <span className="shrink-0 text-xs">
                  {addr ? <Address value={addr} href={c.explorerAddrUrl + addr} short /> : <span className="mono">{r.peer.slice(0, 10)}…{r.peer.slice(-6)}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Row>
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
