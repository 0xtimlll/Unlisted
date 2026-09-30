/**
 * The one tick answers for one transfer AND for the warnings that were on screen when it was
 * given. It must stop counting the moment any part of the transfer changes, on every tab — the
 * network, the token, the amount, the recipient (and the route and the wallet, which are part of
 * the same question) — and the moment a warning appears that the user has not read, or one they
 * read gets heavier. A warning that goes away does not end it: what remains was accepted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { riskTickScope, tickCovers, warningMarks, warningsSince, type TickGrant, type TickScope, type WarningMark } from '@/core/riskTick'
import { warningWeight } from '@/core/severity'

const ROOT = join(__dirname, '..', '..')

const base: TickScope = {
  chain: 'ethereum',
  contract: '0x1111111111111111111111111111111111111111',
  destination: 30110,
  amount: 1_000_000n,
  recipient: '0x2222222222222222222222222222222222222222',
  sender: '0x3333333333333333333333333333333333333333',
}

const changes: Record<keyof TickScope, TickScope[keyof TickScope]> = {
  chain: 'base',
  contract: '0x4444444444444444444444444444444444444444',
  destination: 30184,
  amount: 1_000_001n,
  recipient: '0x5555555555555555555555555555555555555555',
  sender: '0x6666666666666666666666666666666666666666',
}

/** Real codes with their real weights, so the tests say what a screen would say. */
const LOSS = 'risk_blocked'
const STUCK = 'gas_below_min_dst'
const NOTE = 'label_lookalike'
const marks = (...codes: string[]): WarningMark[] => warningMarks(codes.map((code) => ({ code })))
const grantFor = (scope: TickScope, ...codes: string[]): TickGrant => ({ scope: riskTickScope(scope)!, warnings: marks(...codes) })

describe('6. the tick stops covering when the transfer changes', () => {
  const given = grantFor(base, LOSS)
  const shown = marks(LOSS)

  it('covers exactly the scope it was given for', () => {
    expect(riskTickScope(base)).not.toBeNull()
    expect(tickCovers(given, riskTickScope({ ...base }), shown)).toBe(true)
  })

  for (const field of Object.keys(changes) as (keyof TickScope)[]) {
    it(`no longer covers once the ${field} changes`, () => {
      const changed = riskTickScope({ ...base, [field]: changes[field] })
      expect(changed).not.toBe(given.scope)
      expect(tickCovers(given, changed, shown)).toBe(false)
    })
  }

  it('a recipient in another case is another scope — the safe way to be wrong, and on Solana it IS another address', () => {
    const sol = 'So11111111111111111111111111111111111111112'
    expect(tickCovers(grantFor({ ...base, recipient: sol }), riskTickScope({ ...base, recipient: sol.toLowerCase() }), [])).toBe(false)
  })

  it('an amount and a string that print alike do not collide', () => {
    expect(riskTickScope({ ...base, amount: 1n, destination: 23 })).not.toBe(riskTickScope({ ...base, amount: 123n, destination: undefined }))
  })

  it('nothing is covered while any part is still unknown, and nothing is covered by nothing', () => {
    for (const field of Object.keys(base) as (keyof TickScope)[]) {
      expect(riskTickScope({ ...base, [field]: undefined }), field).toBeNull()
      expect(tickCovers(given, riskTickScope({ ...base, [field]: undefined }), shown), field).toBe(false)
    }
    expect(tickCovers(null, given.scope, shown)).toBe(false)
    expect(tickCovers(null, null, [])).toBe(false)
  })
})

