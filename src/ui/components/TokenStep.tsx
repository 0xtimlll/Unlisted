'use client'
import { useState } from 'react'
import { isAddress, type Address as Addr } from 'viem'
import { byEid, type ChainDef } from '@/core/chains'
import { isTxHash } from '@/core/decodeTx'
import type { OftInfo, SuspiciousFlag } from '@/core/types'
import { useDict } from '@/i18n'
import { Address } from './Address'
import { ChainIcon } from './ChainIcon'
import { Alert, Box, BoxLabel, Button, ChainDot, Disclosure, Row, Spinner, Tabs } from './ui'

export type TokenMode = 'address' | 'tx'

export function TokenStep(p: {
  chain: ChainDef
  mode: TokenMode
  onMode: (m: TokenMode) => void
  onProbe: (address: Addr) => void
  onDecode: (hash: `0x${string}`) => void
  busy: boolean
  recent: Addr[]
  info: OftInfo | undefined
  flags: SuspiciousFlag[]
  error: string
  decodedHint: boolean
}) {
  const d = useDict()
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const v = value.trim()
  const ok = p.mode === 'address' ? isAddress(v, { strict: false }) : isTxHash(v)
  const go = () => {
    if (!ok) return
    if (p.mode === 'address') p.onProbe(v as Addr)
    else p.onDecode(v as `0x${string}`)
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
              { value: 'address', label: d.ui.contractTab },
              { value: 'tx', label: d.ui.txTab },
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
          placeholder={p.mode === 'address' ? d.step1.placeholderAddress : d.step1.placeholderTx}
          spellCheck={false}
          autoComplete="off"
          className="mono min-w-0 flex-1 bg-transparent pr-2 text-sm text-ink outline-none placeholder:text-faint"
          aria-label={p.mode === 'address' ? d.step1.byAddress : d.step1.byTx}
        />
        <Button variant="primary" className="h-9 rounded-full px-4" disabled={!ok || p.busy} onClick={go}>
          {p.busy ? <Spinner /> : p.mode === 'address' ? d.step1.probe : d.step1.decode}
        </Button>
      </div>

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
              <OftDetails chain={p.chain} info={p.info} />
            </Disclosure>
          </div>
        </div>
      ) : null}
    </Box>
  )
}

function OftDetails({ chain, info }: { chain: ChainDef; info: OftInfo }) {
  const d = useDict()
  const known = info.routes.filter((r) => byEid(r.eid))
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
      <Row label={d.card.endpoint} mono>
        <Address value={info.endpoint} href={chain.explorerAddrUrl + info.endpoint} short />
      </Row>
      {info.owner ? (
        <Row label={d.card.owner} mono>
          <Address value={info.owner} href={chain.explorerAddrUrl + info.owner} short />
        </Row>
      ) : null}
      <Row label={d.card.routes}>
        {known.length === 0 ? (
          <span className="text-danger">{d.card.noRoutes}</span>
        ) : (
          <ul className="space-y-0.5">
            {known.map((r) => {
              const c = byEid(r.eid)!
              return (
                <li key={r.eid} className="flex items-center justify-end gap-2">
                  <ChainIcon chain={c.key} size={16} />
                  <span>{c.name}</span>
                  <span className="text-xs text-muted">eid {r.eid}</span>
                  <span className="text-xs">
                    <Address value={r.peer} href={c.explorerAddrUrl + r.peer} short />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Row>
    </div>
  )
}
