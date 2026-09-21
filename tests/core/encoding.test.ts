import { describe, expect, it } from 'vitest'
import {
  addressToBytes32,
  bytes32ToAddress,
  checksum,
  isBytes32,
  isZeroBytes32,
  peerToAddress,
  sameAddress,
  ZERO_ADDRESS,
  ZERO_BYTES32,
} from '@/core/encoding'

const TREAD_OFT = '0xd5EE1c81fE161e985dce6b90713c965f9979cf80'
const TREAD_ADAPTER = '0xe68AD53cf0D5E49CF83FBC003672f6D0eBcAe311'

describe('addressToBytes32', () => {
  it('pads with 12 zero bytes on the left', () => {
    expect(addressToBytes32(TREAD_OFT)).toBe('0x000000000000000000000000d5ee1c81fe161e985dce6b90713c965f9979cf80')
    expect(addressToBytes32(TREAD_OFT)).toHaveLength(66)
  })
  it('accepts lowercase input', () => {
    expect(addressToBytes32(TREAD_OFT.toLowerCase())).toBe(addressToBytes32(TREAD_OFT))
  })
  it('rejects garbage', () => {
    expect(() => addressToBytes32('0x123')).toThrow()
    expect(() => addressToBytes32('')).toThrow()
    expect(() => addressToBytes32('0xZZZZ1c81fE161e985dce6b90713c965f9979cf80')).toThrow()
  })
  it('zero address -> zero bytes32', () => {
    expect(addressToBytes32(ZERO_ADDRESS)).toBe(ZERO_BYTES32)
  })
})

describe('bytes32ToAddress', () => {
  it('round-trips with checksum', () => {
    expect(bytes32ToAddress(addressToBytes32(TREAD_OFT))).toBe(TREAD_OFT)
    expect(bytes32ToAddress(addressToBytes32(TREAD_ADAPTER))).toBe(TREAD_ADAPTER)
  })
  it('rejects non-EVM bytes32 (upper bytes set)', () => {
    expect(() => bytes32ToAddress(`0x01${'00'.repeat(11)}d5ee1c81fe161e985dce6b90713c965f9979cf80`)).toThrow()
  })
  it('rejects wrong length', () => {
    expect(() => bytes32ToAddress('0x1234')).toThrow()
  })
})

describe('isZeroBytes32', () => {
  it('detects zero', () => {
    expect(isZeroBytes32(ZERO_BYTES32)).toBe(true)
    expect(isZeroBytes32(addressToBytes32(TREAD_OFT))).toBe(false)
  })
})

describe('checksum / sameAddress', () => {
  it('produces EIP-55', () => {
    expect(checksum(TREAD_OFT.toLowerCase())).toBe(TREAD_OFT)
    expect(checksum(TREAD_OFT.toUpperCase().replace('0X', '0x'))).toBe(TREAD_OFT)
  })
  it('sameAddress ignores case', () => {
    expect(sameAddress(TREAD_OFT, TREAD_OFT.toLowerCase())).toBe(true)
    expect(sameAddress(TREAD_OFT, TREAD_ADAPTER)).toBe(false)
  })
})

describe('peerToAddress / isBytes32 (raw peers from peers())', () => {
  const SOLANA_LIKE = `0x${'ab'.repeat(32)}` as const // no leading zero bytes: an ed25519 pubkey / PDA
  it('EVM-shaped bytes32 → checksummed address', () => {
    expect(peerToAddress(addressToBytes32(TREAD_OFT))).toBe(TREAD_OFT)
  })
  it('a 32-byte value with non-zero upper bytes is NOT an address (never truncated)', () => {
    expect(peerToAddress(SOLANA_LIKE)).toBeUndefined()
    expect(() => bytes32ToAddress(SOLANA_LIKE)).toThrow()
  })
  it('zero bytes32 maps to the zero address; garbage maps to undefined', () => {
    expect(peerToAddress(ZERO_BYTES32)).toBe(ZERO_ADDRESS)
    expect(peerToAddress('0x1234' as never)).toBeUndefined()
    expect(peerToAddress(TREAD_OFT as never)).toBeUndefined() // a bare address is not bytes32
  })
  it('isBytes32', () => {
    expect(isBytes32(SOLANA_LIKE)).toBe(true)
    expect(isBytes32(ZERO_BYTES32)).toBe(true)
    expect(isBytes32(TREAD_OFT)).toBe(false)
    expect(isBytes32(`0x${'ab'.repeat(33)}`)).toBe(false)
    expect(isBytes32(42)).toBe(false)
  })
})
