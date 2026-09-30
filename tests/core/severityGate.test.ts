/**
 * The gate, asserted the same way on all four protocols.
 *
 * core/severity.ts says what may be ticked past and what may not; each guard set applies it. These
 * tests are the seam between the two — what a user can and cannot get through — so they run the
 * REAL guards over stub snapshots (tests/core/gateFixtures.ts) rather than re-deriving the rule.
 * Nothing here touches the network.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getAddress, pad, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { addEntry, applyImport, bookConfirms, bookRefuses, EMPTY_BOOK, lookUp, parseBook, previewImport, type AddressBook } from '@/core/addressBook'
import { guardSeverity, isBlockingCode, isPendingCode, verdictOf, type FailedGuard } from '@/core/severity'
import { LOCKING_HUBS } from '@/protocols/wormhole-ntt/lockingHubs'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'
import { verifyNttManager } from '@/protocols/wormhole-ntt/verify'
import { runNttGuards } from '@/protocols/wormhole-ntt/guards'
import { codesOf, harnesses, NTT, nttInput, riskOf, type Harness } from './gateFixtures'

const ROOT = join(__dirname, '..', '..')

let all: Harness[] = []
beforeAll(async () => {
  all = await harnesses()
})

// ------------------------------------------------- the table and the guards ----

/** Every code a guard can emit, read from the source so a new one cannot be forgotten. */
function emittedCodes(): Set<string> {
  const files = [
    'src/core/guards.ts',
    'src/protocols/lz-v1/guards.ts',
    'src/protocols/wormhole-ntt/guards.ts',
    'src/protocols/ccip/guards.ts',
  ]
  const out = new Set<string>()
  for (const f of files) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/fail\(\d+,\s*'([a-z_0-9]+)'/g)) out.add(m[1]!)
  }
  // g22 does not name its codes; riskWarningCode does.
  for (const c of ['risk_blocked', 'risk_unverified']) out.add(c)
  return out
}

/**
 * The warnings that are deliberate. Anything a guard emits that is neither blocking nor pending
 * must be listed here on purpose: severity.ts makes an unknown code a warning so that a new check
 * cannot silently become a refusal, and the price of that default is that a check meant to refuse
 * can silently become a warning instead. This list is where that decision gets made by a person.
 */
const DELIBERATE_WARNINGS = new Set([
  'adapter_params_missing',
  'amount_out_of_limits',
  'fee_above_ceiling_unconfirmed',
  'gas_below_min_dst',
  'inbound_capacity_unknown',
  'inbound_limit_unknown',
  'no_executor_gas_unconfirmed',
  'no_executor_options_svm',
  'ntt_anchor_missing',
  'outbound_limit_unknown',
  'over_inbound_capacity',
  'over_outbound_capacity',
  'peer_back_mismatch',
  'peer_back_unavailable_unconfirmed',
  'received_lt_min',
  'recipient_pda_unconfirmed',
  'risk_blocked',
  'risk_unverified',
  'simulation_failed',
  'simulation_unavailable',
  'stored_payload_blocked',
  'stored_payload_unavailable_unconfirmed',
  'trusted_remote_back_mismatch',
  'trusted_remote_back_unavailable_unconfirmed',
])

describe('every code a guard emits has been classified on purpose', () => {
  it('is either blocking, pending, or a listed warning — never a warning by omission', () => {
    const unclassified = [...emittedCodes()]
      .filter((c) => !isBlockingCode(c) && !isPendingCode(c) && !DELIBERATE_WARNINGS.has(c))
      .sort()
    expect(unclassified).toEqual([])
  })

  it('does not list a warning that no guard emits, or that has become a block', () => {
    const emitted = emittedCodes()
    for (const c of DELIBERATE_WARNINGS) {
      expect(emitted.has(c), `${c} is listed as a warning but no guard emits it`).toBe(true)
      expect(guardSeverity(c), c).toBe('warn')
    }
  })

  /**
   * The two rules of core/severity.ts, applied to the codes that state them. The file's own header
   * names "the amount arrives as zero" and "the app would have to build something malformed" as the
   * reasons to refuse, and these are those cases on the v1 and NTT paths.
   */
  it('refuses what the header of severity.ts says must be refused', () => {
    const certainLoss = ['delivered_zero', 'oft_fee_exceeds_amount', 'amount_zero', 'amount_rounds_to_zero', 'recipient_zero']
    const malformed = ['min_gt_delivered', 'min_gt_amount', 'slippage_unsupported', 'queueing_enabled', 'adapter_params_forbidden']
    for (const c of [...certainLoss, ...malformed]) expect(isBlockingCode(c), c).toBe(true)
  })
})

