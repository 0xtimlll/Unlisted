/**
 * §3: the v1 guards, and the plan they judge.
 *
 * The plan is built against a stub client so the arithmetic the contract performs — its own fee
 * first, then dust, then the minimum — is checked exactly, without a network in the way.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { isBlockingCode } from '@/core/severity'
import { evmRecipient } from '@/core/recipient'
import { encodeAdapterParamsType1 } from '@/protocols/lz-v1/adapterParams'
import type { OftV1Info, V1Route } from '@/protocols/lz-v1/detect'
import {
  runV1Guards,
  v1g6Amounts,
  v1g10Allowance,
  v1g11NoApprove,
  v1g12Spender,
  v1g15AdapterParams,
  v1g20StoredPayload,
  type V1GuardInput,
  v1g9OftFee,
} from '@/protocols/lz-v1/guards'
import { buildV1SendPlan, encodeV1SendCalldata, toWireRecipient, V1PlanError, type V1SendPlan } from '@/protocols/lz-v1/plan'
import { v1SelfCheck } from '@/protocols/lz-v1/selfcheck'
import { submitV1Send, V1SendRefused, type V1Writer } from '@/protocols/lz-v1/send'
import { assessRisk, CHECK_IDS, emptyRiskInput, type CheckId, type CheckState, type RouteRisk } from '@/protocols/lz-risk/risk'

/** Every check ran and passed: OK, uncapped. Guard 22's own cases build their own verdicts. */
function cleanRisk(over: Parameters<typeof assessRisk>[0] | undefined = undefined): RouteRisk {
  if (over) return assessRisk(over)
  const checks = {} as Record<CheckId, CheckState>
  for (const id of CHECK_IDS) checks[id] = { status: 'pass' }
  return assessRisk({ ...emptyRiskInput(), checks, history: { kind: 'delivered', days: 1 }, linkCrossChecked: true })
}

/** The verdict a route gets when a hard check could not be made: UNVERIFIED, a warning at the send screen. */

function blockedRisk(): RouteRisk {
  const checks = {} as Record<CheckId, CheckState>
  for (const id of CHECK_IDS) checks[id] = { status: 'pass' }
  checks['path'] = { status: 'fail', reason: 'a packet is stuck in front of this transfer' }
  return assessRisk({ ...emptyRiskInput(), checks, history: { kind: 'delivered', days: 1 }, linkCrossChecked: true })
}

/** What the wallet would be handed. */
type Submitted = { address: Address; functionName: string; value: bigint }

/**
 * A stand-in for wagmi's writer. The cast is on the stub, never on the module: submitV1Send is
 * typed against wagmi's own writer so the three argument tuples are checked against their ABIs.
 */
function fakeWriter(onCall: (a: Submitted) => void = () => {}): V1Writer {
  return {
    writeContractAsync: (async (a: Submitted) => {
      onCall(a)
      return '0xabc'
    }) as unknown as V1Writer['writeContractAsync'],
  }
}

const WALLET = getAddress('0x1111111111111111111111111111111111111111')
const RECIPIENT = WALLET
const STRANGER = getAddress('0x3333333333333333333333333333333333333333')
const OFT = getAddress('0x4444444444444444444444444444444444444444')
const TOKEN = getAddress('0x5555555555555555555555555555555555555555')
const ENDPOINT = getAddress('0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675') // Ethereum's Endpoint V1
const REMOTE = getAddress('0x7777777777777777777777777777777777777777')

const NATIVE_FEE = 10n ** 15n

function route(over: Partial<V1Route> = {}): V1Route {
  return {
    key: 'arbitrum',
    v1ChainId: 110,
    trustedRemote: `0x${REMOTE.slice(2)}${OFT.slice(2)}`,
    remoteAddress: REMOTE,
    minDstGas: 150_000n,
    ...over,
  }
}

function info(over: Partial<OftV1Info> = {}): OftV1Info {
  return {
    vm: 'evm',
    protocol: 'lz-v1',
    standard: { wire: 'bytes32', kind: 'OFT' },
    chain: 'ethereum',
    srcV1ChainId: 101,
    oft: OFT,
    token: OFT,
    symbol: 'TEST',
    name: 'Test',
    decimals: 18,
    sharedDecimals: 6,
    conversionRate: 10n ** 12n,
    endpoint: ENDPOINT,
    owner: STRANGER,
    approvalRequired: false,
    useCustomAdapterParams: undefined,
    adapterParamsRequired: true,
    routes: [route()],
    lockedInAdapter: undefined,
    feeProbed: true,
    ...over,
  }
}

