/**
 * §4: the risk verdict.
 *
 * This is the file that decides whether a colour on screen means anything, so it is written as a
 * set of claims about the rule rather than a walk through the code: a check that did not run never
 * counts as passed, a hard check that did not run caps the amount and no typed word lifts that, and
 * a verdict never appears without the reasons behind it.
 */
import { describe, expect, it } from 'vitest'
import {
  assessRisk,
  CHECK_IDS,
  emptyRiskInput,
  FRESH_DELIVERY_DAYS,
  HARD_CHECKS,
  isHard,
  OVERRIDE_WORD,
  overrideAccepted,
  sendAllowed,
  STALE_DELIVERY_DAYS,
  STOPPED_VERIFICATION_MINUTES,
  INFLIGHT_GRACE_MINUTES,
  type CheckId,
  type CheckState,
  type RiskInput,
} from '@/protocols/lz-risk/risk'
import {
  ADAPTER_MIN_LOCKED_BPS,
  ADAPTER_MIN_OUTBOUND_NONCE,
  lockedBps,
  REVIEWED_ADAPTERS,
  reviewedAdapter,
  type AdapterStanding,
} from '@/protocols/lz-risk/adapters'
import { DEAD_DVN_ID, dvnInfo, hasDvnList, judgeDvns } from '@/protocols/lz-risk/dvns'
import dvnTable from '@/protocols/lz-risk/dvns.json'

/** The committed table, for picking a real address to feed the public lookups. */
const listOf = (chain: string): [string, { id: string; deprecated: boolean }][] =>
  Object.entries((dvnTable.chains as Record<string, { dvns: Record<string, { id: string; deprecated: boolean }> }>)[chain]?.dvns ?? {})

const pass: CheckState = { status: 'pass' }

/** Everything ran and everything was fine, with a delivery yesterday. */
function clean(over: Partial<RiskInput> = {}): RiskInput {
  const checks = {} as Record<CheckId, CheckState>
  for (const id of CHECK_IDS) checks[id] = pass
  // A clean route is also a corroborated one; the uncorroborated case has its own tests below.
  return { ...emptyRiskInput(), checks, history: { kind: 'delivered', days: 1 }, linkCrossChecked: true, ...over }
}

const withCheck = (base: RiskInput, id: CheckId, state: CheckState): RiskInput => ({
  ...base,
  checks: { ...base.checks, [id]: state },
})

const AMOUNT = 1_000_000n
const TEST_LIMIT = 1_000n

