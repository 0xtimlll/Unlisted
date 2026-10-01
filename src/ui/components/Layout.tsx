'use client'
import { useState, type ReactNode } from 'react'
import { CaretDownIcon } from './icons'
import { Shell } from './ui'

/**
 * The desktop two-column body: the form on the left, the live preview on the right, each in a
 * card of the same width. Below ~1200px the page scrolls horizontally (AppShell sets the floor)
 * rather than collapsing into a phone layout.
 */
export function TwoColumn({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-[1168px] grid-cols-[576px_576px] items-start justify-center gap-4">
      <div className="flex flex-col gap-4">{left}</div>
      {/* Sticky: the indicator, the fee and the checks stay in view while the form scrolls. */}
      <aside className="scroll-quiet sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto">{right}</aside>
    </div>
  )
}

/** The right-hand card: a small grey title, an optional badge, then the panels. */
export function Panel({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Shell>
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold text-muted">{title}</h2>
        {badge}
      </div>
      {children}
    </Shell>
  )
}

/** A panel with a small grey heading above it, inside the right-hand card. */
export function PanelSection({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-card bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-muted">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  )
}

/** A panel that opens and closes: the long tail of the preview, folded by default. */
export function PanelFold({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-card bg-surface-2 px-4 py-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 text-xs font-semibold text-muted transition hover:text-ink outline-none focus-visible:text-ink">
        <span>{title}</span>
        <CaretDownIcon className={`h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="space-y-3 pt-3">{children}</div> : null}
    </section>
  )
}
