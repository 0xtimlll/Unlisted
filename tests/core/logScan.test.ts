/** Log scans read the newest blocks first and widen only while the answer is open (lz-risk/probe.ts). */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseAbiItem } from 'viem'
import type { ReadClient } from '@/core/client'
import { FIRST_SPAN, isRangeRefusal, resetRefusedSpans, scanNewest, scanWidening } from '@/protocols/lz-risk/probe'

const EVENT = parseAbiItem('event PeerSet(uint32 eid, bytes32 peer)')
const HEAD = 1_000_000n
type Range = { fromBlock: bigint; toBlock: bigint }

function client(chainId: number, serve: (r: Range) => { blockNumber: bigint }[] | Error) {
  const asked: Range[] = []
  const c = {
    chain: { id: chainId },
    getBlockNumber: async () => HEAD,
    getLogs: async (p: Range) => {
      asked.push({ fromBlock: p.fromBlock, toBlock: p.toBlock })
      const r = serve(p)
      if (r instanceof Error) throw r
      return r
    },
  } as unknown as ReadClient
  return { c, asked }
}

beforeEach(() => resetRefusedSpans())

describe('scanWidening / scanNewest', () => {
  it('stops at the narrowest window when it already holds the answer', async () => {
    const { c, asked } = client(1, () => [{ blockNumber: HEAD - 10n }])
    const r = await scanNewest(c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })
    expect(r.status).toBe('found')
    expect(asked).toEqual([{ fromBlock: HEAD - FIRST_SPAN, toBlock: HEAD }])
  })

  it('widens over the blocks not yet read, and reports the whole covered window', async () => {
    const { c, asked } = client(2, () => [])
    const r = await scanNewest(c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })
    expect(r).toMatchObject({ status: 'none', window: { fromBlock: HEAD - 50_000n, toBlock: HEAD } })
    expect(asked).toEqual([
      { fromBlock: HEAD - 2_000n, toBlock: HEAD },
      { fromBlock: HEAD - 10_000n, toBlock: HEAD - 2_001n },
      { fromBlock: HEAD - 50_000n, toBlock: HEAD - 10_001n },
    ])
  })

  it('a refused wider window ends the scan with what was read, and is not asked again on that chain', async () => {
    const refuse = (r: Range) => (r.toBlock - r.fromBlock > 2_000n ? new Error('exceed maximum block range: 5000') : [])
    const first = client(56, refuse)
    expect(await scanNewest(first.c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })).toMatchObject({ status: 'none', window: { blocks: 2_000n } })
    expect(first.asked).toHaveLength(2)
    const again = client(56, refuse)
    await scanNewest(again.c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })
    expect(again.asked).toHaveLength(1) // the refused size is remembered for BNB Chain
    const other = client(1, refuse)
    await scanNewest(other.c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })
    expect(other.asked).toHaveLength(2) // and only for BNB Chain
  })

  it('a chain that refuses even the first window is asked for smaller ones, and starts there next time (X Layer: 100 max)', async () => {
    const xlayer = (r: Range) => (r.toBlock - r.fromBlock > 100n ? new Error('HTTP request failed. Details: no RPC answered: HTTP 400: block range greater than 100 max') : [])
    const first = client(196, xlayer)
    expect(await scanNewest(first.c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })).toMatchObject({ status: 'none', window: { blocks: 100n } })
    expect(first.asked.map((r) => r.toBlock - r.fromBlock)).toEqual([2_000n, 500n, 100n])
    const again = client(196, xlayer)
    await scanNewest(again.c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })
    expect(again.asked.map((r) => r.toBlock - r.fromBlock)).toEqual([100n])
  })

  it('a timeout is not remembered as a refusal, and a failure of the first window is unavailable', async () => {
    const t = client(10, () => new Error('The request took too long to respond. timed out'))
    expect((await scanNewest(t.c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })).status).toBe('unavailable')
    const ok = client(10, () => [])
    await scanNewest(ok.c, { address: '0x0000000000000000000000000000000000000001', event: EVENT })
    expect(ok.asked).toHaveLength(3)
  })

  it('counts across windows until the floor is met', async () => {
    const { c, asked } = client(3, (r) => Array.from({ length: Number((r.toBlock - r.fromBlock) / 1000n) }, (_, i) => ({ blockNumber: r.toBlock - BigInt(i) })))
    const r = await scanWidening(c, (fromBlock, toBlock) => c.getLogs({ fromBlock, toBlock } as never) as Promise<{ blockNumber: bigint }[]>, (logs) => logs.length >= 5)
    expect(r.status).toBe('ok')
    expect(asked).toHaveLength(2)
    if (r.status === 'ok') expect(r.logs.length).toBeGreaterThanOrEqual(5)
  })
})

describe('isRangeRefusal', () => {
  it('knows the providers\' words for "too wide", and not an outage', () => {
    for (const m of [
      'limit exceeded',
      'Archive requests require a personal token',
      'Log response size exceeded. Maximum allowed number of requested blocks is 1000',
      'ranges over 10000 blocks are not supported on free plan',
      'exceed maximum block range: 5000',
      'HTTP request failed. Status: 502 Details: {"code":-32603,"message":"no RPC answered: rpc error: limit exceeded; HTTP 403; rpc error: Log response size exceeded"}',
    ])
      expect(isRangeRefusal(m), m).toBe(true)
    for (const m of ['The request took too long to respond.', 'HTTP request failed. Status: 502 Details: no RPC answered: HTTP 500; upstream timeout', 'fetch failed']) expect(isRangeRefusal(m), m).toBe(false)
  })
})
