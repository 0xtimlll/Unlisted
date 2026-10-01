'use client'
/**
 * The pieces of a send form that every tab shares: the From/To rows with the network picker
 * behind them and the reverse button between them, the amount panel with the balance, Max and the
 * recipient switch, and the recipient panel the switch opens. Each is markup around state the
 * tab owns — nothing here decides anything.
 */
import { useState, type ReactNode } from 'react'
import { formatAmount } from '@/core/amounts'
import type { ChainDef, ChainKey } from '@/core/chains'
import type { AddressFamily, BookVerdict } from '@/core/addressBook'
import { fmt, useDict } from '@/i18n'
import { Address } from './Address'
import { BookPicker, BookVerdictNote } from './RecipientBook'
import { ChainIcon } from './ChainIcon'
import { ArrowsLeftRightIcon, CaretRightIcon, WalletIcon } from './icons'
import { NetworkDialog } from './NetworkDialog'
import { AmountInput, Button, Input } from './ui'

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

export type ReverseControl = { enabled: boolean; title: string; onClick: () => void }

/**
 * The button between From and To. When the route can be reversed it swaps the two sides in one
 * click; otherwise it is the plain arrow it always was, with the reason as its title.
 */
export function ReverseArrow({ onClick, enabled, title }: ReverseControl) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      title={title}
      aria-label={title}
      className="absolute left-1/2 top-1/2 z-10 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 scale-[0.8] items-center justify-center rounded-xl bg-surface-2 text-muted ring-4 ring-surface transition enabled:hover:scale-90 enabled:hover:text-ink disabled:cursor-default outline-none focus-visible:ring-ink/40"
    >
      {enabled ? <ArrowsLeftRightIcon className="h-4 w-4" /> : <CaretRightIcon className="h-4 w-4" />}
    </button>
  )
}

/** One side of the route: the tile, "From"/"To" in small grey, the network's name. */
function Side({ label, chain, placeholder, reverse = false, onClick, disabled = false }: { label: string; chain: ChainDef | undefined; placeholder: string; reverse?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`relative flex h-20 w-full cursor-pointer select-none items-center gap-3 rounded-card bg-surface-2 p-4 text-left transition enabled:hover:scale-[1.02] disabled:cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${reverse ? 'origin-left flex-row-reverse text-right' : 'origin-right'}`}
    >
      {chain ? <ChainIcon chain={chain.key} size={48} /> : <span aria-hidden className="inline-block h-12 w-12 shrink-0 rounded-xl border-2 border-dashed border-line" />}
      <span className="-mb-1 flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-semibold leading-none text-muted">{label}</span>
        <span className={`truncate text-lg font-semibold leading-none ${chain ? 'text-ink' : 'text-muted'}`}>{chain?.name ?? placeholder}</span>
      </span>
    </button>
  )
}

/**
 * From and To side by side, the reverse button between them, the network picker behind each.
 * `toOptions` are the destinations the contract actually has a route to; the rest of the
 * registry is listed dimmed.
 */
export function FromToRow({
  from,
  fromOptions,
  onFrom,
  to,
  toOptions,
  onTo,
  toDisabled = false,
  reverse,
}: {
  from: ChainDef
  fromOptions: ChainKey[]
  onFrom: (k: ChainKey) => void
  to: ChainDef | undefined
  toOptions: ChainKey[]
  onTo: (k: ChainKey) => void
  /** Nothing to choose from yet (no contract analysed): the row is shown but not clickable. */
  toDisabled?: boolean
  reverse: ReverseControl
}) {
  const d = useDict()
  const [open, setOpen] = useState<'from' | 'to' | null>(null)
  const dimmed = fromOptions.filter((k) => k !== from.key && !toOptions.includes(k))
  const swap = { enabled: reverse.enabled, title: reverse.title, onClick: reverse.onClick }
  return (
    <div className="relative grid select-none grid-cols-2 gap-1 pt-0.5">
      <Side label={d.ui.from} chain={from} placeholder={d.header.sourceChain} onClick={() => setOpen('from')} />
      <ReverseArrow {...reverse} />
      <Side label={d.ui.to} chain={to} placeholder={d.network.select} reverse onClick={() => setOpen('to')} disabled={toDisabled} />
      {open === 'from' ? <NetworkDialog options={fromOptions} selected={from.key} onSelect={onFrom} onClose={() => setOpen(null)} swap={swap} /> : null}
      {open === 'to' ? <NetworkDialog options={toOptions} dimmed={dimmed} selected={to?.key} onSelect={onTo} onClose={() => setOpen(null)} swap={swap} /> : null}
    </div>
  )
}

