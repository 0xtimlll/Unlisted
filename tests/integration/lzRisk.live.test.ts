/**
 * §4 against mainnet: the route risk indicator.
 *
 * What is asserted here is the *rule*, on real routes: that the invariants hold whatever the chains
 * happen to say today. A test that demanded a particular colour from a particular contract would
 * fail the week that contract's operator changed something, and would be testing LayerZero rather
 * than this app.
 *
 * The two states that are not asserted here, and why:
 *
 *   BLOCKED is transient. It was produced on a real route during development — JOE from Avalanche to
 *   Arbitrum, one message in flight for four hours without arriving — and cleared by itself when the
 *   message landed. The mechanism is covered by unit tests instead (tests/core/lzRisk.test.ts).
 *
 *   The all-grey case, likewise: `tests/core/lzRiskChecks.test.ts` runs every check against clients
 *   that reject everything, which is a stronger test than an unreachable public RPC would be.
 *
 * Read-only. Public RPCs are flaky, so this project is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { byKey, evmByKey, isEvm } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { buildSendPlan } from '@/core/plan'
import { probeOft } from '@/core/probe'
import { evmRecipient } from '@/core/recipient'
import { probeOftV1 } from '@/protocols/lz-v1/detect'
import { buildV1SendPlan } from '@/protocols/lz-v1/plan'
import { assessRoute, CHECK_IDS, dvnInfo, HARD_CHECKS, sendAllowed, OVERRIDE_WORD, dstOftOf, type RouteRisk } from '@/protocols/lz-risk'

const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')
const JOE = getAddress('0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07')
const MIM_ARB = getAddress('0x957A8Af7894E76e16DB17c2A913496a4E60B7090')
const DEGEN_ROBINHOOD = getAddress('0x0830a9dd26a04e959657ab6788d45f5725590c32')

/** Every invariant §4 states, checked on whatever verdict a real route produced. */
function assertInvariants(risk: RouteRisk) {
  // No colour without reasons, and OK with none.
  if (risk.tier === 'OK') expect(risk.reasons).toEqual([])
  else expect(risk.reasons.length).toBeGreaterThan(0)

  // OK is impossible while a hard check has not run.
  const hardUnchecked = HARD_CHECKS.filter((id) => risk.checks[id].status === 'unchecked')
  expect(risk.hardUnchecked.sort()).toEqual(hardUnchecked.sort())
  if (hardUnchecked.length > 0) {
    expect(risk.tier).not.toBe('OK')
    expect(['UNVERIFIED', 'BLOCKED']).toContain(risk.tier)
  }

  // A failed hard check blocks; a blocked route takes nothing.
  const hardFailed = HARD_CHECKS.filter((id) => risk.checks[id].status === 'fail')
  if (hardFailed.length > 0) expect(risk.tier).toBe('BLOCKED')
  if (risk.tier === 'BLOCKED') {
    expect(sendAllowed(risk, 1n, 10n ** 30n, OVERRIDE_WORD)).toEqual({ allowed: false, why: 'blocked' })
  }

  // Every state carries text a person can read; nothing is a bare status.
  for (const id of CHECK_IDS) {
    const s = risk.checks[id]
    if (s.status !== 'pass') expect(s.reason.length, id).toBeGreaterThan(0)
  }
}

async function v1Risk(srcKey: Parameters<typeof evmByKey>[0], oft: string, dstKey: Parameters<typeof evmByKey>[0]) {
  const srcClient = makeReadClient(evmByKey(srcKey))
  const dstClient = makeReadClient(evmByKey(dstKey))
  const { info } = await probeOftV1(srcClient, srcKey, oft)
  const plan = await buildV1SendPlan({
    info,
    dstKey,
    amountInput: '1',
    sender: SOMEONE,
    recipient: evmRecipient(SOMEONE),
    client: srcClient,
  })
  return assessRoute({ protocol: 'lz-v1', info, plan, srcClient, dstClient })
}