/** Answers only the two view calls buildV1SendPlan makes. */
function stubClient(over: { oftFee?: bigint; nativeFee?: bigint } = {}): ReadClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'quoteOFTFee') return over.oftFee ?? 0n
      if (functionName === 'estimateSendFee') return [over.nativeFee ?? NATIVE_FEE, 0n]
      throw new Error(`unexpected read: ${functionName}`)
    },
  } as unknown as ReadClient
}

const build = (i: OftV1Info, amount: string, over: Partial<Parameters<typeof buildV1SendPlan>[0]> = {}) =>
  buildV1SendPlan({
    info: i,
    dstKey: 'arbitrum',
    amountInput: amount,
    sender: WALLET,
    recipient: evmRecipient(RECIPIENT),
    client: stubClient(),
    ...over,
  })

function guardInput(plan: V1SendPlan, i: OftV1Info, over: Partial<V1GuardInput> = {}): V1GuardInput {
  return {
    walletAddress: WALLET,
    walletChainId: 1,
    srcChainId: 1,
    info: i,
    plan,
    recipientIsCustom: false,
    customRecipientConfirmed: false,
    tokenBalance: 10n ** 24n,
    nativeBalance: 10n ** 18n,
    allowance: 0n,
    gasCostWei: 10n ** 14n,
    simulation: { status: 'ok', gas: 300_000n },
    selfCheck: { ok: true },
    flags: [],
    peerBack: { status: 'ok' },
    storedPayload: { status: 'clear' },
    risk: cleanRisk(),
    ...over,
  }
}