/** A single network row with the picker behind it (the Rescue tab's source chain). */
export function ChainRow({ label, chain, options, onSelect }: { label: string; chain: ChainDef; options: ChainKey[]; onSelect: (k: ChainKey) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Side label={label} chain={chain} placeholder="" onClick={() => setOpen(true)} />
      {open ? <NetworkDialog options={options} selected={chain.key} onSelect={onSelect} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/**
 * The amount panel: the big number, the token on the right, and under them what the wallet holds,
 * Max, and the switch that opens the recipient panel. `note` is the line on the left: what will
 * arrive, the dust that was trimmed, or why the amount is not accepted.
 */
export function AmountPanel({
  value,
  onChange,
  disabled,
  token,
  tokenIcon,
  onPickToken,
  balance,
  onMax,
  note,
  recipientOpen,
  onToggleRecipient,
  recipientForced = false,
}: {
  value: string
  onChange: (v: string) => void
  disabled: boolean
  token: { symbol: string; decimals: number } | undefined
  tokenIcon?: ReactNode
  /** The token is set by the contract that was analysed; the pill sends the user to that field. */
  onPickToken?: () => void
  balance: bigint | undefined
  onMax: () => void
  note?: ReactNode
  recipientOpen: boolean
  onToggleRecipient: () => void
  /** Across VMs the recipient has to be typed, so the panel cannot be closed. */
  recipientForced?: boolean
}) {
  const d = useDict()
  const symbol = token?.symbol ?? ''
  return (
    <div className="relative flex flex-col gap-4 rounded-card border border-transparent bg-surface-2 px-4 pb-5 pt-6 transition-colors focus-within:border-line">
      <div className="flex items-start gap-2">
        <AmountInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="0" disabled={disabled} aria-label={d.step2.amount} className="ml-0.5 mt-0.5" />
        <button
          type="button"
          onClick={onPickToken}
          disabled={!onPickToken}
          title={token ? token.symbol : d.ui.token}
          className="relative -top-1 flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-surface py-2 pl-3 pr-3 text-lg font-semibold text-ink transition enabled:hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          {token ? (
            <>
              {tokenIcon ?? <span className="h-6 w-6 rounded-full bg-ink/20" aria-hidden />}
              <span className="max-w-32 truncate">{symbol}</span>
            </>
          ) : (
            <span className="text-muted">{d.ui.token}</span>
          )}
        </button>
      </div>
      <div className="flex min-h-5 items-center justify-between gap-3 text-xs">
        <div className="min-w-0 flex-1 truncate text-muted">{note}</div>
        <div className="flex shrink-0 items-center gap-2">
          {token && balance !== undefined ? (
            <>
              <span className="tnum text-muted">{fmt(d.ui.available, { amount: formatAmount(balance, token.decimals, { maxFraction: 6 }), symbol })}</span>
              <Button variant="pill" className="h-6" onClick={onMax} disabled={disabled}>
                {d.ui.max}
              </Button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onToggleRecipient}
            disabled={recipientForced}
            aria-pressed={recipientOpen}
            aria-label={d.ui.recipientToggle}
            title={d.ui.recipientToggle}
            className={`inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-full transition enabled:hover:scale-105 disabled:cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${recipientOpen ? 'bg-accent text-page' : 'bg-surface text-muted hover:text-ink'}`}
          >
            <WalletIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The recipient panel: the connected wallet with "Edit", or the typed address with the address
 * book, the book's verdict and the six-character confirmation. The texts come from the tab —
 * Solana and EVM destinations say different things.
 */
export function RecipientPanel({
  crossVm,
  custom,
  onCustom,
  wallet,
  value,
  onChange,
  placeholder,
  error,
  hints = [],
  bookFamily,
  bookVerdict,
  onPickAddress,
  bookConfirmed,
  confirm,
  confirmed,
  onConfirm,
}: {
  crossVm: boolean
  custom: boolean
  onCustom: (custom: boolean) => void
  wallet: string | undefined
  value: string
  onChange: (v: string) => void
  placeholder: string
  error: string
  hints?: ReactNode[]
  bookFamily: AddressFamily | undefined
  bookVerdict: BookVerdict | undefined
  onPickAddress: (address: string) => void
  /** The book vouches for the typed address, so the tail is not asked for. */
  bookConfirmed: boolean
  confirm: string
  confirmed: boolean
  onConfirm: (v: string) => void
}) {
  const d = useDict()
  const typed = value.trim()
  const valid = typed !== '' && error === ''
  const showCustom = crossVm || custom
  return (
    <div className="flex flex-col gap-2 rounded-card bg-surface-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold text-muted">{crossVm ? d.step2.recipient : showCustom ? d.step2.otherAddress : d.step2.recipient}</div>
        {crossVm ? null : showCustom ? (
          <Button variant="pill" onClick={() => onCustom(false)}>
            {d.ui.useWallet}
          </Button>
        ) : (
          <Button variant="pill" onClick={() => onCustom(true)}>
            {d.ui.edit}
          </Button>
        )}
      </div>
      {showCustom ? (
        <>
          <Input tone="surface" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="mono" aria-label={d.step2.recipient} aria-invalid={!valid && typed !== ''} />
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <BookPicker family={bookFamily} onPick={onPickAddress} />
          </div>
          {error && typed !== '' ? <div className="text-xs text-danger">{error}</div> : null}
          {hints.map((h, i) => (
            <div key={i} className="text-xs text-muted">
              {h}
            </div>
          ))}
          {valid ? <BookVerdictNote verdict={bookVerdict} /> : null}
          {valid && !bookConfirmed ? (
            <label className="block text-xs">
              <span className="text-muted">{d.step2.confirmLast6}</span>
              <Input tone="surface" value={confirm} onChange={(e) => onConfirm(e.target.value)} maxLength={6} className={`mono mt-1 max-w-36 ${confirmed ? 'ring-1 ring-ok' : ''}`} aria-invalid={!confirmed} />
            </label>
          ) : null}
        </>
      ) : (
        <div className="flex h-10 items-center text-sm">{wallet ? <Address value={wallet} short /> : <span className="text-muted">—</span>}</div>
      )}
    </div>
  )
}
