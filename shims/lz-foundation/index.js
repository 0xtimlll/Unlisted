/**
 * Stand-in for @layerzerolabs/lz-foundation (see ../README.md). The original wraps the same
 * @noble/hashes functions; it also ships private-key signers for several chains, which a wallet
 * UI must never contain.
 */
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 as keccak } from '@noble/hashes/sha3'

export function keccak_256(message) {
  return keccak(message)
}

export function sha2_256(message) {
  return sha256(message)
}
