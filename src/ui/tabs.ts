'use client'
/**
 * Which protocol tab was used last. Its own tiny localStorage key, deliberately separate from
 * ui/storage.ts: the root page (/) reads it to redirect and must not pull viem and the chain
 * registry into that bundle. Every access is guarded — private mode simply means "no memory".
 */
import { isTabSlug, type TabSlug } from '@/core/protocols'

export const TAB_KEY = 'oft-bridge-ui:tab'
export const DEFAULT_TAB: TabSlug = 'oft'

export function loadLastTab(): TabSlug {
  try {
    const v = globalThis.localStorage?.getItem(TAB_KEY)
    return isTabSlug(v) ? v : DEFAULT_TAB
  } catch {
    return DEFAULT_TAB
  }
}

export function saveLastTab(slug: TabSlug): void {
  try {
    globalThis.localStorage?.setItem(TAB_KEY, slug)
  } catch {
    /* private mode / quota — the tab just is not remembered */
  }
}

export function clearLastTab(): void {
  try {
    globalThis.localStorage?.removeItem(TAB_KEY)
  } catch {
    /* ignore */
  }
}
