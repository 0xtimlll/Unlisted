/**
 * Reversing a route: the other side's contract comes from what this side already read, the chains
 * swap, and a peer that is not a plain address is refused rather than guessed at.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, pad, type Hex } from 'viem'
import { byKey } from '@/core/chains'
import { reverseCcip, reverseNtt, reverseOft, reverseV1 } from '@/core/reverse'
import { decodeBase58 } from '@/core/svm/base58'
import { treadOftInfo, TREAD_ADAPTER, ETH_EID } from './fixtures'

const OTHER = getAddress('0x0A092E544DA31150b439a1aAA1A3a2214a867F46')

describe('LayerZero V2', () => {
  it('EVM → EVM: the peer becomes the source contract, the chains swap', () => {
    // The fixture is TREAD on HyperEVM, peered to its adapter on Ethereum.
    const r = reverseOft('hyperevm', treadOftInfo(), ETH_EID)
    expect(r).toEqual({ ok: true, chain: 'ethereum', contract: TREAD_ADAPTER, dstChain: 'hyperevm', dstEid: byKey('hyperevm').eid })
  })

  it('reversing twice comes back to where it started', () => {
    const there = reverseOft('hyperevm', treadOftInfo(), ETH_EID)
    expect(there.ok).toBe(true)
    if (!there.ok) return
    // The other side's own view of the route: its peer for HyperEVM is the TREAD OFT.
    const otherSide = treadOftInfo({ oft: TREAD_ADAPTER, routes: [{ eid: there.dstEid, peer: pad(treadOftInfo().oft.toLowerCase() as Hex, { size: 32 }) }] })
    const back = reverseOft(there.chain, otherSide, there.dstEid)
    expect(back).toMatchObject({ ok: true, chain: 'hyperevm', contract: treadOftInfo().oft, dstChain: 'ethereum' })
  })

  it('EVM → Solana: the 32-byte peer is the OFT Store, written in base58', () => {
    const store = `0x${'ab'.repeat(32)}` as Hex
    const info = treadOftInfo({ routes: [{ eid: byKey('solana').eid, peer: store }] })
    const r = reverseOft('ethereum', info, byKey('solana').eid)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.chain).toBe('solana')
    expect(Buffer.from(decodeBase58(r.contract)).toString('hex')).toBe('ab'.repeat(32))
    expect(r.dstChain).toBe('ethereum')
  })

  it('refuses rather than guesses', () => {
    expect(reverseOft('hyperevm', treadOftInfo(), undefined)).toEqual({ ok: false, reason: 'no_destination' })
    expect(reverseOft('hyperevm', treadOftInfo(), 99999)).toEqual({ ok: false, reason: 'unknown_chain' })
    expect(reverseOft('hyperevm', treadOftInfo({ routes: [] }), ETH_EID)).toEqual({ ok: false, reason: 'no_peer' })
    expect(reverseOft('hyperevm', treadOftInfo({ routes: [{ eid: ETH_EID, peer: `0x${'0'.repeat(64)}` }] }), ETH_EID)).toEqual({ ok: false, reason: 'no_peer' })
    // A 32-byte peer with non-zero high bytes is not an EVM address; truncating it would name a contract nobody chose.
    expect(reverseOft('hyperevm', treadOftInfo({ routes: [{ eid: ETH_EID, peer: `0x${'11'.repeat(32)}` }] }), ETH_EID)).toEqual({ ok: false, reason: 'peer_not_address' })
  })
})

describe('LayerZero v1', () => {
  it('the trusted remote becomes the source', () => {
    expect(reverseV1('ethereum', { key: 'bsc', remoteAddress: OTHER })).toEqual({ ok: true, chain: 'bsc', contract: OTHER, dstChain: 'ethereum', dstEid: byKey('ethereum').eid })
  })
  it('a path that is not the plain 40-byte shape has no address to reverse to', () => {
    expect(reverseV1('ethereum', { key: 'bsc', remoteAddress: undefined })).toEqual({ ok: false, reason: 'no_peer' })
    expect(reverseV1('ethereum', undefined)).toEqual({ ok: false, reason: 'no_destination' })
  })
})

describe('Wormhole NTT', () => {
  it('the verified peer manager becomes the source', () => {
    const v = { chain: 'ethereum' as const, dst: { chain: 'bsc' as const, manager: OTHER } }
    expect(reverseNtt(v)).toEqual({ ok: true, chain: 'bsc', contract: OTHER, dstChain: 'ethereum', dstEid: byKey('ethereum').eid })
  })
  it('nothing verified, nothing to reverse', () => {
    expect(reverseNtt(undefined)).toEqual({ ok: false, reason: 'no_destination' })
  })
})

describe('Chainlink CCIP', () => {
  it('the pool’s remote token becomes the token to look up on the destination', () => {
    expect(reverseCcip('ethereum', 'base', OTHER)).toEqual({ ok: true, chain: 'base', contract: OTHER, dstChain: 'ethereum', dstEid: byKey('ethereum').eid })
  })
  it('needs both a destination and the remote token', () => {
    expect(reverseCcip('ethereum', undefined, OTHER)).toEqual({ ok: false, reason: 'no_destination' })
    expect(reverseCcip('ethereum', 'base', undefined)).toEqual({ ok: false, reason: 'no_peer' })
  })
})