describe('building a v1 plan', () => {
  it('trims dust to the shared-decimal step on the bytes32 standard', async () => {
    // 1.000000000000123456 with sharedDecimals 6 keeps six decimals; the rest is dust.
    const p = await build(info(), '1.000000000000123456')
    expect(p.amounts.amountRaw).toBe(1_000_000_000_000_123_456n)
    expect(p.amounts.delivered).toBe(1_000_000_000_000_000_000n)
    expect(p.amounts.amountLD).toBe(p.amounts.delivered)
    expect(p.amounts.dustTrimmed).toBe(123_456n)
    expect(p.amounts.minAmountLD).toBeUndefined()
  })

  it('leaves the amount alone on the `bytes` standard, which has no shared decimals', async () => {
    const p = await build(info({ standard: { wire: 'bytes', kind: 'OFT' }, sharedDecimals: undefined, conversionRate: 1n }), '1.000000000000123456')
    expect(p.amounts.amountLD).toBe(1_000_000_000_000_123_456n)
    expect(p.amounts.dustTrimmed).toBe(0n)
    expect(p.toWire).toBe(RECIPIENT.toLowerCase())
  })

  it('subtracts the contract fee BEFORE the dust, in the order the contract does', async () => {
    const withFee = info({ standard: { wire: 'bytes32_fee', kind: 'OFT' } })
    const client = stubClient({ oftFee: 10n ** 16n }) // 1% of 1e18
    const p = await buildV1SendPlan({
      info: withFee,
      dstKey: 'arbitrum',
      amountInput: '1',
      sender: WALLET,
      recipient: evmRecipient(RECIPIENT),
      client,
    })
    expect(p.amounts.oftFee).toBe(10n ** 16n)
    // gross goes on the wire; the contract takes its cut from it
    expect(p.amounts.amountLD).toBe(10n ** 18n)
    expect(p.amounts.delivered).toBe(99n * 10n ** 16n)
    expect(p.amounts.minAmountLD).toBe(p.amounts.delivered)
  })

  it('says the fee at its size — a note, never a hold: 1% is a notice, 84% is extreme, both leave canSend alone', async () => {
    const withFee = info({ standard: { wire: 'bytes32_fee', kind: 'OFT' } })
    const mk = (oftFee: bigint) => buildV1SendPlan({ info: withFee, dstKey: 'arbitrum', amountInput: '1', sender: WALLET, recipient: evmRecipient(RECIPIENT), client: stubClient({ oftFee }) })
    const one = v1g9OftFee({ plan: await mk(10n ** 16n) } as unknown as V1GuardInput)
    expect(!one.ok && one.code).toBe('oft_fee_notice')
    const extreme = v1g9OftFee({ plan: await mk(84n * 10n ** 16n) } as unknown as V1GuardInput)
    expect(!extreme.ok && extreme.code).toBe('oft_fee_extreme')
    expect(!extreme.ok && extreme.detail).toMatch(/84%/)
    const tiny = v1g9OftFee({ plan: await mk(10n ** 14n) } as unknown as V1GuardInput) // 0.01%
    expect(tiny.ok).toBe(true)
    for (const c of ['oft_fee_notice', 'oft_fee_high', 'oft_fee_extreme']) expect(isBlockingCode(c), c).toBe(false)
  })

  it('refuses slippage on a standard whose sendFrom has no minimum to enforce it with', async () => {
    await expect(build(info(), '1', { slippageBps: 100 })).rejects.toThrow(V1PlanError)
    await expect(build(info(), '1', { slippageBps: 100 })).rejects.toMatchObject({ code: 'slippage_unsupported' })
  })

  it('refuses a route the contract has no trusted remote for', async () => {
    await expect(build(info({ routes: [] }), '1')).rejects.toMatchObject({ code: 'no_route' })
  })

  it('refuses to build when the contract wants custom params but sets no minimum gas', async () => {
    await expect(build(info({ routes: [route({ minDstGas: 0n })] }), '1')).rejects.toMatchObject({ code: 'no_min_dst_gas' })
  })

  it('sends empty adapter params when the contract forbids them', async () => {
    const p = await build(info({ useCustomAdapterParams: false, adapterParamsRequired: false }), '1')
    expect(p.adapterParams).toBe('0x')
  })

  it('buys at least the contract minimum, and more when a destination estimate says so', async () => {
    const plain = await build(info(), '1')
    expect(plain.adapterParams).toBe(encodeAdapterParamsType1(150_000n))
    // 400000 × 1.3 = 520000, above the 150000 minimum.
    const simulated = await build(info(), '1', { dstGasEstimate: 400_000n })
    expect(simulated.adapterParams).toBe(encodeAdapterParamsType1(520_000n))
  })

  it('quotes with exactly the arguments the send will carry', async () => {
    const seen: unknown[][] = []
    const client = {
      readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        seen.push([functionName, ...args])
        return functionName === 'quoteOFTFee' ? 0n : [NATIVE_FEE, 0n]
      },
    } as unknown as ReadClient
    const p = await build(info(), '1', { client })
    const quoteCall = seen.find((s) => s[0] === 'estimateSendFee')!
    expect(quoteCall[1]).toBe(110) // dst v1 chain id
    expect(quoteCall[2]).toBe(p.toWire)
    expect(quoteCall[3]).toBe(p.amounts.amountLD)
    expect(quoteCall[4]).toBe(false) // _useZro is never true
    expect(quoteCall[5]).toBe(p.adapterParams)
  })

  it('never lets msg.value fall below the quote', async () => {
    const p = await build(info(), '1', { feeBufferBps: 4000 })
    expect(p.value).toBeGreaterThanOrEqual(p.quote.nativeFee)
  })
})

