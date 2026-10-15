'use client'
/**
 * How the network picker orders its cards, and which networks were picked last — shared by every
 * picker on every tab, persisted with the other settings (ui/storage.ts).
 *
 * A context because the pickers sit deep inside each tab's form (FromToRow → NetworkDialog) and
 * the persisted state lives in Providers; threading it through five tabs for one dialog would be
 * noise. Reads and writes go through `setStored`, so they survive a reload exactly as the theme
 * and the custom RPCs do, with the same try/catch around localStorage.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { ChainKey } from '@/core/chains'
import { DEFAULT_NETWORK_ORDER, pushRecentChain, type NetworkOrder } from './networkOrder'
import type { SetStored, Stored } from './storage'

export type NetworkPrefs = {
  order: NetworkOrder
  recent: readonly ChainKey[]
  setOrder: (o: NetworkOrder) => void
  /** Called when a network is picked in any picker: it becomes the newest recent one. */
  notePick: (key: ChainKey) => void
}

const NetworkPrefsContext = createContext<NetworkPrefs>({ order: DEFAULT_NETWORK_ORDER, recent: [], setOrder: () => {}, notePick: () => {} })

export function NetworkPrefsProvider({ stored, setStored, children }: { stored: Stored; setStored: SetStored; children: ReactNode }) {
  const order = stored.networkOrder
  const recent = stored.recentChains
  const value = useMemo<NetworkPrefs>(
    () => ({
      order,
      recent,
      setOrder: (o) => setStored((prev) => ({ ...prev, networkOrder: o })),
      notePick: (key) => setStored((prev) => ({ ...prev, recentChains: pushRecentChain(prev.recentChains, key) })),
    }),
    // setStored is stable (it closes over a state setter); only the two values matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, recent],
  )
  return <NetworkPrefsContext.Provider value={value}>{children}</NetworkPrefsContext.Provider>
}

export function useNetworkPrefs(): NetworkPrefs {
  return useContext(NetworkPrefsContext)
}
