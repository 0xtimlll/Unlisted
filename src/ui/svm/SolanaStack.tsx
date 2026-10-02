'use client'
/**
 * The Solana wallet stack (@solana/wallet-adapter-react), loaded on the Solana row's "Connect" or
 * when Solana is the source, and kept mounted from then on (SvmWalletHost).
 * `wallets={NO_ADAPTERS}`: no wallet-specific SDKs — browser wallets announce themselves through the
 * Wallet Standard and the provider picks them up. Nothing here talks to the network.
 *
 * Render discipline matters here. The host re-renders on every state this component pushes up, and
 * WalletProvider builds a fresh context object and re-wraps its adapters on every render it gets. If
 * the pushed state depended on those identities, every push would cause the next one: a loop that
 * kept the page at 100% CPU and never let the dialog timers fire (the "frozen page" after connecting
 * a Solana wallet). So: the component is memoised (the host's re-render does not reach the provider),
 * the provider's props are module constants, and the state is derived from the provider's VALUES,
 * never from the context object itself.
 */
import { WalletProvider, useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState, type Adapter } from '@solana/wallet-adapter-base'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { SvmWallet } from './context'
import { shortError } from '../hooks'

const STORAGE_KEY = 'unlisted:solana-wallet'
const NO_ADAPTERS: Adapter[] = []
const IGNORE_ERRORS = () => {}

export default memo(function SolanaStack({ onState }: { onState: (s: SvmWallet) => void }) {
  return (
    <WalletProvider wallets={NO_ADAPTERS} autoConnect={false} localStorageKey={STORAGE_KEY} onError={IGNORE_ERRORS}>
      <Bridge onState={onState} />
    </WalletProvider>
  )
})

/** Reads the adapter context and pushes a plain, trimmed view of it up to the host. */
function Bridge({ onState }: { onState: (s: SvmWallet) => void }) {
  const { wallets, wallet, publicKey, connected, connecting, signTransaction, select, connect, disconnect } = useWallet()
  const [error, setError] = useState('')
  // select() is asynchronous with respect to connect(): remember what was asked for and connect
  // once the provider reports it as the current wallet.
  const pending = useRef<string | null>(null)

  useEffect(() => {
    if (pending.current && wallet?.adapter.name === pending.current && !connected && !connecting) {
      pending.current = null
      connect().catch((e: unknown) => setError(shortError(e)))
    }
  }, [wallet, connected, connecting, connect])

  const options = useMemo(
    () => wallets.map((x) => ({ name: x.adapter.name, icon: x.adapter.icon, installed: x.readyState === WalletReadyState.Installed || x.readyState === WalletReadyState.Loadable })),
    [wallets],
  )

  const state = useMemo<SvmWallet>(
    () => ({
      ready: true,
      wallets: options,
      address: publicKey?.toBase58(),
      connecting,
      signer: publicKey && signTransaction ? { publicKey, signTransaction } : undefined,
      connect: async (name: string) => {
        setError('')
        if (wallet?.adapter.name === name && !connected) {
          await connect()
          return
        }
        pending.current = name
        select(name as Parameters<typeof select>[0])
      },
      disconnect: async () => {
        setError('')
        await disconnect()
        select(null)
      },
      error,
    }),
    [options, wallet, publicKey, connected, connecting, signTransaction, select, connect, disconnect, error],
  )

  useEffect(() => onState(state), [state, onState])
  return null
}
