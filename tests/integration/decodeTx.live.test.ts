/**
 * Live decodeTx + LayerZero Scan against a real `send` tx on HyperEVM.
 * Default: a historical TREAD send (2 TREAD, HyperEVM -> Ethereum, delivered 2026-09-18).
 * Override with OFT_TEST_SEND_TX=0x… to check another one.
 */
import { describe, expect, it } from 'vitest'
import type { Hash } from 'viem'
import { byKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { decodeTx } from '@/core/decodeTx'
import { probeOft } from '@/core/probe'
import { pollMessage } from '@/core/track'

const TREAD_OFT = '0xd5EE1c81fE161e985dce6b90713c965f9979cf80'
const DEFAULT_TX: Hash = '0x59443176b832dcf3b19aa54ce815089d7951496903bedd59174cf6944047bcbc'
const HASH = (process.env['OFT_TEST_SEND_TX'] as Hash | undefined) ?? DEFAULT_TX

describe('decodeTx + track on a real HyperEVM send', () => {
  const hyper = makeReadClient(byKey('hyperevm'))

  it('prefills contract + dstEid, and the contract probes as an OFT with that route', async () => {
    const p = await decodeTx(hyper, HASH)
    expect(p.dstEid).toBeGreaterThan(30000)
    const { info } = await probeOft(hyper, p.oft)
    expect(info.routes.some((r) => r.eid === p.dstEid)).toBe(true)
    expect(p.observed.amountLD % info.conversionRate).toBe(0n)
    if (HASH === DEFAULT_TX) {
      expect(p.oft).toBe(TREAD_OFT)
      expect(p.dstEid).toBe(30101)
      expect(p.observed.amountLD).toBe(2n * 10n ** 18n)
      expect(p.observed.hadComposeMsg).toBe(false)
    }
  })

  it('LayerZero Scan knows the message and our parser reads it', async () => {
    const s = await pollMessage(HASH, { timeoutMs: 0 })
    expect(s.phase).not.toBe('no_data')
    expect(s.srcEid).toBe(30367)
    expect(s.srcTxHash?.toLowerCase()).toBe(HASH.toLowerCase())
    if (HASH === DEFAULT_TX) {
      expect(s.phase).toBe('delivered')
      expect(s.dstEid).toBe(30101)
      expect(s.dstTxHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(s.guid).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })
})
