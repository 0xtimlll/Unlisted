/**
 * v1 `adapterParams` — the bytes that tell the relayer how much gas to buy on the destination.
 *
 * Layout, quoted from RelayerV2.sol (LayerZero-Labs/LayerZero, contracts/RelayerV2.sol):
 *
 *   // txType 1
 *   // bytes  [2       32      ]
 *   // fields [txType  extraGas]
 *   // txType 2
 *   // bytes  [2       32        32            bytes[]         ]
 *   // fields [txType  extraGas  dstNativeAmt  dstNativeAddress]
 *
 *   require(_adapterParameters.length == 34 || _adapterParameters.length > 66, …)
 *   require(extraGas > 0, "Relayer: gas too low");
 *   require(txType == 1 || txType == 2, "Relayer: unsupported txType");
 *
 * Two consequences this module exists to enforce:
 *
 *   - **Empty is a real answer.** UltraLightNodeV2 substitutes `defaultAdapterParams` whenever the
 *     bytes are empty, in `estimateFees` and again in `_handleRelayer` — the same substitution on
 *     both sides, so an empty quote is the quote for an empty send. An OFT with
 *     `useCustomAdapterParams == false` requires empty bytes, and that is a supported route, not a
 *     gap.
 *   - **txType 2 is a native drop.** It pays native coin to `dstNativeAddress` on the destination,
 *     out of the fee the sender pays. This app never builds one, and refuses to carry one over
 *     from a sample transaction — the same rule the V2 tab applies to `nativeDrop` options.
 *
 * Written independently of core/options.ts: that decoder serves V2's `extraOptions`, where the
 * legacy types are a corner case, and its type-2 length rule is not RelayerV2's. Money-path bytes
 * are parsed here against the contract that actually reads them.
 */
import type { Hex } from 'viem'
import { MAX_LZ_RECEIVE_GAS } from '../../core/options'

/** An OFT that wants no adapter params at all. Never confuse with `0x0001…0`. */
export const EMPTY_ADAPTER_PARAMS: Hex = '0x'

/** The ceiling the V2 tab already applies to a receive-gas hint; v1 gas is the same quantity. */
export const MAX_V1_GAS = MAX_LZ_RECEIVE_GAS

export type AdapterParams =
  | { txType: 1; extraGas: bigint }
  | { txType: 2; extraGas: bigint; dstNativeAmt: bigint; dstNativeAddress: Hex }

export class AdapterParamsError extends Error {
  constructor(
    public readonly code: 'not_hex' | 'bad_length' | 'bad_type' | 'zero_gas' | 'empty',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'AdapterParamsError'
  }
}

const body = (h: Hex): string => h.slice(2).toLowerCase()
const u = (hex: string): bigint => (hex === '' ? 0n : BigInt(`0x${hex}`))

/** `abi.encodePacked(uint16(1), uint256(gas))` — exactly 34 bytes, which is what the relayer checks. */
export function encodeAdapterParamsType1(extraGas: bigint): Hex {
  if (extraGas <= 0n) throw new AdapterParamsError('zero_gas')
  if (extraGas > MAX_V1_GAS) throw new AdapterParamsError('bad_length', `gas ${extraGas} above the ${MAX_V1_GAS} ceiling`)
  return `0x0001${extraGas.toString(16).padStart(64, '0')}` as Hex
}

/**
 * Parses adapter params the way RelayerV2 does. Empty bytes are NOT parsed here — they are a
 * valid value with no fields, so the caller decides what empty means before calling.
 */
export function decodeAdapterParams(h: Hex): AdapterParams {
  const s = body(h)
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new AdapterParamsError('not_hex')
  if (s === '') throw new AdapterParamsError('empty')
  const bytes = s.length / 2
  if (bytes !== 34 && bytes <= 66) throw new AdapterParamsError('bad_length', `${bytes} bytes`)

  const txType = Number(u(s.slice(0, 4)))
  const extraGas = u(s.slice(4, 68))
  if (txType !== 1 && txType !== 2) throw new AdapterParamsError('bad_type', `txType ${txType}`)
  if (extraGas <= 0n) throw new AdapterParamsError('zero_gas')
  if (txType === 1) {
    if (bytes !== 34) throw new AdapterParamsError('bad_length', `txType 1 must be 34 bytes, got ${bytes}`)
    return { txType: 1, extraGas }
  }
  return {
    txType: 2,
    extraGas,
    dstNativeAmt: u(s.slice(68, 132)),
    dstNativeAddress: `0x${s.slice(132)}` as Hex,
  }
}

export type AdapterParamsVerdict =
  /** Empty: the relayer uses this route's defaults, and so does the quote. */
  | { kind: 'empty' }
  | { kind: 'ok'; params: AdapterParams & { txType: 1 } }
  /** Carries a native drop, or does not parse. Never built, never copied. */
  | { kind: 'refused'; reason: 'native_drop' | 'malformed' | 'over_cap'; detail?: string }

/**
 * The one judgement the send path asks for: may these bytes be signed?
 *
 * Only empty or a plain txType 1 within the gas cap ever pass. This is what keeps a sample
 * transaction's native drop from being copied into the user's own send.
 */
export function judgeAdapterParams(h: Hex): AdapterParamsVerdict {
  if (h === '0x') return { kind: 'empty' }
  let p: AdapterParams
  try {
    p = decodeAdapterParams(h)
  } catch (e) {
    return { kind: 'refused', reason: 'malformed', detail: e instanceof Error ? e.message : String(e) }
  }
  if (p.txType === 2) return { kind: 'refused', reason: 'native_drop', detail: `${p.dstNativeAmt} to ${p.dstNativeAddress}` }
  if (p.extraGas > MAX_V1_GAS) return { kind: 'refused', reason: 'over_cap', detail: `${p.extraGas} > ${MAX_V1_GAS}` }
  return { kind: 'ok', params: p }
}

/** The gas a set of adapter params buys, or 0n for empty/unreadable. For display and guards. */
export function adapterParamsGas(h: Hex): bigint {
  const v = judgeAdapterParams(h)
  return v.kind === 'ok' ? v.params.extraGas : 0n
}
