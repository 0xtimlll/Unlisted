/** Solana primitives: base58, PDAs, ATA derivation for both token programs, account layouts. */
import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2'
import { decodeBase58, encodeBase58, isBase58 } from '@/core/svm/base58'
import { anchorDiscriminator, decodeMint, decodeOftStore, decodePeerConfig, decodeTokenAccount, LayoutError } from '@/core/svm/layouts'
import { createProgramAddress, findAta, findProgramAddress, isOnCurve, PROGRAM, pubkeyFromBase58, pubkeyFromHex, pubkeyToBase58, pubkeyToHex, u32be, utf8 } from '@/core/svm/pubkey'
import { ataFor } from '@/core/svm/recipient'
import { peerConfigAddress } from '@/core/svm/discover'

describe('base58', () => {
  it('round-trips and preserves leading zeros', () => {
    for (const bytes of [new Uint8Array([0, 0, 1, 2, 3]), new Uint8Array(32), Uint8Array.from({ length: 32 }, (_, i) => 255 - i)]) {
      expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes)
    }
    expect(encodeBase58(new Uint8Array(32))).toBe('1'.repeat(32)) // the System program id
    expect(decodeBase58(PROGRAM.system)).toEqual(new Uint8Array(32))
  })
  it('known program ids decode to 32 bytes', () => {
    for (const id of Object.values(PROGRAM)) expect(decodeBase58(id)).toHaveLength(32)
  })
  it('rejects characters outside the alphabet', () => {
    expect(isBase58('0')).toBe(false)
    expect(isBase58('OIl')).toBe(false)
    expect(isBase58('')).toBe(false)
    expect(() => decodeBase58('0x12')).toThrow(/invalid base58/)
  })
})

describe('pubkey / PDA', () => {
  it('hex ↔ base58 ↔ bytes', () => {
    const p = pubkeyFromBase58(PROGRAM.token)
    expect(pubkeyToBase58(p)).toBe(PROGRAM.token)
    expect(pubkeyFromHex(pubkeyToHex(p))).toEqual(p)
    expect(() => pubkeyFromBase58('abc')).toThrow(/32 bytes/)
  })
  it('program ids are on the curve; PDAs are not', () => {
    expect(isOnCurve(pubkeyFromBase58(PROGRAM.token))).toBe(true)
    expect(isOnCurve(pubkeyFromBase58(PROGRAM.ata))).toBe(true)
    const { address } = findProgramAddress([utf8('anything')], pubkeyFromBase58(PROGRAM.token))
    expect(isOnCurve(address)).toBe(false)
  })
  it('createProgramAddress = sha256(seeds ‖ program ‖ "ProgramDerivedAddress") when off-curve', () => {
    const program = pubkeyFromBase58(PROGRAM.token)
    const { address, bump } = findProgramAddress([utf8('seed')], program)
    const manual = sha256(new Uint8Array([...utf8('seed'), bump, ...program, ...utf8('ProgramDerivedAddress')]))
    expect(address).toEqual(manual)
    expect(createProgramAddress([utf8('seed'), Uint8Array.of(bump)], program)).toEqual(address)
    expect(() => createProgramAddress([new Uint8Array(33)], program)).toThrow(/32 bytes/)
  })
  it('ATA derivation differs between Token and Token-2022 for the same owner/mint', () => {
    const owner = pubkeyFromBase58(PROGRAM.system) // any 32 bytes
    const mint = pubkeyFromBase58(PROGRAM.ata)
    const a = findAta(owner, mint, pubkeyFromBase58(PROGRAM.token))
    const b = findAta(owner, mint, pubkeyFromBase58(PROGRAM.token2022))
    expect(pubkeyToBase58(a)).not.toBe(pubkeyToBase58(b))
    expect(isOnCurve(a)).toBe(false)
    expect(ataFor(PROGRAM.system, PROGRAM.ata, 'token')).toBe(pubkeyToBase58(a))
    expect(ataFor(PROGRAM.system, PROGRAM.ata, 'token2022')).toBe(pubkeyToBase58(b))
  })
  it('PeerConfig PDA depends on the eid (big-endian u32) and the program', () => {
    const store = PROGRAM.ata
    const a = peerConfigAddress(store, PROGRAM.token, 30367)
    const b = peerConfigAddress(store, PROGRAM.token, 30101)
    const c = peerConfigAddress(store, PROGRAM.token2022, 30367)
    expect(new Set([a, b, c]).size).toBe(3)
    expect([...u32be(30367)]).toEqual([0, 0, 0x76, 0x9f])
  })
})

