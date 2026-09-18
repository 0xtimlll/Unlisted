/**
 * bytes32 <-> address helpers. EVM recipients are 12 zero bytes + 20-byte address.
 */
import { getAddress, isAddress, pad, type Address, type Hex } from 'viem'

export const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`
export const ZERO_ADDRESS: Address = `0x${'0'.repeat(40)}`

export function addressToBytes32(addr: string): Hex {
  if (!isAddress(addr, { strict: false })) throw new Error(`invalid address: ${addr}`)
  return pad(getAddress(addr).toLowerCase() as Address, { size: 32 })
}

/** Throws if the upper 12 bytes are non-zero (not an EVM address). */
export function bytes32ToAddress(b: Hex): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(b)) throw new Error(`invalid bytes32: ${b}`)
  const hex = b.slice(2)
  if (hex.slice(0, 24) !== '0'.repeat(24)) throw new Error('bytes32 is not an EVM address')
  return getAddress(`0x${hex.slice(24)}`)
}

export function isZeroBytes32(b: Hex): boolean {
  return /^0x0{64}$/.test(b)
}

/** EIP-55 checksum, or throws. Accepts lowercase/uppercase/mixed-valid input. */
export function checksum(addr: string): Address {
  if (!isAddress(addr, { strict: false })) throw new Error(`invalid address: ${addr}`)
  return getAddress(addr)
}

/** Case-insensitive address equality. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
