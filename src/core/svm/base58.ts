/**
 * Base58 (Bitcoin alphabet) — the address encoding on Solana. ~40 lines, no dependency,
 * so that the EVM-only bundle never pulls a Solana SDK just to validate a string.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]))

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  return '1'.repeat(zeros) + out
}

/** Throws on characters outside the alphabet. Empty string decodes to an empty array. */
export function decodeBase58(s: string): Uint8Array {
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  let n = 0n
  for (const c of s) {
    const v = INDEX.get(c)
    if (v === undefined) throw new Error(`invalid base58 character: ${JSON.stringify(c)}`)
    n = n * 58n + BigInt(v)
  }
  const body: number[] = []
  while (n > 0n) {
    body.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...body])
}

export function isBase58(s: string): boolean {
  return s.length > 0 && [...s].every((c) => INDEX.has(c))
}
