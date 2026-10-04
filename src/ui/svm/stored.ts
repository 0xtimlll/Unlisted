/**
 * What survives a reload about the Solana wallet.
 *
 * `SVM_WALLET_STORAGE_KEY` is @solana/wallet-adapter-react's own memory (`localStorageKey`): a JSON
 * string with the wallet's name. The provider reads it at start-up and connects silently
 * (`autoConnect`), which trusted wallets answer without a prompt — but it also ERASES it whenever
 * that silent connect is refused. Solflare refuses while it is locked, Phantom while the site is
 * not trusted, so one reload with a locked extension used to forget the wallet for good: the sheet
 * said "Connect" while the extension still listed the site as connected.
 *
 * So the app keeps its own memory, `SVM_WALLET_REMEMBERED_KEY`, written when a wallet actually
 * connects and cleared only by the user's own Disconnect. Before the stack mounts, it is copied
 * back into the provider's key, so every start-up tries the silent connect again — and a refusal
 * (locked, untrusted) costs nothing but that attempt. Kept out of the lazy chunk.
 */
export const SVM_WALLET_STORAGE_KEY = 'unlisted:solana-wallet'
export const SVM_WALLET_REMEMBERED_KEY = 'unlisted:solana-wallet-remembered'

function readName(key: string): string | undefined {
  try {
    const raw = window.localStorage.getItem(key)
    if (typeof raw !== 'string') return undefined
    const v = JSON.parse(raw) as unknown
    return typeof v === 'string' && v.length > 0 && v.length < 200 ? v : undefined
  } catch {
    return undefined
  }
}

/** The wallet the user connected last, if any — restoring the provider's own key on the way. */
export function restoreSvmWallet(): string | undefined {
  const remembered = readName(SVM_WALLET_REMEMBERED_KEY)
  const providerHas = readName(SVM_WALLET_STORAGE_KEY)
  if (remembered && !providerHas) {
    try {
      window.localStorage.setItem(SVM_WALLET_STORAGE_KEY, JSON.stringify(remembered))
    } catch {
      /* storage unavailable: nothing to restore into */
    }
  }
  return remembered ?? providerHas
}

export function hasStoredSvmWallet(): boolean {
  return restoreSvmWallet() !== undefined
}

export function rememberSvmWallet(name: string): void {
  try {
    window.localStorage.setItem(SVM_WALLET_REMEMBERED_KEY, JSON.stringify(name))
  } catch {
    /* storage unavailable: the provider's own key still carries this session */
  }
}

export function forgetSvmWallet(): void {
  try {
    window.localStorage.removeItem(SVM_WALLET_REMEMBERED_KEY)
  } catch {
    /* nothing to forget */
  }
}
