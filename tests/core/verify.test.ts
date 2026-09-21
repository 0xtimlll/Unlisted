import { describe, expect, it } from 'vitest'
import type { ReadClient } from '@/core/client'
import { addressToBytes32 } from '@/core/encoding'
import { checkPeerBack } from '@/core/verify'
import { OTHER, TREAD_ADAPTER, TREAD_OFT } from './fixtures'

const clientReturning = (v: unknown | Error): ReadClient =>
  ({
    readContract: async () => {
      if (v instanceof Error) throw v
      return v
    },
  }) as unknown as ReadClient

describe('checkPeerBack', () => {
  const ADAPTER32 = addressToBytes32(TREAD_ADAPTER)
  it('ok when the destination peer names our OFT', async () => {
    const c = clientReturning(addressToBytes32(TREAD_OFT))
    expect(await checkPeerBack(c, ADAPTER32, 30367, TREAD_OFT)).toEqual({ status: 'ok' })
  })
  it('mismatch when it names someone else (fake adapter pointing at the real OFT)', async () => {
    const c = clientReturning(addressToBytes32(OTHER))
    const r = await checkPeerBack(c, ADAPTER32, 30367, TREAD_OFT)
    expect(r.status).toBe('mismatch')
  })
  it('mismatch when it names nobody (zero peer)', async () => {
    const c = clientReturning(`0x${'0'.repeat(64)}`)
    expect((await checkPeerBack(c, ADAPTER32, 30367, TREAD_OFT)).status).toBe('mismatch')
  })
  it('unavailable on RPC error, never "ok"', async () => {
    const c = clientReturning(new Error('boom'))
    const r = await checkPeerBack(c, ADAPTER32, 30367, TREAD_OFT)
    expect(r.status).toBe('unavailable')
  })
  it('a non-EVM-shaped peer on an EVM destination is a mismatch without any RPC call', async () => {
    const c = clientReturning(new Error('must not be called'))
    const solanaLike = `0x${'ab'.repeat(32)}` as const
    expect((await checkPeerBack(c, solanaLike, 30367, TREAD_OFT)).status).toBe('mismatch')
  })
})
