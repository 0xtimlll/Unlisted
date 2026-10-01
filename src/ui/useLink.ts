'use client'
/**
 * Keeps the tab's address in step with the form (core/link.ts): the token and the route go into
 * the query string as they are chosen, and come out of it when the page is opened from a link.
 */
import { useEffect, useRef, useState } from 'react'
import type { AnalysisTarget } from '@/core/analysis/result'
import { buildLink, linkTarget, parseLink, type LinkState } from '@/core/link'
import type { TabSlug } from '@/core/protocols'

/**
 * Writes the state into the address bar. `replaceState`, so the back button is not filled with
 * every change. A query this hook did not write is left alone: on the first render the form is
 * still empty, and clearing the address then would erase the very link the page was opened with
 * before the shell has read it (a child's effect runs before its parent's).
 */
export function useLinkSync(state: LinkState | undefined, enabled = true) {
  const query = enabled ? buildLink(state) : undefined
  const wrote = useRef(false)
  useEffect(() => {
    if (query === undefined) return
    if (query === '' && !wrote.current) return
    try {
      const { pathname, search, hash } = window.location
      if (search === query) return
      window.history.replaceState(window.history.state, '', `${pathname}${query}${hash}`)
      wrote.current = true
    } catch {
      /* history blocked — the form still works, only the address does not follow */
    }
  }, [query])
}

/**
 * The target a link asked for, read once when the shell mounts. It is handed to the tab the same
 * way a target from another tab's analysis is, so one code path applies both.
 */
export function useLinkTarget(tab: TabSlug): AnalysisTarget | null {
  // Read during the first render, not in an effect: the tabs' own effects run first and may
  // already be writing the address by the time a shell effect would look at it.
  const [target] = useState<AnalysisTarget | null>(() => {
    try {
      if (typeof window === 'undefined') return null
      const state = parseLink(window.location.search, tab)
      return (state && linkTarget(state, tab)) ?? null
    } catch {
      return null
    }
  })
  return target
}
