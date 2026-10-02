'use client'
/**
 * The network picker: a full-screen sheet over a blurred page. A search pill with ⌘K, a button
 * that swaps From and To, filter pills for the VMs that are actually on offer, and a grid of
 * cards — each in its network's brand colour with the mark in the middle and the name underneath.
 * Only this app's networks are listed; on the "To" side the ones the contract has no route to are
 * shown dimmed, so the absence of a route is visible rather than silent.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { byKey, CHAINS, type ChainKey } from '@/core/chains'
import { useDict } from '@/i18n'
import { BRAND } from '../brand'
import { CheckIcon, CloseIcon, SearchIcon, SwapIcon } from './icons'
import { Kbd, useDismiss } from './ui'

type Filter = 'all' | 'evm' | 'svm'

export function NetworkDialog({
  options,
  dimmed = [],
  selected,
  onSelect,
  onClose,
  swap,
}: {
  /** The networks that can be chosen, in this order. */
  options: ChainKey[]
  /** Networks shown but not choosable (no route there), with the reason as a tooltip. */
  dimmed?: ChainKey[]
  selected?: ChainKey | undefined
  onSelect: (key: ChainKey) => void
  onClose: () => void
  /** Swap From and To: the arrows button next to the search. Absent when there is nothing to swap. */
  swap?: { enabled: boolean; title: string; onClick: () => void } | undefined
}) {
  const d = useDict()
  const { leaving, dismiss } = useDismiss(onClose)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const input = useRef<HTMLInputElement>(null)

  const all = useMemo(() => {
    const dim = new Set(dimmed)
    const order = new Map(CHAINS.map((c, i) => [c.key, i]))
    return [...options.map((k) => ({ key: k, dim: false })), ...dimmed.map((k) => ({ key: k, dim: true }))]
      .filter((x, i, arr) => arr.findIndex((y) => y.key === x.key) === i)
      .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
      .map((x) => ({ ...x, dim: x.dim && dim.has(x.key) }))
  }, [options, dimmed])

  const vms = new Set(all.map((x) => byKey(x.key).vm))
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: d.network.all },
    ...(vms.has('evm') ? [{ value: 'evm' as const, label: d.network.evm }] : []),
    ...(vms.has('svm') ? [{ value: 'svm' as const, label: d.network.svm }] : []),
  ]
  const needle = q.trim().toLowerCase()
  const shown = all.filter((x) => {
    const c = byKey(x.key)
    if (filter !== 'all' && c.vm !== filter) return false
    return needle === '' || c.name.toLowerCase().includes(needle) || c.key.includes(needle) || c.nativeSymbol.toLowerCase().includes(needle)
  })

  // ⌘K / Ctrl+K focuses the search; Enter picks the first match.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    input.current?.focus()
  }, [])

  const pick = (key: ChainKey) => {
    onSelect(key)
    dismiss()
  }

  return (
    <div className={`overlay fixed inset-0 z-50 ${leaving ? 'animate-fade-out' : 'animate-fade-in'}`} role="dialog" data-dismiss="" aria-modal="true" aria-label={d.network.find}>
      <button type="button" onClick={dismiss} aria-label={d.ui.close} title={d.ui.close} className="fixed right-6 top-6 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface text-ink shadow-sm transition hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-ink/30">
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
      {/* The click-away target: everything that is not a card, a pill or the search. */}
      <main className="scroll-quiet fixed inset-0 flex items-start justify-center overflow-y-scroll py-24" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss() }}>
        <div className="flex w-full flex-col items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss() }}>
          <div className="relative -ml-2 flex w-full items-center justify-center gap-2 px-6 pb-10">
            <div className="relative -ml-14 flex w-auto max-w-lg justify-center">
              <label className="relative flex h-14 items-center overflow-hidden rounded-full bg-surface pl-6 pr-4">
                <SearchIcon className="h-5 w-5 shrink-0 text-ink" />
                <input
                  ref={input}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && shown[0] && !shown[0].dim) pick(shown[0].key)
                  }}
                  placeholder={d.network.find}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={d.network.find}
                  className="ml-4 h-10 w-56 bg-transparent text-lg font-semibold text-ink outline-none placeholder:text-ink"
                />
                <span className="ml-4 hidden sm:block">
                  <Kbd>⌘K</Kbd>
                </span>
              </label>
              {swap ? (
                <div className="absolute -right-16 top-0">
                  <button
                    type="button"
                    disabled={!swap.enabled}
                    title={swap.title}
                    aria-label={swap.title}
                    onClick={() => {
                      swap.onClick()
                      dismiss()
                    }}
                    className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-surface text-ink transition enabled:hover:scale-105 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                  >
                    <SwapIcon className="h-6 w-6" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="w-full pb-8">
            <div className="flex items-center justify-center gap-2 px-6 py-1">
              {filters.map((f) => {
                const active = filter === f.value
                return (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFilter(f.value)}
                    aria-pressed={active}
                    className="relative flex h-12 shrink-0 items-center gap-2 overflow-hidden rounded-full px-4 pr-5 text-sm font-semibold text-ink transition hover:scale-[1.03] outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                  >
                    <span aria-hidden className={`absolute inset-0 bg-surface transition ${active ? 'opacity-100' : 'opacity-30'}`} />
                    <span className={`relative z-10 ${active ? 'text-ink' : 'text-muted'}`}>{f.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid w-full max-w-5xl grid-cols-4 gap-4 px-6" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss() }}>
            {shown.map((x, i) => {
              const c = byKey(x.key)
              const b = BRAND[x.key]
              const isSel = selected === x.key
              return (
                // The entrance animation lives on a wrapper: an animation's final keyframe would
                // otherwise pin the opacity and hide the dimming of a card with no route.
                <div key={x.key} className="animate-card-in" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                  <button
                    type="button"
                    disabled={x.dim}
                    title={x.dim ? d.network.noRoute : c.name}
                    onClick={() => pick(x.key)}
                    style={{ background: b.bg }}
                    className="relative flex aspect-[3.25/4] w-full shrink-0 cursor-pointer flex-col overflow-hidden rounded-[28px] shadow-sm transition enabled:hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-30 outline-none focus-visible:ring-4 focus-visible:ring-ink/40"
                  >
                    <span className="relative z-10 flex w-full grow flex-col items-center justify-center gap-4 px-6">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/chains/${x.key}.svg`} alt="" width={80} height={80} draggable={false} className="pointer-events-none h-20 w-20" />
                      <span className={`text-center text-sm font-semibold ${b.dark ? 'text-[#0b0e11]' : 'text-white'}`}>{c.name}</span>
                    </span>
                    {isSel ? (
                      <span aria-hidden className={`absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full ${b.dark ? 'bg-[#0b0e11] text-white' : 'bg-white text-[#0b0e11]'}`}>
                        <CheckIcon className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                  </button>
                </div>
              )
            })}
            {shown.length === 0 ? <p className="col-span-4 py-10 text-center text-sm text-muted">{d.network.none}</p> : null}
          </div>
        </div>
      </main>
    </div>
  )
}
