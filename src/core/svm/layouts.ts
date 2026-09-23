/**
 * Byte layouts of the on-chain accounts we read. Anchor accounts start with an 8-byte
 * discriminator = sha256("account:<Name>")[0..8]; we verify it, so a wrong or foreign
 * account fails loudly instead of decoding into nonsense.
 *
 * TWO generations of LayerZero's Solana `oft` program are live, and they store different accounts:
 *
 *   current  OFTStore   + PeerConfig  (devtools/examples/oft-solana/programs/oft/src/state/*.rs)
 *   earlier  OftConfig  + Peer        (LayerZero-v2/packages/layerzero-v2/solana/programs/
 *                                      programs/oft/src/state/{oft,peer}.rs)
 *
 * Both are official. The earlier one keeps the token program in the account and holds neither TVL,
 * fee, pause state nor enforced options (those live in a separate EnforcedOptions account), and its
 * peer account carries only the remote address and a rate limiter. The PDA seeds are the same in
 * both: ["Peer", <store>, be_u32(eid)].
 * Mint / token accounts follow the SPL Token layout (shared by Token-2022 for the base fields).
 */
import { sha256 } from '@noble/hashes/sha2'
import type { Hex } from 'viem'
import { pubkeyToBase58, pubkeyToHex } from './pubkey'

export class LayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LayoutError'
  }
}

export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8)
}

class Reader {
  private o = 0
  constructor(private readonly b: Uint8Array) {}
  get offset() {
    return this.o
  }
  private need(n: number) {
    if (this.o + n > this.b.length) throw new LayoutError(`truncated at ${this.o}+${n} (len ${this.b.length})`)
  }
  bytes(n: number): Uint8Array {
    this.need(n)
    const out = this.b.subarray(this.o, this.o + n)
    this.o += n
    return out
  }
  u8(): number {
    return this.bytes(1)[0]!
  }
  u16(): number {
    const b = this.bytes(2)
    return b[0]! | (b[1]! << 8)
  }
  u32(): number {
    const b = this.bytes(4)
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0
  }
  u64(): bigint {
    const b = this.bytes(8)
    let n = 0n
    for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!)
    return n
  }
  pubkey(): Uint8Array {
    return this.bytes(32)
  }
  bool(): boolean {
    const v = this.u8()
    if (v > 1) throw new LayoutError(`bad bool ${v}`)
    return v === 1
  }
  option<T>(read: () => T): T | undefined {
    const tag = this.u8()
    if (tag === 0) return undefined
    if (tag !== 1) throw new LayoutError(`bad option tag ${tag}`)
    return read()
  }
  vecU8(): Uint8Array {
    return this.bytes(this.u32())
  }
  /** Borsh string: u32 length + utf8 bytes. Metaplex pads with NULs; those are stripped. */
  string(): string {
    return new TextDecoder().decode(this.vecU8()).replace(/\0+$/, '')
  }
}

function expectDiscriminator(r: Reader, name: string) {
  const got = r.bytes(8)
  const want = anchorDiscriminator(name)
  for (let i = 0; i < 8; i++) if (got[i] !== want[i]) throw new LayoutError(`not an ${name} account (discriminator mismatch)`)
}

/** True when the account's first 8 bytes are the Anchor discriminator for `name`. */
export function hasDiscriminator(data: Uint8Array, name: string): boolean {
  if (data.length < 8) return false
  const want = anchorDiscriminator(name)
  for (let i = 0; i < 8; i++) if (data[i] !== want[i]) return false
  return true
}

export type OftStore = {
  oftType: 'native' | 'adapter'
  ld2sdRate: bigint
  tokenMint: string
  tokenEscrow: string
  endpointProgram: string
  bump: number
  tvlLd: bigint
  admin: string
  defaultFeeBps: number
  paused: boolean
  pauser?: string
  unpauser?: string
}

