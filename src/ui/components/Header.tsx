'use client'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useDict } from '@/i18n'
import type { Theme } from '../storage'
import { Button } from './ui'

export const CANONICAL_DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? 'localhost'

export function Header({ theme, onTheme, onSettings }: { theme: Theme; onTheme: (t: Theme) => void; onSettings: () => void }) {
  const d = useDict()
  return (
    <header className="flex w-full items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-8">
      <span className="text-[22px] font-black tracking-tight text-ink">{d.app.title}</span>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" aria-label={d.ui.theme} title={d.ui.theme} onClick={() => onTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')} className="w-9 px-0">
          {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
        </Button>
        <Button variant="ghost" aria-label={d.header.settings} title={d.header.settings} onClick={onSettings} className="w-9 px-0">
          ⚙
        </Button>
        <WalletButton />
      </div>
    </header>
  )
}

/** RainbowKit connect button restyled to match: black pill, white text. */
function WalletButton() {
  const d = useDict()
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        const ready = mounted
        const connected = ready && account && chain
        if (!ready) return <span className="h-10 w-24" aria-hidden />
        if (!connected) {
          return (
            <button type="button" onClick={openConnectModal} className="h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-page transition hover:bg-accent-hover">
              {d.header.connect}
            </button>
          )
        }
        return (
          <button type="button" onClick={openAccountModal} className="mono h-10 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink transition hover:bg-surface-2">
            {account.displayName}
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}