// -------------------------------------------------- 1. the red adapter ----

describe('1. a red adapter warns, and only a tick opens it — never a block underneath', () => {
  const RED = { listed: false, lockedBps: 0, outboundNonce: 0n }
  const AMBER = { listed: false, lockedBps: 500, outboundNonce: 500n }
  const redRisk = () => riskOf({ adapter: RED })

  it('is a warning by severity.ts, which is what makes a tick legitimate here', () => {
    expect(redRisk().adapterUnproven).toBe(true)
    expect(guardSeverity('risk_unverified')).toBe('warn')
  })

  for (const name of ['OFT V2', 'OFT v1']) {
    describe(name, () => {
      const h = () => all.find((x) => x.name === name)!

      it('holds the button without the tick, with the reason in the warnings and none in the blocks', () => {
        const rep = h().run({ risk: redRisk() })
        expect(codesOf(rep.riskWarnings)).toEqual(['risk_unverified'])
        expect(rep.blocks).toEqual([])
        expect(rep.warningsCleared).toBe(false)
        expect(rep.canSend).toBe(false)
      })

      it('sends with the tick, because a warning is what it is', () => {
        expect(h().run({ risk: redRisk(), risksAccepted: true }).canSend).toBe(true)
      })

      it('does not send with the tick when something that IS a block is also present', () => {
        for (const [code, mutate] of Object.entries(h().blockers)) {
          const rep = h().run({ risk: redRisk(), risksAccepted: true, ...mutate() })
          expect(rep.canSend, code).toBe(false)
          expect(codesOf(rep.blocks), code).toContain(code)
        }
      })

      it('a route the app could not check at all is BLOCKED by the fold, and still only a warning', () => {
        const noSecondOperator = riskOf({ linkCrossChecked: false })
        expect(noSecondOperator.tier).toBe('BLOCKED')
        const rep = h().run({ risk: noSecondOperator })
        expect(codesOf(rep.riskWarnings)).toEqual(['risk_blocked'])
        expect(rep.canSend).toBe(false)
        expect(h().run({ risk: noSecondOperator, risksAccepted: true }).canSend).toBe(true)
      })

      it('a reviewed adapter is an ordinary route, whatever its signals say', () => {
        const listed = riskOf({ adapter: { listed: true, lockedBps: 0, outboundNonce: 0n } })
        expect(listed.tier).toBe('OK')
        expect(h().run({ risk: listed }).canSend).toBe(true)
      })

      it('an unreviewed adapter with healthy signals is amber, not red — and warns just the same', () => {
        const amber = riskOf({ adapter: AMBER })
        expect(amber.adapterUnproven).toBe(false)
        expect(amber.tier).toBe('UNVERIFIED')
        expect(h().run({ risk: amber }).canSend).toBe(false)
        expect(h().run({ risk: amber, risksAccepted: true }).canSend).toBe(true)
      })
    })
  }
})

// -------------------------------------- 2. NTT without a listed locking hub ----

