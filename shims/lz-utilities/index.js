/**
 * Stand-in for @layerzerolabs/lz-utilities (see ../README.md). Same semantics as the original
 * src/format.ts / src/padding.ts, without Buffer and without the multi-chain key tooling.
 */

export function isHex(value) {
  return /^(0x)?[0-9A-F]+$/i.test(value)
}

function trim0x(hex) {
  return hex.replace(/^0x/i, '')
}

export class SizeExceedsPaddingSizeError extends Error {
  constructor({ size, targetSize, type }) {
    super(`${type.charAt(0).toUpperCase()}${type.slice(1).toLowerCase()} size (${size}) exceeds padding size (${targetSize})`)
    this.name = 'SizeExceedsPaddingSizeError'
  }
}

function padHex(hex, { dir, size = 32 } = {}) {
  if (size === null) return hex
  const value = hex.replace('0x', '')
  if (value.length > size * 2) throw new SizeExceedsPaddingSizeError({ size: Math.ceil(value.length / 2), targetSize: size, type: 'hex' })
  return `0x${value[dir === 'right' ? 'padEnd' : 'padStart'](size * 2, '0')}`
}

function padBytes(bytes, { dir, size = 32 } = {}) {
  if (size === null) return bytes
  if (bytes.length > size) throw new SizeExceedsPaddingSizeError({ size: bytes.length, targetSize: size, type: 'bytes' })
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    const padEnd = dir === 'right'
    out[padEnd ? i : size - i - 1] = bytes[padEnd ? i : bytes.length - i - 1]
  }
  return out
}

export function padify(hexOrBytes, opts = {}) {
  return typeof hexOrBytes === 'string' ? padHex(hexOrBytes, opts) : padBytes(hexOrBytes, opts)
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function _arrayify(value) {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') {
    if (value.match(/^(0x)?[0-9A-F]*$/i)) {
      const hex = value.replace(/^0x/i, '')
      const len = hex.length + 1 - ((hex.length + 1) % 2)
      return hexToBytes(hex.padStart(len, '0'))
    }
    throw new Error('Invalid hex string')
  }
  if (typeof value === 'number') {
    if (value < 0) throw new Error('Number must be non-negative')
    const bytes = []
    while (value > 0) {
      bytes.push(value & 255)
      value >>= 8
    }
    return new Uint8Array(bytes.reverse())
  }
  if (typeof value === 'bigint') return _arrayify(value.toString(16))
  throw new Error('unsupported type')
}

export function arrayify(value, size) {
  const bytes = _arrayify(value)
  return size === undefined ? bytes : padify(bytes, { size })
}

function ensure0x(hex) {
  if (!isHex(hex)) throw new Error('invalid hex string')
  return `0x${trim0x(hex)}`
}

export function hexlify(value) {
  if (typeof value === 'string' && /^(0x)?[0-9A-F]*$/i.test(value)) return '0x' + trim0x(value)
  const bytes = arrayify(value)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  // Like the original: an empty byte string is not a hex string.
  return ensure0x(hex)
}
