import type { Metadata } from 'next'
import { SplashOverlay } from '@/ui/components/SplashOverlay'
import './globals.css'

export const metadata: Metadata = {
  title: 'Unlisted',
  description: 'Bridge any LayerZero OFT token. Non-custodial, static, no backend.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {/* Named so the splash can make the whole app inert while it is up. */}
        <div id="app-root">{children}</div>
        <SplashOverlay />
      </body>
    </html>
  )
}
