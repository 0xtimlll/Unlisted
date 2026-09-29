/**
 * §5 against mainnet: Status / Rescue on real historical messages.
 *
 * Four transactions that really happened, chosen to cover what can be covered without a stuck
 * message to hand: a v1 delivery, a v1 message to a chain this app does not serve, and two V2
 * deliveries on different chains. Each one is read the way the tab reads it — receipt in, state and
 * plan out — and the invariant asserted every time is the one that matters most: **a message that has
 * already arrived produces no action.**
 *
 * What is not asserted here, and why: a parked payload. `PayloadStored` was searched for across five
 * chains' Endpoint V1 contracts and none was found in any window a public provider would serve —
 * they are rare, and a test cannot depend on one existing. The refusals around them are unit-tested
 * instead (tests/core/lzRescue.test.ts), including the case that matters: a payload whose hash does
 * not match what the destination is holding.
 *
 * Read-only. Nothing here signs or submits.
 */
import { describe, expect, it } from 'vitest'
import { evmByKey, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { findMessages, lookupRescue, rescueClientFor } from '@/protocols/lz-rescue'

/** JOE, Arbitrum → Avalanche, v1: delivered. */
const V1_DELIVERED = { chain: 'arbitrum' as ChainKey, hash: '0xc25a1b7bc144928f9da9a54aac801fa740e387c2b1df6fdc78afa5748112d661' as const }
/** JOE, Avalanche → Monad (v1 chain id 390): a destination this app does not serve. */
const V1_UNSERVED = { chain: 'avalanche' as ChainKey, hash: '0x23629da79f5d0d7e99207d2379bd50fee1e061fee8478f9091ffc12b42c10603' as const }
/** TREAD, HyperEVM → Ethereum, V2: delivered. */
const V2_DELIVERED = { chain: 'hyperevm' as ChainKey, hash: '0xfcac25244f287ff638d4c67bdc68239a9575a3b0de9cf3257e444d953e5fe003' as const }
/** DEGEN, Robinhood → Base, V2: delivered. */
const V2_DELIVERED_2 = { chain: 'robinhood' as ChainKey, hash: '0x58cb25ea6798ac6b5046862b0d27ffde59cc11e7f87cf759aa1fd5ce5a9e9469' as const }

async function look(t: { chain: ChainKey; hash: `0x${string}` }) {
  const client = makeReadClient(evmByKey(t.chain))
  const receipt = await client.getTransactionReceipt({ hash: t.hash })
  return {
    receipt,
    result: await lookupRescue(receipt.logs, t.chain, (c) => rescueClientFor(c, {})),
  }
}

describe('a v1 message that arrived', () => {
  it('is read out of the transaction and reported as delivered', async () => {
    const { result } = await look(V1_DELIVERED)
    expect(result.reports).toHaveLength(1)
    const [report] = result.reports
    const m = report!.diagnosis.message
    expect(m.version).toBe('v1')
    expect(m.srcChain).toBe('arbitrum')
    expect(m.dstChain).toBe('avalanche')
    expect(report!.diagnosis.state.kind).toBe('delivered')
    // The whole point: nothing to retry, and no button to offer.
    expect(report!.plan.kind).toBe('nothing')
  }, 40_000)

  it('names the receiving contract and the path from the packet, not from a list', async () => {
    const { receipt } = await look(V1_DELIVERED)
    const [m] = findMessages(receipt.logs, 'arbitrum')
    if (m?.version !== 'v1') throw new Error('expected a v1 message')
    // The path is srcOApp ++ dstOApp, which is the key the destination endpoint stores under.
    expect(m.path.toLowerCase()).toBe(`0x${m.srcOApp.slice(2)}${m.dstOApp.slice(2)}`.toLowerCase())
    expect(m.nonce).toBeGreaterThan(0n)
    expect(m.payload.length).toBeGreaterThan(2)
  }, 40_000)
})

describe('a message to a chain this app does not serve', () => {
  it('is found and named, and no state is invented for it', async () => {
    // JOE's newest Avalanche send at the time of writing went to Monad, v1 chain id 390 — one of the
    // 113 chains with a v1 deployment that this registry does not carry. The honest answer is "found,
    // cannot read the other side", not a diagnosis.
    const { result } = await look(V1_UNSERVED)
    expect(result.reports).toHaveLength(0)
    expect(result.unservedDestinations).toHaveLength(1)
    const m = result.unservedDestinations[0]!
    expect(m.version).toBe('v1')
    expect(m.dstChain).toBeUndefined()
    if (m.version === 'v1') expect(m.dstV1ChainId).toBe(390)
  }, 40_000)
})

describe('V2 messages that arrived', () => {
  it.each([
    ['HyperEVM → Ethereum', V2_DELIVERED, 'ethereum'],
    ['Robinhood → Base', V2_DELIVERED_2, 'base'],
  ] as const)('%s is reported as delivered with nothing to do', async (_label, target, dstChain) => {
    const { result } = await look(target)
    expect(result.reports).toHaveLength(1)
    const report = result.reports[0]!
    const m = report.diagnosis.message
    expect(m.version).toBe('v2')
    expect(m.dstChain).toBe(dstChain)
    expect(report.diagnosis.state.kind).toBe('delivered')
    expect(report.plan.kind).toBe('nothing')
    // The endpoint was read off the receiving contract itself, which is the only place §5 allows.
    expect(report.diagnosis.dstEndpoint).toBeDefined()
  }, 40_000)

  it('splits the packet into the header and the payload the endpoint hashes', async () => {
    const { receipt } = await look(V2_DELIVERED)
    const [m] = findMessages(receipt.logs, 'hyperevm')
    if (m?.version !== 'v2') throw new Error('expected a v2 message')
    expect((m.header.length - 2) / 2).toBe(81)
    expect(m.payload.startsWith(m.packet.guid)).toBe(true)
    expect(m.payloadHash).toMatch(/^0x[0-9a-f]{64}$/)
  }, 40_000)
})

describe('across all four', () => {
  it('never offers an action for a message that has already arrived', async () => {
    for (const t of [V1_DELIVERED, V2_DELIVERED, V2_DELIVERED_2]) {
      const { result } = await look(t)
      for (const report of result.reports) {
        if (report.diagnosis.state.kind === 'delivered') {
          expect(report.plan.kind, `${t.hash}`).toBe('nothing')
        }
      }
    }
  }, 90_000)

  it('never builds a call that carries value', async () => {
    for (const t of [V1_DELIVERED, V1_UNSERVED, V2_DELIVERED, V2_DELIVERED_2]) {
      const { result } = await look(t)
      for (const report of result.reports) {
        if (report.plan.kind === 'action') expect(report.plan.call.value).toBe(0n)
      }
    }
  }, 90_000)
})