describe('2. an NTT manager no committed list vouches for', () => {
  const ETH_CORE = getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge)
  const DST_MANAGER = NTT.DST_MANAGER
  const m = (a: string) => a.toLowerCase()

  /** Answers `${address}.${functionName}`; anything unset throws, like a revert. */
  const client = (answers: Record<string, unknown>): ReadClient =>
    ({
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        const key = `${m(address)}.${functionName}`
        if (!(key in answers)) throw new Error(`no answer for ${key}`)
        const v = answers[key]
        if (v instanceof Error) throw v
        return v
      },
    }) as unknown as ReadClient

  /** A LOCKING manager: nothing mints, so the token can grant it nothing to check. */
  const lockingSrc = (manager: Address, token: Address) => ({
    [`${m(manager)}.token`]: token,
    [`${m(manager)}.chainId`]: 2,
    [`${m(manager)}.getMode`]: 0,
    [`${m(manager)}.tokenDecimals`]: 18,
    [`${m(manager)}.getPeer`]: { peerAddress: pad(m(DST_MANAGER) as Address, { size: 32 }), tokenDecimals: 18 },
    [`${m(manager)}.getTransceivers`]: [NTT.TRANSCEIVER],
    [`${m(NTT.TRANSCEIVER)}.getTransceiverType`]: 'wormhole',
    [`${m(NTT.TRANSCEIVER)}.wormhole`]: ETH_CORE,
    [`${m(NTT.TRANSCEIVER)}.isWormholeRelayingEnabled`]: true,
    [`${m(NTT.TRANSCEIVER)}.isSpecialRelayingEnabled`]: false,
    [`${m(token)}.minter`]: new Error('locking hub: nothing mints'),
    [`${m(token)}.MINTER_ROLE`]: new Error('no role'),
  })
  const dstFor = (manager: Address) => ({
    [`${m(DST_MANAGER)}.getPeer`]: { peerAddress: pad(m(manager) as Address, { size: 32 }), tokenDecimals: 18 },
    [`${m(DST_MANAGER)}.token`]: NTT.DST_TOKEN,
  })
  const verify = (manager: Address, token: Address, tokenList: Parameters<typeof verifyNttManager>[0]['tokenList'] = []) =>
    verifyNttManager({
      srcChain: 'ethereum',
      dstChain: 'bsc',
      manager,
      srcClient: client(lockingSrc(manager, token)),
      dstClient: client(dstFor(manager)),
      tokenList,
    })

  it('the fixture manager is not in the committed list — otherwise this file tests nothing', () => {
    expect(LOCKING_HUBS.some((h) => h.manager.toLowerCase() === m(NTT.MANAGER))).toBe(false)
  })

  it('verifies, finds no anchor, and lands as a warning that the tick opens', async () => {
    const r = await verify(NTT.MANAGER, NTT.TOKEN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.verified.anchor).toBeNull()

    const held = runNttGuards(nttInput({ verification: r }))
    expect(codesOf(held.riskWarnings)).toEqual(['ntt_anchor_missing'])
    expect(held.blocks).toEqual([])
    expect(held.canSend).toBe(false)
    expect(runNttGuards(nttInput({ verification: r, risksAccepted: true })).canSend).toBe(true)
  })

  it('an outage of the third-party catalogue changes nothing — it may narrow the search, never vouch', async () => {
    const withList = await verify(NTT.MANAGER, NTT.TOKEN, [
      { symbol: 'W', coingeckoId: 'w', platforms: { ethereum: NTT.TOKEN, bsc: NTT.DST_TOKEN } } as never,
    ])
    const without = await verify(NTT.MANAGER, NTT.TOKEN, [])
    for (const r of [withList, without]) {
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.verified.anchor).toBeNull()
    }
  })

  it('the tick never lifts a block that sits beside the missing anchor', async () => {
    const r = await verify(NTT.MANAGER, NTT.TOKEN)
    for (const [code, mutate] of Object.entries(all.find((x) => x.name === 'NTT')!.blockers)) {
      if (code === 'manager_unverified') continue // replaces the verification this test is about
      const rep = runNttGuards(nttInput({ verification: r, risksAccepted: true, ...mutate() } as never))
      expect(rep.canSend, code).toBe(false)
      expect(codesOf(rep.blocks), code).toContain(code)
    }
  })

  it('a hub the committed list DOES name needs no warning at all', async () => {
    const hub = LOCKING_HUBS.find((h) => h.chain === 'ethereum')
    expect(hub, 'locking-hubs.json has no ethereum entry to test with').toBeDefined()
    const r = await verify(hub!.manager, hub!.token)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.verified.anchor).toEqual({ side: 'listed', kind: 'committed' })
    expect(runNttGuards(nttInput({ verification: r })).riskWarnings).toEqual([])
  })
})

// -------------------------------------------------- 3. recipient = a contract ----

describe('3. a recipient that is a contract of this very route is refused', () => {
  const contractsOf = (h: Harness) => h.contractsInPlay.map((c) => [`${h.name}: ${c.label}`, h, c.address] as const)

  it('on every protocol, for every contract in play, ticked or not', () => {
    const cases = all.flatMap(contractsOf)
    expect(cases.length).toBeGreaterThanOrEqual(14)
    for (const [label, h, address] of cases) {
      for (const risksAccepted of [false, true]) {
        const rep = h.run({ ...h.recipientOverride(address), risksAccepted })
        expect(codesOf(rep.blocks), `${label} (tick=${risksAccepted})`).toContain('recipient_is_contract')
        expect(rep.canSend, label).toBe(false)
      }
    }
  })

  it('whatever case the address is typed in', () => {
    for (const h of all) {
      for (const c of h.contractsInPlay) {
        const lower = h.run(h.recipientOverride(c.address.toLowerCase() as Address))
        expect(codesOf(lower.blocks), `${h.name}: ${c.label}`).toContain('recipient_is_contract')
      }
    }
  })

  it('the code is a block in the table, not a warning the tick could cover', () => {
    expect(guardSeverity('recipient_is_contract')).toBe('block')
  })

  it('an address that is none of them, typed and confirmed, is not refused', () => {
    const ordinary = getAddress('0x9999999999999999999999999999999999999999')
    for (const h of all) {
      const rep = h.run(h.recipientOverride(ordinary))
      expect(codesOf(rep.blocks), h.name).toEqual([])
      expect(rep.canSend, h.name).toBe(true)
    }
  })
})

