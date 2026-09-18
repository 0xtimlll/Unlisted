'use client'
import { darkTheme, lightTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { WagmiProvider } from 'wagmi'
import { LangProvider, type Lang } from '@/i18n'
import { BridgeApp } from './BridgeApp'
import { load, save, type Stored } from './storage'
import { makeWagmiConfig } from './wagmi'

function useDark(): boolean {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setDark(mq.matches)
    const h = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  return dark
}

export default function Providers() {
  const [stored, setStoredState] = useState<Stored>(() => load())
  const setStored = (s: Stored) => {
    setStoredState(s)
    save(s)
  }
  const dark = useDark()
  const rpcKey = JSON.stringify(stored.customRpc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => makeWagmiConfig(stored.customRpc), [rpcKey])
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }))
  const onLang = (l: Lang) => setStored({ ...stored, lang: l })

  return (
    <LangProvider initial={stored.lang} onChange={onLang}>
      <WagmiProvider config={config} key={rpcKey}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={dark ? darkTheme() : lightTheme()} modalSize="compact">
            <BridgeApp stored={stored} setStored={setStored} />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </LangProvider>
  )
}
