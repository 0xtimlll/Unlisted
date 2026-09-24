'use client'
/** One entry point for the app itself. Wallet libraries touch `window`, so it is client-only. */
import dynamic from 'next/dynamic'
import { useState } from 'react'
import { tabOfPath, type TabSlug } from '@/core/protocols'
import { DEFAULT_TAB, loadLastTab } from './tabs'

const Providers = dynamic(() => import('./Providers'), {
  ssr: false,
  loading: () => <Loading />,
})

export function Loading() {
  return <main className="flex min-h-screen items-center justify-center p-8 text-sm text-muted">Unlisted — loading…</main>
}

/** The tab the address asks for; on the welcome screen (/), the one that was open last. */
function initialTab(): TabSlug {
  if (typeof window === 'undefined') return DEFAULT_TAB
  return tabOfPath(window.location.pathname) ?? loadLastTab()
}

export function AppEntry() {
  const [tab] = useState<TabSlug>(initialTab)
  return <Providers tab={tab} />
}
