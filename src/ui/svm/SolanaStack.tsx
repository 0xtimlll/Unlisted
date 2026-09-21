'use client'
/**
 * The Solana wallet stack (@solana/wallet-adapter-react), loaded only while Solana is the source.
 * `wallets={[]}`: no wallet-specific SDKs — browser wallets announce themselves through the Wallet
 * Standard and the provider picks them up. Nothing here talks to the network.
 */
import { WalletProvider, useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState } from '@solana/wallet-adapter-base'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SvmWallet } from './context'

const STORAGE_KEY = 'unlisted:solana-wallet'

export default function SolanaStack({ onState }: { onState: (s: SvmWallet) => void }) {
  return (
    <WalletProvider wallets={[]} autoConnect={false} localStorageKey={STORAGE_KEY} onError={() => {}}>
      <Bridge onState={onState} />
    </WalletProvider>
  )
}

/** Reads the adapter context and pushes a plain, trimmed view of it up to the host. */
function Bridge({ onState }: { onState: (s: SvmWallet) => void }) {
  const w = useWallet()
  const [error, setError] = useState('')
  // select() is asynchronous with respect to connect(): remember what was asked for and connect
  // once the provider reports it as the current wallet.
  const pending = useRef<string | null>(null)

  useEffect(() => {
    if (pending.current && w.wallet?.adapter.name === pending.current && !w.connected && !w.connecting) {
      pending.current = null
      w.connect().catch((e: unknown) => setError(e instanceof Error ? e.message.slice(0, 120) : String(e)))
    }
  }, [w])

  const state = useMemo<SvmWallet>(() => {
    const address = w.publicKey?.toBase58()
    const signTransaction = w.signTransaction
    return {
      ready: true,
      wallets: w.wallets.map((x) => ({ name: x.adapter.name, icon: x.adapter.icon, installed: x.readyState === WalletReadyState.Installed || x.readyState === WalletReadyState.Loadable })),
      address,
      connecting: w.connecting,
      signer: w.publicKey && signTransaction ? { publicKey: w.publicKey, signTransaction } : undefined,
      connect: async (name: string) => {
        setError('')
        if (w.wallet?.adapter.name === name && !w.connected) {
          await w.connect()
          return
        }
        pending.current = name
        w.select(name as Parameters<typeof w.select>[0])
      },
      disconnect: async () => {
        setError('')
        await w.disconnect()
        w.select(null)
      },
      error,
    }
  }, [w, error])

  useEffect(() => onState(state), [state, onState])
  return null
}
