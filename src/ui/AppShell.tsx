'use client'
/**
 * Everything that is the same on every tab: the header (tabs, theme, settings, wallet), the
 * page frame, Recent transfers across the full width, the footer and the settings dialog.
 * The active tab renders its own two columns inside `children`.
 */
import { useState } from 'react'
import type { ChainKey } from '@/core/chains'
import type { TabSlug } from '@/core/protocols'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { History } from './components/History'
import { SettingsDialog } from './components/SettingsDialog'
import type { HistoryEntry, Stored, Theme } from './storage'

export function AppShell({
  tab,
  onTab,
  stored,
  setStored,
  onTheme,
  srcVm,
  gated,
  onReload,
  onTrack,
  children,
}: {
  tab: TabSlug
  onTab: (t: TabSlug) => void
  stored: Stored
  setStored: (s: Stored) => void
  onTheme: (t: Theme) => void
  /** Which wallet connector the header shows — follows the active tab's source chain. */
  srcVm: 'evm' | 'svm'
  /** The entry veil is up: the shell goes inert, so nothing behind the glass takes a click or the focus. */
  gated: boolean
  onReload: () => void
  onTrack: (e: HistoryEntry) => void
  children: React.ReactNode
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    // min-w: below ~1024px the page scrolls sideways instead of falling apart (desktop-only tool).
    <div inert={gated} className="flex min-h-screen w-full min-w-[1024px] flex-col">
      <Header
        tab={tab}
        onTab={onTab}
        theme={stored.theme}
        onTheme={onTheme}
        onSettings={() => setSettingsOpen(true)}
        onReload={onReload}
        srcVm={srcVm}
      />

      <main className="mx-auto w-full max-w-[1280px] flex-1 px-6 py-8">
        {children}
        <div className="pt-10">
          <History entries={stored.history} onClear={() => setStored({ ...stored, history: [] })} onTrack={onTrack} />
        </div>
      </main>

      <Footer />

      {settingsOpen ? (
        <SettingsDialog
          stored={stored}
          onClose={() => setSettingsOpen(false)}
          onSave={(rpc: Partial<Record<ChainKey, string>>) => {
            setStored({ ...stored, customRpc: rpc })
            setSettingsOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
