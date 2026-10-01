/**
 * A shareable link carries the bridge (the path), the source, the token and the destination —
 * and nothing else. Reading is strict: a chain the registry does not know, an address of the
 * wrong shape, a Solana side on an EVM-only tab, all fall back to "no link".
 */
import { describe, expect, it } from 'vitest'
import { buildLink, linkTarget, parseLink } from '@/core/link'

const CT = '0x0A092E544DA31150b439a1aAA1A3a2214a867F46'
const STORE = 'D2hZiYnFqNS9YgNRoDtK7zajKjxc68139niZ1MmD8aae'

describe('parseLink', () => {
  it('reads from, token and to', () => {
    expect(parseLink('?from=ethereum&token=' + CT + '&to=bsc', 'oft')).toEqual({ from: 'ethereum', token: CT, to: 'bsc' })
    expect(parseLink('from=ethereum&token=' + CT, 'ntt')).toEqual({ from: 'ethereum', token: CT })
  })
  it('a Solana source on the OFT tab takes an OFT Store in base58', () => {
    expect(parseLink(`?from=solana&token=${STORE}&to=ethereum`, 'oft')).toEqual({ from: 'solana', token: STORE, to: 'ethereum' })
    expect(parseLink(`?from=solana&token=${CT}`, 'oft')).toBeUndefined()
  })
  it('NTT and CCIP are EVM-only: a Solana side is not a link there', () => {
    expect(parseLink(`?from=solana&token=${STORE}`, 'ntt')).toBeUndefined()
    expect(parseLink(`?from=ethereum&token=${CT}&to=solana`, 'ccip')).toEqual({ from: 'ethereum', token: CT })
  })
  it('refuses what it does not know, and drops a bad destination rather than the whole link', () => {
    expect(parseLink('?from=mars&token=' + CT, 'oft')).toBeUndefined()
    expect(parseLink('?from=ethereum&token=0x1234', 'oft')).toBeUndefined()
    expect(parseLink('?from=ethereum', 'oft')).toBeUndefined()
    expect(parseLink('', 'oft')).toBeUndefined()
    expect(parseLink('?from=ethereum&token=' + CT + '&to=mars', 'oft')).toEqual({ from: 'ethereum', token: CT })
    expect(parseLink('?from=ethereum&token=' + CT + '&to=ethereum', 'oft')).toEqual({ from: 'ethereum', token: CT })
  })
  it('ignores a recipient, an amount or anything else a link might try to carry', () => {
    const r = parseLink('?from=ethereum&token=' + CT + '&to=bsc&recipient=0x1111111111111111111111111111111111111111&amount=25&wallet=x', 'oft')
    expect(r).toEqual({ from: 'ethereum', token: CT, to: 'bsc' })
    expect(Object.keys(r!)).toEqual(['from', 'token', 'to'])
  })
  it('the rescue tab has no link', () => {
    expect(parseLink('?from=ethereum&token=' + CT, 'rescue')).toBeUndefined()
  })
})

describe('buildLink', () => {
  it('writes the three fields and nothing else, and round-trips', () => {
    const q = buildLink({ from: 'ethereum', token: CT, to: 'bsc' })
    expect(q).toBe(`?from=ethereum&token=${CT}&to=bsc`)
    expect(parseLink(q, 'oft')).toEqual({ from: 'ethereum', token: CT, to: 'bsc' })
    expect(buildLink({ from: 'base', token: CT })).toBe(`?from=base&token=${CT}`)
    expect(buildLink(undefined)).toBe('')
  })
})

describe('linkTarget', () => {
  it('is the same shape a tab takes from another tab, marked as coming from a link', () => {
    expect(linkTarget({ from: 'ethereum', token: CT, to: 'bsc' }, 'oft')).toEqual({ chain: 'ethereum', address: CT, kind: 'oft', dstChain: 'bsc', via: 'link' })
    expect(linkTarget({ from: 'solana', token: STORE }, 'oft')).toEqual({ chain: 'solana', address: STORE, kind: 'oft-store', via: 'link' })
    expect(linkTarget({ from: 'ethereum', token: CT }, 'ntt')).toEqual({ chain: 'ethereum', address: CT, kind: 'ntt-manager', via: 'link' })
    expect(linkTarget({ from: 'base', token: CT, to: 'ethereum' }, 'ccip')).toEqual({ chain: 'base', address: CT, token: CT, kind: 'ccip-token', dstChain: 'ethereum', via: 'link' })
    expect(linkTarget({ from: 'ethereum', token: CT }, 'rescue')).toBeUndefined()
  })
})
