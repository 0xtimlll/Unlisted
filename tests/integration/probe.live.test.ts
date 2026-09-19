/**
 * Read-only tests against public RPCs (§9). No keys, no state changes.
 * Run: npm run test:integration
 */
import { describe, expect, it } from 'vitest'
import { byKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { runGuards } from '@/core/guards'
import { buildSendPlan, PlanError } from '@/core/plan'
import { probeOft, ProbeError } from '@/core/probe'

const TREAD_OFT = '0xd5EE1c81fE161e985dce6b90713c965f9979cf80'
const TREAD_ADAPTER = '0xe68AD53cf0D5E49CF83FBC003672f6D0eBcAe311'
const USDT0_OFT = '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98'
const USDT0_TOKEN = '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb'
const WHYPE = '0x5555555555555555555555555555555555555555' // plain ERC-20, not an OFT
const SOME_EOA = '0x000000000000000000000000000000000000dEaD'
const USER = '0x1111111111111111111111111111111111111111'

const hyper = makeReadClient(byKey('hyperevm'))
const eth = makeReadClient(byKey('ethereum'))

describe('HyperEVM / TREAD OFT', () => {
  it('probes as plain OFT, no approve, 18/6, peer on Ethereum', async () => {
    const { info, flags } = await probeOft(hyper, TREAD_OFT)
    expect(info.kind).toBe('OFT')
    expect(info.token).toBe(TREAD_OFT)
    expect(info.approvalRequired).toBe(false)
    expect(info.decimals).toBe(18)
    expect(info.sharedDecimals).toBe(6)
    expect(info.conversionRate).toBe(10n ** 12n)
    expect(info.symbol.length).toBeGreaterThan(0)
    const eth = info.routes.find((r) => r.eid === 30101)
    expect(eth?.peer).toBe(TREAD_ADAPTER)
    expect(Array.isArray(flags)).toBe(true)
  })

  it('builds a plan with real quotes and the pure guards agree', async () => {
    const { info } = await probeOft(hyper, TREAD_OFT)
    const plan = await buildSendPlan(hyper, {
      info, src: byKey('hyperevm'), dstEid: 30101, amountInput: '1', sender: USER, recipient: USER,
    })
    expect(plan.amounts.amountLD).toBe(10n ** 18n)
    expect(plan.quote.nativeFee).toBeGreaterThan(0n)
    expect(plan.value).toBeGreaterThanOrEqual(plan.quote.nativeFee)
    expect(plan.value % byKey('hyperevm').feeStepWei).toBe(0n)
    expect(plan.quote.amountReceivedLD).toBe(plan.amounts.amountLD) // no OFT fee on this route
    // Guards that do not need a wallet/simulation should all pass.
    const rep = runGuards({
      walletAddress: USER, walletChainId: 999, srcChainId: 999, info, plan,
      recipientIsCustom: false, customRecipientConfirmed: false,
      tokenBalance: 10n ** 18n, nativeBalance: plan.value + 10n ** 16n, allowance: 0n, gasCostWei: 10n ** 15n,
      simulation: { ok: true }, selfCheck: { ok: true }, noExecutorGasAccepted: true, flags: [], peerBack: { status: 'ok' }, peerBackUnavailableAccepted: false,
    })
    expect(rep.results.filter((r) => !r.ok)).toEqual([])
  })

  it('refuses a destination without a peer', async () => {
    const { info } = await probeOft(hyper, TREAD_OFT)
    await expect(
      buildSendPlan(hyper, { info, src: byKey('hyperevm'), dstEid: 30184, amountInput: '1', sender: USER, recipient: USER }),
    ).rejects.toMatchObject({ code: 'no_route' } satisfies Partial<PlanError>)
  })
})

describe('HyperEVM / USDT0 adapter', () => {
  it('probes as adapter with a separate token, 6/6, multiple peers', async () => {
    const { info } = await probeOft(hyper, USDT0_OFT)
    expect(info.kind).toBe('OFTAdapter')
    expect(info.token).toBe(USDT0_TOKEN)
    expect(info.approvalRequired).toBe(false)
    expect(info.decimals).toBe(6)
    expect(info.sharedDecimals).toBe(6)
    expect(info.conversionRate).toBe(1n)
    const eids = info.routes.map((r) => r.eid)
    expect(eids).toEqual(expect.arrayContaining([30101, 30110, 30111]))
    // mint/burn adapter: the locked-balance signal does not apply
    expect(info.lockedInAdapter).toBeUndefined()
  })
})

describe('Ethereum / TREAD adapter', () => {
  it('requires approve and peers back to HyperEVM', async () => {
    const { info, flags } = await probeOft(eth, TREAD_ADAPTER)
    expect(info.kind).toBe('OFTAdapter')
    expect(info.approvalRequired).toBe(true)
    expect(info.token).not.toBe(TREAD_ADAPTER)
    expect(info.routes.find((r) => r.eid === 30367)?.peer).toBe(TREAD_OFT)
    // A real lock/unlock adapter holds everything ever bridged out.
    expect(info.lockedInAdapter).toBeGreaterThan(0n)
    expect(flags).not.toContain('adapter_empty')
  })
})

describe('negative', () => {
  it('plain ERC-20 is rejected as not an OFT', async () => {
    await expect(probeOft(hyper, WHYPE)).rejects.toMatchObject({ code: 'not_oft' } satisfies Partial<ProbeError>)
  })
  it('EOA is rejected as not a contract', async () => {
    await expect(probeOft(hyper, SOME_EOA)).rejects.toMatchObject({ code: 'not_contract' })
  })
  it('garbage address is rejected before any RPC', async () => {
    await expect(probeOft(hyper, '0x1234')).rejects.toMatchObject({ code: 'invalid_address' })
  })
})
