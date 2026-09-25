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
import { GithubIcon } from './icons'
import { Button } from './ui'

/** Kept in step with the dissolve in globals.css. */
const OUT_MS = 400

/** Build-time, public, and the same two values the footer uses. Absent ones simply do not render. */
const REPO = process.env['NEXT_PUBLIC_REPO_URL'] ?? ''
const DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? ''

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
      // Enter belongs to whatever is focused, when that is something Enter already activates:
      // otherwise the GitHub link below could be tabbed to but never opened, because this
      // listener would preventDefault() it and open the bridge instead.
      if ((e.target as HTMLElement | null)?.closest('a[href], button')) return
      e.preventDefault()
      enter()
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

      {/*
        * Where the app comes from, at the foot of the glass. It is an <a>, not a Button, so it
        * keeps a real link's middle-click and context menu — but it wears the secondary Button's
        * shape and hover exactly, and a translucent fill so it sits ON the glass instead of
        * punching a plate through it.
        *
        * `absolute` keeps it out of the centred column: the wordmark and the call to action stay
        * optically centred on the screen whether or not these two lines are there.
        */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-9">
        {REPO ? (
          <a
            href={REPO}
            target="_blank"
            rel="noopener noreferrer"
            title={d.splash.source}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-line bg-surface/60 px-4 text-sm font-medium text-ink transition hover:border-ink/25 hover:bg-surface-2/80 outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            <GithubIcon className="h-[17px] w-[17px]" />
            {d.splash.sourceLabel}
          </a>
        ) : null}
        {DOMAIN ? <span className="mono text-xs tracking-wide text-faint">{DOMAIN}</span> : null}
      </div>
    </div>
  )
}
