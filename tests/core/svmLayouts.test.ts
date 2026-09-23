/**
 * Both official Solana OFT store layouts, and what happens with an account that is neither.
 *
 * The byte strings here are built from the structs LayerZero declares, so a change to either
 * decoder shows up as a decode failure rather than as silently wrong fields.
 */
import { describe, expect, it } from 'vitest'
import { anchorDiscriminator, decodeAnyOftStore, decodeAnyPeer, hasDiscriminator, LayoutError } from '@/core/svm/layouts'
import { pubkeyFromBase58 } from '@/core/svm/pubkey'

const MINT = 'So11111111111111111111111111111111111111112'
const PROGRAM_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ENDPOINT = '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6'
const ADMIN = 'EWZCJs2JRo3tMKgDt8FGx7MccD8sKv4QEcdsY9ZhVKZA'

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const u8 = (v: number) => Uint8Array.of(v)
const u16 = (v: number) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff)
const u64 = (v: bigint) => { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn); return b }
const key = (b58: string) => pubkeyFromBase58(b58)

/** The earlier generation: OftConfig { ld2sd, mint, token_program, endpoint, bump, admin, ext }. */
const oftConfigNative = () =>
  cat(anchorDiscriminator('OftConfig'), u64(1000n), key(MINT), key(PROGRAM_TOKEN), key(ENDPOINT), u8(255), key(ADMIN), u8(0), u8(1), key(ADMIN))

/** The current generation: OFTStore { type, ld2sd, mint, escrow, endpoint, bump, tvl, admin, fee, paused, … }. */
const oftStoreNative = () =>
  cat(anchorDiscriminator('OFTStore'), u8(0), u64(1000n), key(MINT), key(MINT), key(ENDPOINT), u8(254), u64(7n), key(ADMIN), u16(0), u8(0), u8(0), u8(0))

describe('both official store layouts', () => {
  it('reads the current OFTStore', () => {
    const r = decodeAnyOftStore(oftStoreNative())
    expect(r.layout).toBe('OFTStore')
    if (r.layout !== 'OFTStore') return
    expect(r.store).toMatchObject({ oftType: 'native', ld2sdRate: 1000n, tokenMint: MINT, tvlLd: 7n, paused: false })
  })

  it('reads the earlier OftConfig, which records the token program and holds no TVL or pause flag', () => {
    const r = decodeAnyOftStore(oftConfigNative())
    expect(r.layout).toBe('OftConfig')
    if (r.layout !== 'OftConfig') return
    expect(r.store).toMatchObject({ oftType: 'native', ld2sdRate: 1000n, tokenMint: MINT, tokenProgram: PROGRAM_TOKEN, admin: ADMIN })
    expect(r.store.tokenEscrow).toBeUndefined() // a native OFT mints and burns
  })

  it('an adapter in the earlier layout carries its escrow in the ext field', () => {
    const adapter = cat(anchorDiscriminator('OftConfig'), u64(1n), key(MINT), key(PROGRAM_TOKEN), key(ENDPOINT), u8(255), key(ADMIN), u8(1), key(ENDPOINT))
    const r = decodeAnyOftStore(adapter)
    if (r.layout !== 'OftConfig') throw new Error('expected OftConfig')
    expect(r.store).toMatchObject({ oftType: 'adapter', tokenEscrow: ENDPOINT })
  })

  it('refuses an account that is neither, and says so rather than decoding nonsense', () => {
    const foreign = cat(anchorDiscriminator('SomethingElse'), new Uint8Array(200))
    expect(() => decodeAnyOftStore(foreign)).toThrow(LayoutError)
    expect(() => decodeAnyOftStore(new Uint8Array(4))).toThrow(LayoutError)
    expect(hasDiscriminator(foreign, 'OFTStore')).toBe(false)
    expect(hasDiscriminator(foreign, 'OftConfig')).toBe(false)
  })

  it('never depends on an exact account length', () => {
    // Trailing bytes an older or newer build might add must not break the decode.
    const padded = cat(oftConfigNative(), new Uint8Array(64))
    expect(decodeAnyOftStore(padded).layout).toBe('OftConfig')
  })
})

describe('both peer accounts', () => {
  const remote = `0x${'00'.repeat(12)}${'58538e6a46e07434d7e7375bc268d3cb839c0133'}`

  it('reads the earlier Peer { address, rate_limiter, bump }', () => {
    const peer = cat(anchorDiscriminator('Peer'), key(MINT), u8(0), u8(255))
    const decoded = decodeAnyPeer(peer)
    expect(decoded.peerAddress).toHaveLength(66)
    // The earlier program keeps enforced options in a separate account, so none are reported.
    expect(decoded.enforcedSend).toBe('0x')
  })

  it('reads a Peer whose rate limiter is set', () => {
    const peer = cat(anchorDiscriminator('Peer'), key(MINT), u8(1), u64(1n), u64(2n), u64(3n), u64(4n), u8(254))
    expect(decodeAnyPeer(peer).bump).toBe(254)
  })

  it('reads the current PeerConfig', () => {
    const vec = (b: Uint8Array) => cat(Uint8Array.of(b.length, 0, 0, 0), b)
    const pc = cat(anchorDiscriminator('PeerConfig'), key(MINT), vec(Uint8Array.of(0, 3)), vec(new Uint8Array(0)), u8(0), u8(0), u8(0), u8(7))
    expect(decodeAnyPeer(pc).enforcedSend).toBe('0x0003')
  })

  it('refuses anything else', () => {
    expect(() => decodeAnyPeer(cat(anchorDiscriminator('Nope'), new Uint8Array(64)))).toThrow(LayoutError)
  })

  void remote
})
