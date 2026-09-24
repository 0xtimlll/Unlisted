'use client'
/**
 * The welcome screen at /. The bridge is already mounted underneath it (the root layout owns it),
 * so this is only a sheet of glass over a running app: leaving is a dissolve and a change of
 * address, never a reload, and whatever was connected stays connected.
 *
 * It exists only on this route. /bridge is served without it, which is what makes that address
 * one to bookmark and reload.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { tabPath } from '@/core/protocols'
import { useDict } from '@/i18n'
import { loadLastTab } from '../tabs'
import { Button } from './ui'

/** Kept in step with the dissolve in globals.css. */
const OUT_MS = 400

/** The id of the wrapper the root layout puts around the app. */
const APP_ID = 'app-root'

/** Nothing waits for an animation that was turned off. */
function motionMs(ms: number): number {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
  } catch {
    return ms
  }
}

export function SplashOverlay() {
  const d = useDict()
  const router = useRouter()
  const [leaving, setLeaving] = useState(false)
  const going = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const timers = useRef<number[]>([])
  const wait = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, motionMs(ms)))

  /**
   * The bridge behind the glass does not scroll and is `inert`: the sheet already swallows every
   * click, and this takes the keyboard and the focus ring with it. Both are undone when the
   * screen leaves — including when it leaves by navigating away.
   */
  useEffect(() => {
    const app = document.getElementById(APP_ID)
    const prev = document.body.style.overflow
    const pending = timers.current
    document.body.style.overflow = 'hidden'
    app?.setAttribute('inert', '')
    frame.current?.focus()
    return () => {
      document.body.style.overflow = prev
      app?.removeAttribute('inert')
      pending.forEach((t) => window.clearTimeout(t))
    }
  }, [])

  /** Dissolve, then open the tab that was last in use — /bridge unless another one was. */
  const enter = () => {
    if (going.current) return
    going.current = true
    setLeaving(true)
    wait(() => router.push(tabPath(loadLastTab())), OUT_MS)
  }

  return (
    <div
      ref={frame}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="splash-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') enter()
      }}
      className={`splash fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 outline-none ${leaving ? 'splash-leaving' : ''}`}
    >
      <span id="splash-title" className="relative text-[56px] font-black leading-none tracking-tight text-ink">
        {d.app.title}
      </span>
      {/* The bridge's own call-to-action button, unchanged — same component, same variant. */}
      <div className="relative w-[300px]">
        <Button variant="cta" onClick={enter}>
          {d.splash.start}
        </Button>
      </div>
    </div>
  )
}
