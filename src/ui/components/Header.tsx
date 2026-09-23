'use client'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { TAB_SLUGS, tabPath, type TabSlug } from '@/core/protocols'
import { fmt, useDict } from '@/i18n'
import type { Theme } from '../storage'
import { SvmWalletButton } from '../svm/SvmWalletButton'
import { IconButton, LinkTabs } from './ui'

export const CANONICAL_DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? 'localhost'

const THEME_GLYPH: Record<Theme, string> = { dark: '☾', light: '☀', system: '◐' }
const NEXT_THEME: Record<Theme, Theme> = { dark: 'light', light: 'system', system: 'dark' }

/**
 * One header for every tab: the wordmark (which reloads the page, so the splash is back), the
 * protocol tabs, then the shared controls. One wallet slot — the connector follows the source chain's VM (RainbowKit for
 * EVM, wallet-adapter for Solana). Everything here is 40px tall so tabs, icons and the wallet
 * button share one baseline.
 */
export function Header({
  tab,
  onTab,
  theme,
  onTheme,
  onSettings,
  srcVm,
}: {
  tab: TabSlug
  onTab: (t: TabSlug) => void
  theme: Theme
  onTheme: (t: Theme) => void
  onSettings: () => void
  srcVm: 'evm' | 'svm'
}) {
  const d = useDict()
  return (
    <header className="flex w-full items-center gap-6 border-b border-line px-6 py-3">
      <button
        type="button"
        onClick={() => window.location.reload()}
        title={d.splash.reload}
        aria-label={d.splash.reload}
        className="-mx-1.5 rounded-lg px-1.5 text-[22px] font-black tracking-tight text-ink transition hover:text-muted outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        {d.app.title}
      </button>
      <LinkTabs
        value={tab}
        onSelect={onTab}
        items={TAB_SLUGS.map((s) => ({ value: s, label: d.tabs[s], href: tabPath(s) }))}
      />
      <div className="ml-auto flex items-center gap-1.5">
        <IconButton label={fmt(d.ui.themeTooltip, { mode: d.ui[`theme_${theme}`] })} onClick={() => onTheme(NEXT_THEME[theme])}>
          {THEME_GLYPH[theme]}
        </IconButton>
        <IconButton label={d.header.settings} onClick={onSettings}>
          ⚙
        </IconButton>
        {srcVm === 'svm' ? <SvmWalletButton /> : <WalletButton />}
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
