/**
 * The issuer's fee on an OFT transfer, read from the contract's own quote and nothing else.
 *
 * `quoteOFT` answers with what is debited (`amountSentLD`) and what the far side will credit
 * (`amountReceivedLD`); the difference is the fee the contract keeps, whatever its
 * `oftFeeDetails` array says (some issuers keep a cut without describing it). That array is for
 * labels only. The fee is set by the contract's owner — it is not a market rate — so the
 * indicator says it aloud at these thresholds, and the person decides (CLAUDE.md rule 2: nothing
 * here holds the button or asks for a tick).
 *
 * All arithmetic is bigint; basis points are integers of the sent amount.
 */

/** 0.5% and above: a nuance, said in yellow. */
export const OFT_FEE_NOTICE_BPS = 50n
/** Above 3%: red, with the headline printed under the indicator. */
export const OFT_FEE_HIGH_BPS = 300n
/** Above 20%: red, and the headline names the loss first. */
export const OFT_FEE_EXTREME_BPS = 2000n

export type IssuerFee = {
  /** amountSentLD - amountReceivedLD. Negative when the contract credits MORE than it debits. */
  feeLD: bigint
  /** feeLD as basis points of amountSentLD (0 when nothing was sent). Negative for a bonus. */
  feeBps: bigint
}

export function issuerFee(q: { amountSentLD: bigint; amountReceivedLD: bigint }): IssuerFee {
  const feeLD = q.amountSentLD - q.amountReceivedLD
  const feeBps = q.amountSentLD === 0n ? 0n : (feeLD * 10_000n) / q.amountSentLD
  return { feeLD, feeBps }
}

export type FeeClass = 'none' | 'notice' | 'high' | 'extreme'

export function classifyFee(feeBps: bigint): FeeClass {
  if (feeBps > OFT_FEE_EXTREME_BPS) return 'extreme'
  if (feeBps > OFT_FEE_HIGH_BPS) return 'high'
  if (feeBps >= OFT_FEE_NOTICE_BPS) return 'notice'
  return 'none'
}

/** Basis points as a percentage with up to two decimals: 8400 → "84%", 50 → "0.5%", 325 → "3.25%". */
export function formatBps(bps: bigint): string {
  const neg = bps < 0n
  const abs = neg ? -bps : bps
  const whole = abs / 100n
  const frac = (abs % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}%`
}
