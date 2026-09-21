'use client'
import { createContext, useContext } from 'react'
import type { SvmSigner } from '@/core/svm/send'

/** A wallet the browser exposes through the Wallet Standard, as the picker shows it. */
export type SvmWalletOption = { name: string; icon: string; installed: boolean }

/**
 * The Solana wallet slot. Only `signTransaction` is ever handed to the send path (as `signer`);
 * message signing and batch signing are deliberately not surfaced.
 */
export type SvmWallet = {
  /** The adapter stack is loaded (it is fetched only when Solana is the source). */
  ready: boolean
  wallets: SvmWalletOption[]
  /** base58, when connected. */
  address: string | undefined
  connecting: boolean
  signer: SvmSigner | undefined
  connect: (walletName: string) => Promise<void>
  disconnect: () => Promise<void>
  error: string
}

export const INERT_SVM_WALLET: SvmWallet = {
  ready: false,
  wallets: [],
  address: undefined,
  connecting: false,
  signer: undefined,
  connect: async () => {},
  disconnect: async () => {},
  error: '',
}

export const SvmWalletContext = createContext<SvmWallet>(INERT_SVM_WALLET)

export function useSvmWallet(): SvmWallet {
  return useContext(SvmWalletContext)
}
