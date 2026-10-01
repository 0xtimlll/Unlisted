/**
 * Paste the token, get the adapter: the far-side OFT's `peers(srcEid)` is a search hint, the probe
 * on the source chain is what decides, and only an OFTAdapter for exactly this token is offered.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, pad, type Address, type Hex } from 'viem'
import { findAdapterForToken, type AdapterSearchDeps } from '@/core/adapterSearch'
import { byKey, type ChainKey } from '@/core/chains'
import { treadAdapterInfo, treadOftInfo } from './fixtures'

// The CT shape: the token on Ethereum, the OFT at the same address on BNB Chain, the adapter elsewhere.
const TOKEN = getAddress('0x0A092E544DA31150b439a1aAA1A3a2214a867F46')
const ADAPTER = getAddress('0x121873Fe37BE77372b69D7a8A642618b8305E71a')
const STRANGER = getAddress('0x3333333333333333333333333333333333333333')
const ETH_EID = byKey('ethereum').eid
const b32 = (a: Address): Hex => pad(a.toLowerCase() as Address, { size: 32 })
const ZERO: Hex = `0x${'0'.repeat(64)}`

/** `peers` answers per chain, and what the source-chain probe says about each address. */
function deps(peers: Partial<Record<ChainKey, Hex | Error>>, probes: Record<string, ReturnType<typeof treadAdapterInfo> | Error>, log: string[] = []): AdapterSearchDeps {
  return {
    readPeer: async (chain, address, eid) => {
      log.push(`peers ${chain} ${address} ${eid}`)
      const a = peers[chain]
      if (a === undefined) return ZERO
      if (a instanceof Error) throw a
      return a
    },
    probe: async (address) => {
      log.push(`probe ${address}`)
      const r = probes[address.toLowerCase()]
      if (!r) throw new Error('not_oft')
      if (r instanceof Error) throw r
      return r
    },
  }
}

const adapterForToken = treadAdapterInfo({ oft: ADAPTER, token: TOKEN })
const chains: ChainKey[] = ['ethereum', 'bsc', 'arbitrum', 'base']

describe('findAdapterForToken', () => {
  it('finds the adapter the far-side OFT names, and verifies it on the source chain', async () => {
    const log: string[] = []
    const r = await findAdapterForToken({ token: TOKEN, srcChain: 'ethereum', srcEid: ETH_EID, chains }, deps({ bsc: b32(ADAPTER) }, { [ADAPTER.toLowerCase()]: adapterForToken }, log))
    expect(r.found).toEqual([{ adapter: ADAPTER, foundOn: ['bsc'] }])
    expect(r.named).toEqual(['bsc'])
    expect(r.failed).toEqual([])
    expect(r.rejected).toEqual([])
    // The source chain itself is never asked, and every other chain is asked for THIS source's eid.
    expect(log.filter((l) => l.startsWith('peers'))).toEqual([`peers bsc ${TOKEN} ${ETH_EID}`, `peers arbitrum ${TOKEN} ${ETH_EID}`, `peers base ${TOKEN} ${ETH_EID}`])
    expect(log.filter((l) => l.startsWith('probe'))).toEqual([`probe ${ADAPTER}`])
  })

  it('the same adapter named by several chains is one candidate, probed once', async () => {
    const log: string[] = []
    const r = await findAdapterForToken({ token: TOKEN, srcChain: 'ethereum', srcEid: ETH_EID, chains }, deps({ bsc: b32(ADAPTER), arbitrum: b32(ADAPTER) }, { [ADAPTER.toLowerCase()]: adapterForToken }, log))
    expect(r.found).toEqual([{ adapter: ADAPTER, foundOn: ['bsc', 'arbitrum'] }])
    expect(log.filter((l) => l.startsWith('probe'))).toHaveLength(1)
  })

  it('a named peer that is not an adapter for this token is rejected — the hint does not decide', async () => {
    // A plain OFT at the named address, an adapter for ANOTHER token, and an address that is not an OFT at all.
    const otherToken = treadAdapterInfo({ oft: STRANGER, token: getAddress('0x4444444444444444444444444444444444444444') })
    for (const probes of [
      { [ADAPTER.toLowerCase()]: treadOftInfo({ oft: ADAPTER }) },
      { [ADAPTER.toLowerCase()]: otherToken },
      {},
    ]) {
      const r = await findAdapterForToken({ token: TOKEN, srcChain: 'ethereum', srcEid: ETH_EID, chains }, deps({ bsc: b32(ADAPTER) }, probes))
      expect(r.found).toEqual([])
      expect(r.rejected).toEqual([ADAPTER])
      expect(r.named).toEqual(['bsc'])
    }
  })

  it('a peer pointing back at the token itself is not an adapter', async () => {
    const r = await findAdapterForToken({ token: TOKEN, srcChain: 'ethereum', srcEid: ETH_EID, chains }, deps({ bsc: b32(TOKEN) }, {}))
    expect(r.found).toEqual([])
    expect(r.rejected).toEqual([TOKEN])
  })

  it('a chain that could not be asked is reported as failed, never as "no peer"', async () => {
    const r = await findAdapterForToken({ token: TOKEN, srcChain: 'ethereum', srcEid: ETH_EID, chains }, deps({ bsc: b32(ADAPTER), arbitrum: new Error('rpc down') }, { [ADAPTER.toLowerCase()]: adapterForToken }))
    expect(r.found).toEqual([{ adapter: ADAPTER, foundOn: ['bsc'] }])
    expect(r.failed).toEqual(['arbitrum'])
  })

  it('a 32-byte peer that is not an EVM address is not a candidate', async () => {
    const r = await findAdapterForToken({ token: TOKEN, srcChain: 'ethereum', srcEid: ETH_EID, chains }, deps({ bsc: `0x${'11'.repeat(32)}` }, {}))
    expect(r.found).toEqual([])
    expect(r.named).toEqual([])
    expect(r.rejected).toEqual([])
  })

  it('nothing named anywhere: an empty, honest answer', async () => {
    const r = await findAdapterForToken({ token: TOKEN, srcChain: 'ethereum', srcEid: ETH_EID, chains }, deps({}, {}))
    expect(r).toEqual({ found: [], named: [], failed: [], rejected: [] })
  })
})
