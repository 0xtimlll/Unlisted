/**
 * probeOft with a fake client: routes keep the raw 32-byte peer, including non-EVM peers
 * (a Solana OFT Store pubkey has no leading zero bytes and must not be dropped or truncated).
 */
import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import type { ReadClient } from '@/core/client'
import { addressToBytes32 } from '@/core/encoding'
import { labelLooksSpoofed, probeOft, sanitizeLabel } from '@/core/probe'
import { ENDPOINT_HYPER, OWNER, TREAD_ADAPTER, TREAD_OFT } from './fixtures'

const SOLANA_PEER: Hex = `0x${'c3'.repeat(32)}`
const SOLANA_EID = 30168

/** Answers the multicalls probeOft makes, keyed by functionName, in the order it issues them. */
function fakeClient(peers: Record<number, Hex>): ReadClient {
  const ok = (result: unknown) => ({ status: 'success' as const, result })
  return {
    getCode: async () => '0x6001',
    getStorageAt: async () => `0x${'0'.repeat(64)}`,
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
      contracts.map((c) => {
        switch (c.functionName) {
          case 'token': return ok(TREAD_OFT)
          case 'approvalRequired': return ok(false)
          case 'sharedDecimals': return ok(6)
          case 'decimalConversionRate': return ok(10n ** 12n)
          case 'endpoint': return ok(ENDPOINT_HYPER)
          case 'owner': return ok(OWNER)
          case 'oftVersion': return ok(['0x02e49c2c', 1n])
          case 'peers': return ok(peers[c.args![0] as number] ?? `0x${'0'.repeat(64)}`)
          case 'enforcedOptions': return ok('0x')
          case 'decimals': return ok(18)
          case 'symbol': return ok('TREAD')
          case 'name': return ok('Tread')
          case 'balanceOf': return ok(0n)
          default: return { status: 'failure' as const, error: new Error(`unexpected ${c.functionName}`) }
        }
      }),
  } as unknown as ReadClient
}

describe('probeOft keeps raw bytes32 peers', () => {
  it('EVM peer is stored padded, not as a 20-byte address', async () => {
    const { info } = await probeOft(fakeClient({ 30101: addressToBytes32(TREAD_ADAPTER) }), TREAD_OFT, [30101, SOLANA_EID])
    expect(info.routes).toEqual([{ eid: 30101, peer: addressToBytes32(TREAD_ADAPTER) }])
  })
  it('a non-EVM (Solana-shaped) peer is present with all 32 bytes — previously it was silently dropped', async () => {
    const { info } = await probeOft(fakeClient({ 30101: addressToBytes32(TREAD_ADAPTER), [SOLANA_EID]: SOLANA_PEER }), TREAD_OFT, [30101, SOLANA_EID])
    expect(info.routes.map((r) => r.eid)).toEqual([30101, SOLANA_EID])
    expect(info.routes[1]?.peer).toBe(SOLANA_PEER)
    expect(info.routes[1]?.peer).toHaveLength(66)
  })
  it('zero peers are not routes', async () => {
    const { info } = await probeOft(fakeClient({}), TREAD_OFT, [30101, SOLANA_EID])
    expect(info.routes).toEqual([])
  })
})

/**
 * §7 A token's symbol and name are chosen by the contract, and this app's whole promise is that
 * the user reads them. So the contract must not get to choose how they are laid out.
 */
describe('sanitizeLabel', () => {
  it('keeps an ordinary symbol intact', () => {
    expect(sanitizeLabel('USDC')).toBe('USDC')
    expect(sanitizeLabel('  wstETH  ')).toBe('wstETH')
  })

  it('strips the bidi override that makes "USDC‮toor" read as "USDCroot"', () => {
    expect(sanitizeLabel('USDC‮toor‬')).toBe('USDCtoor')
  })

  it('strips zero-width and invisible characters used to clone a trusted name', () => {
    expect(sanitizeLabel('US​DC')).toBe('USDC')
    expect(sanitizeLabel('﻿USDC⁠')).toBe('USDC')
    expect(sanitizeLabel('US­DC')).toBe('USDC')
    expect(sanitizeLabel('USDC⁦⁩')).toBe('USDC')
  })

  it('still strips control characters and still truncates', () => {
    expect(sanitizeLabel('US\u0000D\u001fC')).toBe('USDC')
    expect(sanitizeLabel('x'.repeat(80))).toHaveLength(32)
  })

  it('rejects anything that is not a string', () => {
    expect(sanitizeLabel(undefined)).toBe('')
    expect(sanitizeLabel(42)).toBe('')
  })
})

describe('labelLooksSpoofed', () => {
  it('is quiet for ASCII', () => {
    expect(labelLooksSpoofed('USDC')).toBe(false)
    expect(labelLooksSpoofed('Wrapped Ether')).toBe(false)
  })

  it('catches Cyrillic and Greek look-alikes of ASCII letters', () => {
    expect(labelLooksSpoofed('ЅОЅ')).toBe(true) // ЅОЅ, not SOS
    expect(labelLooksSpoofed('USАDC')).toBe(true) // Cyrillic А
    expect(labelLooksSpoofed('ΟMG')).toBe(true) // Greek Ο
  })

  it('catches full-width forms', () => {
    expect(labelLooksSpoofed('ＵＳＤＣ')).toBe(true)
  })
})
