'use client'
import { darkTheme, lightTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { WagmiProvider } from 'wagmi'
import { LangProvider, type Lang } from '@/i18n'
import { BridgeApp } from './BridgeApp'
import { load, save, type Stored, type Theme } from './storage'
import { makeWagmiConfig } from './wagmi'

function useSystemDark(): boolean {
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

const RK_ACCENT = { light: '#4615c8', dark: '#6d4aff' }

export default function Providers() {
  const [stored, setStoredState] = useState<Stored>(() => load())
  const setStored = (s: Stored) => {
    setStoredState(s)
    save(s)
  }
  const systemDark = useSystemDark()
  const dark = stored.theme === 'dark' || (stored.theme === 'system' && systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  const rpcKey = JSON.stringify(stored.customRpc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => makeWagmiConfig(stored.customRpc), [rpcKey])
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }))
  const onLang = (l: Lang) => setStored({ ...stored, lang: l })
  const onTheme = (t: Theme) => setStored({ ...stored, theme: t })

  const rkTheme = dark
    ? darkTheme({ accentColor: RK_ACCENT.dark, borderRadius: 'large' })
    : lightTheme({ accentColor: RK_ACCENT.light, borderRadius: 'large' })

  return (
    <LangProvider initial={stored.lang} onChange={onLang}>
      <WagmiProvider config={config} key={rpcKey}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={rkTheme} modalSize="compact">
            <BridgeApp stored={stored} setStored={setStored} onTheme={onTheme} />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </LangProvider>
  )
}