describe('the shape of the rule', () => {
  it('keeps the two in-flight thresholds in order and in risk.ts', () => {
    expect(INFLIGHT_GRACE_MINUTES).toBe(30)
    expect(STOPPED_VERIFICATION_MINUTES).toBe(60)
    expect(STOPPED_VERIFICATION_MINUTES).toBeGreaterThan(INFLIGHT_GRACE_MINUTES)
  })

  it('names five hard checks and eight in total', () => {
    expect(CHECK_IDS.length).toBe(8)
    expect([...HARD_CHECKS].sort()).toEqual(['adapter_liquidity', 'delivery_sim', 'limits', 'path', 'peers'])
    expect(isHard('history')).toBe(false)
    expect(isHard('recent_changes')).toBe(false)
    expect(isHard('config')).toBe(false)
  })

  it('starts from nothing known, which is not the same as nothing wrong', () => {
    // Nothing known includes "nobody corroborated the contract", which blocks outright.
    const r = assessRisk(emptyRiskInput('not run yet'))
    expect(r.tier).toBe('BLOCKED')
    expect(r.overridable).toBe(false)
    // With the link corroborated, the five unrun hard checks are what is left, and they cap.
    const corroborated = assessRisk({ ...emptyRiskInput('not run yet'), linkCrossChecked: true })
    expect(corroborated.tier).toBe('UNVERIFIED')
    expect(corroborated.hardUnchecked.length).toBe(HARD_CHECKS.length)
    expect(corroborated.overridable).toBe(false)
  })

  it('an uncorroborated contract is BLOCKED, not merely capped', () => {
    // Everything passed — but only one operator ever answered, so "everything" is one story.
    const r = assessRisk(clean({ linkCrossChecked: false }))
    expect(r.tier).toBe('BLOCKED')
    expect(r.overridable).toBe(false)
    // Not a cap: §4 gives a blocked route no allowance at all, test amount included.
    expect(r.testLimitOnly).toBe(false)
    expect(r.reasons.some((x) => /independent RPC operator/.test(x.text))).toBe(true)
    // The same route with a second operator behind it is the OK it looked like.
    expect(assessRisk(clean()).tier).toBe('OK')
  })

  it('no word and no past test transfer lifts an uncorroborated contract', () => {
    for (const over of [{ testVerified: true }, { testVerified: true, delayed: undefined }]) {
      const r = assessRisk(clean({ linkCrossChecked: false, ...over }))
      expect(r.tier).toBe('BLOCKED')
      expect(r.overridable).toBe(false)
    }
  })

  it('never returns a verdict without reasons, or OK with them', () => {
    // Every single-flag variation, asserted against the two invariants at once.
    const variants: RiskInput[] = [
      clean(),
      clean({ unverifiedStandard: true }),
      clean({ unknownInfra: true }),
      clean({ unknownInfra: true, history: { kind: 'never' } }),
      clean({ deprecatedVerifier: true }),
      clean({ delayed: { packets: 2, oldestMinutes: 45 } }),
      clean({ delayed: { packets: 2, oldestMinutes: 90 } }),
      clean({ configMismatch: true }),
      clean({ unknownDvnSet: true }),
      clean({ recentChange: true }),
      clean({ thinGas: true }),
      clean({ nearLimit: true }),
      clean({ history: { kind: 'never' } }),
      clean({ history: { kind: 'unknown', reason: 'window too short' } }),
      clean({ history: { kind: 'delivered', days: 40 } }),
      clean({ history: { kind: 'delivered', days: 10 } }),
      ...HARD_CHECKS.map((id) => withCheck(clean(), id, { status: 'unchecked', reason: 'rpc down' })),
      ...HARD_CHECKS.map((id) => withCheck(clean(), id, { status: 'fail', reason: 'bad' })),
      ...CHECK_IDS.map((id) => withCheck(clean(), id, { status: 'skipped', reason: 'n/a' })),
    ]
    for (const v of variants) {
      const r = assessRisk(v)
      if (r.tier === 'OK') expect(r.reasons).toEqual([])
      else expect(r.reasons.length, JSON.stringify(r.tier)).toBeGreaterThan(0)
    }
  })
})

describe('OK is only for a route where everything ran and passed', () => {
  it('gives OK for a clean route', () => {
    const r = assessRisk(clean())
    expect(r.tier).toBe('OK')
    expect(r.reasons).toEqual([])
    expect(r.testLimitOnly).toBe(false)
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT)).toEqual({ allowed: true })
  })

  it('a check that does not apply does not stand in the way of OK', () => {
    // No adapter on the destination, no pause on the contract: nothing is missing.
    let i = withCheck(clean(), 'adapter_liquidity', { status: 'skipped', reason: 'the destination is not an adapter' })
    i = withCheck(i, 'limits', { status: 'skipped', reason: 'the contract has no pause or rate limit' })
    expect(assessRisk(i).tier).toBe('OK')
  })

  it('a pass with a note is still a pass', () => {
    const i = withCheck(clean(), 'path', { status: 'pass', note: '2 messages in flight' })
    expect(assessRisk(i).tier).toBe('OK')
  })

  it.each(HARD_CHECKS)('cannot be OK when the hard check %s did not run', (id) => {
    const r = assessRisk(withCheck(clean(), id, { status: 'unchecked', reason: 'timeout' }))
    expect(r.tier).not.toBe('OK')
    expect(r.hardUnchecked).toContain(id)
  })
})

