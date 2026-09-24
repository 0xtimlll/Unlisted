'use client'
import { darkTheme, lightTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { WagmiProvider } from 'wagmi'
import type { ChainKey } from '@/core/chains'
import type { AnalysisTarget } from '@/core/analysis/result'
import { tabOfPath, tabOfProtocol, tabPath, type ProtocolId, type TabSlug } from '@/core/protocols'
import { AppShell } from './AppShell'
import { BridgeApp } from './BridgeApp'
import { CcipApp } from './CcipApp'
import { NttApp } from './NttApp'
import { entryProtocol, load, save, type HistoryEntry, type Stored, type Theme } from './storage'
import { saveLastTab } from './tabs'
import { SvmWalletHost } from './svm/SvmWalletHost'
import { makeWagmiConfig } from './wagmi'

/**
 * RainbowKit's modal is themed in JavaScript, not CSS, so the two palette colours it needs are
 * read back off the document — the tokens in globals.css stay the only place they are written.
 */
function cssColor(name: string, fallback: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  } catch {
    return fallback
  }
}

export default function Providers({ tab: initialTab }: { tab: TabSlug }) {
  const [stored, setStoredState] = useState<Stored>(() => load())
  // The source chain lives here so the Solana wallet slot can follow it without remounting the app.
  const [srcKey, setSrcKey] = useState<ChainKey>('ethereum')
  const [tab, setTabState] = useState<TabSlug>(initialTab)
  const [trackRequest, setTrackRequest] = useState<HistoryEntry | null>(null)
  /** What the analysis found for another protocol, carried across when its tab opens. */
  const [handoff, setHandoff] = useState<AnalysisTarget | null>(null)
  const setStored = (s: Stored) => {
    setStoredState(s)
    save(s)
  }

  /**
   * Tabs are separate static pages, but switching between them stays in the app: history.pushState
   * updates the URL without unmounting anything, so the wallet connection, the RPC settings and an
   * in-flight transfer survive. Entering /ntt directly still serves that page's own HTML.
   */
  const goTab = (t: TabSlug) => {
    setTabState(t)
    saveLastTab(t)
    try {
      if (window.location.pathname !== tabPath(t)) window.history.pushState(null, '', tabPath(t))
    } catch {
      /* history blocked — the tab still switches, only the URL does not follow */
    }
  }

  useEffect(() => {
    saveLastTab(initialTab)
    const onPop = () => setTabState(tabOfPath(window.location.pathname) ?? initialTab)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [initialTab])

  const dark = stored.theme === 'dark'
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  // The wallet modal's two colours, re-read whenever the palette underneath it changes.
  const [rk, setRk] = useState({ accent: '#ffc107', on: '#1a1a1a' })
  useEffect(() => {
    setRk({ accent: cssColor('--color-accent', '#ffc107'), on: cssColor('--color-page', '#1a1a1a') })
  }, [dark])

  /**
   * Moving between the welcome screen and a tab is a real navigation (the layout keeps the app
   * mounted through it), so the tab follows the address. Switching tabs inside the app uses
   * history.pushState below and does not come through here.
   */
  const pathname = usePathname()
  useEffect(() => {
    const t = tabOfPath(pathname)
    if (t) setTabState(t)
  }, [pathname])

  const rpcKey = JSON.stringify(stored.customRpc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => makeWagmiConfig(stored.customRpc), [rpcKey])
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }))
  const onTheme = (t: Theme) => setStored({ ...stored, theme: t })

  const rkTheme = dark
    ? darkTheme({ accentColor: rk.accent, accentColorForeground: rk.on, borderRadius: 'large' })
    : lightTheme({ accentColor: rk.accent, accentColorForeground: rk.on, borderRadius: 'large' })

  // Only the OFT tab can have a Solana source; the others are EVM-only, so the header shows the
  // EVM wallet there and the Solana stack is not loaded.
  const svmSource = tab === 'oft' && srcKey === 'solana'

  return (
    <WagmiProvider config={config} key={rpcKey}>
      <QueryClientProvider client={queryClient}>
        {/* RainbowKit otherwise follows the browser language; the whole app is English. */}
        <RainbowKitProvider theme={rkTheme} modalSize="compact" locale="en-US">
          <SvmWalletHost enabled={svmSource}>
            <AppShell
              tab={tab}
              onTab={goTab}
              stored={stored}
              setStored={setStored}
              onTheme={onTheme}
              srcVm={svmSource ? 'svm' : 'evm'}
              onTrack={(e: HistoryEntry) => {
                goTab(tabOfProtocol(entryProtocol(e)))
                setTrackRequest(e)
              }}
            >
              {tab === 'oft' ? (
                <BridgeApp
                  stored={stored}
                  setStored={setStored}
                  srcKey={srcKey}
                  setSrcKey={setSrcKey}
                  trackRequest={trackRequest}
                  onTrackConsumed={() => setTrackRequest(null)}
                  onOpenTab={(protocol: ProtocolId, target: AnalysisTarget | undefined) => {
                    setHandoff(target ?? null)
                    goTab(tabOfProtocol(protocol))
                  }}
                />
              ) : tab === 'ntt' ? (
                <NttApp stored={stored} setStored={setStored} srcKey={srcKey} setSrcKey={setSrcKey} handoff={handoff} />
              ) : (
                <CcipApp stored={stored} setStored={setStored} srcKey={srcKey} setSrcKey={setSrcKey} handoff={handoff} />
              )}
            </AppShell>
          </SvmWalletHost>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
