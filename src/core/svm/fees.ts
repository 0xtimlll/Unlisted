/** Solana fee constants. Dependency-free so the review screen can show them without the svm stack. */

/** Solana's hard per-transaction compute cap. */
export const MAX_COMPUTE_UNITS = 1_400_000
/** Priority fee bounds, micro-lamports per compute unit. At 600k CU: 0.000006–0.0006 SOL. */
export const PRIORITY_FEE_MIN = 10_000n
export const PRIORITY_FEE_MAX = 1_000_000n
/** Base fee per signature; our transaction has exactly one. */
export const BASE_FEE_LAMPORTS = 5_000n

/** Tx fee in lamports: base fee + priority fee (CU × price / 1e6, rounded up). */
export function svmTxFee(computeUnitLimit: number, computeUnitPrice: bigint): bigint {
  return BASE_FEE_LAMPORTS + (BigInt(computeUnitLimit) * computeUnitPrice + 999_999n) / 1_000_000n
}
