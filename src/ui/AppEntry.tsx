'use client'
/** One entry point for every tab page. Wallet libraries touch `window`, so it is client-only. */
import dynamic from 'next/dynamic'
import type { TabSlug } from '@/core/protocols'

const Providers = dynamic(() => import('./Providers'), {
  ssr: false,
  loading: () => <Loading />,
})

export function Loading() {
  return <main className="flex min-h-screen items-center justify-center p-8 text-sm text-muted">Unlisted — loading…</main>
}

export function AppEntry({ tab }: { tab: TabSlug }) {
  return <Providers tab={tab} />
}
