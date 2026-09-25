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

export type Vm = 'evm' | 'svm'

/**
 * Per-VM ceilings for what a sample transaction may hand us. On EVM `gas` is gas and `value`
 * is wei delivered to the receiver contract (almost never wanted). On Solana `gas` is COMPUTE
 * UNITS (hard chain limit 1.4M per transaction) and `value` is LAMPORTS the executor drops on
 * the destination — legitimately used to fund a token account, so it is allowed up to a cap.
 */
export const LIMITS: Record<Vm, { maxGas: bigint; maxValue: bigint }> = {
  evm: { maxGas: 2_000_000n, maxValue: 10n ** 16n }, // 0.01 native
  svm: { maxGas: 1_400_000n, maxValue: 10_000_000n }, // 0.01 SOL
}

/** Kept for EVM callers/tests: the EVM gas ceiling. */
export const MAX_LZ_RECEIVE_GAS = LIMITS.evm.maxGas

/** Rent-exempt minimum for an SPL token account (165 bytes). What a receive must carry if the ATA is missing. */
export const ATA_RENT_LAMPORTS = 2_039_280n

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

/** Encodes a single executor lzReceive(gas[, value]) as type-3 options. Both zero -> '0x'. */
export function encodeLzReceive(gas: bigint, value = 0n): Hex {
  if (gas < 0n || value < 0n) throw new OptionsError('negative option field')
  if (gas === 0n && value === 0n) return '0x'
  if (gas >= 1n << 128n || value >= 1n << 128n) throw new OptionsError('option field does not fit u128')
  const g = gas.toString(16).padStart(32, '0')
  if (value === 0n) {
    // type 0003 | workerId 01 | size 0011 (1 type byte + 16 gas bytes) | optionType 01 | gas u128
    return `0x000301001101${g}` as Hex
  }
  const v = value.toString(16).padStart(32, '0')
  // size 0021 = 1 type byte + 16 gas bytes + 16 value bytes
  return `0x000301002101${g}${v}` as Hex
}

/** Back-compat name. */
export const encodeLzReceiveGas = (gas: bigint): Hex => encodeLzReceive(gas, 0n)

export type SanitizedOptions = {
  /** What we will actually send: at most one lzReceive(gas, value) within the VM's caps, or '0x'. */
  options: Hex
  gas: bigint
  value: bigint
  /** Items that were removed from the sample; non-empty means "show a red warning". */
  dropped: OptionItem[]
  /** True when the sample was malformed and ignored entirely. */
  malformed: boolean
}

/**
 * Reduces someone else's options to the only thing that is safe to reuse: one lzReceive with
 * gas/value inside the destination VM's caps. nativeDrop, lzCompose, DVN, unknown options and
 * over-cap receives are dropped and reported.
 */
export function sanitizeOptions(sample: Hex, dstVm: Vm = 'evm'): SanitizedOptions {
  let decoded: DecodedOptions
  try {
    decoded = decodeOptions(sample)
  } catch {
    return { options: '0x', gas: 0n, value: 0n, dropped: [], malformed: true }
  }
  const lim = LIMITS[dstVm]
  const dropped: OptionItem[] = []
  let gas = 0n
  let value = 0n
  for (const it of decoded.items) {
    if (it.kind === 'lzReceive' && it.gas <= lim.maxGas && it.value <= lim.maxValue) {
      gas = it.gas > gas ? it.gas : gas
      value = it.value > value ? it.value : value
    } else if (it.kind === 'ordered') {
      // harmless, but not needed for an OFT transfer; drop silently
    } else {
      dropped.push(it)
    }
  }
  return { options: encodeLzReceive(gas, value), gas, value, dropped, malformed: false }
}

/**
 * §6.16 The SAME judgement, applied to the options the CONTRACT enforces.
 *
 * hasDangerousOptions() below guards `extraOptions` — the field this app fills in itself, and
 * therefore the one it already controls. `enforcedOptions(eid, SEND)` is the other half, and it is
 * the half an attacker actually owns: the executor appends it to every send, the user pays for it
 * through quoteSend, and until now nothing looked at it. A `nativeDrop` enforced by the contract
 * hands the sender's native coin to a fixed address on the destination, on every single transfer.
 *
 * This never blocks. A legitimate OFT may enforce options this app did not expect, and refusing a
 * working route would be worse than saying what is in it — so the result is a warning (§6.16) and
 * the review screen prints the decoded options underneath it.
 */
