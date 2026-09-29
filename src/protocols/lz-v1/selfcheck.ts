/**
 * §3 + the recipient check: read the calldata back, the way the contract on the other side reads
 * it, and refuse if it is not the transfer on screen.
 *
 * This decoder shares NOTHING with the encoder in plan.ts — no helper, no ABI decode, no
 * address-to-bytes32 utility. It walks the raw words itself. That is the whole point: a self-check
 * built out of the same functions that produced the bytes can only ever confirm that those
 * functions agree with themselves. A bug in `toWireRecipient` would pass such a check and lose
 * the funds anyway.
 *
 * What "the way the contract reads it" means, from the destination's own code:
 *
 *   bytes      OFTCore._sendAck:      `address to = toAddressBytes.toAddress(0)`
 *              BytesLib.toAddress(b, 0) takes the FIRST 20 bytes. A 32-byte left-padded address
 *              would therefore be read as `0x0000…0000` — twelve zero bytes and the first eight
 *              of the real address. So the length must be exactly 20, and nothing else passes.
 *
 *   bytes32    OFTCoreV2._decodeSendPayload:  `to = _payload.toAddress(13)  // drop the first 12
 *              bytes of bytes32`. The high 12 bytes are ignored by the contract, which is exactly
 *              why they must be checked here: a right-padded bytes32 would deliver to a different
 *              address than the one shown, and the contract would never notice.
 *
 * The selector is checked against the table derived from the signatures (abi.ts), because the
 * three `sendFrom`s differ by one argument in the middle and decoding with the wrong one would
 * line `_minAmount` up against a recipient.
 */
import type { Address, Hex } from 'viem'
import { SEND_FROM_SELECTOR, WIRE_OF_SELECTOR, type V1Wire } from './abi'
import type { V1SendPlan } from './plan'

export type V1SelfCheckResult = { ok: true } | { ok: false; mismatches: string[] }

/** What the calldata says, as an independent reading of it. */
export type DecodedV1Send = {
  wire: V1Wire
  from: Address
  dstChainId: number
  /** `_toAddress` exactly as it appears on the wire. */
  toRaw: Hex
  /** The address the DESTINATION contract will credit, by its own rule. */
  recipient: Address
  amount: bigint
  /** `bytes32_fee` only. */
  minAmount: bigint | undefined
  refundAddress: Address
  zroPaymentAddress: Address
  adapterParams: Hex
}

export class V1DecodeError extends Error {
  constructor(
    public readonly code:
      | 'not_hex'
      | 'too_short'
      | 'unknown_selector'
      | 'wrong_selector'
      | 'truncated'
      | 'bad_offset'
      | 'to_length'
      | 'to_not_left_padded'
      | 'dirty_word',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'V1DecodeError'
  }
}

const HEX = /^0x[0-9a-fA-F]*$/

/** A 32-byte word at word index `i` of the argument area (after the 4-byte selector). */
function word(body: string, i: number): string {
  const start = i * 64
  const w = body.slice(start, start + 64)
  if (w.length !== 64) throw new V1DecodeError('truncated', `word ${i}`)
  return w
}

const asBig = (w: string): bigint => BigInt(`0x${w}`)

/** An ABI `address` word: 12 zero bytes then 20 bytes. A dirty high half is never an address. */
function addressAt(body: string, i: number, what: string): Address {
  const w = word(body, i)
  if (w.slice(0, 24) !== '0'.repeat(24)) throw new V1DecodeError('dirty_word', `${what} has a non-zero high half`)
  return `0x${w.slice(24)}` as Address
}

/** An ABI `uint16` word, checked to actually fit in uint16. */
function uint16At(body: string, i: number, what: string): number {
  const v = asBig(word(body, i))
  if (v > 0xffffn) throw new V1DecodeError('dirty_word', `${what} does not fit in uint16`)
  return Number(v)
}

/**
 * A dynamic `bytes` at the offset stored in word `i`. Returns the raw hex, no 0x prefix.
 * `body` is the area offsets are measured from — the argument area, or a dynamic tuple's own
 * start, since an offset inside a tuple is relative to the tuple rather than to the call.
 */
function bytesAt(body: string, i: number): string {
  const off = asBig(word(body, i))
  if (off % 32n !== 0n || off > BigInt(body.length / 2)) throw new V1DecodeError('bad_offset', `word ${i} offset ${off}`)
  const at = Number(off) * 2
  const lenHex = body.slice(at, at + 64)
  if (lenHex.length !== 64) throw new V1DecodeError('truncated', `length of word ${i}`)
  const len = Number(asBig(lenHex))
  const data = body.slice(at + 64, at + 64 + len * 2)
  if (data.length !== len * 2) throw new V1DecodeError('truncated', `data of word ${i}`)
  return data
}

/**
 * The recipient, read as the destination contract reads it.
 *
 * `bytes`   → the first 20 bytes, and the length must be exactly 20.
 * `bytes32` → the last 20 bytes, and the first 12 must be zero.
 */
export function readRecipient(wire: V1Wire, toRaw: Hex): Address {
  const h = toRaw.slice(2).toLowerCase()
  if (wire === 'bytes') {
    if (h.length !== 40) throw new V1DecodeError('to_length', `_toAddress is ${h.length / 2} bytes, must be exactly 20`)
    return `0x${h}` as Address
  }
  if (h.length !== 64) throw new V1DecodeError('to_length', `_toAddress is ${h.length / 2} bytes, must be 32`)
  if (h.slice(0, 24) !== '0'.repeat(24)) throw new V1DecodeError('to_not_left_padded', `_toAddress is not a left-padded address: ${toRaw}`)
  return `0x${h.slice(24)}` as Address
}