describe('BLOCKED is facts only, and takes nothing at all', () => {
  it.each(HARD_CHECKS)('a failed hard check (%s) blocks', (id) => {
    const r = assessRisk(withCheck(clean(), id, { status: 'fail', reason: 'the peer does not point back' }))
    expect(r.tier).toBe('BLOCKED')
    expect(r.reasons.some((x) => x.check === id)).toBe(true)
    expect(r.overridable).toBe(false)
    // Not even a test amount.
    expect(sendAllowed(r, TEST_LIMIT, TEST_LIMIT)).toEqual({ allowed: false, why: 'blocked' })
    expect(sendAllowed(r, 1n, TEST_LIMIT, OVERRIDE_WORD)).toEqual({ allowed: false, why: 'blocked' })
  })

  it('a deprecated verifier blocks, whether it is a DVN or a v1 oracle', () => {
    const r = assessRisk(clean({ deprecatedVerifier: true }))
    expect(r.tier).toBe('BLOCKED')
    expect(r.reasons[0]!.text).toMatch(/deprecated/)
  })

  it('a send/receive config mismatch blocks', () => {
    expect(assessRisk(clean({ configMismatch: true })).tier).toBe('BLOCKED')
  })

  it('a delivered test does not unblock a blocked route', () => {
    const r = assessRisk(clean({ deprecatedVerifier: true, testVerified: true }))
    expect(r.tier).toBe('BLOCKED')
  })

  it('a soft check failing is a warning, not a block', () => {
    const r = assessRisk(withCheck(clean(), 'history', { status: 'fail', reason: 'no deliveries found' }))
    expect(r.tier).toBe('CAUTION')
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT)).toEqual({ allowed: true })
  })
})

