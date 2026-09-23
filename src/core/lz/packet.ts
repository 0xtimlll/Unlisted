/**
 * The LayerZero V2 wire packet, as PacketSent carries it.
 *
 * Layout from PacketV1Codec.sol (LayerZero-Labs/LayerZero-v2,
 * packages/layerzero-v2/evm/protocol/contracts/messagelib/libs/PacketV1Codec.sol):
 *
 *   offset  size  field
 *        0     1  version (must be 1)
 *        1     8  nonce
 *        9     4  srcEid
 *       13    32  sender    (the OApp on the source chain, bytes32)
 *       45     4  dstEid
 *       49    32  receiver  (the OApp on the destination chain, bytes32)
 *       81    32  guid
 *      113     -  message
 *
 * The header is bytes[0:81]; the payload is guid + message.
 */
import type { Hex } from 'viem'

export const PACKET_VERSION = 1

/** Byte offsets, named exactly as in PacketV1Codec. */
export const PACKET_VERSION_OFFSET = 0
export const NONCE_OFFSET = 1
export const SRC_EID_OFFSET = 9
export const SENDER_OFFSET = 13
export const DST_EID_OFFSET = 45
export const RECEIVER_OFFSET = 49
export const GUID_OFFSET = 81
export const MESSAGE_OFFSET = 113

export class PacketError extends Error {
  constructor(
    public readonly code: 'not_hex' | 'too_short' | 'bad_version',
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'PacketError'
  }
}

export type LzPacket = {
  version: number
  nonce: bigint
  srcEid: number
  /** The sending OApp, raw bytes32 (an EVM address is left-padded; a Solana program is 32 real bytes). */
  sender: Hex
  dstEid: number
  /** The receiving OApp, raw bytes32. */
  receiver: Hex
  guid: Hex
  message: Hex
}

/** Hex slice by BYTE offsets, half-open [from, to). `to` omitted means "to the end". */
function slice(hex: string, from: number, to?: number): Hex {
  return `0x${hex.slice(from * 2, to === undefined ? undefined : to * 2)}`
}

const num = (h: Hex): bigint => (h === '0x' ? 0n : BigInt(h))

/** Decodes `PacketSent.encodedPayload`. Throws PacketError on anything that is not a V1 packet. */
export function decodePacket(encodedPayload: Hex): LzPacket {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(encodedPayload)) throw new PacketError('not_hex')
  const h = encodedPayload.slice(2).toLowerCase()
  const bytes = h.length / 2
  if (bytes < MESSAGE_OFFSET) throw new PacketError('too_short', `${bytes} bytes < ${MESSAGE_OFFSET}`)

  const version = Number(num(slice(h, PACKET_VERSION_OFFSET, NONCE_OFFSET)))
  if (version !== PACKET_VERSION) throw new PacketError('bad_version', `version ${version}`)

  return {
    version,
    nonce: num(slice(h, NONCE_OFFSET, SRC_EID_OFFSET)),
    srcEid: Number(num(slice(h, SRC_EID_OFFSET, SENDER_OFFSET))),
    sender: slice(h, SENDER_OFFSET, DST_EID_OFFSET),
    dstEid: Number(num(slice(h, DST_EID_OFFSET, RECEIVER_OFFSET))),
    receiver: slice(h, RECEIVER_OFFSET, GUID_OFFSET),
    guid: slice(h, GUID_OFFSET, MESSAGE_OFFSET),
    message: slice(h, MESSAGE_OFFSET),
  }
}

/** The inverse of decodePacket — used by the round-trip test and by fixtures. */
export function encodePacket(p: LzPacket): Hex {
  const hex = (v: bigint, bytes: number) => v.toString(16).padStart(bytes * 2, '0')
  const raw = (v: Hex) => v.slice(2).toLowerCase()
  return `0x${hex(BigInt(p.version), 1)}${hex(p.nonce, 8)}${hex(BigInt(p.srcEid), 4)}${raw(p.sender)}${hex(BigInt(p.dstEid), 4)}${raw(p.receiver)}${raw(p.guid)}${raw(p.message)}`
}