export function decodeOftStore(data: Uint8Array): OftStore {
  const r = new Reader(data)
  expectDiscriminator(r, 'OFTStore')
  const typeTag = r.u8()
  if (typeTag > 1) throw new LayoutError(`unknown OFTType ${typeTag}`)
  const out: OftStore = {
    oftType: typeTag === 0 ? 'native' : 'adapter',
    ld2sdRate: r.u64(),
    tokenMint: pubkeyToBase58(r.pubkey()),
    tokenEscrow: pubkeyToBase58(r.pubkey()),
    endpointProgram: pubkeyToBase58(r.pubkey()),
    bump: r.u8(),
    tvlLd: r.u64(),
    admin: pubkeyToBase58(r.pubkey()),
    defaultFeeBps: r.u16(),
    paused: r.bool(),
  }
  const pauser = r.option(() => pubkeyToBase58(r.pubkey()))
  const unpauser = r.option(() => pubkeyToBase58(r.pubkey()))
  if (pauser) out.pauser = pauser
  if (unpauser) out.unpauser = unpauser
  return out
}

/**
 * The earlier generation's store.
 *
 *   pub struct OftConfig {
 *       pub ld2sd_rate: u64,
 *       pub token_mint: Pubkey,
 *       pub token_program: Pubkey,
 *       pub endpoint_program: Pubkey,
 *       pub bump: u8,
 *       pub admin: Pubkey,
 *       pub ext: OftConfigExt,     // Native(Option<Pubkey>) | Adapter(Pubkey escrow)
 *   }
 *
 * It has no TVL, no fee and no pause flag — the fields simply do not exist, so they are reported
 * as zero/false rather than guessed at.
 */
export type OftConfig = {
  oftType: 'native' | 'adapter'
  ld2sdRate: bigint
  tokenMint: string
  /** This generation records the token program itself; the caller cross-checks it against the mint. */
  tokenProgram: string
  endpointProgram: string
  bump: number
  admin: string
  /** Adapter only. A native OFT mints and burns, so it holds no escrow. */
  tokenEscrow?: string
}

export function decodeOftConfig(data: Uint8Array): OftConfig {
  const r = new Reader(data)
  expectDiscriminator(r, 'OftConfig')
  const ld2sdRate = r.u64()
  const tokenMint = pubkeyToBase58(r.pubkey())
  const tokenProgram = pubkeyToBase58(r.pubkey())
  const endpointProgram = pubkeyToBase58(r.pubkey())
  const bump = r.u8()
  const admin = pubkeyToBase58(r.pubkey())

  const extTag = r.u8()
  if (extTag > 1) throw new LayoutError(`unknown OftConfigExt ${extTag}`)
  if (extTag === 0) {
    // Native(Option<Pubkey> mint_authority) — the authority itself is not needed here.
    r.option(() => r.pubkey())
    return { oftType: 'native', ld2sdRate, tokenMint, tokenProgram, endpointProgram, bump, admin }
  }
  return { oftType: 'adapter', ld2sdRate, tokenMint, tokenProgram, endpointProgram, bump, admin, tokenEscrow: pubkeyToBase58(r.pubkey()) }
}

/** Either generation's store, tagged with which one it turned out to be. */
export type AnyOftStore =
  | { layout: 'OFTStore'; store: OftStore }
  | { layout: 'OftConfig'; store: OftConfig }

/** Tries both official layouts. Throws only when the account is neither. */
export function decodeAnyOftStore(data: Uint8Array): AnyOftStore {
  if (hasDiscriminator(data, 'OFTStore')) return { layout: 'OFTStore', store: decodeOftStore(data) }
  if (hasDiscriminator(data, 'OftConfig')) return { layout: 'OftConfig', store: decodeOftConfig(data) }
  throw new LayoutError('neither an OFTStore nor an OftConfig account')
}

export type PeerConfig = {
  /** bytes32 of the remote OFT (an EVM address left-padded). */
  peerAddress: Hex
  enforcedSend: Hex
  enforcedSendAndCall: Hex
  feeBps?: number
  bump: number
}

