import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { ATA_RENT_LAMPORTS, decodeOptions, encodeLzReceive, encodeLzReceiveGas, hasDangerousOptions, LIMITS, MAX_LZ_RECEIVE_GAS, OptionsError, planSvmOptions, receiveTotals, sanitizeOptions } from '@/core/options'

const ATTACKER = '0x000000000000000000000000badbadbadbadbadbadbadbadbadbadbadbadbad0' as Hex

// Real enforced options seen on TREAD: type 3, executor lzReceive gas 60000 (0xea60).
const TREAD_ENFORCED: Hex = '0x0003010011010000000000000000000000000000ea60'

/** Builds a type-3 executor option: workerId 01 | size | type | data. */
function exec(type: number, dataHex: string): string {
  const size = (dataHex.length / 2 + 1).toString(16).padStart(4, '0')
  return `01${size}${type.toString(16).padStart(2, '0')}${dataHex}`
}
const u128 = (n: bigint) => n.toString(16).padStart(32, '0')
const u16 = (n: number) => n.toString(16).padStart(4, '0')
const t3 = (...parts: string[]): Hex => `0x0003${parts.join('')}` as Hex

describe('decodeOptions', () => {
  it('decodes real enforced options (lzReceive gas only)', () => {
    expect(decodeOptions(TREAD_ENFORCED)).toEqual({ type: 3, items: [{ kind: 'lzReceive', gas: 60000n, value: 0n }] })
  })
  it('empty is type 3 with no items', () => {
    expect(decodeOptions('0x')).toEqual({ type: 3, items: [] })
  })
  it('decodes nativeDrop, lzCompose, ordered and DVN options', () => {
    const o = t3(
      exec(1, u128(200000n)),
      exec(2, u128(10n ** 18n) + ATTACKER.slice(2)),
      exec(3, u16(0) + u128(50000n)),
      exec(4, ''),
      `0200030000aa`, // workerId 2 (DVN), size 3: dvnIdx 00, type 00, data aa
    )
    const d = decodeOptions(o)
    expect(d.type).toBe(3)
    expect(d.items).toEqual([
      { kind: 'lzReceive', gas: 200000n, value: 0n },
      { kind: 'nativeDrop', amount: 10n ** 18n, receiver: ATTACKER },
      { kind: 'lzCompose', index: 0, gas: 50000n, value: 0n },
      { kind: 'ordered' },
      { kind: 'dvn', dvnIdx: 0, optionType: 0, data: '0xaa' },
    ])
  })
  it('decodes lzReceive with value', () => {
    const d = decodeOptions(t3(exec(1, u128(100000n) + u128(5n))))
    expect(d.items[0]).toEqual({ kind: 'lzReceive', gas: 100000n, value: 5n })
  })
  it('decodes legacy type 1 and type 2', () => {
    const gas = 200000n.toString(16).padStart(64, '0')
    expect(decodeOptions(`0x0001${gas}`)).toEqual({ type: 1, items: [{ kind: 'lzReceive', gas: 200000n, value: 0n }] })
    const value = (10n ** 17n).toString(16).padStart(64, '0')
    const d = decodeOptions(`0x0002${gas}${value}${ATTACKER.slice(2)}`)
    expect(d.type).toBe(2)
    expect(d.items[1]).toEqual({ kind: 'nativeDrop', amount: 10n ** 17n, receiver: ATTACKER })
  })
  it('rejects malformed input', () => {
    for (const bad of ['0x00', '0x0003' + '01', '0x0003' + '01ffff01', '0x0009' + '00', '0xzz', `0x0001${'00'.repeat(31)}`]) {
      expect(() => decodeOptions(bad as Hex)).toThrow(OptionsError)
    }
  })
})

describe('encodeLzReceiveGas', () => {
  it('round-trips through decodeOptions', () => {
    for (const g of [1n, 60000n, 200000n, MAX_LZ_RECEIVE_GAS]) {
      expect(decodeOptions(encodeLzReceiveGas(g))).toEqual({ type: 3, items: [{ kind: 'lzReceive', gas: g, value: 0n }] })
    }
    expect(encodeLzReceiveGas(60000n)).toBe(TREAD_ENFORCED)
    expect(encodeLzReceiveGas(0n)).toBe('0x')
  })
})

