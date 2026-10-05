/**
 * The route indicator: one colour, the worst reason wins, and it holds nothing.
 *
 * One case per condition the owner named: grey before a destination, green for a plain OFT / a
 * proven adapter / an anchored NTT / a CCIP pool with a passing simulation, yellow for the
 * nuances, red for the losses. And the two things that must never change the colour: a proxy,
 * and the send button.
 */
import { describe, expect, it } from 'vitest'
import { assessIndicator, flagLevel, noteLevel, type IndicatorInput } from '@/core/indicator'
import { runGuards } from '@/core/guards'
import { isBlockingCode } from '@/core/severity'
import { assessRisk, CHECK_IDS, emptyRiskInput, type CheckId, type CheckState, type RouteRisk } from '@/protocols/lz-risk/risk'
import { ADAPTER_MIN_LOCKED_BPS, ADAPTER_MIN_OUTBOUND_NONCE } from '@/protocols/lz-risk/adapters'
import { goodInput, treadOftInfo } from './fixtures'

const label = (c: string) => `L:${c}`
const flagLabel = (f: string) => `F:${f}`

function riskOf(over: Partial<Parameters<typeof assessRisk>[0]> = {}, failing?: { id: CheckId; state: CheckState }): RouteRisk {
  const checks = {} as Record<CheckId, CheckState>
  for (const id of CHECK_IDS) checks[id] = { status: 'pass' }
  if (failing) checks[failing.id] = failing.state
  return assessRisk({ ...emptyRiskInput(), checks, history: { kind: 'delivered', days: 1 }, linkCrossChecked: true, ...over })
}

/** A LayerZero V2 route with every guard passing and a clean verdict. */
function base(over: Partial<IndicatorInput> = {}): IndicatorInput {
  return {
    hasDestination: true,
    hasPlan: true,
    results: runGuards(goodInput()).results,
    label,
    flags: [],
    flagLabel,
    risk: riskOf(),
    riskCovered: true,
    riskPending: false,
    ...over,
  }
}

const failed = (code: string, detail?: string) => ({ ok: false as const, code, ...(detail ? { detail } : {}) })

describe('grey', () => {
  it('no destination → none, whatever else is known', () => {
    expect(assessIndicator(base({ hasDestination: false, results: [failed('recipient_zero')] })).level).toBe('none')
  })
  it('no plan yet → none', () => {
    expect(assessIndicator(base({ hasPlan: false })).level).toBe('none')
    const failed = assessIndicator(base({ hasPlan: false, planError: 'The contract refused to quote this transfer. (SlippageExceeded)' }))
    expect(failed.level).toBe('red')
    expect(failed.headline?.code).toBe('quote_failed')
  })
  it('a read in flight and nothing red known → pending', () => {
    expect(assessIndicator(base({ results: [failed('simulation_missing')] })).level).toBe('pending')
    expect(assessIndicator(base({ risk: undefined, riskPending: true })).level).toBe('pending')
  })
  it('behind a hold the reads never run, so it is "not assessed" rather than "checking" — red is still said', () => {
    expect(assessIndicator(base({ results: [failed('simulation_missing'), failed('insufficient_balance')], held: true })).level).toBe('none')
    expect(assessIndicator(base({ results: [failed('simulation_missing'), failed('insufficient_balance'), failed('recipient_zero')], held: true })).level).toBe('red')
  })
  it('red is red even while something is still loading', () => {
    expect(assessIndicator(base({ results: [failed('simulation_missing'), failed('recipient_zero')] })).level).toBe('red')
  })
})

describe('green', () => {
  it('a plain OFT: peer back, simulation passed, nothing to say', () => {
    const i = assessIndicator(base())
    expect(i.level).toBe('green')
    expect(i.reasons).toEqual([])
    expect(i.headline).toBeUndefined()
  })
  it('an adapter that locks ≥ 0.1% of supply and has ≥ 20 sends — read from the real token and endpoint', () => {
    const risk = riskOf({ adapter: { lockedBps: ADAPTER_MIN_LOCKED_BPS, outboundNonce: ADAPTER_MIN_OUTBOUND_NONCE } })
    expect(risk.tier).toBe('OK')
    expect(assessIndicator(base({ risk })).level).toBe('green')
  })
  it('a route the eight checks do not cover (NTT, CCIP, Solana) is green on its own guards alone', () => {
    expect(assessIndicator(base({ risk: undefined, riskCovered: false })).level).toBe('green')
  })
})

