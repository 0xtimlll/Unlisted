/**
 * Amount arithmetic (§5.2). String parsing only — no floats anywhere near money.
 */

export class AmountError extends Error {
  constructor(
    public readonly code: 'empty' | 'invalid' | 'negative' | 'too_many_decimals',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'AmountError'
  }
}

const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/

/**
 * "19.82" with decimals=18 -> 19820000000000000000n.
 * Accepts optional surrounding whitespace, comma as decimal separator, and
 * underscores/spaces as thousands separators ("1 000,5"). Rejects exponents,
 * signs, and more fractional digits than `decimals`.
 */
export function parseAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new AmountError('invalid', `bad decimals: ${decimals}`)
  }
  let s = input.trim()
  if (s === '') throw new AmountError('empty')
  if (s.startsWith('-')) throw new AmountError('negative')
  s = s.replace(/[\s_]/g, '').replace(',', '.')
  if (s.startsWith('.')) s = '0' + s
  if (s.endsWith('.')) s = s.slice(0, -1)
  const m = AMOUNT_RE.exec(s)
  if (!m) throw new AmountError('invalid')
  const whole = m[1] ?? '0'
  const frac = m[2] ?? ''
  if (frac.length > decimals) throw new AmountError('too_many_decimals')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/** Rounds DOWN to a multiple of `rate` (the OFT's decimalConversionRate). */
export function trimDust(amount: bigint, rate: bigint): bigint {
  if (rate <= 0n) throw new Error('rate must be > 0')
  if (amount < 0n) throw new Error('amount must be >= 0')
  return amount - (amount % rate)
}

/** Rounds UP to a multiple of `step`. step <= 0 -> identity. */
export function ceilToStep(x: bigint, step: bigint): bigint {
  if (x < 0n) throw new Error('x must be >= 0')
  if (step <= 0n) return x
  const r = x % step
  return r === 0n ? x : x + (step - r)
}

/** x * bps / 10000, multiply-before-divide, rounds down. */
export function applyBps(x: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`bad bps: ${bps}`)
  return (x * BigInt(bps)) / 10000n
}

export type FormatOptions = {
  /** Max fractional digits to show (trailing zeros trimmed). Default: all. */
  maxFraction?: number
  /** Group the integer part with thin spaces. Default false. */
  group?: boolean
}

/** bigint -> plain decimal string, never exponent notation. */
export function formatAmount(amount: bigint, decimals: number, opts: FormatOptions = {}): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error(`bad decimals: ${decimals}`)
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const s = abs.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  let frac = decimals === 0 ? '' : s.slice(s.length - decimals)
  if (opts.maxFraction !== undefined) frac = frac.slice(0, Math.max(0, opts.maxFraction))
  frac = frac.replace(/0+$/, '')
  const wholeOut = opts.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : whole
  return (neg ? '-' : '') + wholeOut + (frac ? '.' + frac : '')
}