describe('the v1 guards', () => {
  it('passes a clean plan', async () => {
    const i = info()
    const p = await build(i, '1')
    const r = runV1Guards(guardInput(p, i))
    expect(r.results.filter((x) => !x.ok)).toEqual([])
    expect(r.canSend).toBe(true)
  })

  it('blocks a recipient that is not the wallet until it is confirmed by hand', async () => {
    const i = info()
    const p = await buildV1SendPlan({
      info: i,
      dstKey: 'arbitrum',
      amountInput: '1',
      sender: WALLET,
      recipient: evmRecipient(STRANGER),
      client: stubClient(),
    })
    const unconfirmed = runV1Guards(guardInput(p, i))
    expect(unconfirmed.canSend).toBe(false)
    expect(unconfirmed.results.find((x) => x.id === 3)).toMatchObject({ ok: false, code: 'recipient_unconfirmed' })
    const confirmed = runV1Guards(guardInput(p, i, { recipientIsCustom: true, customRecipientConfirmed: true }))
    expect(confirmed.results.find((x) => x.id === 3)).toMatchObject({ ok: true })
  })

  it('blocks sending to any of the contracts in play', async () => {
    const i = info()
    for (const target of [i.oft, i.endpoint, REMOTE]) {
      const p = await buildV1SendPlan({
        info: i,
        dstKey: 'arbitrum',
        amountInput: '1',
        sender: WALLET,
        recipient: evmRecipient(target),
        client: stubClient(),
      })
      const r = runV1Guards(guardInput(p, i, { recipientIsCustom: true, customRecipientConfirmed: true }))
      expect(r.results.find((x) => x.id === 4), target).toMatchObject({ ok: false, code: 'recipient_is_contract' })
    }
  })

  it('blocks a path the destination endpoint is already holding a packet for', async () => {
    const i = info()
    const p = await build(i, '1')
    expect(v1g20StoredPayload(guardInput(p, i, { storedPayload: { status: 'blocked' } }))).toMatchObject({
      ok: false,
      code: 'stored_payload_blocked',
    })
    // A read that could not be made is neither a pass nor a failure: a note for the indicator.
    expect(v1g20StoredPayload(guardInput(p, i, { storedPayload: { status: 'unavailable', reason: 'rpc down' } }))).toMatchObject({
      ok: false,
      code: 'stored_payload_unavailable',
    })
    // Not yet read at all is pending, not passing.
    expect(v1g20StoredPayload(guardInput(p, i, { storedPayload: undefined }))).toMatchObject({ ok: false, code: 'stored_payload_unknown' })
  })

  it('blocks when the destination does not trust us back', async () => {
    const i = info()
    const p = await build(i, '1')
    const r = runV1Guards(guardInput(p, i, { peerBack: { status: 'mismatch', theirRemote: STRANGER } }))
    expect(r.results.find((x) => x.id === 17)).toMatchObject({ ok: false, code: 'trusted_remote_back_mismatch' })
  })

  it('holds adapter params to what the contract demands, in both directions', async () => {
    const wants = info()
    const p = await build(wants, '1')
    expect(v1g15AdapterParams(guardInput(p, wants))).toMatchObject({ ok: true })
    // The contract forbids them, but the plan carries some.
    const forbids = info({ useCustomAdapterParams: false, adapterParamsRequired: false })
    expect(v1g15AdapterParams(guardInput(p, forbids))).toMatchObject({ ok: false, code: 'adapter_params_forbidden' })
    // The contract requires them, but the plan is empty.
    expect(v1g15AdapterParams(guardInput({ ...p, adapterParams: '0x' }, wants))).toMatchObject({ ok: false, code: 'adapter_params_missing' })
    // Below the contract's own minimum: LzApp._checkGasLimit would revert.
    const thin = { ...p, adapterParams: encodeAdapterParamsType1(1_000n) }
    expect(v1g15AdapterParams(guardInput(thin, wants))).toMatchObject({ ok: false, code: 'gas_below_min_dst' })
  })

  it('refuses an approve for a plain OFT and requires an exact one for an adapter', async () => {
    const plain = info()
    const p = await build(plain, '1')
    expect(v1g11NoApprove(guardInput(p, plain, { approveIntent: { token: TOKEN, spender: OFT, amount: 1n } }))).toMatchObject({
      ok: false,
      code: 'approve_forbidden',
    })

    const adapter = info({ standard: { wire: 'bytes32', kind: 'Proxy' }, token: TOKEN, approvalRequired: true })
    const ap = await build(adapter, '1')
    expect(v1g10Allowance(guardInput(ap, adapter, { allowance: 0n }))).toMatchObject({ ok: false, code: 'needs_approve' })
    expect(
      v1g10Allowance(guardInput(ap, adapter, { allowance: 0n, approveIntent: { token: TOKEN, spender: OFT, amount: 1n } })),
    ).toMatchObject({ ok: false, code: 'approve_amount_mismatch' })
    expect(v1g10Allowance(guardInput(ap, adapter, { allowance: ap.amounts.amountLD }))).toMatchObject({ ok: true })
    // Spender and token both have to be the ones the contract itself named.
    expect(v1g12Spender(guardInput(ap, adapter, { approveIntent: { token: TOKEN, spender: STRANGER, amount: 1n } }))).toMatchObject({
      ok: false,
      code: 'approve_wrong_spender',
    })
    expect(v1g12Spender(guardInput(ap, adapter, { approveIntent: { token: STRANGER, spender: OFT, amount: 1n } }))).toMatchObject({
      ok: false,
      code: 'approve_wrong_token',
    })
  })

  it('treats a simulation that could not run as a note, never as a pass', async () => {
    const i = info()
    const p = await build(i, '1')
    // Not run yet: a read in flight, which holds.
    expect(runV1Guards(guardInput(p, i, { simulation: undefined })).canSend).toBe(false)
    // Could not run: said in the indicator, with the reason; the person decides.
    const r = runV1Guards(guardInput(p, i, { simulation: { status: 'unavailable', reason: 'rpc down' } }))
    expect(r.results.find((x) => x.id === 13)).toMatchObject({ ok: false, code: 'simulation_unavailable', detail: 'rpc down' })
    expect(r.notes.some((n) => !n.ok && n.code === 'simulation_unavailable')).toBe(true)
    expect(r.canSend).toBe(true)
  })

  it('rejects a plan whose amounts were tampered with after the quote', async () => {
    const i = info()
    const p = await build(i, '1')
    // A delivered amount that is not a whole number of shared-decimal units.
    const bad = { ...p, amounts: { ...p.amounts, delivered: p.amounts.delivered + 1n } }
    expect(v1g6Amounts(guardInput(bad, i))).toMatchObject({ ok: false, code: 'not_multiple_of_rate' })
  })

  it('notes an extravagant fee for the indicator, and holds nothing', async () => {
    const i = info()
    const huge = await build(i, '1', { client: stubClient({ nativeFee: 10n ** 18n }) })
    // A wallet that can pay it, so guard 8 does not hold for its own reason.
    const r = runV1Guards(guardInput(huge, i, { nativeBalance: 10n * 10n ** 18n }))
    expect(r.results.find((x) => x.id === 21)).toMatchObject({ ok: false, code: 'fee_above_ceiling' })
    expect(r.notes.some((n) => !n.ok && n.code === 'fee_above_ceiling')).toBe(true)
    expect(r.canSend).toBe(true)
  })
})

