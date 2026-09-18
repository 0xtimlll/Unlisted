import { describe, expect, it } from 'vitest'
import { AmountError, applyBps, ceilToStep, formatAmount, parseAmount, trimDust } from '@/core/amounts'

describe('parseAmount', () => {
  it.each([
    ['1', 18, 10n ** 18n],
    ['19.82', 18, 19_820000000000000000n],
    ['0.000001', 6, 1n],
    ['1.5', 6, 1_500000n],
    ['0.00000001', 8, 1n],
    ['21000000', 8, 21000000n * 10n ** 8n],
    ['1.123456789', 9, 1_123456789n],
    ['0', 18, 0n],
    ['0.0', 18, 0n],
    ['.5', 18, 5n * 10n ** 17n],
    ['5.', 18, 5n * 10n ** 18n],
    ['  12  ', 6, 12_000000n],
    ['1,5', 18, 15n * 10n ** 17n],
    ['1 000 000', 6, 1_000_000_000000n],
    ['1_000.25', 2, 100025n],
    ['007', 0, 7n],
    ['123456789012345678901234567890', 18, 123456789012345678901234567890n * 10n ** 18n],
  ])('parses %s @ %d decimals', (input, decimals, expected) => {
    expect(parseAmount(input, decimals)).toBe(expected)
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['-1', 'negative'],
    ['1e3', 'invalid'],
    ['1E18', 'invalid'],
    ['abc', 'invalid'],
    ['0x10', 'invalid'],
    ['1.2.3', 'invalid'],
    ['+1', 'invalid'],
    ['1.5', 'too_many_decimals', 0],
    ['1.1234567', 'too_many_decimals', 6],
    ['0.0000000000000000001', 'too_many_decimals', 18],
    ['Infinity', 'invalid'],
    ['NaN', 'invalid'],
  ])('rejects %s -> %s', (input, code, decimals = 18) => {
    expect(() => parseAmount(input, decimals)).toThrow(AmountError)
    try {
      parseAmount(input, decimals)
    } catch (e) {
      expect((e as AmountError).code).toBe(code)
    }
  })

  it('rejects bad decimals', () => {
    expect(() => parseAmount('1', -1)).toThrow()
    expect(() => parseAmount('1', 1.5)).toThrow()
  })

  it('never goes through floats (precision beyond 2^53)', () => {
    expect(parseAmount('9007199254740993', 0)).toBe(9007199254740993n)
    expect(parseAmount('0.123456789012345678', 18)).toBe(123456789012345678n)
  })
})

describe('trimDust', () => {
  const rate = 10n ** 12n // decimals 18, shared 6
  it('is identity when rate = 1', () => {
    expect(trimDust(123456789n, 1n)).toBe(123456789n)
  })
  it('rounds down to a multiple of rate', () => {
    expect(trimDust(19_820000000000000000n, rate)).toBe(19_820000000000000000n)
    expect(trimDust(19_820000000000000001n, rate)).toBe(19_820000000000000000n)
    expect(trimDust(1_234567891234567890n, rate)).toBe(1_234567000000000000n)
    expect(trimDust(999_999_999_999n, rate)).toBe(0n)
    expect(trimDust(rate, rate)).toBe(rate)
    expect(trimDust(0n, rate)).toBe(0n)
  })
  it('result is always a multiple of rate and <= amount', () => {
    for (const a of [1n, 7n, 10n ** 12n + 1n, 3n * 10n ** 18n + 5n, 2n ** 128n]) {
      const t = trimDust(a, rate)
      expect(t % rate).toBe(0n)
      expect(t <= a).toBe(true)
      expect(a - t < rate).toBe(true)
    }
  })
  it('rejects bad input', () => {
    expect(() => trimDust(1n, 0n)).toThrow()
    expect(() => trimDust(-1n, 1n)).toThrow()
  })
})

describe('ceilToStep', () => {
  const step = 10n ** 16n // 0.01
  it('rounds up', () => {
    // 0.02912 -> 0.03
    expect(ceilToStep(29_120000000000000n, step)).toBe(30_000000000000000n)
    expect(ceilToStep(30_000000000000000n, step)).toBe(30_000000000000000n)
    expect(ceilToStep(1n, step)).toBe(step)
    expect(ceilToStep(0n, step)).toBe(0n)
  })
  it('step <= 0 is identity', () => {
    expect(ceilToStep(123n, 0n)).toBe(123n)
    expect(ceilToStep(123n, -5n)).toBe(123n)
  })
  it('never rounds down', () => {
    for (const x of [1n, 999n, 10n ** 16n - 1n, 10n ** 16n + 1n, 10n ** 30n + 7n]) {
      const y = ceilToStep(x, step)
      expect(y >= x).toBe(true)
      expect(y % step).toBe(0n)
      expect(y - x < step).toBe(true)
    }
  })
})

describe('applyBps', () => {
  it('multiplies before dividing', () => {
    expect(applyBps(10000n, 10000)).toBe(10000n)
    expect(applyBps(10000n, 9950)).toBe(9950n)
    expect(applyBps(3n, 14000)).toBe(4n) // 3*1.4 = 4.2 -> 4
    expect(applyBps(1n, 5000)).toBe(0n)
    expect(applyBps(20_800000000000000n, 14000)).toBe(29_120000000000000n)
  })
  it('rejects bad bps', () => {
    expect(() => applyBps(1n, -1)).toThrow()
    expect(() => applyBps(1n, 1.5)).toThrow()
  })
})

describe('formatAmount', () => {
  it('never uses exponent notation', () => {
    expect(formatAmount(10n ** 30n, 18)).toBe('1000000000000')
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001')
    expect(formatAmount(10n ** 40n, 0)).toBe('1' + '0'.repeat(40))
  })
  it('trims trailing zeros and handles zero', () => {
    expect(formatAmount(19_820000000000000000n, 18)).toBe('19.82')
    expect(formatAmount(0n, 18)).toBe('0')
    expect(formatAmount(5n * 10n ** 17n, 18)).toBe('0.5')
    expect(formatAmount(1_500000n, 6)).toBe('1.5')
    expect(formatAmount(42n, 0)).toBe('42')
  })
  it('respects maxFraction and grouping', () => {
    expect(formatAmount(1_234567n, 6, { maxFraction: 2 })).toBe('1.23')
    expect(formatAmount(1_200000n, 6, { maxFraction: 4 })).toBe('1.2')
    expect(formatAmount(1234567_000000n, 6, { group: true })).toBe('1 234 567')
  })
  it('round-trips with parseAmount', () => {
    for (const [s, d] of [
      ['19.82', 18],
      ['0.000001', 6],
      ['123456.789', 9],
    ] as const) {
      expect(formatAmount(parseAmount(s, d), d)).toBe(s)
    }
  })
  it('handles negatives (display only)', () => {
    expect(formatAmount(-1_500000n, 6)).toBe('-1.5')
  })
})
