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
 * that trusted, unlocked wallets answer without a prompt. A refusal (locked, untrusted) makes the
 * provider forget the wallet; the app's own memory (svm/stored.ts) outlives that, so the next
 * start-up tries again. Only a connect the user asked for reports its failure as `error`: a refused
 * silent connect on page load is not news to show anyone.
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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SvmWallet } from './context'
import { forgetSvmWallet, rememberSvmWallet, SVM_WALLET_STORAGE_KEY } from './stored'
import { shortError } from '../hooks'

const NO_ADAPTERS: Adapter[] = []

export default memo(function SolanaStack({ onState }: { onState: (s: SvmWallet) => void }) {
  const [error, setError] = useState('')
  // True between the user's pick and the outcome of that pick; errors outside it are the
  // provider's own silent start-up attempt, which stays quiet.
  const userAsked = useRef(false)
  const onError = useCallback((e: unknown) => {
    if (userAsked.current) setError(shortError(e))
  }, [])
  return (
    <WalletProvider wallets={NO_ADAPTERS} autoConnect localStorageKey={SVM_WALLET_STORAGE_KEY} onError={onError}>
      <Bridge onState={onState} error={error} setError={setError} userAsked={userAsked} />
    </WalletProvider>
  )
})

/** Reads the adapter context and pushes a plain, trimmed view of it up to the host. */
function Bridge({ onState, error, setError, userAsked }: { onState: (s: SvmWallet) => void; error: string; setError: (m: string) => void; userAsked: React.MutableRefObject<boolean> }) {
  const { wallets, wallet, publicKey, connected, connecting, signTransaction, select, connect, disconnect } = useWallet()

  // A wallet that really connected is remembered by the app itself, until the user disconnects.
  useEffect(() => {
    if (connected && wallet) {
      rememberSvmWallet(wallet.adapter.name)
      userAsked.current = false
    }
  }, [connected, wallet, userAsked])

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
        userAsked.current = true
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
        forgetSvmWallet()
        // One call only. The provider forgets the wallet itself on the adapter's `disconnect`
        // event; a `select(null)` after this ran `adapter.disconnect()` a second time through a
        // stale closure, and the extension was asked to disconnect twice.
        await disconnect()
      },
      error,
    }),
    [options, wallet, publicKey, connected, connecting, signTransaction, select, connect, disconnect, error, setError, userAsked],
  )

  useEffect(() => onState(state), [state, onState])
  return null
}
