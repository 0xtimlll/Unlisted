/** Error type for Solana-side discovery. Dependency-free so the UI can import it without the svm stack. */
export type SvmDiscoverErrorCode = 'bad_peer' | 'store_missing' | 'not_oft_store' | 'mint_missing' | 'unknown_token_program' | 'escrow_mismatch'

export class SvmDiscoverError extends Error {
  constructor(
    public readonly code: SvmDiscoverErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'SvmDiscoverError'
  }
}
