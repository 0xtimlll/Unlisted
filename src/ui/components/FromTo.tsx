'use client'
import type { Address as Addr } from 'viem'
import { formatAmount } from '@/core/amounts'
import { byEid, evmChains, type ChainDef, type ChainKey } from '@/core/chains'
import type { SendPlan } from '@/core/plan'
import type { OftInfo } from '@/core/types'
import { useDict } from '@/i18n'
import { Address } from './Address'
import { ChainIcon } from './ChainIcon'
import { AmountInput, Box, BoxLabel, Input, PillSelect } from './ui'

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

/** "Sell"-style box: source chain + amount. */
export function FromBox(p: {
  src: ChainDef
  onSrcChange: (k: ChainKey) => void
  info: OftInfo | undefined
  balance: bigint | undefined
  amountInput: string
  onAmount: (v: string) => void
  amountError: string
  dustTrimmed: bigint | undefined
}) {
  const d = useDict()
  const dec = p.info?.decimals ?? 18
  return (
    <Box>
      <BoxLabel
        right={
          p.info && p.balance !== undefined ? (
            <button type="button" className="tnum text-accent-ink hover:underline" onClick={() => p.onAmount(formatAmount(p.balance ?? 0n, dec))}>
              {d.step2.balance}: {formatAmount(p.balance, dec, { maxFraction: 6 })} {p.info.symbol} · {d.step2.max}
            </button>
          ) : null
        }
      >
        {d.ui.from}
      </BoxLabel>
      <div className="flex items-center gap-3">
        <AmountInput
          value={p.amountInput}
          onChange={(e) => p.onAmount(e.target.value)}
          placeholder="0"
          disabled={!p.info}
          aria-label={d.step2.amount}
          aria-invalid={!!p.amountError}
        />
        <PillSelect
          label={p.src.name}
          sub={p.info ? p.info.symbol : p.src.nativeSymbol}
          icon={<ChainIcon chain={p.src.key} />}
          value={p.src.key}
          onSelect={(v) => p.onSrcChange(v as ChainKey)}
          options={evmChains().map((c) => ({ value: c.key, label: c.name, sub: c.nativeSymbol, icon: <ChainIcon chain={c.key} size={28} /> }))}
          aria-label={d.header.sourceChain}
        />
      </div>
      <div className="mt-2 min-h-4 text-xs">
        {p.amountError ? (
          <span className="text-danger">{p.amountError}</span>
        ) : p.dustTrimmed && p.dustTrimmed > 0n ? (
          <span className="text-warn">
            {d.step2.dustTrimmed} <span className="mono">{formatAmount(p.dustTrimmed, dec)}</span> {p.info?.symbol}
          </span>
        ) : null}
      </div>
    </Box>
  )
}

/** "Buy"-style box: destination chain + minimum received + recipient. */
export function ToBox(p: {
  info: OftInfo
  wallet: Addr | undefined
  plan: SendPlan | undefined
  state: DestinationState
  onChange: (s: DestinationState) => void
  /** VM of the selected destination; undefined until one is chosen. */
  dstVm: 'evm' | 'svm' | undefined
  /** Validation message for the typed recipient (core/recipient.ts), or ''. */
  recipientError: string
  /** Error from Solana-side discovery, or ''. */
  svmError: string
}) {
  const d = useDict()
  const s = p.state
  const set = (patch: Partial<DestinationState>) => p.onChange({ ...s, ...patch })
  const routes = p.info.routes.filter((r) => byEid(r.eid))
  const dst = s.dstEid !== undefined ? byEid(s.dstEid) : undefined
  // On a Solana destination the field is always custom: there is no "use my wallet" (§4.3).
  const custom = p.dstVm === 'svm' || s.recipientCustom
  const typed = s.recipientInput.trim()
  const recipientValid = !custom || (typed !== '' && p.recipientError === '')
  const last6 = custom && recipientValid ? typed.slice(-6).toLowerCase() : ''
  const confirmed = !custom || (last6 !== '' && s.confirmLast6.trim().toLowerCase() === last6)

  return (
    <Box>
      <BoxLabel
        right={
          p.dstVm === 'svm' ? null : s.recipientCustom ? (
            <button type="button" className="text-accent-ink hover:underline" onClick={() => set({ recipientCustom: false, recipientInput: '', confirmLast6: '' })}>
              {d.ui.useWallet}
            </button>
          ) : (
            <span className="inline-flex items-center gap-2">
              {p.wallet ? <Address value={p.wallet} short /> : <span className="text-faint">—</span>}
              <button type="button" className="text-accent-ink hover:underline" onClick={() => set({ recipientCustom: true, recipientInput: '', confirmLast6: '' })}>
                {d.ui.edit}
              </button>
            </span>
          )
        }
      >
        {d.ui.to}
      </BoxLabel>
      <div className="flex items-center gap-3">
        <div className="tnum min-w-0 flex-1 truncate text-[32px] font-bold leading-none text-faint">
          {p.plan ? <span className="text-ink">{formatAmount(p.plan.amounts.minAmountLD, p.info.decimals, { maxFraction: 6 })}</span> : '0'}
        </div>
        <PillSelect
          label={dst?.name ?? d.step2.destination}
          sub={dst ? `eid ${dst.eid}` : ''}
          {...(dst ? { icon: <ChainIcon chain={dst.key} /> } : {})}
          value={s.dstEid !== undefined ? String(s.dstEid) : ''}
          onSelect={(v) => set({ dstEid: v ? Number(v) : undefined })}
          options={routes.map((r) => {
            const c = byEid(r.eid)!
            return { value: String(r.eid), label: c.name, sub: `eid ${r.eid}`, icon: <ChainIcon chain={c.key} size={28} /> }
          })}
          aria-label={d.step2.destination}
        />
      </div>
      <div className="mt-2 text-xs text-muted">{d.step3.receiveMin}</div>
      {p.svmError ? (
        <div className="mt-2 text-xs text-danger">{p.svmError}</div>
      ) : null}

      {custom ? (
        <div className="mt-3 space-y-2 rounded-xl bg-surface-2 p-3">
          <div className="text-xs text-muted">{p.dstVm === 'svm' ? d.step2.recipient : d.step2.otherAddress}</div>
          <Input
            value={s.recipientInput}
            onChange={(e) => set({ recipientInput: e.target.value, confirmLast6: '' })}
            placeholder={p.dstVm === 'svm' ? d.step3.svmRecipientPlaceholder : '0x…'}
            className="mono"
            aria-label={d.step2.recipient}
            aria-invalid={!recipientValid && typed !== ''}
          />
          {p.recipientError && typed !== '' ? <div className="text-xs text-danger">{p.recipientError}</div> : null}
          {p.dstVm === 'svm' ? <div className="text-xs text-muted">{d.step3.svmRecipientHint}</div> : null}
          {recipientValid && typed !== '' ? (
            <label className="block text-xs">
              <span className="text-muted">{d.step2.confirmLast6}</span> <span className="mono text-ink">…{last6}</span>
              <Input
                value={s.confirmLast6}
                onChange={(e) => set({ confirmLast6: e.target.value })}
                maxLength={6}
                className={`mono mt-1 max-w-36 ${confirmed ? 'border-ok' : ''}`}
                aria-invalid={!confirmed}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </Box>
  )
}