describe('a real v1 route', () => {
  it('produces a verdict that satisfies every §4 invariant', async () => {
    const { risk } = await v1Risk('arbitrum', JOE, 'avalanche')
    assertInvariants(risk)
    // Both sides of a live route name each other, and the destination would credit the transfer —
    // whatever the overall verdict, those two facts should be readable.
    expect(risk.checks.peers.status).toBe('pass')
    expect(risk.checks.delivery_sim.status).toBe('pass')
  }, 40_000)

  it('says nothing about JOE running its own oracle, because LayerZero publishes it', () => {
    // JOE's UltraLightNode app config names Chainlink as its oracle rather than the default. That is
    // a listed, undeprecated party (id `ccip`, version 1 in the committed table), so it is not a
    // finding at all — an earlier version of this check called it non-standard and capped the route.
    // Asserted against the committed table rather than the network: the table is what decides.
    expect(dvnInfo('arbitrum', '0x150A58e9E6BF69ccEb1DBA5ae97C166DC8792539')).toMatchObject({ id: 'ccip', deprecated: false })
  })

  it('reads the route’s verifiers and treats both of LayerZero’s own sources as published', async () => {
    const { risk } = await v1Risk('arbitrum', JOE, 'avalanche')
    assertInvariants(risk)
    const config = risk.checks.config
    expect(config.status).toBe('pass')
    // Every live relayer seen is the UltraLightNode's own default, and the DVN feed does not list
    // relayers at all — so the on-chain default has to count as published, or this reports
    // LayerZero's own relayer as unknown on every route.
    if (config.status === 'pass' && config.note) {
      expect(config.note).toMatch(/verified by /)
      expect(config.note).not.toMatch(/not published/)
    }
    expect(risk.reasons.some((r) => /not in LayerZero|not published/.test(r.text))).toBe(false)
  }, 40_000)

  it('treats undelivered packets ahead of ours as a delay, not a blocked path', async () => {
    // Whether a queue exists today is not this test's business; that it is never a BLOCKED is.
    for (const [src, dst] of [
      ['arbitrum', 'avalanche'],
      ['avalanche', 'arbitrum'],
    ] as const) {
      const { risk } = await v1Risk(src, JOE, dst)
      const path = risk.checks.path
      if (path.status === 'pass' && path.note && /undelivered/.test(path.note)) {
        expect(risk.tier).toBe('UNVERIFIED')
        expect(risk.reasons.some((r) => /queues behind them/.test(r.text))).toBe(true)
        // A queue still allows a test amount; only a stored payload refuses everything.
        expect(sendAllowed(risk, 1n, 10n ** 18n)).toEqual({ allowed: true })
      }
      // A stored payload is the only thing that makes this check fail outright.
      if (path.status === 'fail') expect(path.reason).toMatch(/stuck packet|no path/)
    }
  }, 60_000)

  it('measures the destination credit, which is what §3 buys adapter gas with', async () => {
    const { risk, dstGasEstimate } = await v1Risk('arbitrum', MIM_ARB, 'ethereum')
    assertInvariants(risk)
    expect(risk.checks.delivery_sim.status).toBe('pass')
    expect(dstGasEstimate).toBeDefined()
    expect(dstGasEstimate!).toBeGreaterThan(20_000n)
  }, 40_000)

  it('reads an adapter’s reserve on the destination and skips it where there is none', async () => {
    // MIM's Ethereum side is an adapter: it holds a reserve, and that reserve is the check.
    const toEth = await v1Risk('arbitrum', MIM_ARB, 'ethereum')
    expect(['pass', 'unchecked']).toContain(toEth.risk.checks.adapter_liquidity.status)
    // JOE on Arbitrum mints its own token, so on the way there the check does not apply.
    const toArb = await v1Risk('avalanche', JOE, 'arbitrum')
    expect(['skipped', 'unchecked']).toContain(toArb.risk.checks.adapter_liquidity.status)
  }, 60_000)
})

describe('a real V2 route', () => {
  async function v2Risk(srcKey: Parameters<typeof evmByKey>[0], oft: string, dstKey: Parameters<typeof evmByKey>[0]) {
    const src = evmByKey(srcKey)
    const dstDef = byKey(dstKey)
    if (!isEvm(dstDef)) throw new Error('EVM destinations only here')
    const srcClient = makeReadClient(src)
    const dstClient = makeReadClient(dstDef)
    const { info } = await probeOft(srcClient, oft)
    const plan = await buildSendPlan(srcClient, {
      info,
      src,
      dstEid: dstDef.eid,
      amountInput: '1',
      sender: SOMEONE,
      recipient: evmRecipient(SOMEONE),
    })
    const dstOft = dstOftOf(info, dstDef.eid)
    expect(dstOft, 'the destination peer should be an EVM address').toBeDefined()
    return assessRoute({ protocol: 'lz-oft', info, plan, srcChain: srcKey, dstChain: dstKey, srcClient, dstClient, dstOft: dstOft! })
  }

  it('produces a verdict that satisfies every §4 invariant', async () => {
    const { risk } = await v2Risk('robinhood', DEGEN_ROBINHOOD, 'arbitrum')
    assertInvariants(risk)
    expect(risk.checks.peers.status).toBe('pass')
    expect(risk.checks.delivery_sim.status).toBe('pass')
  }, 40_000)

  it('does not call a healthy route’s DVN config a mismatch', async () => {
    // The regression this guards: the send side's DVNs and the receive side's are different
    // addresses for the same operators, and comparing them by address reported every working V2
    // route as broken. The comparison is by operator, so a live route passes.
    const { risk } = await v2Risk('robinhood', DEGEN_ROBINHOOD, 'ethereum')
    expect(risk.checks.config.status).toBe('pass')
    const config = risk.checks.config
    if (config.status === 'pass' && config.note) expect(config.note).toMatch(/verified by /)
    expect(risk.reasons.some((r) => /does not match/.test(r.text))).toBe(false)
  }, 40_000)

  it('names the DVNs from LayerZero’s own published list', async () => {
    const { risk } = await v2Risk('robinhood', DEGEN_ROBINHOOD, 'arbitrum')
    const config = risk.checks.config
    // Names, not addresses: the committed table is what turns one into the other.
    if (config.status === 'pass' && config.note) expect(config.note).not.toMatch(/0x[0-9a-fA-F]{40}/)
  }, 40_000)
})

describe('the whole panel is fast enough to be worth showing', () => {
  it('answers within a few seconds', async () => {
    const t = Date.now()
    await v1Risk('arbitrum', MIM_ARB, 'ethereum')
    const elapsed = Date.now() - t
    // §4 asks for 1-3 seconds for the checks. The probe and the plan are not counted here, and the
    // ceiling is generous because a public RPC is a public RPC.
    expect(elapsed).toBeLessThan(15_000)
  }, 40_000)
})