describe('sanitizeOptions — the sample-tx attack', () => {
  it('keeps a plain receive-gas hint', () => {
    expect(sanitizeOptions(TREAD_ENFORCED)).toEqual({ options: TREAD_ENFORCED, gas: 60000n, value: 0n, dropped: [], malformed: false })
  })
  it('DROPS a nativeDrop to a stranger and reports it', () => {
    const sample = t3(exec(1, u128(200000n)), exec(2, u128(10n ** 18n) + ATTACKER.slice(2)))
    const s = sanitizeOptions(sample)
    expect(s.options).toBe(encodeLzReceiveGas(200000n))
    expect(s.dropped).toEqual([{ kind: 'nativeDrop', amount: 10n ** 18n, receiver: ATTACKER }])
    expect(hasDangerousOptions(s.options)).toBe(false)
    expect(hasDangerousOptions(sample)).toBe(true)
  })
  it('drops compose, DVN and unknown options; a small receive value is kept within the EVM cap', () => {
    const sample = t3(exec(1, u128(100000n) + u128(1n)), exec(3, u16(0) + u128(50000n)), `0200030000aa`, exec(9, 'ff'))
    const s = sanitizeOptions(sample)
    expect(s.gas).toBe(100000n)
    expect(s.value).toBe(1n)
    expect(s.dropped.map((d) => d.kind)).toEqual(['lzCompose', 'dvn', 'unknown'])
  })
  it('EVM: a receive value above 0.01 native is dropped like a native drop', () => {
    const s = sanitizeOptions(t3(exec(1, u128(100000n) + u128(LIMITS.evm.maxValue + 1n))))
    expect(s.options).toBe('0x')
    expect(s.dropped).toHaveLength(1)
  })
  it('drops absurd gas (fee inflation)', () => {
    const s = sanitizeOptions(t3(exec(1, u128(MAX_LZ_RECEIVE_GAS + 1n))))
    expect(s.options).toBe('0x')
    expect(s.dropped).toHaveLength(1)
  })
  it('legacy type 2 loses its native drop', () => {
    const gas = 200000n.toString(16).padStart(64, '0')
    const value = (10n ** 17n).toString(16).padStart(64, '0')
    const s = sanitizeOptions(`0x0002${gas}${value}${ATTACKER.slice(2)}`)
    expect(s.options).toBe(encodeLzReceiveGas(200000n))
    expect(s.dropped[0]?.kind).toBe('nativeDrop')
  })
  it('malformed sample → nothing copied, flagged', () => {
    expect(sanitizeOptions('0x0003ff' as Hex)).toEqual({ options: '0x', gas: 0n, value: 0n, dropped: [], malformed: true })
  })
  it('output is always plain or empty', () => {
    for (const sample of [TREAD_ENFORCED, '0x', t3(exec(2, u128(1n) + ATTACKER.slice(2))), '0xdeadbeef'] as Hex[]) {
      expect(hasDangerousOptions(sanitizeOptions(sample).options)).toBe(false)
    }
  })
})

describe('hasDangerousOptions', () => {
  it('malformed counts as dangerous', () => {
    expect(hasDangerousOptions('0x0003ff' as Hex)).toBe(true)
  })
  it('plain gas and empty are safe', () => {
    expect(hasDangerousOptions('0x')).toBe(false)
    expect(hasDangerousOptions(TREAD_ENFORCED)).toBe(false)
  })
})