describe('guard 22: the route verdict is a note, not a cap and not a hold', () => {
  it('a blocked verdict is a note the indicator shows in red; the send is still possible', async () => {
    const i = info()
    const p = await build(i, '1')
    const rep = runV1Guards(guardInput(p, i, { risk: blockedRisk() }))
    expect(rep.results.find((x) => x.id === 22)).toMatchObject({ ok: false, code: 'risk_blocked' })
    // A note, never a block — the owner's decision (CLAUDE.md rule 2).
    expect(rep.blocks.some((b) => !b.ok && b.code === 'risk_blocked')).toBe(false)
    expect(rep.canSend).toBe(true)
  })

  it('a runner that failed is a note too, never a hold', async () => {
    const i = info()
    const p = await build(i, '1')
    const rep = runV1Guards(guardInput(p, i, { risk: undefined, riskError: 'timeout' }))
    expect(rep.results.find((x) => x.id === 22)).toMatchObject({ ok: false, code: 'risk_unavailable', detail: 'timeout' })
    expect(rep.canSend).toBe(true)
    // Without an error it is still a read in flight, which does hold.
    expect(runV1Guards(guardInput(p, i, { risk: undefined })).canSend).toBe(false)
  })
})

describe('the submit boundary', () => {
  it('hands the wallet the plan it verified', async () => {
    const p = await build(info(), '1')
    let seen: Submitted | undefined
    const hash = await submitV1Send(
      fakeWriter((a) => {
        seen = { address: a.address, functionName: a.functionName, value: a.value }
      }),
      p,
      1,
    )
    expect(hash).toBe('0xabc')
    expect(seen).toEqual({ functionName: 'sendFrom', value: p.value, address: p.oft })
  })

  it('refuses without asking the wallet when the self-check fails', async () => {
    const p = await build(info(), '1')
    // The wire recipient is swapped for a stranger while the plan still shows the wallet: the two
    // views of the same transfer now disagree, which is exactly what the self-check exists to see.
    const tampered: V1SendPlan = { ...p, toWire: toWireRecipient(STRANGER, 'bytes32') }
    expect(v1SelfCheck(p, encodeV1SendCalldata(tampered)).ok).toBe(false)
    let asked = false
    await expect(
      submitV1Send(
        fakeWriter(() => {
          asked = true
        }),
        tampered,
        1,
      ),
    ).rejects.toThrow(V1SendRefused)
    expect(asked).toBe(false)
  })

  it('refuses when msg.value would not cover the quote', async () => {
    const p = await build(info(), '1')
    await expect(submitV1Send(fakeWriter(), { ...p, value: p.quote.nativeFee - 1n }, 1)).rejects.toMatchObject({
      code: 'value_mismatch',
    })
  })
})
