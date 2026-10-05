/**
 * The sentence for a guard code. Most are static; the issuer-fee notes (guard 9) name the fee,
 * the symbol and the percentage read from the plan's own quote, so the indicator's headline says
 * "you would lose 5040 BRLA (84%)" rather than "a fee".
 */
import { formatAmount } from '@/core/amounts'
import { formatBps, issuerFee } from '@/core/oftFee'
import type { SendPlan } from '@/core/plan'
import { fmt, type Dict } from '@/i18n'

export type FeeContext = { plan: SendPlan | undefined; decimals: number; symbol: string }

export function guardLabel(d: Dict, code: string, ctx?: FeeContext | undefined): string {
  const raw = d.guard[code as keyof typeof d.guard] ?? code
  if (!code.startsWith('oft_fee_') || !ctx?.plan) return raw
  const fee = issuerFee(ctx.plan.quote)
  const abs = (v: bigint) => (v < 0n ? -v : v)
  return fmt(raw, { fee: formatAmount(abs(fee.feeLD), ctx.decimals), symbol: ctx.symbol, pct: formatBps(abs(fee.feeBps)) })
}