/**
 * Decodes a v1 `sendFrom` from raw calldata, for the wire shape that was detected.
 *
 * `expect` is the standard the contract was probed to be. The selector must be that standard's,
 * not merely one of the three: a plain OFTV2 asked to run OFTWithFee's calldata would revert, but
 * the reverse mix-up reads `_minAmount` where the call params begin.
 */
export function decodeV1SendCalldata(data: Hex, expect: V1Wire): DecodedV1Send {
  if (typeof data !== 'string' || !HEX.test(data)) throw new V1DecodeError('not_hex')
  if (data.length < 10) throw new V1DecodeError('too_short')
  const selector = data.slice(0, 10).toLowerCase() as Hex
  const wire = WIRE_OF_SELECTOR.get(selector)
  if (!wire) throw new V1DecodeError('unknown_selector', selector)
  if (wire !== expect) {
    throw new V1DecodeError('wrong_selector', `${selector} is ${wire}'s sendFrom, but this contract is ${expect}`)
  }
  const body = data.slice(10).toLowerCase()

  if (wire === 'bytes') {
    // (address, uint16, bytes, uint256, address, address, bytes)
    const toRaw = `0x${bytesAt(body, 2)}` as Hex
    return {
      wire,
      from: addressAt(body, 0, '_from'),
      dstChainId: uint16At(body, 1, '_dstChainId'),
      toRaw,
      recipient: readRecipient(wire, toRaw),
      amount: asBig(word(body, 3)),
      minAmount: undefined,
      refundAddress: addressAt(body, 4, '_refundAddress'),
      zroPaymentAddress: addressAt(body, 5, '_zroPaymentAddress'),
      adapterParams: `0x${bytesAt(body, 6)}` as Hex,
    }
  }

  // Both bytes32 shapes end in LzCallParams, a dynamic tuple reached through an offset.
  const minAmount = wire === 'bytes32_fee' ? asBig(word(body, 4)) : undefined
  const tupleWord = wire === 'bytes32_fee' ? 5 : 4
  const tupleOff = asBig(word(body, tupleWord))
  if (tupleOff % 32n !== 0n) throw new V1DecodeError('bad_offset', `LzCallParams offset ${tupleOff}`)
  const tupleBase = Number(tupleOff) * 2
  const tuple = body.slice(tupleBase)
  if (tuple.length < 64 * 3) throw new V1DecodeError('truncated', 'LzCallParams')
  const toRaw = `0x${word(body, 2)}` as Hex
  return {
    wire,
    from: addressAt(body, 0, '_from'),
    dstChainId: uint16At(body, 1, '_dstChainId'),
    toRaw,
    recipient: readRecipient(wire, toRaw),
    amount: asBig(word(body, 3)),
    minAmount,
    refundAddress: addressAt(tuple, 0, 'refundAddress'),
    zroPaymentAddress: addressAt(tuple, 1, 'zroPaymentAddress'),
    // Offsets inside a dynamic tuple are relative to the tuple's own start.
    adapterParams: `0x${bytesAt(tuple, 2)}` as Hex,
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const ZERO = `0x${'0'.repeat(40)}`

/**
 * Every field of the calldata against the plan on screen. Any difference blocks the send.
 *
 * `recipient` is compared twice on purpose: once as the raw wire value the plan committed to, and
 * once as the address the destination will actually credit. The two can only disagree if the
 * encoder and this decoder disagree — which is precisely the failure this check exists to catch.
 *
 * Whether the recipient may differ from the connected wallet is guard 3's question, not this
 * one's: here the only claim is that the bytes say what the screen says.
 */
export function v1SelfCheck(plan: V1SendPlan, calldata: Hex): V1SelfCheckResult {
  const mismatches: string[] = []
  let d: DecodedV1Send
  try {
    d = decodeV1SendCalldata(calldata, plan.standard.wire)
  } catch (e) {
    return { ok: false, mismatches: [`decode: ${e instanceof Error ? e.message : String(e)}`] }
  }

  if (!same(calldata.slice(0, 10), SEND_FROM_SELECTOR[plan.standard.wire])) mismatches.push('selector')
  if (!same(d.from, plan.sender)) mismatches.push('_from != sender')
  if (d.dstChainId !== plan.dst.v1ChainId) mismatches.push('_dstChainId')
  if (!same(d.toRaw, plan.toWire)) mismatches.push('_toAddress')
  if (!same(d.recipient, plan.recipient)) mismatches.push('recipient the destination would credit')
  if (same(d.recipient, ZERO)) mismatches.push('recipient is the zero address')
  if (d.amount !== plan.amounts.amountLD) mismatches.push('_amount')
  if (d.minAmount !== plan.amounts.minAmountLD) mismatches.push('_minAmount')
  if (!same(d.refundAddress, plan.sender)) mismatches.push('refundAddress != sender')
  if (!same(d.zroPaymentAddress, ZERO)) mismatches.push('zroPaymentAddress is not zero')
  if (!same(d.adapterParams, plan.adapterParams)) mismatches.push('adapterParams')

  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches }
}