describe('Solana (svm) options', () => {
  const PENGU_ENFORCED: Hex = '0x00030100210100000000000000000000000000030d40000000000000000000000000002625a0' // 200k CU + 2.5M lamports (real)
  const GAS_ONLY: Hex = encodeLzReceive(150000n)

  it('encodeLzReceive with value round-trips and matches the real enforced-options wire format', () => {
    expect(encodeLzReceive(200000n, 2500000n)).toBe(PENGU_ENFORCED)
    expect(decodeOptions(PENGU_ENFORCED).items).toEqual([{ kind: 'lzReceive', gas: 200000n, value: 2500000n }])
    expect(receiveTotals(PENGU_ENFORCED)).toEqual({ gas: 200000n, value: 2500000n })
    expect(receiveTotals('0x')).toEqual({ gas: 0n, value: 0n })
  })
  it('caps: 1.4M CU and 0.01 SOL; above either the receive is dropped', () => {
    expect(sanitizeOptions(t3(exec(1, u128(1_400_000n))), 'svm').gas).toBe(1_400_000n)
    expect(sanitizeOptions(t3(exec(1, u128(1_400_001n))), 'svm').dropped).toHaveLength(1)
    expect(sanitizeOptions(t3(exec(1, u128(100n) + u128(10_000_000n))), 'svm').value).toBe(10_000_000n)
    expect(sanitizeOptions(t3(exec(1, u128(100n) + u128(10_000_001n))), 'svm').options).toBe('0x')
    expect(hasDangerousOptions(t3(exec(1, u128(100n) + u128(10_000_000n))), 'svm')).toBe(false)
    expect(hasDangerousOptions(t3(exec(1, u128(100n) + u128(10_000_001n))), 'svm')).toBe(true)
    expect(hasDangerousOptions(t3(exec(1, u128(2_000_000n))), 'svm')).toBe(true) // fine on EVM, over the CU limit on svm
    expect(hasDangerousOptions(t3(exec(1, u128(2_000_000n))), 'evm')).toBe(false)
  })
  it('planSvmOptions: enforced already funds the ATA → nothing added, even when the ATA is missing', () => {
    const p = planSvmOptions({ enforced: PENGU_ENFORCED, ataExists: false })
    expect(p.extraOptions).toBe('0x')
    expect(p.addedLamports).toBe(0n)
    expect(p.total).toEqual({ gas: 200000n, value: 2500000n })
    expect(p.error).toBeUndefined()
  })
  it('planSvmOptions: enforced has CU only and the ATA is missing → add exactly the rent, no CU', () => {
    const p = planSvmOptions({ enforced: GAS_ONLY, ataExists: false })
    expect(p.extraOptions).toBe(encodeLzReceive(0n, ATA_RENT_LAMPORTS))
    expect(p.addedLamports).toBe(ATA_RENT_LAMPORTS)
    expect(p.total).toEqual({ gas: 150000n, value: ATA_RENT_LAMPORTS })
    // partial coverage: top up only the difference
    const q = planSvmOptions({ enforced: encodeLzReceive(150000n, 1_000_000n), ataExists: false })
    expect(q.addedLamports).toBe(ATA_RENT_LAMPORTS - 1_000_000n)
  })
  it('planSvmOptions: ATA exists → extra options empty', () => {
    expect(planSvmOptions({ enforced: GAS_ONLY, ataExists: true }).extraOptions).toBe('0x')
    expect(planSvmOptions({ enforced: PENGU_ENFORCED, ataExists: true }).extraOptions).toBe('0x')
  })
  it('planSvmOptions: nothing enforced → CU must come from the sample, else refuse', () => {
    const none = planSvmOptions({ enforced: '0x', ataExists: true })
    expect(none.error).toBe('no_executor_options')
    const fromSample = planSvmOptions({ enforced: '0x', ataExists: false, sample: t3(exec(1, u128(120000n))) })
    expect(fromSample.error).toBeUndefined()
    expect(fromSample.extraOptions).toBe(encodeLzReceive(120000n, ATA_RENT_LAMPORTS))
    // a sample with a native drop contributes nothing but a red flag
    const bad = planSvmOptions({ enforced: '0x', ataExists: true, sample: t3(exec(2, u128(1n) + ATTACKER.slice(2))) })
    expect(bad.error).toBe('no_executor_options')
    expect(bad.dropped[0]?.kind).toBe('nativeDrop')
  })
  it('planSvmOptions: enforced CU present → a sample never adds CU (would sum and overpay)', () => {
    const p = planSvmOptions({ enforced: GAS_ONLY, ataExists: true, sample: t3(exec(1, u128(900000n))) })
    expect(p.extraOptions).toBe('0x')
    expect(p.total.gas).toBe(150000n)
  })
})
