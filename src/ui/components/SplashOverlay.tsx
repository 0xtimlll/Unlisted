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
import { TouchId } from './TouchId'
import { Button } from './ui'

/** Kept in step with globals.css: the dissolve, and the scan that runs before it. */
const OUT_MS = 400
const SCAN_MS = 900

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
  const [scanning, setScanning] = useState(false)
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

  /** The print fills in ring by ring first, and the screen leaves when the scan is through. */
  const scan = () => {
    if (going.current || scanning) return
    setScanning(true)
    wait(enter, SCAN_MS)
  }

  // Enter reads the print, exactly as it would on the lock screen — and only once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        scan()
      }
      if (e.key === 'Escape') enter()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <div
      ref={frame}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="splash-title"
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
      <div className="relative pt-6">
        <TouchId scanning={scanning} onActivate={scan} label={d.splash.touchId} />
      </div>
    </div>
  )
}
