'use client'
/**
 * The network picker: a full-screen sheet over a blurred page. A search pill with ⌘K, a button
 * that swaps From and To, filter pills for the VMs that are actually on offer, the order switch
 * (most popular first, or the networks picked last first — remembered across reloads), and a
 * grid of cards — each in its network's brand colour with the mark in the middle and the name
 * underneath; a network without a mark shows its initials. Only this app's networks are listed;
 * on the "To" side the ones the contract has no route to are shown dimmed, so the absence of a
 * route is visible rather than silent.
 *
 * Built for a hundred-odd cards: the marks load lazily and the rows below the fold are not laid
 * out until scrolled to (`card-lazy`), so opening, searching and scrolling cost the same as with
 * fifteen.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { byKey, type ChainKey } from '@/core/chains'
import { useDict } from '@/i18n'
import { BRAND, initialsOf } from '../brand'
import { orderNetworks, type NetworkOrder } from '../networkOrder'
import { useNetworkPrefs } from '../networkPrefs'
import { CheckIcon, CloseIcon, SearchIcon, SwapIcon } from './icons'
import { Kbd, Tabs, useDismiss } from './ui'

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
  const prefs = useNetworkPrefs()
  const { leaving, dismiss } = useDismiss(onClose)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const input = useRef<HTMLInputElement>(null)

  const all = useMemo(() => {
    const dim = new Set(dimmed)
    const keys = [...options, ...dimmed].filter((k, i, arr) => arr.indexOf(k) === i)
    return orderNetworks(keys, prefs.order, prefs.recent).map((key) => ({ key, dim: dim.has(key) && !options.includes(key) }))
  }, [options, dimmed, prefs.order, prefs.recent])

  const vms = new Set(all.map((x) => byKey(x.key).vm))
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: d.network.all },
    ...(vms.has('evm') ? [{ value: 'evm' as const, label: d.network.evm }] : []),
    ...(vms.has('svm') ? [{ value: 'svm' as const, label: d.network.svm }] : []),
  ]
  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () =>
      all.filter((x) => {
        const c = byKey(x.key)
        if (filter !== 'all' && c.vm !== filter) return false
        return needle === '' || c.name.toLowerCase().includes(needle) || c.key.includes(needle) || c.nativeSymbol.toLowerCase().includes(needle)
      }),
    [all, filter, needle],
  )

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
    prefs.notePick(key)
    onSelect(key)
    dismiss()
  }

  const orderItems: { value: NetworkOrder; label: string }[] = [
    { value: 'popular', label: d.network.popular },
    { value: 'recent', label: d.network.recentFirst },
  ]

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

          <div className="w-full max-w-5xl pb-8">
            <div className="flex items-center justify-between gap-4 px-6 py-1">
              <div className="flex items-center gap-2">
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
              {/* The order switch: a pill pair in the page's own style, remembered across reloads. */}
              <div className="flex h-12 items-center rounded-full bg-surface/30 px-1" role="group" aria-label={d.network.order}>
                <Tabs<NetworkOrder> value={prefs.order} onChange={prefs.setOrder} items={orderItems} />
              </div>
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
                <div key={x.key} className="card-lazy animate-card-in" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                  <button
                    type="button"
                    disabled={x.dim}
                    title={x.dim ? d.network.noRoute : c.name}
                    onClick={() => pick(x.key)}
                    style={{ background: b.bg }}
                    className="relative flex aspect-[3.25/4] w-full shrink-0 cursor-pointer flex-col overflow-hidden rounded-[28px] shadow-sm transition enabled:hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-30 outline-none focus-visible:ring-4 focus-visible:ring-ink/40"
                  >
                    <span className="relative z-10 flex w-full grow flex-col items-center justify-center gap-4 px-6">
                      {b.logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/chains/${x.key}.svg`} alt="" width={80} height={80} loading="lazy" decoding="async" draggable={false} className="pointer-events-none h-20 w-20" />
                      ) : (
                        <span aria-hidden className={`flex h-20 w-20 items-center justify-center rounded-full text-3xl font-semibold ${b.dark ? 'bg-[#0b0e11]/10 text-[#0b0e11]' : 'bg-white/10 text-white'}`}>
                          {initialsOf(c.name)}
                        </span>
                      )}
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
