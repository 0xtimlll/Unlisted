import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'OFT Bridge',
  description: 'A form on top of LayerZero OFT contracts. Non-custodial, static, no backend.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