export type EnforcedRisk = 'native_drop' | 'compose' | 'over_cap' | 'malformed'

export function inspectEnforcedOptions(enforced: Hex, dstVm: Vm = 'evm'): EnforcedRisk[] {
  if (enforced === '0x' || (enforced as string) === '') return []
  let decoded: DecodedOptions
  try {
    decoded = decodeOptions(enforced)
  } catch {
    return ['malformed']
  }
  const lim = LIMITS[dstVm]
  const out = new Set<EnforcedRisk>()
  for (const it of decoded.items) {
    if (it.kind === 'nativeDrop' && it.amount > 0n) out.add('native_drop')
    else if (it.kind === 'lzCompose') out.add('compose')
    else if (it.kind === 'lzReceive' && (it.gas > lim.maxGas || it.value > lim.maxValue)) out.add('over_cap')
    else if (it.kind === 'unknown') out.add('malformed')
  }
  return [...out]
}

/** Enforced options as one line per item, for the review screen. Never throws. */
export function describeOptions(options: Hex): OptionItem[] {
  try {
    return decodeOptions(options).items
  } catch {
    return []
  }
}

/** True when options carry anything beyond a plain receive within the VM's caps. */
export function hasDangerousOptions(options: Hex, dstVm: Vm = 'evm'): boolean {
  const lim = LIMITS[dstVm]
  try {
    return decodeOptions(options).items.some(
      (it) => it.kind === 'nativeDrop' || it.kind === 'lzCompose' || it.kind === 'unknown' || (it.kind === 'lzReceive' && (it.gas > lim.maxGas || it.value > lim.maxValue)),
    )
  } catch {
    return true
  }
}

/** The single lzReceive(gas, value) a set of options amounts to (executor sums repeated ones). */
export function receiveTotals(options: Hex): { gas: bigint; value: bigint } {
  let gas = 0n
  let value = 0n
  try {
    for (const it of decodeOptions(options).items) {
      if (it.kind === 'lzReceive') {
        gas += it.gas
        value += it.value
      }
    }
  } catch {
    /* malformed → zero */
  }
  return { gas, value }
}

export type SvmOptionsPlan = {
  /** extraOptions to put in SendParam (on top of the contract's enforced options). */
  extraOptions: Hex
  /** Lamports we add so a missing token account can be created (0 when enforced already covers it). */
  addedLamports: bigint
  /** Items dropped from the sample, for the UI. */
  dropped: OptionItem[]
  sampleMalformed: boolean
  /** Totals the executor will see: enforced + extra. */
  total: { gas: bigint; value: bigint }
  /** Neither enforced nor extra carries compute units: the message would be undeliverable. */
  error?: 'no_executor_options'
}

/**
 * §5.1 for a Solana destination. Options are ADDED to the contract's enforced options, so:
 *   - never add our own CU when enforced already carries some (they would sum and overpay);
 *   - add lamports for the recipient's token account only if it does not exist AND enforced does
 *     not already carry enough value;
 *   - with nothing enforced and nothing to add, refuse: quoteSend would under-quote and delivery fail.
 */
export function planSvmOptions(p: { enforced: Hex; ataExists: boolean; sample?: Hex }): SvmOptionsPlan {
  const enf = receiveTotals(p.enforced)
  const s = p.sample && p.sample !== '0x' ? sanitizeOptions(p.sample, 'svm') : undefined
  const dropped = s?.dropped ?? []
  const sampleMalformed = s?.malformed ?? false

  // CU: only when the contract enforces none; take the sample's hint if any.
  const gas = enf.gas > 0n ? 0n : (s?.gas ?? 0n)
  // Lamports: rent for a missing ATA, minus what enforced already delivers; never above the cap.
  let value = 0n
  if (!p.ataExists && enf.value < ATA_RENT_LAMPORTS) value = ATA_RENT_LAMPORTS - enf.value
  if (value > LIMITS.svm.maxValue) value = LIMITS.svm.maxValue

  const extraOptions = encodeLzReceive(gas, value)
  const total = { gas: enf.gas + gas, value: enf.value + value }
  const out: SvmOptionsPlan = { extraOptions, addedLamports: value, dropped, sampleMalformed, total }
  if (total.gas === 0n) out.error = 'no_executor_options'
  return out
}
