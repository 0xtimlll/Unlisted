'use client'
import dynamic from 'next/dynamic'

// Wallet libraries touch `window`; with a static export we render the app client-side only.
const Providers = dynamic(() => import('@/ui/Providers'), {
  ssr: false,
  loading: () => (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center justify-center p-8 text-sm text-muted">
      OFT Bridge — loading…
    </main>
  ),
})

export default function Home() {
  return <Providers />
}
