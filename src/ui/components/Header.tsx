'use client'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import Link from 'next/link'
import { TAB_SLUGS, tabPath, type TabSlug } from '@/core/protocols'
import { useDict } from '@/i18n'
import type { Theme } from '../storage'
import { SvmWalletButton } from '../svm/SvmWalletButton'
import { GearIcon } from './icons'
import { ThemeToggle } from './ThemeToggle'
import { IconButton, LinkTabs } from './ui'

export const CANONICAL_DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? 'localhost'

/**
 * One header for every tab: the wordmark (a link back to the welcome screen), the protocol tabs,
 * then the shared controls. One wallet slot — the connector follows the source chain's VM
 * (RainbowKit for EVM, wallet-adapter for Solana). Everything here is 40px tall so tabs, icons and
 * the wallet button share one baseline.
 *
 * It is a panel that floats over the page rather than a bar stuck to its edge: same corner radius
 * as the cards below it, one step lighter than the page, and no rule underneath (6-header-reference).
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
    <header className="flex w-full items-center gap-6 rounded-card border border-line/60 bg-raised px-5 py-2.5">
      {/* A real link: the address really does change, and the welcome screen is bookmarkable too. */}
      <Link
        href="/"
        title={d.splash.home}
        className="-mx-1.5 rounded-lg px-1.5 text-[22px] font-black tracking-tight text-ink outline-none transition hover:text-muted focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        {d.app.title}
      </Link>
      <LinkTabs
        value={tab}
        onSelect={onTab}
        items={TAB_SLUGS.map((s) => ({ value: s, label: d.tabs[s], href: tabPath(s) }))}
      />
      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle theme={theme} onTheme={onTheme} />
        <IconButton label={d.header.settings} onClick={onSettings} className="group">
          <GearIcon className="h-6 w-6 transition-transform duration-300 group-hover:rotate-[75deg]" />
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