describe('UNVERIFIED caps the amount, and what may lift the cap', () => {
  it.each(HARD_CHECKS)('a hard check that could not run (%s) caps the amount and no word lifts it', (id) => {
    const r = assessRisk(withCheck(clean(), id, { status: 'unchecked', reason: 'destination RPC did not answer' }))
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.testLimitOnly).toBe(true)
    expect(r.overridable).toBe(false)
    // The reason is shown, with why it could not be checked.
    expect(r.reasons.some((x) => x.check === id && /not checked: destination RPC did not answer/.test(x.text))).toBe(true)
    // Below the limit: fine. Above it: refused, and the confirmation word changes nothing.
    expect(sendAllowed(r, TEST_LIMIT, TEST_LIMIT)).toEqual({ allowed: true })
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT)).toEqual({ allowed: false, why: 'over_test_limit', limit: TEST_LIMIT })
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT, OVERRIDE_WORD)).toEqual({ allowed: false, why: 'over_test_limit', limit: TEST_LIMIT })
  })

  it('an unverified standard caps the amount, whatever else passed', () => {
    const r = assessRisk(clean({ unverifiedStandard: true }))
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.overridable).toBe(false)
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT, OVERRIDE_WORD)).toMatchObject({ allowed: false })
    expect(r.reasons.some((x) => /never been verified against a live deployment/.test(x.text))).toBe(true)
  })

  it('an unpublished verifier is a warning where deliveries have gone through it', () => {
    // The route's own history answers for the infrastructure: something that has actually arrived
    // through that oracle is better evidence than a name in a list would have been.
    const r = assessRisk(clean({ unknownInfra: true, history: { kind: 'delivered', days: 1 } }))
    expect(r.tier).toBe('CAUTION')
    expect(r.testLimitOnly).toBe(false)
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT)).toEqual({ allowed: true })
    expect(r.reasons.some((x) => /deliveries have gone through it/.test(x.text))).toBe(true)
  })

  it('an unpublished verifier caps the amount only when nothing has arrived in a window we searched', () => {
    for (const history of [{ kind: 'never' } as const, { kind: 'none_in_window', days: 12 } as const]) {
      const r = assessRisk(clean({ unknownInfra: true, history }))
      expect(r.tier, JSON.stringify(history)).toBe('UNVERIFIED')
      expect(r.overridable).toBe(true)
      expect(sendAllowed(r, AMOUNT, TEST_LIMIT)).toMatchObject({ allowed: false })
      expect(sendAllowed(r, AMOUNT, TEST_LIMIT, OVERRIDE_WORD)).toEqual({ allowed: true })
      expect(sendAllowed(r, AMOUNT, TEST_LIMIT, 'yes please')).toMatchObject({ allowed: false })
    }
  })

  it('an unpublished verifier does not cap when the history window could not be searched', () => {
    // §4's first rule: a window we could not search is not evidence that nothing arrived, so it
    // cannot be half of a two-condition cap.
    const r = assessRisk(clean({ unknownInfra: true, history: { kind: 'unknown', reason: 'provider refused the range' } }))
    expect(r.tier).toBe('CAUTION')
    expect(r.testLimitOnly).toBe(false)
  })

  it('a verifier LayerZero publishes and has not deprecated is not mentioned at all', () => {
    const r = assessRisk(clean({ unknownInfra: false, deprecatedVerifier: false }))
    expect(r.tier).toBe('OK')
    expect(r.reasons).toEqual([])
  })

  it('a queue younger than an hour caps the amount, and the word lifts it', () => {
    const r = assessRisk(clean({ delayed: { packets: 3, oldestMinutes: STOPPED_VERIFICATION_MINUTES - 1 } }))
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.testLimitOnly).toBe(true)
    expect(r.overridable).toBe(true)
    expect(r.reasons.some((x) => /3 packet\(s\).*not been delivered.*queues behind/.test(x.text))).toBe(true)
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT, OVERRIDE_WORD)).toEqual({ allowed: true })
    // It is a delay, not a blocked path: the path check itself is untouched by it.
    expect(r.checks.path.status).toBe('pass')
  })

  it('a queue older than an hour is not something a word can lift', () => {
    // An hour of no movement is not "slow" — it is evidence that nothing is moving, and the only
    // thing that answers it is a test transfer that arrives.
    const r = assessRisk(clean({ delayed: { packets: 3, oldestMinutes: STOPPED_VERIFICATION_MINUTES + 1 } }))
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.testLimitOnly).toBe(true)
    expect(r.overridable).toBe(false)
    expect(r.reasons.some((x) => /waiting more than an hour.*verification may have stopped/.test(x.text))).toBe(true)
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT, OVERRIDE_WORD)).toMatchObject({ allowed: false, why: 'over_test_limit' })
    // A test-sized amount still goes: it is a stoppage on the route, not a refusal to send.
    expect(sendAllowed(r, TEST_LIMIT, TEST_LIMIT)).toEqual({ allowed: true })
  })

  it('sits exactly on the threshold on the overridable side', () => {
    // The boundary is spelled out so a later change to the constant cannot move it by accident.
    const at = assessRisk(clean({ delayed: { packets: 1, oldestMinutes: STOPPED_VERIFICATION_MINUTES } }))
    expect(at.overridable).toBe(true)
    const just_over = assessRisk(clean({ delayed: { packets: 1, oldestMinutes: STOPPED_VERIFICATION_MINUTES + 0.01 } }))
    expect(just_over.overridable).toBe(false)
  })

  it('a delivered test lifts even the hour-old queue’s cap', () => {
    const r = assessRisk(clean({ delayed: { packets: 2, oldestMinutes: 240 }, testVerified: true }))
    expect(r.tier).toBe('CAUTION')
    expect(r.testLimitOnly).toBe(false)
  })

  it('a stuck payload still blocks, which is the difference from a queue', () => {
    const r = assessRisk(withCheck(clean(), 'path', { status: 'fail', reason: 'the endpoint is holding a stored payload' }))
    expect(r.tier).toBe('BLOCKED')
  })

  it('a route nothing has ever been delivered on is unverified', () => {
    const r = assessRisk(clean({ history: { kind: 'never' } }))
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.overridable).toBe(true)
  })

  it('history decides between unverified, caution and silence', () => {
    expect(assessRisk(clean({ history: { kind: 'delivered', days: STALE_DELIVERY_DAYS + 1 } })).tier).toBe('UNVERIFIED')
    expect(assessRisk(clean({ history: { kind: 'delivered', days: FRESH_DELIVERY_DAYS + 1 } })).tier).toBe('CAUTION')
    expect(assessRisk(clean({ history: { kind: 'delivered', days: FRESH_DELIVERY_DAYS } })).tier).toBe('OK')
  })

  it('a history window too short to cover the period is never read as "never delivered"', () => {
    // The distinction that makes the verdict honest: not finding a delivery in seven hours of
    // blocks is not the same fact as nothing ever having been delivered.
    const unknown = assessRisk(clean({ history: { kind: 'unknown', reason: 'the provider would not serve a longer range' } }))
    expect(unknown.tier).toBe('OK')
    expect(unknown.reasons).toEqual([])
    const never = assessRisk(clean({ history: { kind: 'never' } }))
    expect(never.tier).toBe('UNVERIFIED')
  })

  it('one hard check unchecked plus an overridable reason stays non-overridable', () => {
    // The stricter of the two wins: a word cannot stand in for the check that never ran.
    const i = withCheck(clean({ unknownInfra: true, history: { kind: 'never' } }), 'peers', { status: 'unchecked', reason: 'rpc' })
    const r = assessRisk(i)
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.overridable).toBe(false)
  })

  it('a confirmed test delivery lifts the cap and says so', () => {
    const capped = assessRisk(withCheck(clean(), 'delivery_sim', { status: 'unchecked', reason: 'rpc' }))
    expect(capped.testLimitOnly).toBe(true)
    const after = assessRisk(withCheck(clean({ testVerified: true }), 'delivery_sim', { status: 'unchecked', reason: 'rpc' }))
    expect(after.tier).toBe('CAUTION')
    expect(after.testLimitOnly).toBe(false)
    expect(sendAllowed(after, AMOUNT, TEST_LIMIT)).toEqual({ allowed: true })
    // The reason it could not be checked is still on screen — the cap lifted, the fact did not.
    expect(after.reasons.some((x) => x.check === 'delivery_sim')).toBe(true)
    expect(after.reasons.some((x) => /confirmed delivered/.test(x.text))).toBe(true)
  })
})

