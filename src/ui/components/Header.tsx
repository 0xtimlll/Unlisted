'use client'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { LANGS, useDict, useLang } from '@/i18n'
import type { Theme } from '../storage'
import { Button } from './ui'

export const CANONICAL_DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? 'localhost'

export function Header({ theme, onTheme, onSettings }: { theme: Theme; onTheme: (t: Theme) => void; onSettings: () => void }) {
  const d = useDict()
  const { lang, setLang } = useLang()
  return (
    <header className="flex items-center justify-between gap-3 px-1 py-3 sm:px-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-black tracking-tight text-ink">
          OFT<span className="text-accent-ink">BRIDGE</span>
          <span className="ml-1 text-accent-ink">✳</span>
        </span>
        <span className="mono hidden text-[11px] text-muted sm:inline" title={d.app.domainNotice}>
          {CANONICAL_DOMAIN}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="hidden overflow-hidden rounded-full bg-surface-2 p-0.5 sm:flex" role="group" aria-label={d.header.language}>
          {LANGS.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={`h-7 rounded-full px-2.5 text-xs font-semibold uppercase transition ${lang === l ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
            >
              {l}
            </button>
          ))}
        </div>
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

/** RainbowKit connect button restyled as a Relay-like pill. */
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
            <button type="button" onClick={openConnectModal} className="h-10 rounded-xl bg-accent-soft px-4 text-sm font-semibold text-accent-ink transition hover:bg-line">
              {d.header.connect}
            </button>
          )
        }
        return (
          <button type="button" onClick={openAccountModal} className="mono h-10 rounded-xl bg-surface-2 px-3 text-sm font-semibold text-ink transition hover:bg-line">
            {account.displayName}
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}
