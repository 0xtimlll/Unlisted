'use client'
/**
 * The theme switch (2-theme-toggle.gif): a hairline capsule, a knob that overhangs it, a spring
 * at the end of the travel and a squash on the way there. Two themes only — the shape of the
 * control is in globals.css, this only says which way it is pointing.
 */
import { useEffect, useRef, useState } from 'react'
import { fmt, useDict } from '@/i18n'
import type { Theme } from '../storage'
import { MoonIcon, SunIcon } from './icons'

/** As long as the knob's travel and the colour transition in globals.css. */
const TRAVEL_MS = 400
const REPAINT_MS = 320

export function ThemeToggle({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
  const d = useDict()
  const [squashing, setSquashing] = useState(false)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  const dark = theme === 'dark'
  const next: Theme = dark ? 'light' : 'dark'

  const flip = () => {
    setSquashing(true)
    timers.current.push(window.setTimeout(() => setSquashing(false), TRAVEL_MS))
    // Colours are only allowed to animate while the switch is in flight (globals.css).
    document.documentElement.classList.add('theme-switching')
    timers.current.push(window.setTimeout(() => document.documentElement.classList.remove('theme-switching'), REPAINT_MS))
    onTheme(next)
  }

  const label = fmt(d.ui.themeSwitch, { mode: d.ui[`theme_${next}`] })
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={label}
      title={label}
      onClick={flip}
      data-on={dark}
      data-anim={squashing}
      className="toggle outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      <span className="toggle-knob">
        <span className="toggle-knob-inner">
          <MoonIcon className="toggle-icon toggle-icon-moon h-4 w-4" />
          <SunIcon className="toggle-icon toggle-icon-sun h-4 w-4" />
        </span>
      </span>
    </button>
  )
}