// ----------------------------------------- 4. the look-alike of a saved address ----

describe('4. a twin of a saved address is refused, and nothing lifts it', () => {
  const saved = '0x1234000000000000000000000000000000005678'
  const twin = getAddress('0x1234ffffffffffffffffffffffffffffffff5678')
  const book = (): AddressBook => addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'Exchange', address: saved, family: 'evm' }, 1_700_000_000_000, 'e1')

  it('the book calls it a look-alike, and that is what the screens hand to the guards', () => {
    const v = lookUp(book(), 'evm', twin)
    expect(v.kind).toBe('lookalike')
    expect(bookRefuses(v)).toBe(true)
    expect(bookConfirms(v)).toBe(false)
  })

  it('on every protocol: refused with the tail confirmed, and refused with the tick', () => {
    const refuse = bookRefuses(lookUp(book(), 'evm', twin))
    for (const h of all) {
      for (const risksAccepted of [false, true]) {
        // recipientOverride sets custom + confirmed: the tail check is satisfied and it still fails.
        const rep = h.run({ ...h.recipientOverride(twin), recipientLookalike: refuse, risksAccepted })
        expect(codesOf(rep.blocks), `${h.name} (tick=${risksAccepted})`).toContain('recipient_lookalike')
        expect(rep.canSend, h.name).toBe(false)
      }
    }
  })

  it('the code is a block in the table', () => {
    expect(guardSeverity('recipient_lookalike')).toBe('block')
  })

  it('the saved address itself is not a twin of itself, and needs no second confirmation', () => {
    const v = lookUp(book(), 'evm', saved)
    expect(v.kind).toBe('known')
    expect(bookRefuses(v)).toBe(false)
    expect(bookConfirms(v)).toBe(true)
  })

  it('an imported copy of the twin does not launder it: without its own confirmation it is not imported and stays refused', () => {
    const p = previewImport({ version: 1, entries: [{ label: 'Fake', address: twin, family: 'evm' }] }, book())
    const merged = applyImport(book(), p!)
    expect(merged.entries).toHaveLength(1)
    const v = lookUp(merged, 'evm', twin)
    expect(v.kind).toBe('lookalike')
    expect(bookRefuses(v)).toBe(true)
    for (const h of all) {
      const rep = h.run({ ...h.recipientOverride(twin), recipientLookalike: bookRefuses(v), risksAccepted: true })
      expect(codesOf(rep.blocks), h.name).toContain('recipient_lookalike')
      expect(rep.canSend, h.name).toBe(false)
    }
  })

  it('an imported twin the user confirmed row by row is imported, so the tail is still owed', () => {
    const p = previewImport({ version: 1, entries: [{ label: 'Other', address: twin, family: 'evm' }] }, book())!
    const merged = applyImport(book(), p, new Set([p.add[0]!.id]))
    const v = lookUp(merged, 'evm', twin)
    expect(v.kind).toBe('imported')
    expect(bookConfirms(v)).toBe(false)
    expect(bookRefuses(v)).toBe(false)
    // The screens compute recipientConfirmed = bookConfirms(v) || confirmsTail(...). With neither,
    // the recipient is unconfirmed on every protocol.
    for (const h of all) {
      const rep = h.run({ ...h.recipientOverride(twin), customRecipientConfirmed: false, recipientLookalike: bookRefuses(v), risksAccepted: true })
      expect(codesOf(rep.blocks), h.name).toContain('recipient_unconfirmed')
      expect(rep.canSend, h.name).toBe(false)
    }
  })

  it('a twin that is in the book without anyone having confirmed the pair is refused on every protocol', () => {
    // A hand-edited store, or any path that skipped the question.
    const stored = { version: 1, entries: [{ id: 'e1', label: 'Exchange', address: saved, family: 'evm' }, { id: 'e2', label: 'Fake', address: twin, family: 'evm' }] }
    const v = lookUp(applyImportless(stored), 'evm', twin)
    expect(v.kind).toBe('lookalike')
    for (const h of all) {
      const rep = h.run({ ...h.recipientOverride(twin), recipientLookalike: bookRefuses(v), risksAccepted: true })
      expect(codesOf(rep.blocks), h.name).toContain('recipient_lookalike')
      expect(rep.canSend, h.name).toBe(false)
    }
  })
})