describe('yellow', () => {
  it('a fresh adapter: too little locked, or too little history, or a read that failed', () => {
    for (const adapter of [
      { lockedBps: ADAPTER_MIN_LOCKED_BPS - 1, outboundNonce: ADAPTER_MIN_OUTBOUND_NONCE },
      { lockedBps: ADAPTER_MIN_LOCKED_BPS, outboundNonce: ADAPTER_MIN_OUTBOUND_NONCE - 1n },
      { lockedBps: undefined, outboundNonce: ADAPTER_MIN_OUTBOUND_NONCE },
    ]) {
      const i = assessIndicator(base({ risk: riskOf({ adapter }) }))
      expect(i.level, JSON.stringify(adapter, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe('yellow')
      expect(i.reasons.some((r) => /fresh adapter/.test(r.text))).toBe(true)
    }
  })
  it('no second RPC operator confirmed the contract', () => {
    const i = assessIndicator(base({ risk: riskOf({ linkCrossChecked: false }) }))
    expect(i.level).toBe('yellow')
    expect(assessIndicator(base({ flags: ['not_cross_checked'] })).level).toBe('yellow')
  })
  it('the simulation reverted, or could not be run', () => {
    const i = assessIndicator(base({ results: [failed('simulation_failed', 'Error("no")')] }))
    expect(i.level).toBe('yellow')
    expect(i.reasons[0]).toMatchObject({ code: 'simulation_failed', detail: 'Error("no")' })
    expect(assessIndicator(base({ results: [failed('simulation_unavailable')] })).level).toBe('yellow')
  })
  it('a weak DVN set', () => {
    expect(assessIndicator(base({ dvnWeak: true, dvnWeakText: 'one DVN' })).level).toBe('yellow')
  })
  it('the route checks could not be run at all', () => {
    expect(assessIndicator(base({ risk: undefined, riskError: 'timeout' })).level).toBe('yellow')
    expect(assessIndicator(base({ results: [failed('risk_unavailable')], risk: undefined, riskError: 'timeout' })).level).toBe('yellow')
  })
  it('UNVERIFIED and CAUTION verdicts, with their reasons', () => {
    const unverified = riskOf({}, { id: 'adapter_liquidity', state: { status: 'unchecked', reason: 'rpc down' } })
    expect(unverified.tier).toBe('UNVERIFIED')
    expect(assessIndicator(base({ risk: unverified })).level).toBe('yellow')
    const caution = riskOf({ recentChange: true })
    expect(caution.tier).toBe('CAUTION')
    const i = assessIndicator(base({ risk: caution }))
    expect(i.level).toBe('yellow')
    expect(i.reasons.some((r) => /7 days/.test(r.text))).toBe(true)
  })
  it('the fee above the chain ceiling, no executor gas, an unreachable back-check', () => {
    for (const code of ['fee_above_ceiling', 'no_executor_gas', 'peer_back_unavailable', 'trusted_remote_back_unavailable', 'stored_payload_unavailable']) {
      expect(noteLevel(code), code).toBe('yellow')
      expect(assessIndicator(base({ results: [failed(code)] })).level, code).toBe('yellow')
    }
  })
})

describe('red', () => {
  it.each([
    'recipient_zero',
    'recipient_is_contract',
    'recipient_lookalike',
    'recipient_token_account',
    'peer_back_mismatch',
    'trusted_remote_back_mismatch',
    'ntt_anchor_missing',
  ])('%s — with the one line said without a hover', (code) => {
    expect(noteLevel(code)).toBe('red')
    const i = assessIndicator(base({ results: [failed(code)] }))
    expect(i.level).toBe('red')
    expect(i.headline).toMatchObject({ code, text: `L:${code}` })
  })
  it('a route LayerZero has blocked: a dead DVN, a config mismatch, a hard check that failed', () => {
    for (const risk of [
      riskOf({ deprecatedVerifier: true }),
      riskOf({ configMismatch: true }),
      riskOf({}, { id: 'peers', state: { status: 'fail', reason: 'the destination names someone else' } }),
    ]) {
      expect(risk.tier).toBe('BLOCKED')
      const i = assessIndicator(base({ risk }))
      expect(i.level).toBe('red')
      expect(i.headline?.text).toBe(risk.reasons[0]!.text)
    }
  })
  it('the colour is the worst reason, and the tooltip carries all of them', () => {
    const i = assessIndicator(base({ results: [failed('fee_above_ceiling'), failed('recipient_lookalike')], flags: ['not_cross_checked'] }))
    expect(i.level).toBe('red')
    expect(i.reasons.map((r) => r.level)).toEqual(['red', 'yellow', 'yellow'])
    expect(i.headline?.code).toBe('recipient_lookalike')
  })
})

describe('what does not change the colour', () => {
  it('a proxy, an EOA owner, unverified source, a look-alike name: details only', () => {
    for (const f of ['behind_proxy', 'owner_is_eoa', 'not_verified', 'label_lookalike', 'svm_fee']) {
      expect(flagLevel(f), f).toBe('info')
      const i = assessIndicator(base({ flags: [f] }))
      expect(i.level, f).toBe('green')
      expect(i.reasons).toEqual([{ level: 'info', code: `flag_${f}`, text: `F:${f}` }])
    }
  })
  it('a block is said under the button, never in the indicator', () => {
    for (const code of ['insufficient_balance', 'chain_mismatch', 'peer_missing', 'amount_zero', 'recipient_vm_mismatch']) {
      expect(isBlockingCode(code), code).toBe(true)
      const i = assessIndicator(base({ results: [failed(code)] }))
      expect(i.reasons, code).toEqual([])
    }
  })
  it('the indicator never enters the guards: a red route still sends', () => {
    const rep = runGuards(goodInput({ info: treadOftInfo({ routes: goodInput().info!.routes }), peerBack: { status: 'mismatch', theirPeer: `0x${'0'.repeat(64)}` } }))
    expect(rep.canSend).toBe(true)
    expect(assessIndicator(base({ results: rep.results })).level).toBe('red')
  })
})

describe('the issuer fee colours the indicator at its size, and holds nothing', () => {
  it('a notice is yellow, high and extreme are red with the headline, unknown is yellow', () => {
    expect(assessIndicator(base({ results: [failed('oft_fee_notice')] })).level).toBe('yellow')
    const high = assessIndicator(base({ results: [failed('oft_fee_high')] }))
    expect(high.level).toBe('red')
    expect(high.headline?.code).toBe('oft_fee_high')
    expect(assessIndicator(base({ results: [failed('oft_fee_extreme')] })).headline?.code).toBe('oft_fee_extreme')
    expect(assessIndicator(base({ results: [failed('oft_fee_unknown')] })).level).toBe('yellow')
    for (const c of ['oft_fee_notice', 'oft_fee_high', 'oft_fee_extreme', 'oft_fee_unknown']) expect(isBlockingCode(c), c).toBe(false)
  })
})

describe('a preview judges the route without the funds, and never calls it green', () => {
  it('ignores the hold and the reads that wait for funds, says so in yellow', () => {
    const r = assessIndicator(base({ held: true, preview: 'Preview for 1 TEST', results: [failed('simulation_missing'), failed('balance_unknown')] }))
    expect(r.level).toBe('yellow')
    expect(r.preview).toBe(true)
    expect(r.reasons.map((x) => x.code)).toContain('preview_unsimulated')
  })
  it('red stays red, with the headline, in a preview', () => {
    const r = assessIndicator(base({ held: true, preview: 'Preview for 1 TEST', results: [failed('peer_back_mismatch')] }))
    expect(r.level).toBe('red')
    expect(r.headline?.code).toBe('peer_back_mismatch')
  })
  it('a provider still reading is still pending, even in a preview', () => {
    expect(assessIndicator(base({ preview: 'Preview', results: [failed('peer_back_unknown')] })).level).toBe('pending')
  })
  it('without a preview a hold still means "not assessed" (the old rule)', () => {
    expect(assessIndicator(base({ held: true, results: [failed('simulation_missing')] })).level).toBe('none')
  })
})
