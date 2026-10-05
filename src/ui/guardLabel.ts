/**
 * The sentence for a guard code. Most are static; the issuer-fee notes (guard 9 on V2 and Solana,
 * guard 9 on v1) name the fee, the symbol and the percentage read from the plan's own quote, so the
 * indicator's headline says "you would lose 5040 BRLA (84%)" rather than "a fee".
 */
import { formatAmount } from '@/core/amounts'
import { formatBps, type IssuerFee } from '@/core/oftFee'
import { fmt } from '@/i18n'

export type FeeContext = { fee: IssuerFee | undefined; decimals: number; symbol: string }

export function guardLabel(dict: Record<string, string | undefined>, code: string, ctx?: FeeContext | undefined): string {
  const raw = dict[code] ?? code
  if (!code.startsWith('oft_fee_') || !ctx?.fee) return raw
  const abs = (v: bigint) => (v < 0n ? -v : v)
  return fmt(raw, { fee: formatAmount(abs(ctx.fee.feeLD), ctx.decimals), symbol: ctx.symbol, pct: formatBps(abs(ctx.fee.feeBps)) })
}
