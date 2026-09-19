import { describe, expect, it } from 'vitest'
import type { ReadClient } from '@/core/client'
import { addressToBytes32 } from '@/core/encoding'
import { checkPeerBack, findVerified, VERIFIED_CONTRACTS } from '@/core/verify'
import { OTHER, TREAD_ADAPTER, TREAD_OFT } from './fixtures'

const clientReturning = (v: unknown | Error): ReadClient =>
  ({
    readContract: async () => {
      if (v instanceof Error) throw v
      return v
    },
  }) as unknown as ReadClient

describe('verified list', () => {
  it('knows TREAD and USDT0, case-insensitively', () => {
    expect(findVerified('hyperevm', TREAD_OFT)?.label).toBe('TREAD (OFT)')
    expect(findVerified('hyperevm', TREAD_OFT.toLowerCase())?.label).toBe('TREAD (OFT)')
    expect(findVerified('ethereum', TREAD_ADAPTER)?.label).toBe('TREAD (OFTAdapter)')
    expect(findVerified('hyperevm', '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98')?.label).toBe('USDT0 (OFTAdapter)')
  })
  it('does not match the same address on another chain, or unknown addresses', () => {
    expect(findVerified('ethereum', TREAD_OFT)).toBeUndefined()
    expect(findVerified('hyperevm', OTHER)).toBeUndefined()
  })
  it('entries are checksummed and unique', () => {
    const keys = new Set(VERIFIED_CONTRACTS.map((v) => `${v.chain}:${v.address.toLowerCase()}`))
    expect(keys.size).toBe(VERIFIED_CONTRACTS.length)
    for (const v of VERIFIED_CONTRACTS) expect(v.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('checkPeerBack', () => {
  it('ok when the destination peer names our OFT', async () => {
    const c = clientReturning(addressToBytes32(TREAD_OFT))
    expect(await checkPeerBack(c, TREAD_ADAPTER, 30367, TREAD_OFT)).toEqual({ status: 'ok' })
  })
  it('mismatch when it names someone else (fake adapter pointing at the real OFT)', async () => {
    const c = clientReturning(addressToBytes32(OTHER))
    const r = await checkPeerBack(c, TREAD_ADAPTER, 30367, TREAD_OFT)
    expect(r.status).toBe('mismatch')
  })
  it('mismatch when it names nobody (zero peer)', async () => {
    const c = clientReturning(`0x${'0'.repeat(64)}`)
    expect((await checkPeerBack(c, TREAD_ADAPTER, 30367, TREAD_OFT)).status).toBe('mismatch')
  })
  it('unavailable on RPC error, never "ok"', async () => {
    const c = clientReturning(new Error('boom'))
    const r = await checkPeerBack(c, TREAD_ADAPTER, 30367, TREAD_OFT)
    expect(r.status).toBe('unavailable')
  })
})
