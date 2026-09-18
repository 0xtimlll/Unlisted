'use client'
import { useState } from 'react'
import { isAddress, type Address } from 'viem'
import type { ChainDef } from '@/core/chains'
import { isTxHash } from '@/core/decodeTx'
import { useDict } from '@/i18n'
import { Button, Card, H2, Input, Spinner } from './ui'

export type TokenMode = 'address' | 'tx'

export function TokenStep(p: {
  chain: ChainDef
  mode: TokenMode
  onMode: (m: TokenMode) => void
  onProbe: (address: Address) => void
  onDecode: (hash: `0x${string}`) => void
  busy: boolean
  recent: Address[]
}) {
  const d = useDict()
  const [addr, setAddr] = useState('')
  const [hash, setHash] = useState('')
  const addrOk = isAddress(addr.trim(), { strict: false })
  const hashOk = isTxHash(hash.trim())

  return (
    <Card>
      <H2>{d.step1.title}</H2>
      <div className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="mode" checked={p.mode === 'address'} onChange={() => p.onMode('address')} className="mt-1" />
          <span className="flex-1">
            <span className="block">{d.step1.byAddress}</span>
            <span className="mt-1 flex gap-2">
              <Input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                onFocus={() => p.onMode('address')}
                placeholder={d.step1.placeholderAddress}
                className="mono"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addrOk) p.onProbe(addr.trim() as Address)
                }}
              />
              <Button variant="primary" disabled={!addrOk || p.busy} onClick={() => p.onProbe(addr.trim() as Address)}>
                {p.busy && p.mode === 'address' ? <Spinner /> : d.step1.probe}
              </Button>
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="mode" checked={p.mode === 'tx'} onChange={() => p.onMode('tx')} className="mt-1" />
          <span className="flex-1">
            <span className="block">{d.step1.byTx}</span>
            <span className="mt-1 flex gap-2">
              <Input
                value={hash}
                onChange={(e) => setHash(e.target.value)}
                onFocus={() => p.onMode('tx')}
                placeholder={d.step1.placeholderTx}
                className="mono"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hashOk) p.onDecode(hash.trim() as `0x${string}`)
                }}
              />
              <Button variant="primary" disabled={!hashOk || p.busy} onClick={() => p.onDecode(hash.trim() as `0x${string}`)}>
                {p.busy && p.mode === 'tx' ? <Spinner /> : d.step1.decode}
              </Button>
            </span>
          </span>
        </label>
        {p.recent.length > 0 ? (
          <div className="text-xs">
            <span className="opacity-60">{d.step1.recent}: </span>
            {p.recent.map((a) => (
              <button
                key={a}
                type="button"
                className="mono mr-2 underline decoration-dotted"
                onClick={() => {
                  setAddr(a)
                  p.onMode('address')
                  p.onProbe(a)
                }}
              >
                {a.slice(0, 8)}…{a.slice(-6)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
