import { describe, expect, it, vi } from 'vitest'
import type { ReadClient } from '@/core/client'
import { DecodeTxError } from '@/core/decodeTx'
import { ProbeError } from '@/core/probe'
import { decodeTxQuorum, probeOftQuorum, sameOftInfo, sameTx, type Pair } from '@/core/quorum'
import { assembleSendArgs, encodeSendCalldata } from '@/core/plan'
import { OTHER, TREAD_ADAPTER, TREAD_OFT, treadOftInfo, treadPlan } from './fixtures'

// probeOft / decodeTx are exercised elsewhere; here we mock them to test the quorum logic.
vi.mock('@/core/probe', async (orig) => {
  const m = await orig<typeof import('@/core/probe')>()
  return { ...m, probeOft: vi.fn() }
})
vi.mock('@/core/decodeTx', async (orig) => {
  const m = await orig<typeof import('@/core/decodeTx')>()
  return { ...m, decodeTx: vi.fn() }
})
import { probeOft } from '@/core/probe'
import { decodeTx } from '@/core/decodeTx'

const A = { tag: 'A' } as unknown as ReadClient
const B = { tag: 'B' } as unknown as ReadClient
const pair: Pair = { primary: A, secondaries: [B] }
const single: Pair = { primary: A, secondaries: [] }
// Returns a mock implementation that answers differently for client A and client B.
const byClient = (a: unknown, b: unknown): never =>
  (async (client: ReadClient) => {
    const v = client === A ? a : b
    if (v instanceof Error) throw v
    return v
  }) as never

describe('probeOftQuorum', () => {
  const good = { info: treadOftInfo(), flags: [] }
  it('agreeing providers → crossChecked', async () => {
    vi.mocked(probeOft).mockImplementation(byClient(good, { info: treadOftInfo(), flags: ['behind_proxy'] }))
    const r = await probeOftQuorum(pair, TREAD_OFT)
    expect(r.crossChecked).toBe(true)
    expect(r.info.oft).toBe(TREAD_OFT)
  })
  it('a lying second provider (different token/peer/approve) → rpc_mismatch', async () => {
    for (const lie of [
      treadOftInfo({ token: OTHER }),
      treadOftInfo({ approvalRequired: true }),
      treadOftInfo({ routes: [{ eid: 30101, peer: OTHER }] }),
      treadOftInfo({ routes: [] }),
      treadOftInfo({ conversionRate: 1n }),
    ]) {
      vi.mocked(probeOft).mockImplementation(byClient(good, { info: lie, flags: [] }))
      await expect(probeOftQuorum(pair, TREAD_OFT)).rejects.toMatchObject({ code: 'rpc_mismatch' })
    }
  })
  it('second provider says "not an OFT" → mismatch, not outage', async () => {
    vi.mocked(probeOft).mockImplementation(byClient(good, new ProbeError('not_oft')))
    await expect(probeOftQuorum(pair, TREAD_OFT)).rejects.toMatchObject({ code: 'rpc_mismatch' })
  })
  it('second provider down → result without crossChecked', async () => {
    vi.mocked(probeOft).mockImplementation(byClient(good, new Error('ECONNRESET')))
    const r = await probeOftQuorum(pair, TREAD_OFT)
    expect(r.crossChecked).toBe(false)
  })
  it('primary failure propagates', async () => {
    vi.mocked(probeOft).mockImplementation(byClient(new ProbeError('not_contract'), good))
    await expect(probeOftQuorum(pair, TREAD_OFT)).rejects.toMatchObject({ code: 'not_contract' })
  })
  it('one secondary down, another agrees → crossChecked; all down → not', async () => {
    const C = { tag: 'C' } as unknown as ReadClient
    const three: Pair = { primary: A, secondaries: [B, C] }
    vi.mocked(probeOft).mockImplementation((async (client: ReadClient) => {
      if (client === B) throw new Error('timeout')
      return good
    }) as never)
    expect((await probeOftQuorum(three, TREAD_OFT)).crossChecked).toBe(true)
    vi.mocked(probeOft).mockImplementation((async (client: ReadClient) => {
      if (client !== A) throw new Error('timeout')
      return good
    }) as never)
    expect((await probeOftQuorum(three, TREAD_OFT)).crossChecked).toBe(false)
    // a disagreeing third provider still blocks even if the second is down
    vi.mocked(probeOft).mockImplementation((async (client: ReadClient) => {
      if (client === B) throw new Error('timeout')
      if (client === C) return { info: treadOftInfo({ token: OTHER }), flags: [] }
      return good
    }) as never)
    await expect(probeOftQuorum(three, TREAD_OFT)).rejects.toMatchObject({ code: 'rpc_mismatch' })
  })
  it('no secondary → never crossChecked', async () => {
    vi.mocked(probeOft).mockImplementation(byClient(good, good))
    expect((await probeOftQuorum(single, TREAD_OFT)).crossChecked).toBe(false)
  })
  it('sameOftInfo ignores owner/name/symbol/enforced (non-critical, may legitimately vary)', () => {
    expect(sameOftInfo(treadOftInfo(), treadOftInfo({ symbol: 'X', name: 'Y', enforced: {} }))).toBe(true)
  })
})

describe('decodeTxQuorum', () => {
  const plan = treadPlan()
  const calldata = encodeSendCalldata(assembleSendArgs(plan))
  const prefill = {
    oft: TREAD_OFT, dstEid: 30101, extraOptions: '0x' as const, droppedOptions: [], optionsMalformed: false,
    observed: { from: OTHER, amountLD: plan.amounts.amountLD, minAmountLD: plan.amounts.minAmountLD, nativeFee: plan.value, value: plan.value, hadComposeMsg: false, hadOftCmd: false },
  }
  void calldata
  it('agreeing providers → crossChecked', async () => {
    vi.mocked(decodeTx).mockImplementation(byClient(prefill, { ...prefill }))
    expect((await decodeTxQuorum(pair, `0x${'11'.repeat(32)}`)).crossChecked).toBe(true)
  })
  it('a lying provider swapping tx.to → rpc_mismatch (the fake-adapter-by-hash attack)', async () => {
    vi.mocked(decodeTx).mockImplementation(byClient(prefill, { ...prefill, oft: TREAD_ADAPTER }))
    await expect(decodeTxQuorum(pair, `0x${'11'.repeat(32)}`)).rejects.toMatchObject({ code: 'rpc_mismatch' })
  })
  it('second says not_send → mismatch; second down → not crossChecked', async () => {
    vi.mocked(decodeTx).mockImplementation(byClient(prefill, new DecodeTxError('not_send')))
    await expect(decodeTxQuorum(pair, `0x${'11'.repeat(32)}`)).rejects.toMatchObject({ code: 'rpc_mismatch' })
    vi.mocked(decodeTx).mockImplementation(byClient(prefill, new Error('timeout')))
    expect((await decodeTxQuorum(pair, `0x${'11'.repeat(32)}`)).crossChecked).toBe(false)
  })
  it('sameTx compares the fields that matter', () => {
    expect(sameTx(prefill, { ...prefill, dstEid: 30110 })).toBe(false)
    expect(sameTx(prefill, { ...prefill, extraOptions: '0x01' })).toBe(false)
    expect(sameTx(prefill, { ...prefill, optionsMalformed: true })).toBe(true)
  })
})
