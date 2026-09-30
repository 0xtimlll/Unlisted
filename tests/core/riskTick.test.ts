/**
 * The one tick answers for one transfer. It must stop counting the moment any part of that
 * transfer changes, on every tab — the network, the token, the amount, the recipient (and the
 * route and the wallet, which are part of the same question).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { riskTickScope, tickCovers, type TickScope } from '@/core/riskTick'

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

describe('6. the tick stops covering when the transfer changes', () => {
  const given = riskTickScope(base)

  it('covers exactly the scope it was given for', () => {
    expect(given).not.toBeNull()
    expect(tickCovers(given, riskTickScope({ ...base }))).toBe(true)
  })

  for (const field of Object.keys(changes) as (keyof TickScope)[]) {
    it(`no longer covers once the ${field} changes`, () => {
      const changed = riskTickScope({ ...base, [field]: changes[field] })
      expect(changed).not.toBe(given)
      expect(tickCovers(given, changed)).toBe(false)
    })
  }

  it('a recipient in another case is another scope — the safe way to be wrong, and on Solana it IS another address', () => {
    const sol = 'So11111111111111111111111111111111111111112'
    expect(tickCovers(riskTickScope({ ...base, recipient: sol }), riskTickScope({ ...base, recipient: sol.toLowerCase() }))).toBe(false)
  })

  it('an amount and a string that print alike do not collide', () => {
    expect(riskTickScope({ ...base, amount: 1n, destination: 23 })).not.toBe(riskTickScope({ ...base, amount: 123n, destination: undefined }))
  })

  it('nothing is covered while any part is still unknown, and nothing is covered by nothing', () => {
    for (const field of Object.keys(base) as (keyof TickScope)[]) {
      expect(riskTickScope({ ...base, [field]: undefined }), field).toBeNull()
      expect(tickCovers(given, riskTickScope({ ...base, [field]: undefined })), field).toBe(false)
    }
    expect(tickCovers(null, given)).toBe(false)
    expect(tickCovers(null, null)).toBe(false)
  })

  /**
   * The rule is only as good as its use: a screen that goes back to a boolean and its own list of
   * dependencies would pass everything above and still miss a field. So the four screens are held
   * to deriving the tick from the scope, with every part named.
   */
  it('every send screen derives the tick from the full scope, and none keeps a boolean of its own', () => {
    for (const f of ['BridgeApp', 'BridgeV1', 'NttApp', 'CcipApp']) {
      const src = readFileSync(join(ROOT, 'src/ui', `${f}.tsx`), 'utf8')
      expect(src, f).toContain('riskTickScope({')
      expect(src, f).toContain('tickCovers(tickedFor, tickScope)')
      expect(src, f).not.toMatch(/\[risksAccepted, setRisksAccepted\]/)
      const call = src.slice(src.indexOf('riskTickScope({'), src.indexOf('})', src.indexOf('riskTickScope({')))
      for (const field of Object.keys(base)) expect(call, `${f}: ${field}`).toMatch(new RegExp(`\\b${field}\\b\\s*[:,]`))
    }
  })
})
