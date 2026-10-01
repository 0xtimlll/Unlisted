'use client'
/**
 * The welcome screen at /. The bridge is already mounted underneath it (the root layout owns it),
 * so this is only a blurred sheet over a running app with one card on it: leaving is a dissolve
 * and a change of address, never a reload, and whatever was connected stays connected.
 *
 * It exists only on this route. /bridge is served without it, which is what makes that address
 * one to bookmark and reload.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { tabPath } from '@/core/protocols'
import { useDict } from '@/i18n'
import { loadLastTab } from '../tabs'
import { InfoIcon, WarningIcon } from './icons'
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
    // A link opened at / keeps its query: the tab it dissolves into reads it (core/link.ts).
    wait(() => router.push(tabPath(loadLastTab()) + window.location.search), OUT_MS)
  }

  /**
   * Enter opens the bridge without reaching for the mouse, and Escape does the same. The listener
   * is on the document rather than on the frame below, so it answers wherever the focus has
   * wandered to; `enter` itself only ever runs once.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        enter()
        return
      }
      if (e.key !== 'Enter') return
      // Enter belongs to whatever is focused, when that is something Enter already activates.
      if ((e.target as HTMLElement | null)?.closest('a[href], button')) return
      e.preventDefault()
      enter()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <div ref={frame} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="splash-title" className={`splash fixed inset-0 z-[100] flex items-center justify-center p-6 outline-none ${leaving ? 'splash-leaving' : ''}`}>
      <div className={`flex w-full max-w-[440px] flex-col rounded-dialog bg-surface shadow-lg ${leaving ? 'animate-exit' : 'animate-enter'}`}>
        <div className="flex flex-col gap-2 px-6 pb-0 pt-10 text-center">
          <h2 id="splash-title" className="text-3xl font-semibold leading-9 text-ink">
            {d.app.title}
          </h2>
          <p className="text-xs font-semibold text-muted">{d.splash.subtitle}</p>
        </div>
        <div className="flex flex-col gap-6 p-6">
          <div className="flex items-start gap-3">
            <InfoIcon className="mt-0.5 h-6 w-6 shrink-0 text-ink" />
            <p className="text-sm leading-6 text-ink">{d.splash.how}</p>
          </div>
          <div className="flex items-start gap-3">
            <WarningIcon className="mt-0.5 h-6 w-6 shrink-0 text-ink" />
            <p className="text-sm leading-6 text-ink">{d.footer.disclaimer}</p>
          </div>
          {/* The bridge's own call-to-action button, in its "ready" tone. */}
          <Button variant="cta" data-tone="primary" className="h-12" onClick={enter}>
            {d.splash.start}
          </Button>
        </div>
      </div>
    </div>
  )
}
