'use client'
import type { ReactNode } from 'react'

/**
 * The desktop two-column body: the bridge form on the left, the live preview on the right.
 * The minimums keep both readable down to a 1024px window; below that the page scrolls
 * horizontally (AppShell sets the floor) rather than collapsing into a phone layout.
 */
export function TwoColumn({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(460px,1fr)_minmax(420px,1fr)] items-start gap-6">
      <div className="space-y-2">{left}</div>
      {/* Sticky: the verdict, the fee and the checks stay in view while the form scrolls. */}
      <aside className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto">{right}</aside>
    </div>
  )
}

export function Panel({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  )
}