describe('CAUTION never becomes worse than it is', () => {
  it('an unusual DVN set is a warning at most', () => {
    const r = assessRisk(clean({ unknownDvnSet: true }))
    expect(r.tier).toBe('CAUTION')
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT)).toEqual({ allowed: true })
  })

  it('an unusual DVN set on a route with no history is still only a warning about the DVNs', () => {
    // §4: for v2 this combination is capped at CAUTION by the DVN side; the missing history is its
    // own reason and carries its own weight.
    const r = assessRisk(clean({ unknownDvnSet: true, history: { kind: 'never' } }))
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.reasons.some((x) => /DVN set/.test(x.text))).toBe(true)
    expect(r.reasons.some((x) => /ever been delivered/.test(x.text))).toBe(true)
    // The DVN half of that never caps on its own — §4 says a V2 route with an unusual but healthy
    // set and no history is CAUTION at most. The missing history is what capped it.
    expect(assessRisk(clean({ unknownDvnSet: true })).tier).toBe('CAUTION')
  })

  it.each([['recentChange'], ['thinGas'], ['nearLimit']] as const)('%s warns and allows the send', (flag) => {
    const r = assessRisk(clean({ [flag]: true }))
    expect(r.tier).toBe('CAUTION')
    expect(sendAllowed(r, AMOUNT, TEST_LIMIT)).toEqual({ allowed: true })
  })
})

describe('the confirmation word', () => {
  it('accepts only the word, in any case, trimmed', () => {
    expect(overrideAccepted(OVERRIDE_WORD)).toBe(true)
    expect(overrideAccepted(' unverified ')).toBe(true)
    expect(overrideAccepted('unverifie')).toBe(false)
    expect(overrideAccepted('')).toBe(false)
    expect(overrideAccepted('yes')).toBe(false)
  })
})

describe('what LayerZero says about a DVN', () => {
  it('has a committed list for every chain the app serves', () => {
    for (const key of ['ethereum', 'arbitrum', 'base', 'robinhood', 'linea', 'solana'] as const) {
      expect(hasDvnList(key), key).toBe(true)
    }
  })

  it('knows the dead DVN and marks it deprecated', () => {
    // Its address is in the committed table; find it by the id LayerZero gives it.
    const dead = listOf('ethereum').find(([, e]) => e.id === DEAD_DVN_ID)
    expect(dead, 'ethereum should list LZDeadDVN').toBeDefined()
    expect(dead![1].deprecated).toBe(true)
    // And judging a set containing it puts it in `dead`, not `unknown`.
    const v = judgeDvns('ethereum', [dead![0]])
    expect(v.dead.length).toBe(1)
    expect(v.unknown).toEqual([])
    expect(v.healthy).toEqual([])
  })

  it('treats a DVN it has never heard of as unknown, never as dead', () => {
    const v = judgeDvns('ethereum', ['0x1234567890123456789012345678901234567890'])
    expect(v.unknown.length).toBe(1)
    expect(v.dead).toEqual([])
  })

  it('finds a healthy DVN by either casing', () => {
    const healthy = listOf('arbitrum').find(([, e]) => !e.deprecated)!
    expect(dvnInfo('arbitrum', healthy[0])).toBeDefined()
    expect(dvnInfo('arbitrum', healthy[0].toUpperCase().replace('0X', '0x'))).toBeDefined()
    expect(judgeDvns('arbitrum', [healthy[0]]).healthy.length).toBe(1)
  })
})

