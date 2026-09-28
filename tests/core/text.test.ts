/**
 * The four channels that used to carry a contract's (or an explorer's) own layout controls all the
 * way to the screen. Each one is checked where it is actually parsed, not just at the stripper.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeText, sanitizeLabel } from '@/core/text'
import { parseScanResponse } from '@/core/track'
import { parseTokenList } from '@/protocols/wormhole-ntt/tokenList'
import { formatRevert } from '@/core/sim/revert'

/** Right-to-left override: everything after it renders backwards. */
const RTL = '‮'
const ZWSP = '​'

describe('sanitizeText', () => {
  it('keeps ordinary text, including honest non-ASCII', () => {
    expect(sanitizeText('Wrapped Ether', 64)).toBe('Wrapped Ether')
    expect(sanitizeText('  0.001 ETH  ', 64)).toBe('0.001 ETH')
    expect(sanitizeText('Süß', 64)).toBe('Süß')
  })

  it('strips the characters that let a string lay itself out', () => {
    expect(sanitizeText(`fee${RTL}drawn`, 64)).toBe('feedrawn')
    expect(sanitizeText(`US${ZWSP}DC`, 64)).toBe('USDC')
    expect(sanitizeText('a\u0000b\u001fc', 64)).toBe('abc')
    expect(sanitizeText('﻿x⁠', 64)).toBe('x')
  })

  it('caps the length and refuses anything that is not a string', () => {
    expect(sanitizeText('x'.repeat(500), 64)).toHaveLength(64)
    expect(sanitizeText(undefined, 64)).toBe('')
    expect(sanitizeText(42, 64)).toBe('')
  })

  it('still exports the label form probe.ts used to own', () => {
    expect(sanitizeLabel('x'.repeat(80))).toHaveLength(32)
  })
})

describe('the channels that reach the screen', () => {
  it('a revert string cannot reorder the line it is printed on', () => {
    const line = formatRevert({ kind: 'string', message: `insufficient${RTL}dnuf`, meaning: 'generic' })
    expect(line).toBe('Error("insufficientdnuf")')
    expect(line).not.toContain(RTL)
  })

  it('a custom error’s string argument cannot either', () => {
    const line = formatRevert({
      kind: 'error',
      name: 'SlippageExceeded',
      args: [`ok${RTL}`, 1000n],
      meaning: 'generic',
      selector: '0xdeadbeef',
      source: 'known',
    })
    expect(line).toBe('SlippageExceeded(ok, 1000)')
  })

  it('the NTT token list cannot smuggle a symbol that renders as another one', () => {
    const [token] = parseTokenList([
      { symbol: `US${ZWSP}DC`, coingecko_id: 'x', platforms: { ethereum: '0x1111111111111111111111111111111111111111' } },
    ])
    expect(token?.symbol).toBe('USDC')
  })

  it('LayerZero Scan’s status message cannot either', () => {
    const s = parseScanResponse({
      data: [{ status: { name: 'FAILED', message: `delivered${RTL}ton` }, pathway: {}, source: {}, destination: {} }],
    })
    expect(s.message).toBe('deliveredton')
    expect(s.phase).toBe('failed')
  })
})
