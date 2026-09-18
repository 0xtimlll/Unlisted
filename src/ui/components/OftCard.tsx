'use client'
import { byEid, type ChainDef } from '@/core/chains'
import type { OftInfo, SuspiciousFlag } from '@/core/types'
import { useDict } from '@/i18n'
import { Address } from './Address'
import { Alert, Row } from './ui'

export function OftCard({ chain, info, flags }: { chain: ChainDef; info: OftInfo; flags: SuspiciousFlag[] }) {
  const d = useDict()
  const known = info.routes.filter((r) => byEid(r.eid))
  return (
    <div className="mt-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-lg font-bold">{info.symbol || '—'}</span>
        <span className="text-sm opacity-60">{info.name}</span>
        <span className="ml-auto rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">{info.kind}</span>
      </div>
      <Row label={d.card.decimals}>
        {info.decimals} · {d.card.shared}: {info.sharedDecimals}
      </Row>
      <Row label={d.card.approve}>
        <span className={info.approvalRequired ? 'text-amber-700 dark:text-amber-300' : ''}>{info.approvalRequired ? d.card.yes : d.card.no}</span>
      </Row>
      <Row label={d.card.oft} mono>
        <Address value={info.oft} href={chain.explorerAddrUrl + info.oft} />
      </Row>
      {info.kind === 'OFTAdapter' ? (
        <Row label={d.card.token} mono>
          <Address value={info.token} href={chain.explorerAddrUrl + info.token} />
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
          <span className="text-red-600 dark:text-red-400">{d.card.noRoutes}</span>
        ) : (
          <ul className="space-y-0.5">
            {known.map((r) => {
              const c = byEid(r.eid)!
              return (
                <li key={r.eid} className="flex flex-wrap items-center gap-2">
                  <span>{c.name}</span>
                  <span className="text-xs opacity-60">eid {r.eid}</span>
                  <span className="text-xs">
                    <Address value={r.peer} href={c.explorerAddrUrl + r.peer} short />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Row>
      {flags.length > 0 ? (
        <div className="mt-2">
          <Alert kind="warn">
            <div className="font-semibold">{d.card.flags}</div>
            <ul className="list-disc pl-5">
              {flags.map((f) => (
                <li key={f}>{d.card[`flag_${f}`]}</li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}
    </div>
  )
}
