import { describe, expect, it, vi } from 'vitest'
import type { Hash } from 'viem'
import { fetchStatus, parseScanResponse, pollMessage, scanApiUrl, scanMessageUrl, type FetchLike } from '@/core/track'

const HASH: Hash = `0x${'ab'.repeat(32)}`
const DST: Hash = `0x${'cd'.repeat(32)}`
const GUID = `0x${'ef'.repeat(32)}`

const msg = (status: string, extra: Record<string, unknown> = {}) => ({
  data: [
    {
      pathway: { srcEid: 30367, dstEid: 30101 },
      source: { status: 'SUCCEEDED', tx: { txHash: HASH } },
      destination: { status: 'SUCCEEDED', tx: { txHash: DST } },
      guid: GUID,
      status: { name: status, message: 'm' },
      updated: '2026-09-18T00:00:00Z',
      ...extra,
    },
  ],
})

describe('parseScanResponse', () => {
  it('maps DELIVERED', () => {
    const s = parseScanResponse(msg('DELIVERED'))
    expect(s).toEqual({
      phase: 'delivered', raw: 'DELIVERED', message: 'm', guid: GUID,
      srcEid: 30367, dstEid: 30101, srcTxHash: HASH, dstTxHash: DST, updated: '2026-09-18T00:00:00Z',
    })
  })
  it.each(['INFLIGHT', 'CONFIRMING', 'inflight'])('%s is pending', (n) => {
    expect(parseScanResponse(msg(n)).phase).toBe('pending')
  })
  it.each(['FAILED', 'BLOCKED', 'PAYLOAD_STORED', 'APPLICATION_BURNED', 'MALFORMED_COMMAND'])('%s is failed', (n) => {
    expect(parseScanResponse(msg(n)).phase).toBe('failed')
  })
  it('unknown status name stays pending with raw preserved', () => {
    const s = parseScanResponse(msg('SOMETHING_NEW'))
    expect(s.phase).toBe('pending')
    expect(s.raw).toBe('SOMETHING_NEW')
  })
  it('garbage shapes -> no_data', () => {
    for (const j of [null, undefined, 42, 'x', {}, { data: null }, { data: [] }, { data: [null] }, { data: [{}] }]) {
      expect(parseScanResponse(j).phase).toBe('no_data')
    }
  })
  it('drops malformed hashes/eids instead of trusting them', () => {
    const s = parseScanResponse(
      msg('INFLIGHT', {
        destination: { tx: { txHash: 'javascript:alert(1)' } },
        pathway: { srcEid: '30367', dstEid: 30101 },
        guid: 'nope',
      }),
    )
    expect(s.dstTxHash).toBeUndefined()
    expect(s.srcEid).toBeUndefined()
    expect(s.dstEid).toBe(30101)
    expect(s.guid).toBeUndefined()
  })
  it('truncates long strings', () => {
    const s = parseScanResponse(msg('INFLIGHT', { status: { name: 'INFLIGHT', message: 'x'.repeat(1000) } }))
    expect(s.message).toHaveLength(256)
  })
})

describe('urls', () => {
  it('point at layerzero scan only', () => {
    expect(scanApiUrl(HASH)).toBe(`https://scan.layerzero-api.com/v1/messages/tx/${HASH}`)
    expect(scanMessageUrl(HASH)).toBe(`https://layerzeroscan.com/tx/${HASH}`)
  })
})

const fakeFetch = (responses: Array<unknown | Error | { httpStatus: number }>): FetchLike => {
  let i = 0
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)]
    if (r instanceof Error) throw r
    if (r && typeof r === 'object' && 'httpStatus' in r) {
      return { ok: false, status: (r as { httpStatus: number }).httpStatus, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => r }
  }
}

describe('fetchStatus', () => {
  it('network error -> no_data, not failed', async () => {
    expect((await fetchStatus(HASH, fakeFetch([new Error('offline')]))).phase).toBe('no_data')
  })
  it('HTTP 404/500 -> no_data', async () => {
    expect((await fetchStatus(HASH, fakeFetch([{ httpStatus: 404 }]))).phase).toBe('no_data')
    expect((await fetchStatus(HASH, fakeFetch([{ httpStatus: 500 }]))).phase).toBe('no_data')
  })
})

describe('pollMessage', () => {
  const noSleep = async () => {}

  it('polls until delivered and reports each update', async () => {
    const updates: string[] = []
    const s = await pollMessage(HASH, {
      fetchImpl: fakeFetch([new Error('x'), msg('INFLIGHT'), msg('CONFIRMING'), msg('DELIVERED')]),
      sleep: noSleep,
      onUpdate: (u) => updates.push(u.phase),
    })
    expect(s.phase).toBe('delivered')
    expect(updates).toEqual(['no_data', 'pending', 'pending', 'delivered'])
  })

  it('stops on failed', async () => {
    const s = await pollMessage(HASH, { fetchImpl: fakeFetch([msg('INFLIGHT'), msg('BLOCKED')]), sleep: noSleep })
    expect(s.phase).toBe('failed')
    expect(s.raw).toBe('BLOCKED')
  })

  it('times out with last state, not failure', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(fakeFetch([msg('INFLIGHT')]))
      const sleep = async () => {
        vi.advanceTimersByTime(10_000)
      }
      const s = await pollMessage(HASH, { fetchImpl, sleep, intervalMs: 10_000, timeoutMs: 35_000 })
      expect(s.phase).toBe('pending')
      expect(fetchImpl).toHaveBeenCalledTimes(4) // fetched at t=0,10,20,30; after sleeping to 40 >= 35 -> stop
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects abort', async () => {
    const ac = new AbortController()
    const fetchImpl = vi.fn(fakeFetch([msg('INFLIGHT')]))
    const sleep = async () => {
      ac.abort()
    }
    const s = await pollMessage(HASH, { fetchImpl, sleep, signal: ac.signal })
    expect(s.phase).toBe('pending')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
