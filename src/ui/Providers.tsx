'use client'
import { darkTheme, lightTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit'
import '@rainbow-me/rainbowkit/styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { WagmiProvider } from 'wagmi'
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

const RK_ACCENT = { light: '#0a0a0a', dark: '#fafafa' }

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
  const onTheme = (t: Theme) => setStored({ ...stored, theme: t })

  const rkTheme = dark
    ? darkTheme({ accentColor: RK_ACCENT.dark, accentColorForeground: '#0a0a0a', borderRadius: 'large' })
    : lightTheme({ accentColor: RK_ACCENT.light, accentColorForeground: '#ffffff', borderRadius: 'large' })

  return (
    <WagmiProvider config={config} key={rpcKey}>
      <QueryClientProvider client={queryClient}>
        {/* RainbowKit otherwise follows the browser language; the whole app is English. */}
        <RainbowKitProvider theme={rkTheme} modalSize="compact" locale="en-US">
          <BridgeApp stored={stored} setStored={setStored} onTheme={onTheme} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
