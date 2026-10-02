/**
 * Where @solana/wallet-adapter-react remembers the chosen wallet (its `localStorageKey`): a JSON
 * string with the wallet's name, removed on disconnect. Read at start-up so that a wallet the user
 * connected before survives a reload — the stack is mounted and the adapter reconnects silently
 * (`autoConnect`), which trusted wallets answer without a prompt. Kept out of the lazy chunk.
 */
export const SVM_WALLET_STORAGE_KEY = 'unlisted:solana-wallet'

export function hasStoredSvmWallet(): boolean {
  try {
    const raw = window.localStorage.getItem(SVM_WALLET_STORAGE_KEY)
    return typeof raw === 'string' && typeof JSON.parse(raw) === 'string'
  } catch {
    return false
  }
}
