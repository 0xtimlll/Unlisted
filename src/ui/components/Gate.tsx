'use client'
/**
 * The entry veil: a sheet of frosted glass over the live app with one button on it. It is up on
 * every load and nothing behind it can be clicked or tabbed into (AppShell is `inert` while it
 * shows) until the button is pressed.
 *
 * `reloading` runs the same veil the other way round: the glass fades back in over the running
 * app and the page reloads underneath it, so a restart from the wordmark is a fade rather than a
 * white flash — the veil that comes back after the reload is the same one.
 */
import { useEffect, useRef, useState } from 'react'
import { useDict } from '@/i18n'
import { Button } from './ui'

/** Kept in step with the animations in globals.css. */
const IN_MS = 420
const OUT_MS = 360

/** Nothing waits for an animation that was turned off. */
function motionMs(ms: number): number {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
  } catch {
    return ms
  }
}

export function Gate({ reloading, onEnter }: { reloading: boolean; onEnter: () => void }) {
  const d = useDict()
  const [leaving, setLeaving] = useState(false)
  const done = useRef(false)

  // Nothing scrolls behind the glass.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Let the glass finish covering the app, then refresh underneath it.
  useEffect(() => {
    if (!reloading) return
    const t = window.setTimeout(() => window.location.reload(), motionMs(IN_MS))
    return () => window.clearTimeout(t)
  }, [reloading])

  const enter = () => {
    if (done.current || reloading) return
    done.current = true
    setLeaving(true)
    window.setTimeout(onEnter, motionMs(OUT_MS))
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gate-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') enter()
      }}
      className={`gate fixed inset-0 z-50 flex items-center justify-center ${leaving ? 'gate-leaving' : ''}`}
    >
      <div className="gate-glass absolute inset-0" />
      <div className="gate-card relative flex w-[360px] flex-col items-center gap-8 rounded-[32px] px-10 py-9 text-center">
        {/* The highlight sliding across the tile; the content below is positioned, so it stays on top. */}
        <span className="gate-sheen" aria-hidden />
        <span id="gate-title" className="relative text-[46px] font-black leading-none tracking-tight text-ink">
          {d.app.title}
        </span>
        {/* The app's own call-to-action button, so the veil is the page rather than a splash screen. */}
        <Button variant="cta" autoFocus onClick={enter} className="relative">
          {d.gate.start}
        </Button>
      </div>
    </div>
  )
}
