/** Tab <-> protocol mapping and the paths the static export serves. */
import { describe, expect, it } from 'vitest'
import {
  IMPLEMENTED,
  PROTOCOL_IDS,
  TAB_SLUGS,
  isProtocolId,
  isTabSlug,
  protocolOfTab,
  tabOfPath,
  tabOfProtocol,
  tabPath,
} from '@/core/protocols'

describe('protocols', () => {
  it('every tab maps to a protocol and back', () => {
    for (const slug of TAB_SLUGS) expect(tabOfProtocol(protocolOfTab(slug))).toBe(slug)
    for (const id of PROTOCOL_IDS) expect(protocolOfTab(tabOfProtocol(id))).toBe(id)
  })

  it('there is exactly one tab per protocol', () => {
    expect(TAB_SLUGS).toHaveLength(PROTOCOL_IDS.length)
    expect(new Set(TAB_SLUGS.map((s) => protocolOfTab(s))).size).toBe(PROTOCOL_IDS.length)
  })

  it('validates untrusted values (localStorage, URLs)', () => {
    expect(isTabSlug('oft')).toBe(true)
    expect(isTabSlug('OFT')).toBe(false)
    expect(isTabSlug('../oft')).toBe(false)
    expect(isTabSlug(null)).toBe(false)
    expect(isProtocolId('lz-oft')).toBe(true)
    expect(isProtocolId('lz_oft')).toBe(false)
    expect(isProtocolId(undefined)).toBe(false)
  })

  it('reads the tab out of a pathname', () => {
    expect(tabOfPath('/bridge')).toBe('oft')
    expect(tabOfPath('/ntt/')).toBe('ntt')
    expect(tabOfPath('/ccip?x=1#y')).toBe('ccip')
    expect(tabOfPath('/')).toBeUndefined()
    expect(tabOfPath('/bridge/extra')).toBe('oft')
    expect(tabOfPath('/nope')).toBeUndefined()
    expect(tabOfPath('/oft')).toBeUndefined()
  })

  it('paths are the slugs the export writes', () => {
    expect(TAB_SLUGS.map(tabPath)).toEqual(['/bridge', '/ntt', '/ccip'])
  })

  it('every protocol with a tab now has a bridge behind it', () => {
    expect([...IMPLEMENTED].sort()).toEqual([...PROTOCOL_IDS].sort())
  })
})
