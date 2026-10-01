'use client'
import { useAccount } from 'wagmi'
import Link from 'next/link'
import { TAB_SLUGS, tabPath, type TabSlug } from '@/core/protocols'
import { useDict } from '@/i18n'
import type { Theme } from '../storage'
import { useSvmWallet } from '../svm/context'
import { WalletIcon } from './icons'
import { HeaderMenu } from './Menu'
import { LinkTabs } from './ui'

export const CANONICAL_DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? 'localhost'

/**
 * One header for every tab: the wordmark (a link back to the welcome screen), the protocol tabs,
 * then the wallet pill and the menu. Everything on the right is a 40px pill on the card colour.
 *
 * The wallet pill says "Connect" until a wallet is connected, then shows the address of the one
 * the active tab's source chain uses (EVM or Solana); either way a click opens the wallets sheet.
 */
export function Header({
  tab,
  onTab,
  theme,
  onTheme,
  onSettings,
  onAddressBook,
  onWallets,
  srcVm,
}: {
  tab: TabSlug
  onTab: (t: TabSlug) => void
  theme: Theme
  onTheme: (t: Theme) => void
  onSettings: () => void
  onAddressBook: () => void
  onWallets: () => void
  srcVm: 'evm' | 'svm'
}) {
  const d = useDict()
  return (
    <header className="flex h-[88px] w-full items-center gap-6 px-6">
      {/* A real link: the address really does change, and the welcome screen is bookmarkable too. */}
      <Link href="/" title={d.splash.home} className="-mx-1.5 rounded-lg px-1.5 text-[22px] font-bold tracking-tight text-ink outline-none transition hover:text-muted focus-visible:ring-2 focus-visible:ring-ink/30">
        {d.app.title}
      </Link>
      <LinkTabs value={tab} onSelect={onTab} items={TAB_SLUGS.map((s) => ({ value: s, label: d.tabs[s], href: tabPath(s) }))} />
      <div className="ml-auto flex items-center gap-2">
        <WalletPill srcVm={srcVm} onClick={onWallets} />
        <HeaderMenu theme={theme} onTheme={onTheme} onAddressBook={onAddressBook} onSettings={onSettings} />
      </div>
    </header>
  )
}

/** "Connect" with a wallet glyph, or the connected address with the same glyph. */
function WalletPill({ srcVm, onClick }: { srcVm: 'evm' | 'svm'; onClick: () => void }) {
  const d = useDict()
  const { address } = useAccount()
  const svm = useSvmWallet()
  const shown = srcVm === 'svm' ? svm.address : address
  const label = shown ? (srcVm === 'svm' ? `${shown.slice(0, 4)}…${shown.slice(-4)}` : `${shown.slice(0, 6)}…${shown.slice(-4)}`) : d.header.connect
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={shown ? `${d.wallets.title}: ${label}` : d.header.connect}
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-raised py-2 pl-5 pr-4 text-sm font-semibold text-ink shadow-sm backdrop-blur-sm transition hover:scale-105 outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      <span className={shown ? 'tnum' : ''}>{label}</span>
      <WalletIcon className="h-5 w-5" />
    </button>
  )
}
