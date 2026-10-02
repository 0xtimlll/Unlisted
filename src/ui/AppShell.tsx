'use client'
/**
 * Everything that is the same on every tab: the header (tabs, wallet, menu), the page frame,
 * Recent transfers across the full width, and the dialogs the header opens — the wallets sheet,
 * the address book, the settings, the Solana wallet picker. The active tab renders its own two
 * cards inside `children`. Either wallet can be connected at any time; the form uses the one its
 * source chain needs.
 */
import { useEffect, useState } from 'react'
import type { ChainKey } from '@/core/chains'
import type { TabSlug } from '@/core/protocols'
import { Header } from './components/Header'
import { History } from './components/History'
import { AddressBookDialog } from './components/AddressBookDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { WalletsDialog } from './components/WalletsDialog'
import type { HistoryEntry, SetStored, Stored, Theme } from './storage'
import { useSvmWallet } from './svm/context'
import { SvmWalletPicker } from './svm/SvmWalletButton'

export function AppShell({
  tab,
  onTab,
  stored,
  setStored,
  onTheme,
  srcVm,
  onEnableSvm,
  onTrack,
  children,
}: {
  tab: TabSlug
  onTab: (t: TabSlug) => void
  stored: Stored
  setStored: SetStored
  onTheme: (t: Theme) => void
  /** Which wallet the header shows — follows the active tab's source chain. */
  srcVm: 'evm' | 'svm'
  /** Loads the Solana wallet stack without touching the form; it stays loaded from then on. */
  onEnableSvm: () => void
  onTrack: (e: HistoryEntry) => void
  children: React.ReactNode
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bookOpen, setBookOpen] = useState(false)
  const [walletsOpen, setWalletsOpen] = useState(false)
  const [svmPickerOpen, setSvmPickerOpen] = useState(false)
  // "Connect" on the Solana row while the stack is not loaded: load it, then open the picker.
  const [svmPickerPending, setSvmPickerPending] = useState(false)
  const svm = useSvmWallet()
  useEffect(() => {
    if (svmPickerPending && svm.ready) {
      setSvmPickerPending(false)
      setSvmPickerOpen(true)
    }
  }, [svmPickerPending, svm.ready])

  const connectSvm = () => {
    if (svm.ready) {
      setSvmPickerOpen(true)
      return
    }
    setSvmPickerPending(true)
    onEnableSvm()
  }

  return (
    // min-w: below ~1200px the page scrolls sideways instead of falling apart (desktop-only tool).
    <div className="flex min-h-screen w-full min-w-[1200px] flex-col">
      <Header tab={tab} onTab={onTab} theme={stored.theme} onTheme={onTheme} onSettings={() => setSettingsOpen(true)} onAddressBook={() => setBookOpen(true)} onWallets={() => setWalletsOpen(true)} srcVm={srcVm} />

      <main className="mx-auto w-full max-w-[1216px] flex-1 px-6 pb-12 pt-6">
        {children}
        <div className="mx-auto max-w-[1168px] pt-10">
          <History entries={stored.history} onClear={() => setStored((prev) => ({ ...prev, history: [] }))} onTrack={onTrack} />
        </div>
      </main>

      {walletsOpen ? <WalletsDialog onClose={() => setWalletsOpen(false)} onConnectSvm={connectSvm} /> : null}
      {svmPickerOpen ? (
        <SvmWalletPicker
          onClose={() => setSvmPickerOpen(false)}
          onPick={(name) => {
            setSvmPickerOpen(false)
            void svm.connect(name)
          }}
        />
      ) : null}

      {bookOpen ? <AddressBookDialog onClose={() => setBookOpen(false)} /> : null}

      {settingsOpen ? (
        <SettingsDialog
          stored={stored}
          onClose={() => setSettingsOpen(false)}
          onSave={(rpc: Partial<Record<ChainKey, string>>) => {
            setStored((prev) => ({ ...prev, customRpc: rpc }))
            setSettingsOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
