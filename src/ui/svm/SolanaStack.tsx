'use client'
/**
 * The Solana wallet stack (@solana/wallet-adapter-react), loaded on the Solana row's "Connect", when
 * Solana is the source, or at start-up when a wallet was connected before (svm/stored.ts), and kept
 * mounted from then on (SvmWalletHost).
 * `wallets={NO_ADAPTERS}`: no wallet-specific SDKs — browser wallets announce themselves through the
 * Wallet Standard and the provider picks them up. Nothing here talks to the network.
 *
 * Connecting is the provider's job (`autoConnect`): after `select(name)` it calls the adapter's
 * `connect()`, and at start-up with a remembered wallet it calls `autoConnect()` — a silent connect
 * that trusted wallets answer without a prompt and untrusted ones refuse, which clears the memory.
 * A failed connect is reported through `onError` and shown as `error`.
 *
 * Render discipline matters here. The host re-renders on every state this component pushes up, and
 * WalletProvider builds a fresh context object and re-wraps its adapters on every render it gets. If
 * the pushed state depended on those identities, every push would cause the next one: a loop that
 * kept the page at 100% CPU and never let the dialog timers fire (the "frozen page" after connecting
 * a Solana wallet). So: the component is memoised (the host's re-render does not reach the provider),
 * the provider's props are constants or stable callbacks, and the state is derived from the
 * provider's VALUES, never from the context object itself.
 */
import { WalletProvider, useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState, type Adapter } from '@solana/wallet-adapter-base'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { SvmWallet } from './context'
import { SVM_WALLET_STORAGE_KEY } from './stored'
import { shortError } from '../hooks'

const NO_ADAPTERS: Adapter[] = []

export default memo(function SolanaStack({ onState }: { onState: (s: SvmWallet) => void }) {
  const [error, setError] = useState('')
  const onError = useCallback((e: unknown) => setError(shortError(e)), [])
  return (
    <WalletProvider wallets={NO_ADAPTERS} autoConnect localStorageKey={SVM_WALLET_STORAGE_KEY} onError={onError}>
      <Bridge onState={onState} error={error} setError={setError} />
    </WalletProvider>
  )
})

/** Reads the adapter context and pushes a plain, trimmed view of it up to the host. */
function Bridge({ onState, error, setError }: { onState: (s: SvmWallet) => void; error: string; setError: (m: string) => void }) {
  const { wallets, wallet, publicKey, connected, connecting, signTransaction, select, connect, disconnect } = useWallet()

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
        if (wallet?.adapter.name === name) {
          // The same wallet again (after a refusal): the provider only auto-connects once per
          // selection, so this time connect by hand.
          if (!connected) await connect().catch((e: unknown) => setError(shortError(e)))
          return
        }
        // A new selection: the provider connects it (autoConnect after a user's select).
        select(name as Parameters<typeof select>[0])
      },
      disconnect: async () => {
        setError('')
        await disconnect()
        select(null)
      },
      error,
    }),
    [options, wallet, publicKey, connected, connecting, signTransaction, select, connect, disconnect, error, setError],
  )

  useEffect(() => onState(state), [state, onState])
  return null
}
