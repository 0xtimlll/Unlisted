import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Unlisted',
  description: 'Bridge any LayerZero OFT token. Non-custodial, static, no backend.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