/** The store as `parseBook` reads it back — the path an import preview never sees. */
function applyImportless(raw: unknown): AddressBook {
  const r = parseBook(raw)
  if (!r.ok) throw new Error('fixture is not a book')
  return r.book
}

// --------------------------------------------- 5. a recipient that is any contract ----

describe('5. a recipient that is merely a contract is not the guards’ business', () => {
  /**
   * severity.ts says "a recipient that is merely a contract is a warning: exchange deposits and
   * multisigs are contracts". The guards are pure functions over an address and cannot tell a
   * contract from an EOA — no guard reads code — so there is nothing to warn ABOUT. This pins the
   * half that exists: a contract that is not part of the route is not refused.
   */
  const SOME_SAFE = getAddress('0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552')

  it('is not a block, and not a warning, on any protocol', () => {
    for (const h of all) {
      const rep = h.run(h.recipientOverride(SOME_SAFE))
      expect(codesOf(rep.blocks), h.name).toEqual([])
      expect(rep.riskWarnings, h.name).toEqual([])
      expect(rep.canSend, h.name).toBe(true)
    }
  })

  it('the guard modules never read code — the distinction cannot be drawn there', () => {
    for (const f of ['src/core/guards.ts', 'src/protocols/lz-v1/guards.ts', 'src/protocols/wormhole-ntt/guards.ts', 'src/protocols/ccip/guards.ts']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/getCode|getBytecode|eth_getCode/)
    }
  })
})

// --------------------------------------------------- 7. the assembly invariants ----

describe('7. the tick opens warnings and nothing else', () => {
  it('every blocker of every protocol produces its own code (the table below tests something)', () => {
    for (const h of all) {
      for (const [code, mutate] of Object.entries(h.blockers)) {
        expect(codesOf(h.run(mutate()).blocks), `${h.name}: ${code}`).toContain(code)
      }
    }
  })

  it('a blocker stays exactly as blocking with the tick on, on all four protocols', () => {
    let n = 0
    for (const h of all) {
      for (const [code, mutate] of Object.entries(h.blockers)) {
        const off = h.run({ ...mutate(), risksAccepted: false })
        const on = h.run({ ...mutate(), risksAccepted: true })
        expect(on.canSend, `${h.name}: ${code}`).toBe(false)
        // The same failures, in the same order: the tick removed nothing from the blocks.
        expect(codesOf(on.blocks), `${h.name}: ${code}`).toEqual(codesOf(off.blocks))
        n++
      }
    }
    expect(n).toBeGreaterThanOrEqual(50)
  })

  it('every code the table calls blocking or pending keeps the button down under the tick', () => {
    const codes = [...emittedCodes()].filter((c) => isBlockingCode(c) || isPendingCode(c))
    expect(codes.length).toBeGreaterThan(40)
    for (const code of codes) {
      const failed: FailedGuard = { ok: false, code }
      expect(verdictOf([failed], true).canSend, code).toBe(false)
      expect(verdictOf([failed], true).blocks, code).toEqual([failed])
    }
  })

  it('a warning alone is opened by the tick, and only a warning', () => {
    for (const code of DELIBERATE_WARNINGS) {
      const failed: FailedGuard = { ok: false, code }
      expect(verdictOf([failed], false).canSend, code).toBe(false)
      expect(verdictOf([failed], true).canSend, code).toBe(true)
      // …and mixed with a block it opens nothing.
      expect(verdictOf([failed, { ok: false, code: 'recipient_zero' }], true).canSend, code).toBe(false)
    }
  })

  it('the transaction does not depend on the tick: no builder or sender ever reads it', () => {
    const allowed = new Set([
      'src/core/severity.ts',
      'src/core/guards.ts',
      'src/protocols/lz-v1/guards.ts',
      'src/protocols/wormhole-ntt/guards.ts',
      'src/protocols/ccip/guards.ts',
      'src/ui/BridgeApp.tsx',
      'src/ui/BridgeV1.tsx',
      'src/ui/NttApp.tsx',
      'src/ui/CcipApp.tsx',
      'src/ui/components/RiskWarnings.tsx',
    ])
    const seen: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
        else if (/\.(ts|tsx)$/.test(name) && /risksAccepted/.test(readFileSync(join(ROOT, rel), 'utf8'))) seen.push(rel)
      }
    }
    walk('src')
    const stray = seen.filter((f) => !allowed.has(f))
    expect(stray, 'a file outside the guards and the screens reads the tick').toEqual([])
  })

  it('a plan made for another sender is refused: the refund goes to plan.sender, and the wallet is who signs', () => {
    const other = getAddress('0x9999999999999999999999999999999999999999')
    for (const h of all) {
      for (const risksAccepted of [false, true]) {
        const rep = h.run({ walletAddress: other, risksAccepted })
        // The recipient defaults to "my wallet", so a swapped wallet trips the recipient guard too;
        // what this pins is that the sender mismatch is reported on its own.
        expect(codesOf(rep.blocks), `${h.name} (tick=${risksAccepted})`).toContain('chain_mismatch')
        expect(rep.canSend, h.name).toBe(false)
      }
    }
  })

  it('every send handler judges the guards of the render it is called from, not of an earlier one', () => {
    // A memoised onSend keeps the guardInput of the render it was created in: the tick, the balance
    // and the simulation would all be stale at the moment of the click.
    for (const f of ['BridgeApp', 'BridgeV1', 'NttApp', 'CcipApp']) {
      const src = readFileSync(join(ROOT, 'src/ui', `${f}.tsx`), 'utf8')
      expect(src, f).not.toMatch(/onSend\s*=\s*useCallback/)
      expect(src, f).not.toMatch(/onApprove\s*=\s*useCallback/)
    }
  })

  it('the calldata is a function of the plan alone: the same plan encodes to the same bytes', async () => {
    // The encoders take a plan. There is no parameter through which the tick could reach them, and
    // the source scan above is what keeps it that way; this pins that the output is stable.
    const { assembleSendArgs, encodeSendCalldata } = await import('@/core/plan')
    const { treadPlan } = await import('./fixtures')
    const plan = treadPlan()
    expect(encodeSendCalldata(assembleSendArgs(plan))).toBe(encodeSendCalldata(assembleSendArgs(plan)))
    expect(Object.keys(plan)).not.toContain('risksAccepted')
  })
})

