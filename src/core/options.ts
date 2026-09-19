/**
 * LayerZero V2 executor options: decode, judge, re-encode.
 *
 * A sample transaction's `extraOptions` may carry a `nativeDrop(amount, receiver)` — native coin
 * delivered on the destination to an arbitrary address, paid for by the sender through the
 * LayerZero fee. Copying that from someone else's tx would hand money to a stranger. So we
 * decode options, keep ONLY plain `lzReceive(gas)` (capped), and drop everything else loudly.
 *
 * Wire format (type 3): 0x0003 then repeated
 *   workerId(1) | optionSize(2) | optionType(1) | option(optionSize-1)
 * Executor (workerId 1) option types: 1 lzReceive(gas u128 [, value u128]),
 *   2 nativeDrop(amount u128, receiver b32), 3 lzCompose(index u16, gas u128 [, value u128]),
 *   4 orderedExecution. DVN options (workerId 2) are opaque.
 * Legacy type 1: 0x0001 | gas u256.  Legacy type 2: 0x0002 | gas u256 | value u256 | receiver b32.
 */
import type { Hex } from 'viem'

/** Anything above this is not a real receive; it only inflates the fee. Typical OFT: 60k–300k. */
export const MAX_LZ_RECEIVE_GAS = 2_000_000n

export type OptionItem =
  | { kind: 'lzReceive'; gas: bigint; value: bigint }
  | { kind: 'nativeDrop'; amount: bigint; receiver: Hex }
  | { kind: 'lzCompose'; index: number; gas: bigint; value: bigint }
  | { kind: 'ordered' }
  | { kind: 'dvn'; dvnIdx: number; optionType: number; data: Hex }
  | { kind: 'unknown'; workerId: number; optionType: number; data: Hex }

export type DecodedOptions = { type: 1 | 2 | 3; items: OptionItem[] }

export class OptionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OptionsError'
  }
}

const strip = (h: Hex) => h.slice(2).toLowerCase()
const big = (hex: string) => (hex === '' ? 0n : BigInt('0x' + hex))

/** Throws OptionsError on malformed input. `0x` decodes to type 3 with no items. */
export function decodeOptions(options: Hex): DecodedOptions {
  const h = strip(options)
  if (!/^([0-9a-f]{2})*$/.test(h)) throw new OptionsError('not hex')
  if (h === '') return { type: 3, items: [] }
  if (h.length < 4) throw new OptionsError('too short')
  const type = Number(big(h.slice(0, 4)))
  const body = h.slice(4)

  if (type === 1) {
    if (body.length !== 64) throw new OptionsError('type 1: expected 32-byte gas')
    return { type: 1, items: [{ kind: 'lzReceive', gas: big(body), value: 0n }] }
  }
  if (type === 2) {
    if (body.length !== 64 * 3) throw new OptionsError('type 2: expected gas, value, receiver')
    const gas = big(body.slice(0, 64))
    const value = big(body.slice(64, 128))
    const receiver = ('0x' + body.slice(128, 192)) as Hex
    return { type: 2, items: [{ kind: 'lzReceive', gas, value: 0n }, { kind: 'nativeDrop', amount: value, receiver }] }
  }
  if (type !== 3) throw new OptionsError(`unknown options type ${type}`)

  const items: OptionItem[] = []
  let i = 0
  while (i < body.length) {
    if (body.length - i < 8) throw new OptionsError('type 3: truncated header')
    const workerId = Number(big(body.slice(i, i + 2)))
    const size = Number(big(body.slice(i + 2, i + 6)))
    const optionType = Number(big(body.slice(i + 6, i + 8)))
    const dataStart = i + 8
    const dataEnd = i + 6 + size * 2
    if (size < 1 || dataEnd > body.length) throw new OptionsError('type 3: bad option size')
    const data = body.slice(dataStart, dataEnd)
    i = dataEnd

    if (workerId === 1) {
      if (optionType === 1 && (data.length === 32 || data.length === 64)) {
        items.push({ kind: 'lzReceive', gas: big(data.slice(0, 32)), value: big(data.slice(32)) })
      } else if (optionType === 2 && data.length === 32 + 64) {
        items.push({ kind: 'nativeDrop', amount: big(data.slice(0, 32)), receiver: ('0x' + data.slice(32)) as Hex })
      } else if (optionType === 3 && (data.length === 4 + 32 || data.length === 4 + 64)) {
        items.push({ kind: 'lzCompose', index: Number(big(data.slice(0, 4))), gas: big(data.slice(4, 36)), value: big(data.slice(36)) })
      } else if (optionType === 4 && data.length === 0) {
        items.push({ kind: 'ordered' })
      } else {
        items.push({ kind: 'unknown', workerId, optionType, data: ('0x' + data) as Hex })
      }
    } else if (workerId === 2) {
      // DVN layout: workerId | size | dvnIdx | dvnOptionType | data — the byte parsed as
      // `optionType` above is the dvnIdx here.
      items.push({ kind: 'dvn', dvnIdx: optionType, optionType: Number(big(data.slice(0, 2))), data: ('0x' + data.slice(2)) as Hex })
    } else {
      items.push({ kind: 'unknown', workerId, optionType, data: ('0x' + data) as Hex })
    }
  }
  return { type: 3, items }
}

/** Encodes plain lzReceive(gas) executor options as type 3. gas = 0 -> '0x'. */
export function encodeLzReceiveGas(gas: bigint): Hex {
  if (gas <= 0n) return '0x'
  if (gas >= 1n << 128n) throw new OptionsError('gas does not fit u128')
  const g = gas.toString(16).padStart(32, '0')
  // type 0003 | workerId 01 | size 0011 (1 type byte + 16 gas bytes) | optionType 01 | gas u128
  return `0x000301001101${g}` as Hex
}

export type SanitizedOptions = {
  /** What we will actually send. Only lzReceive gas, capped, or '0x'. */
  options: Hex
  /** Items that were removed from the sample; non-empty means "show a red warning". */
  dropped: OptionItem[]
  /** True when the sample was malformed and ignored entirely. */
  malformed: boolean
}

/**
 * Reduces someone else's options to the only thing that is safe to reuse: a receive-gas hint.
 * nativeDrop, lzCompose, lzReceive value, DVN and unknown options are dropped and reported.
 */
export function sanitizeOptions(sample: Hex): SanitizedOptions {
  let decoded: DecodedOptions
  try {
    decoded = decodeOptions(sample)
  } catch {
    return { options: '0x', dropped: [], malformed: true }
  }
  const dropped: OptionItem[] = []
  let gas = 0n
  for (const it of decoded.items) {
    if (it.kind === 'lzReceive' && it.value === 0n && it.gas <= MAX_LZ_RECEIVE_GAS) {
      gas = it.gas > gas ? it.gas : gas
    } else if (it.kind === 'ordered') {
      // harmless, but not needed for an OFT transfer; drop silently
    } else {
      dropped.push(it)
    }
  }
  return { options: encodeLzReceiveGas(gas), dropped, malformed: false }
}

/** True when options carry anything that moves value or calls code beyond a plain receive. */
export function hasDangerousOptions(options: Hex): boolean {
  try {
    return decodeOptions(options).items.some(
      (it) => it.kind === 'nativeDrop' || it.kind === 'lzCompose' || (it.kind === 'lzReceive' && it.value > 0n) || it.kind === 'unknown',
    )
  } catch {
    return true
  }
}
