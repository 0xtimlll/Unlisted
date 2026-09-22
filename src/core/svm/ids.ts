/** Shape checks for Solana identifiers. Dependency-free: the UI validates input without the svm stack. */

/** A base58 32-byte public key is 32–44 characters. Shape only; the chain decides what it is. */
export function looksLikePubkey(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)
}

/** A Solana transaction signature: 64 bytes in base58 (86–88 chars). */
export function isSolanaSignature(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s)
}