describe('the approve waits for the blocks too, not only for the warnings', () => {
  it('is ready when the allowance is the only thing missing, and nothing else blocks', () => {
    for (const h of all) {
      const rep = h.run(h.blockers['needs_approve']!())
      expect(codesOf(rep.blocks), h.name).toEqual(['needs_approve'])
      expect(rep.approveReady, h.name).toBe(true)
    }
  })

  it('is NOT ready while a refused recipient stands — no allowance for a transfer that cannot happen', () => {
    for (const h of all) {
      for (const other of ['recipient_lookalike', 'recipient_zero', 'insufficient_balance', 'chain_mismatch']) {
        const rep = h.run({ ...h.blockers['needs_approve']!(), ...h.blockers[other]!() })
        expect(codesOf(rep.blocks), `${h.name}+${other}`).toContain('needs_approve')
        expect(rep.approveReady, `${h.name}+${other}`).toBe(false)
        expect(h.run({ ...h.blockers['needs_approve']!(), ...h.blockers[other]!(), risksAccepted: true }).approveReady, `${h.name}+${other} ticked`).toBe(false)
      }
    }
  })

  it('still waits for the tick when something warns', () => {
    for (const name of ['OFT V2', 'OFT v1']) {
      const h = all.find((x) => x.name === name)!
      const risk = riskOf({ adapter: { listed: false, lockedBps: 0, outboundNonce: 0n } })
      const off = h.run({ ...h.blockers['needs_approve']!(), risk })
      expect(off.approveReady, name).toBe(false)
      expect(h.run({ ...h.blockers['needs_approve']!(), risk, risksAccepted: true }).approveReady, name).toBe(true)
    }
  })

  it('the four screens gate the approve on approveReady, not on warningsCleared', () => {
    for (const f of ['BridgeApp', 'BridgeV1', 'NttApp', 'CcipApp']) {
      const src = readFileSync(join(ROOT, 'src/ui', `${f}.tsx`), 'utf8')
      expect(src, f).toContain('report.approveReady')
      expect(src, f).not.toContain('report.warningsCleared')
    }
  })
})
