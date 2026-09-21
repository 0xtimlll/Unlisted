/**
 * Solana public keys and program-derived addresses (PDAs), done with primitives only:
 * sha256 + an ed25519 "is this point on the curve" check from @noble (already a viem
 * dependency). No Solana SDK — this module is the only place that needs the curve, and the
 * UI loads it on demand.
 */
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import type { Hex } from 'viem'
import { decodeBase58, encodeBase58 } from './base58'

export const PROGRAM = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
} as const

export type Pubkey = Uint8Array & { readonly length: 32 }

export function pubkeyFromBase58(s: string): Pubkey {
  const b = decodeBase58(s)
  if (b.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${b.length}`)
  return b as Pubkey
}

export function pubkeyToBase58(p: Uint8Array): string {
  return encodeBase58(p)
}

export function pubkeyFromHex(h: Hex): Pubkey {
  const clean = h.slice(2)
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('pubkey hex must be 32 bytes')
  return Uint8Array.from(clean.match(/../g)!.map((x) => parseInt(x, 16))) as Pubkey
}

export function pubkeyToHex(p: Uint8Array): Hex {
  return `0x${[...p].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** A 32-byte value is a valid ed25519 public key iff it decodes to a point on the curve. */
export function isOnCurve(p: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(pubkeyToHex(p).slice(2))
    return true
  } catch {
    return false
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')

/** sha256(seeds ‖ programId ‖ "ProgramDerivedAddress"); must NOT be on the curve. */
export function createProgramAddress(seeds: Uint8Array[], programId: Pubkey): Pubkey {
  for (const s of seeds) if (s.length > 32) throw new Error('seed longer than 32 bytes')
  const h = sha256(concat([...seeds, programId, PDA_MARKER]))
  if (isOnCurve(h)) throw new Error('invalid seeds: address is on the curve')
  return h as Pubkey
}

/** Standard bump search: 255 downwards. */
export function findProgramAddress(seeds: Uint8Array[], programId: Pubkey): { address: Pubkey; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return { address: createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump }
    } catch {
      /* try next bump */
    }
  }
  throw new Error('no viable bump')
}

/** Associated token account: seeds [owner, tokenProgram, mint] on the ATA program. */
export function findAta(owner: Pubkey, mint: Pubkey, tokenProgram: Pubkey): Pubkey {
  return findProgramAddress([owner, tokenProgram, mint], pubkeyFromBase58(PROGRAM.ata)).address
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}

export const utf8 = (s: string) => new TextEncoder().encode(s)