export function decodePeerConfig(data: Uint8Array): PeerConfig {
  const r = new Reader(data)
  expectDiscriminator(r, 'PeerConfig')
  const peerAddress = pubkeyToHex(r.pubkey())
  const enforcedSend = pubkeyToHexAny(r.vecU8())
  const enforcedSendAndCall = pubkeyToHexAny(r.vecU8())
  const rateLimiter = () => ({ capacity: r.u64(), tokens: r.u64(), refillPerSecond: r.u64(), lastRefillTime: r.u64() })
  r.option(rateLimiter) // outbound
  r.option(rateLimiter) // inbound
  const feeBps = r.option(() => r.u16())
  const bump = r.u8()
  return { peerAddress, enforcedSend, enforcedSendAndCall, ...(feeBps !== undefined ? { feeBps } : {}), bump }
}

/**
 * The earlier generation's peer account:
 *
 *   pub struct Peer { pub address: [u8; 32], pub rate_limiter: Option<RateLimiter>, pub bump: u8 }
 *
 * Its enforced options live in a separate EnforcedOptions account, so none are returned here.
 */
export function decodePeer(data: Uint8Array): PeerConfig {
  const r = new Reader(data)
  expectDiscriminator(r, 'Peer')
  const peerAddress = pubkeyToHex(r.pubkey())
  r.option(() => ({ capacity: r.u64(), tokens: r.u64(), refillPerSecond: r.u64(), lastRefillTime: r.u64() }))
  const bump = r.u8()
  return { peerAddress, enforcedSend: '0x', enforcedSendAndCall: '0x', bump }
}

/** Either generation's peer account. Both put the 32-byte remote address first. */
export function decodeAnyPeer(data: Uint8Array): PeerConfig {
  if (hasDiscriminator(data, 'PeerConfig')) return decodePeerConfig(data)
  if (hasDiscriminator(data, 'Peer')) return decodePeer(data)
  throw new LayoutError('neither a PeerConfig nor a Peer account')
}

function pubkeyToHexAny(b: Uint8Array): Hex {
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

export type Mint = { supply: bigint; decimals: number; initialized: boolean }

/** SPL Token mint (82 bytes; Token-2022 appends extensions after the same base). */
export function decodeMint(data: Uint8Array): Mint {
  if (data.length < 82) throw new LayoutError(`mint account too short (${data.length})`)
  const r = new Reader(data)
  r.bytes(36) // COption<Pubkey> mint_authority
  const supply = r.u64()
  const decimals = r.u8()
  const initialized = r.u8() === 1
  return { supply, decimals, initialized }
}

export type TokenAccount = { mint: string; owner: string; amount: bigint }

/** SPL Token account (165 bytes base). */
export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < 165) throw new LayoutError(`token account too short (${data.length})`)
  const r = new Reader(data)
  return { mint: pubkeyToBase58(r.pubkey()), owner: pubkeyToBase58(r.pubkey()), amount: r.u64() }
}

export type TokenMetadata = { name: string; symbol: string }

/**
 * Metaplex Token Metadata account (mpl-token-metadata `Metadata`): key u8, update authority, mint,
 * then name / symbol / uri as borsh strings. Only name and symbol are read; the rest is ignored.
 */
export function decodeTokenMetadata(data: Uint8Array, expectedMint: string): TokenMetadata {
  const r = new Reader(data)
  const key = r.u8()
  if (key !== 4) throw new LayoutError(`not a MetadataV1 account (key ${key})`)
  r.pubkey() // update authority
  const mint = pubkeyToBase58(r.pubkey())
  if (mint !== expectedMint) throw new LayoutError('metadata is for a different mint')
  const name = r.string().slice(0, 64)
  const symbol = r.string().slice(0, 16)
  return { name, symbol }
}

/** Address lookup table (AddressLookupTab1e…): 56-byte header, then 32-byte addresses. */
export function decodeLookupTable(data: Uint8Array): { addresses: string[] } {
  if (data.length < 56) throw new LayoutError(`lookup table too short (${data.length})`)
  const r = new Reader(data)
  const kind = r.u32()
  if (kind !== 1) throw new LayoutError(`not an initialized lookup table (type ${kind})`)
  r.bytes(52)
  const addresses: string[] = []
  while (r.offset + 32 <= data.length) addresses.push(pubkeyToBase58(r.pubkey()))
  return { addresses }
}
