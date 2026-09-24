import type { Metadata } from 'next'
import { AppEntry } from '@/ui/AppEntry'
import './globals.css'

export const metadata: Metadata = {
  title: 'Unlisted',
  description: 'Bridge any LayerZero OFT token. Non-custodial, static, no backend.',
}

/**
 * The bridge itself lives here, above the route, and is mounted exactly once: moving between the
 * welcome screen (/) and the bridge (/bridge) swaps only `children`, so nothing in the app is
 * remounted, the wallet stays connected and the glass dissolves onto a bridge that is already
 * standing there.
 */
/* The document ships in the dark theme; public/theme.js undoes that before the first paint for
 * anyone who chose light (scripts/inject-theme.mjs puts it in the head of every exported page). */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: 'dark' }}>
      <body className="antialiased">
        {/* Named so the welcome screen can make the whole app inert while the glass is up. */}
        <div id="app-root">
          <AppEntry />
        </div>
        {children}
      </body>
    </html>
  )
}
