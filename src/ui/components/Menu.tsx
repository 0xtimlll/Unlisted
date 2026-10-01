'use client'
/**
 * The menu behind the round button in the header: the address book, the theme, the settings,
 * and where the source lives. A small card anchored under the button, sections with a quiet grey
 * heading each and a hairline between them.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useDict } from '@/i18n'
import type { Theme } from '../storage'
import { BookIcon, GearIcon, GithubIcon, MoonIcon, SunIcon } from './icons'
import { IconButton } from './ui'
import { MenuIcon } from './icons'

const REPO = process.env['NEXT_PUBLIC_REPO_URL'] ?? ''

/** As long as the colour transition in globals.css. */
const REPAINT_MS = 320

function Heading({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1.5 text-xs font-semibold text-muted">{children}</div>
}

function Item({ icon, children, onClick, href }: { icon: ReactNode; children: ReactNode; onClick?: () => void; href?: string }) {
  const cls = 'flex h-9 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-ink transition hover:bg-surface-2 focus-visible:bg-surface-2 outline-none'
  const body = (
    <>
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted [&_svg]:h-5 [&_svg]:w-5">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </>
  )
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" role="menuitem" className={cls}>
        {body}
      </a>
    )
  }
  return (
    <button type="button" role="menuitem" onClick={onClick} className={cls}>
      {body}
    </button>
  )
}

function Separator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-surface-2" />
}

export function HeaderMenu({ theme, onTheme, onAddressBook, onSettings }: { theme: Theme; onTheme: (t: Theme) => void; onAddressBook: () => void; onSettings: () => void }) {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const dark = theme === 'dark'
  const flip = () => {
    // Colours are only allowed to animate while the switch is in flight (globals.css).
    document.documentElement.classList.add('theme-switching')
    timers.current.push(window.setTimeout(() => document.documentElement.classList.remove('theme-switching'), REPAINT_MS))
    onTheme(dark ? 'light' : 'dark')
  }

  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={ref} className="relative">
      <IconButton label={d.menu.open} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} className={open ? 'scale-105' : ''}>
        <MenuIcon className="text-ink" />
      </IconButton>
      {open ? (
        <div role="menu" className="absolute right-0 top-[calc(100%+4px)] z-50 w-[280px] origin-top-right overflow-hidden rounded-[14px] bg-raised p-2 text-ink shadow-md backdrop-blur-lg animate-enter">
          <div role="group" className="my-2">
            <Heading>{d.menu.addresses}</Heading>
            <Item icon={<BookIcon />} onClick={run(onAddressBook)}>
              {d.header.addressBook}
            </Item>
          </div>
          <Separator />
          <div role="group" className="my-2">
            <Heading>{d.menu.appearance}</Heading>
            <button type="button" role="menuitemcheckbox" aria-checked={dark} onClick={flip} className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-ink transition hover:bg-surface-2 focus-visible:bg-surface-2 outline-none">
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted [&_svg]:h-5 [&_svg]:w-5">{dark ? <MoonIcon /> : <SunIcon />}</span>
              <span className="min-w-0 flex-1 truncate">{dark ? d.menu.themeDark : d.menu.themeLight}</span>
              {/* A two-state switch: the knob sits on the side of the theme that is on. */}
              <span aria-hidden className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${dark ? 'bg-accent' : 'bg-line'}`}>
                <span className={`absolute left-0.5 h-4 w-4 rounded-full bg-page shadow-sm transition ${dark ? 'translate-x-4' : ''}`} />
              </span>
            </button>
          </div>
          <Separator />
          <div role="group" className="my-2">
            <Heading>{d.menu.settings}</Heading>
            <Item icon={<GearIcon />} onClick={run(onSettings)}>
              {d.header.settings}
            </Item>
          </div>
          {REPO ? (
            <>
              <Separator />
              <div role="group" className="my-2">
                <div className="flex items-center gap-2 p-3">
                  <a href={REPO} target="_blank" rel="noopener noreferrer" title={d.splash.source} aria-label={d.splash.source} className="inline-flex text-muted transition hover:scale-105 hover:text-ink">
                    <GithubIcon className="h-6 w-6" />
                  </a>
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
