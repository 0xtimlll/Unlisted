'use client'
import { useState } from 'react'
import { isAddress, type Address as Addr } from 'viem'
import { formatAmount } from '@/core/amounts'
import { byEid } from '@/core/chains'
import type { OftInfo } from '@/core/types'
import { useDict } from '@/i18n'
import { Address } from './Address'
import { Button, Card, H2, Input, Select } from './ui'

export type DestinationState = {
  dstEid: number | undefined
  amountInput: string
  recipientCustom: boolean
  recipientInput: string
  confirmLast6: string
  slippageBps: number
  feeBufferBps: number
  extraOptions: `0x${string}`
}

export function DestinationStep(p: {
  info: OftInfo
  wallet: Addr | undefined
  balance: bigint | undefined
  state: DestinationState
  onChange: (s: DestinationState) => void
  amountError: string
  dustTrimmed: bigint | undefined
}) {
  const d = useDict()
  const s = p.state
  const [adv, setAdv] = useState(false)
  const routes = p.info.routes.filter((r) => byEid(r.eid))
  const set = (patch: Partial<DestinationState>) => p.onChange({ ...s, ...patch })

  const recipientValid = !s.recipientCustom || isAddress(s.recipientInput.trim(), { strict: false })
  const last6 = s.recipientCustom && recipientValid ? s.recipientInput.trim().slice(-6).toLowerCase() : ''
  const confirmed = !s.recipientCustom || (last6 !== '' && s.confirmLast6.trim().toLowerCase() === last6)

  return (
    <Card>
      <H2>{d.step2.title}</H2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="opacity-60">{d.step2.destination}</span>
          <Select value={s.dstEid ?? ''} onChange={(e) => set({ dstEid: e.target.value ? Number(e.target.value) : undefined })} className="mt-1 w-full">
            <option value="">—</option>
            {routes.map((r) => {
              const c = byEid(r.eid)!
              return (
                <option key={r.eid} value={r.eid}>
                  {c.name} (eid {r.eid})
                </option>
              )
            })}
          </Select>
        </label>
        <label className="block text-sm">
          <span className="opacity-60">
            {d.step2.amount}
            {p.balance !== undefined ? (
              <span className="ml-2 mono">
                {d.step2.balance}: {formatAmount(p.balance, p.info.decimals, { maxFraction: 8 })} {p.info.symbol}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex gap-2">
            <Input
              value={s.amountInput}
              onChange={(e) => set({ amountInput: e.target.value })}
              inputMode="decimal"
              placeholder="0.0"
              className="mono"
              aria-invalid={!!p.amountError}
            />
            <Button disabled={p.balance === undefined} onClick={() => set({ amountInput: formatAmount(p.balance ?? 0n, p.info.decimals) })}>
              {d.step2.max}
            </Button>
          </span>
          {p.amountError ? <span className="text-xs text-red-600 dark:text-red-400">{p.amountError}</span> : null}
          {p.dustTrimmed && p.dustTrimmed > 0n ? (
            <span className="block text-xs text-amber-700 dark:text-amber-300">
              {d.step2.dustTrimmed} <span className="mono">{formatAmount(p.dustTrimmed, p.info.decimals)}</span> {p.info.symbol}
            </span>
          ) : null}
        </label>
      </div>

      <div className="mt-3 text-sm">
        <div className="opacity-60">{d.step2.recipient}</div>
        {!s.recipientCustom ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {p.wallet ? <Address value={p.wallet} /> : <span className="opacity-60">—</span>}
            <span className="text-xs opacity-60">{d.step2.yourWallet}</span>
          </div>
        ) : (
          <div className="mt-1 space-y-2">
            <Input
              value={s.recipientInput}
              onChange={(e) => set({ recipientInput: e.target.value, confirmLast6: '' })}
              placeholder="0x…"
              className="mono"
              aria-invalid={!recipientValid}
            />
            {recipientValid && s.recipientInput.trim() !== '' ? (
              <label className="block text-xs">
                <span className="opacity-60">{d.step2.confirmLast6}</span>{' '}
                <span className="mono">…{last6}</span>
                <Input
                  value={s.confirmLast6}
                  onChange={(e) => set({ confirmLast6: e.target.value })}
                  maxLength={6}
                  className={`mono mt-1 max-w-40 ${confirmed ? 'border-emerald-500' : ''}`}
                  aria-invalid={!confirmed}
                />
              </label>
            ) : null}
          </div>
        )}
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input type="checkbox" checked={s.recipientCustom} onChange={(e) => set({ recipientCustom: e.target.checked, recipientInput: '', confirmLast6: '' })} />
          {d.step2.otherAddress}
        </label>
      </div>

      <div className="mt-3 text-xs">
        <button type="button" className="underline decoration-dotted opacity-70" onClick={() => setAdv(!adv)}>
          {d.step2.advanced} {adv ? '▴' : '▾'}
        </button>
        {adv ? (
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="opacity-60">{d.step2.slippage}</span>
              <Input type="number" min={0} max={10000} step={1} value={s.slippageBps} onChange={(e) => set({ slippageBps: clampInt(e.target.value, 0, 10000) })} className="mono" />
            </label>
            <label className="block">
              <span className="opacity-60">{d.step2.feeBuffer}</span>
              <Input type="number" min={0} max={500} step={1} value={s.feeBufferBps / 100} onChange={(e) => set({ feeBufferBps: clampInt(e.target.value, 0, 500) * 100 })} className="mono" />
            </label>
            {s.extraOptions !== '0x' ? (
              <div className="sm:col-span-2">
                <span className="opacity-60">{d.step2.extraOptions}</span>
                <div className="mono break-all">{s.extraOptions}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function clampInt(v: string, lo: number, hi: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}