/** Builds an OFTStore account image the way Anchor/borsh lays it out. */
function oftStoreBytes(o: { type: number; rate: bigint; mint: Uint8Array; escrow: Uint8Array; paused: boolean; fee: number; tvl: bigint }): Uint8Array {
  const u64 = (n: bigint) => Uint8Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn))
  return new Uint8Array([
    ...anchorDiscriminator('OFTStore'),
    o.type,
    ...u64(o.rate),
    ...o.mint,
    ...o.escrow,
    ...new Uint8Array(32), // endpoint program
    255, // bump
    ...u64(o.tvl),
    ...new Uint8Array(32), // admin
    o.fee & 0xff,
    (o.fee >> 8) & 0xff,
    o.paused ? 1 : 0,
    0, // pauser: None
    1,
    ...new Uint8Array(32).fill(9), // unpauser: Some(9…)
  ])
}

describe('layouts', () => {
  it('OFTStore decodes and validates its discriminator', () => {
    const mint = pubkeyFromBase58(PROGRAM.token)
    const escrow = pubkeyFromBase58(PROGRAM.ata)
    const s = decodeOftStore(oftStoreBytes({ type: 1, rate: 1000n, mint, escrow, paused: true, fee: 25, tvl: 7n }))
    expect(s).toMatchObject({ oftType: 'adapter', ld2sdRate: 1000n, tokenMint: PROGRAM.token, tokenEscrow: PROGRAM.ata, paused: true, defaultFeeBps: 25, tvlLd: 7n, bump: 255 })
    expect(s.pauser).toBeUndefined()
    expect(s.unpauser).toBe(pubkeyToBase58(new Uint8Array(32).fill(9)))
    const wrong = oftStoreBytes({ type: 0, rate: 1n, mint, escrow, paused: false, fee: 0, tvl: 0n })
    wrong.set(anchorDiscriminator('PeerConfig'), 0)
    expect(() => decodeOftStore(wrong)).toThrow(LayoutError)
    expect(() => decodeOftStore(wrong.slice(0, 20))).toThrow(LayoutError)
  })
  it('PeerConfig decodes peer + enforced options', () => {
    const peer = new Uint8Array(32).fill(0xaa)
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))
    const send = hex('0003010011010000000000000000000000000000ea60') // type 3 + lzReceive 60000 CU
    const vec = (b: Uint8Array) => new Uint8Array([b.length, 0, 0, 0, ...b])
    const data = new Uint8Array([...anchorDiscriminator('PeerConfig'), ...peer, ...vec(send), ...vec(new Uint8Array()), 0, 0, 1, 0x39, 0x05, 254])
    const pc = decodePeerConfig(data)
    expect(pc.peerAddress).toBe(`0x${'aa'.repeat(32)}`)
    expect(pc.enforcedSend).toBe('0x0003010011010000000000000000000000000000ea60')
    expect(pc.enforcedSendAndCall).toBe('0x')
    expect(pc.feeBps).toBe(0x0539)
    expect(pc.bump).toBe(254)
  })
  it('Mint / TokenAccount base layouts', () => {
    const mint = new Uint8Array(82)
    mint[36 + 0] = 0x10 // supply = 16
    mint[44] = 6
    mint[45] = 1
    expect(decodeMint(mint)).toEqual({ supply: 16n, decimals: 6, initialized: true })
    expect(() => decodeMint(mint.slice(0, 40))).toThrow(LayoutError)
    const ta = new Uint8Array(165)
    ta.set(pubkeyFromBase58(PROGRAM.token), 0)
    ta.set(pubkeyFromBase58(PROGRAM.ata), 32)
    ta[64] = 5
    expect(decodeTokenAccount(ta)).toEqual({ mint: PROGRAM.token, owner: PROGRAM.ata, amount: 5n })
  })
})
