'use client'
/**
 * The splash over the bridge. It is up on every load and on every reload — nothing about it is
 * stored, so a refresh always brings it back — and it goes away for good once the button is
 * pressed. The whole screen is the glass: `backdrop-filter` blurs the bridge that is already
 * painted underneath, so the app itself is never filtered and nothing about its layout changes.
 */
import { useEffect, useState } from 'react'
import { useDict } from '@/i18n'
import { Button } from './ui'

/** Kept in step with the transition in globals.css. */
const OUT_MS = 400

/** The id of the wrapper the root layout puts around the app. */
const APP_ID = 'app-root'

/** Nothing waits for a transition that was turned off. */
function motionMs(ms: number): number {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
  } catch {
    return ms
  }
}

export function SplashOverlay() {
  const d = useDict()
  const [leaving, setLeaving] = useState(false)
  const [gone, setGone] = useState(false)

  /**
   * While the splash is up the bridge does not scroll, and it is `inert`: the overlay already
   * swallows every click, and this takes the keyboard and the focus ring with it.
   */
  useEffect(() => {
    if (gone) return
    const app = document.getElementById(APP_ID)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    app?.setAttribute('inert', '')
    return () => {
      document.body.style.overflow = prev
      app?.removeAttribute('inert')
    }
  }, [gone])

  if (gone) return null

  const enter = () => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(() => setGone(true), motionMs(OUT_MS))
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="splash-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') enter()
      }}
      className={`splash fixed inset-0 z-[100] flex flex-col items-center justify-center gap-8 ${leaving ? 'splash-leaving' : ''}`}
    >
      <span id="splash-title" className="text-[56px] font-black leading-none tracking-tight text-ink">
        {d.app.title}
      </span>
      {/* The bridge's own call-to-action button, unchanged — same component, same variant. */}
      <div className="w-[300px]">
        <Button variant="cta" autoFocus onClick={enter}>
          {d.splash.start}
        </Button>
      </div>
    </div>
  )
}