// ------------------------------------------------------ the OFTAdapter rule ----

/**
 * An OFTAdapter is a lockbox the real token knows nothing about, so no on-chain fact can vouch for
 * it and guard 17's peer-back is the adapter confirming itself. Only the committed list reaches
 * OK; the two indirect signals decide amber vs red and never more than that.
 */
describe('an adapter is trusted by the committed list, or not at all', () => {
  const standing = (over: Partial<AdapterStanding> = {}): AdapterStanding => ({
    listed: false,
    lockedBps: ADAPTER_MIN_LOCKED_BPS,
    outboundNonce: ADAPTER_MIN_OUTBOUND_NONCE,
    ...over,
  })

  it('a fresh fake adapter — nothing locked, no history — is BLOCKED', () => {
    const r = assessRisk(clean({ adapter: standing({ lockedBps: 0, outboundNonce: 0n }) }))
    expect(r.tier).toBe('BLOCKED')
    expect(r.overridable).toBe(false)
    // Not a cap: a test amount into a lockbox that may not be one is still a loss.
    expect(r.testLimitOnly).toBe(false)
  })

  it('healthy signals but no listing is amber, capped, and not overridable by a word', () => {
    const r = assessRisk(clean({ adapter: standing() }))
    expect(r.tier).toBe('UNVERIFIED')
    expect(r.testLimitOnly).toBe(true)
    expect(r.overridable).toBe(false)
    // The wording must not read as "checked".
    expect(r.reasons.some((x) => /not on the reviewed list/.test(x.text) && /not proof/.test(x.text))).toBe(true)
  })

  it('a listed adapter is an ordinary route', () => {
    expect(assessRisk(clean({ adapter: standing({ listed: true }) })).tier).toBe('OK')
    // ...and listing outranks weak signals, because the list is the evidence, not the signals.
    expect(assessRisk(clean({ adapter: standing({ listed: true, lockedBps: 0, outboundNonce: 0n }) })).tier).toBe('OK')
  })

  it('a plain OFT is unaffected: there is no lockbox to vouch for', () => {
    expect(assessRisk(clean()).tier).toBe('OK')
  })

  it('a read that did not answer is not a pass', () => {
    for (const over of [{ lockedBps: undefined }, { outboundNonce: undefined }]) {
      expect(assessRisk(clean({ adapter: standing(over) })).tier).toBe('BLOCKED')
    }
  })

  it('each floor is enforced on its own', () => {
    expect(assessRisk(clean({ adapter: standing({ lockedBps: ADAPTER_MIN_LOCKED_BPS - 1 }) })).tier).toBe('BLOCKED')
    expect(assessRisk(clean({ adapter: standing({ outboundNonce: ADAPTER_MIN_OUTBOUND_NONCE - 1n }) })).tier).toBe('BLOCKED')
  })

  it('lockedBps is a share of supply, and an unreadable supply is unknown rather than zero', () => {
    expect(lockedBps(5n, 1000n)).toBe(50) // 0.5%
    expect(lockedBps(0n, 1000n)).toBe(0)
    expect(lockedBps(1n, 0n)).toBeUndefined()
  })

  it('the list matches on chain + adapter + token, all three', () => {
    // The file ships empty, so nothing is listed — which is exactly the shipped default.
    expect(REVIEWED_ADAPTERS).toHaveLength(0)
    expect(reviewedAdapter('ethereum', '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222')).toBeUndefined()
  })
})
