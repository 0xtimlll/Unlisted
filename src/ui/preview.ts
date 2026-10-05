/**
 * The preview assessment: the route judged before the person holds the token.
 *
 * The plan hooks need an amount, a sender and a recipient to quote. When one is missing, the same
 * hook is run with these stand-ins — a probe amount of one whole token, a placeholder sender and
 * recipient — so the quote, the contract's fee, the peers, the DVNs and the eight checks are read
 * for real. Nothing built from a stand-in can be sent: the button's own state machine asks for the
 * wallet, the amount and the recipient before it ever looks at a plan.
 */
import { formatAmount } from '@/core/amounts'
import { evmRecipient, type Recipient } from '@/core/recipient'
import { fmt, type Dict } from '@/i18n'

/** A sender/recipient nobody controls, with no code: never zero, never a contract, never in the book. */
export const PREVIEW_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const

export const PREVIEW_RECIPIENT: Recipient = evmRecipient(PREVIEW_ADDRESS)

/** One whole token, in its smallest unit. */
export function previewAmountRaw(decimals: number): bigint {
  return 10n ** BigInt(decimals)
}

export const PREVIEW_AMOUNT_INPUT = '1'

/** The chip's caption for a preview, and for a real plan the funds do not yet allow to simulate. */
export function previewCaption(d: Dict, kind: 'probe' | 'held', decimals: number, symbol: string): string {
  return kind === 'probe'
    ? fmt(d.indicator.previewFor, { amount: `${formatAmount(previewAmountRaw(decimals), decimals)} ${symbol}` })
    : d.indicator.notSimulated
}