describe('6b. the tick is an answer about the warnings that were shown, not about warnings in general', () => {
  const scope = riskTickScope(base)

  it('the marks are real weights from the table, so the fixtures below mean what they say', () => {
    expect(warningWeight(LOSS)).toBe('loss')
    expect(warningWeight(STUCK)).toBe('stuck')
    expect(warningWeight(NOTE)).toBe('note')
  })

  it('a new warning ends the tick, and is what the screen points at', () => {
    const given = grantFor(base, STUCK)
    expect(tickCovers(given, scope, marks(STUCK))).toBe(true)
    expect(tickCovers(given, scope, marks(STUCK, LOSS))).toBe(false)
    expect(warningsSince(given.warnings, marks(STUCK, LOSS))).toEqual([{ code: LOSS, weight: 'loss' }])
    // A note is still a new warning: the user accepted a list, and this is not that list.
    expect(tickCovers(given, scope, marks(STUCK, NOTE))).toBe(false)
  })

  it('a warning that got heavier ends the tick, even under the same code', () => {
    const given: TickGrant = { scope: scope!, warnings: [{ code: 'x', weight: 'note' }] }
    expect(tickCovers(given, scope, [{ code: 'x', weight: 'note' }])).toBe(true)
    expect(tickCovers(given, scope, [{ code: 'x', weight: 'stuck' }])).toBe(false)
    expect(tickCovers(given, scope, [{ code: 'x', weight: 'loss' }])).toBe(false)
    expect(warningsSince(given.warnings, [{ code: 'x', weight: 'loss' }])).toEqual([{ code: 'x', weight: 'loss' }])
    // The route indicator says a heavier thing under a different code; that is a new code, same result.
    const tier = grantFor(base, 'risk_unverified')
    expect(tickCovers(tier, scope, marks('risk_blocked'))).toBe(false)
  })

  it('a warning that disappeared does not end the tick — what is left was accepted', () => {
    const given = grantFor(base, LOSS, STUCK, NOTE)
    expect(tickCovers(given, scope, marks(LOSS, STUCK))).toBe(true)
    expect(tickCovers(given, scope, marks(NOTE))).toBe(true)
    expect(tickCovers(given, scope, [])).toBe(true)
    expect(warningsSince(given.warnings, marks(NOTE))).toEqual([])
  })

  it('a warning that got milder does not end the tick either', () => {
    const given: TickGrant = { scope: scope!, warnings: [{ code: 'x', weight: 'loss' }] }
    expect(tickCovers(given, scope, [{ code: 'x', weight: 'note' }])).toBe(true)
  })

  it('order and repeats of the same code do not matter', () => {
    expect(marks(STUCK, LOSS, STUCK)).toEqual(marks(LOSS, STUCK))
    expect(tickCovers(grantFor(base, LOSS, STUCK), scope, marks(STUCK, LOSS))).toBe(true)
  })

  it('a grant for one scope with more warnings does not carry over to another scope with fewer', () => {
    const given = grantFor(base, LOSS, STUCK)
    expect(tickCovers(given, riskTickScope({ ...base, amount: 1n }), marks(LOSS))).toBe(false)
  })
})

/**
 * The rule is only as good as its use: a screen that goes back to a boolean and its own list of
 * dependencies would pass everything above and still miss a field. So the four screens are held
 * to deriving the tick from the full scope and from the warnings on screen, through the one hook.
 */
describe('every send screen gives the tick its full scope and its warnings, and none keeps a boolean of its own', () => {
  it('the hook is the only place the tick is judged, and it judges scope and warnings together', () => {
    const hook = readFileSync(join(ROOT, 'src/ui/useRiskTick.ts'), 'utf8')
    expect(hook).toContain('tickCovers(grant, scope, marks)')
    expect(hook).toContain('warningsSince(grant.warnings, marks)')
  })

  for (const f of ['BridgeApp', 'BridgeV1', 'NttApp', 'CcipApp']) {
    it(`${f} derives the tick from the scope and the first-pass warnings`, () => {
      const src = readFileSync(join(ROOT, 'src/ui', `${f}.tsx`), 'utf8')
      expect(src).toContain('riskTickScope({')
      expect(src).toMatch(/useRiskTick\(tickScope, planData \? shownFailures\(draft\.riskWarnings\) : \[\]\)/)
      expect(src).toMatch(/risksAccepted: tick\.accepted/)
      expect(src).toMatch(/accepted=\{tick\.accepted\}/)
      expect(src).toMatch(/added=\{tick\.added\}/)
      expect(src).not.toMatch(/\[risksAccepted, setRisksAccepted\]/)
      expect(src).not.toMatch(/useState<string \| null>\(null\)\s*\n[^\n]*tick/i)
      const call = src.slice(src.indexOf('riskTickScope({'), src.indexOf('})', src.indexOf('riskTickScope({')))
      for (const field of Object.keys(base)) expect(call, `${f}: ${field}`).toMatch(new RegExp(`\\b${field}\\b\\s*[:,]`))
    })
  }
})
