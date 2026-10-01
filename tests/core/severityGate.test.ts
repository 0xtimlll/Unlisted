/**
 * The gate, asserted the same way on all four protocols.
 *
 * core/severity.ts says what holds the button (the transaction is impossible, or the app would be
 * building something malformed) and what is a note for the indicator; each guard set applies it.
 * These tests are the seam between the two — what holds and what only colours — so they run the
 * REAL guards over stub snapshots (tests/core/gateFixtures.ts) rather than re-deriving the rule.
 * Nothing here touches the network.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getAddress, pad, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { addEntry, applyImport, bookConfirms, bookRefuses, EMPTY_BOOK, lookUp, parseBook, previewImport, type AddressBook } from '@/core/addressBook'
import { guardSeverity, isBlockingCode, isNoteCode, isPendingCode, isStepCode, shownFailures, verdictOf, waitsOnlyForApprove, type FailedGuard } from '@/core/severity'
import { noteLevel } from '@/core/indicator'
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
 * The notes that are deliberate. Anything a guard emits that is neither blocking nor pending must
 * be listed here on purpose: severity.ts makes an unknown code a note so that a new check cannot
 * silently become a refusal, and the price of that default is that a check meant to refuse can
 * silently become a note instead. This list is where that decision gets made by a person.
 */
const DELIBERATE_NOTES = new Set([
  'amount_out_of_limits',
  'fee_above_ceiling',
  'gas_below_min_dst',
  'inbound_capacity_unknown',
  'inbound_limit_unknown',
  'no_executor_gas',
  'no_executor_options_svm',
  'ntt_anchor_missing',
  'outbound_limit_unknown',
  'over_inbound_capacity',
  'over_outbound_capacity',
  'peer_back_mismatch',
  'peer_back_unavailable',
  'recipient_is_contract',
  'recipient_lookalike',
  'recipient_pda',
  'recipient_token_account',
  'recipient_zero',
  'risk_blocked',
  'risk_unavailable',
  'risk_unverified',
  'simulation_failed',
  'simulation_unavailable',
  'stored_payload_blocked',
  'stored_payload_unavailable',
  'trusted_remote_back_mismatch',
  'trusted_remote_back_unavailable',
])

describe('every code a guard emits has been classified on purpose', () => {
  it('is either blocking, pending, or a listed note — never a note by omission', () => {
    const unclassified = [...emittedCodes()]
      .filter((c) => !isBlockingCode(c) && !isPendingCode(c) && !DELIBERATE_NOTES.has(c))
      .sort()
    expect(unclassified).toEqual([])
  })

  it('does not list a note that no guard emits, or that has become a block', () => {
    const emitted = emittedCodes()
    for (const c of DELIBERATE_NOTES) {
      expect(emitted.has(c), `${c} is listed as a note but no guard emits it`).toBe(true)
      expect(guardSeverity(c), c).toBe('note')
    }
  })

  /**
   * The header of severity.ts names the only reasons to hold the button: no wallet or the wrong
   * chain, no balance, no route, an amount that arrives as zero, a recipient that cannot be
   * encoded — and the assembly invariants, which are the app being correct about itself.
   */
  it('holds exactly what the header of severity.ts says is impossible', () => {
    const impossible = [
      'wallet_not_connected', 'chain_mismatch', 'insufficient_balance', 'insufficient_native',
      'peer_missing', 'route_missing', 'route_unsupported', 'manager_unverified',
      'amount_zero', 'amount_rounds_to_zero', 'delivered_zero', 'oft_fee_exceeds_amount', 'amount_has_dust',
      'recipient_invalid', 'recipient_vm_mismatch', 'recipient_unconfirmed',
    ]
    const malformed = ['min_gt_delivered', 'min_gt_amount', 'slippage_unsupported', 'queueing_enabled', 'adapter_params_forbidden', 'selfcheck_failed', 'approve_wrong_spender', 'message_not_plain']
    for (const c of [...impossible, ...malformed]) expect(isBlockingCode(c), c).toBe(true)
  })

  it('what used to be a block and is now a colour: the zero address, a route contract, a twin, a peer that does not point back', () => {
    for (const c of ['recipient_zero', 'recipient_is_contract', 'recipient_lookalike', 'peer_back_mismatch', 'trusted_remote_back_mismatch', 'ntt_anchor_missing']) {
      expect(isNoteCode(c), c).toBe(true)
      expect(noteLevel(c), c).toBe('red')
    }
  })
})

// -------------------------------------------------- 1. the fresh adapter ----

describe('1. a fresh adapter is a yellow nuance, and the send is possible', () => {
  const FRESH = { lockedBps: 0, outboundNonce: 0n }
  const PROVEN = { lockedBps: 500, outboundNonce: 500n }

  for (const name of ['OFT V2', 'OFT v1']) {
    describe(name, () => {
      const h = () => all.find((x) => x.name === name)!

      it('is a note, with the reason, and nothing in the blocks', () => {
        const risk = riskOf({ adapter: FRESH })
        expect(risk.tier).toBe('UNVERIFIED')
        const rep = h().run({ risk })
        expect(codesOf(rep.notes)).toEqual(['risk_unverified'])
        expect(rep.blocks).toEqual([])
        expect(rep.canSend).toBe(true)
      })

      it('a real block next to it still holds, whatever the indicator says', () => {
        for (const [code, mutate] of Object.entries(h().blockers)) {
          const rep = h().run({ risk: riskOf({ adapter: FRESH }), ...mutate() })
          expect(rep.canSend, code).toBe(false)
          expect(codesOf(rep.blocks), code).toContain(code)
        }
      })

      it('a route only one RPC operator answered for is UNVERIFIED — a note, not a hold', () => {
        const oneOperator = riskOf({ linkCrossChecked: false })
        expect(oneOperator.tier).toBe('UNVERIFIED')
        const rep = h().run({ risk: oneOperator })
        expect(codesOf(rep.notes)).toEqual(['risk_unverified'])
        expect(rep.canSend).toBe(true)
      })

      it('an adapter that locks a real share and has real history is an ordinary route', () => {
        const proven = riskOf({ adapter: PROVEN })
        expect(proven.tier).toBe('OK')
        const rep = h().run({ risk: proven })
        expect(rep.notes).toEqual([])
        expect(rep.canSend).toBe(true)
      })
    })
  }
})

// -------------------------------------- 2. NTT with nothing vouching for the manager ----

describe('2. an NTT manager nothing on the source chain vouches for', () => {
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

  it('verifies, finds no anchor, and lands as a RED note — the send is still possible', async () => {
    const r = await verify(NTT.MANAGER, NTT.TOKEN)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.verified.anchor).toBeNull()

    const rep = runNttGuards(nttInput({ verification: r }))
    expect(codesOf(rep.notes)).toEqual(['ntt_anchor_missing'])
    expect(noteLevel('ntt_anchor_missing')).toBe('red')
    expect(rep.blocks).toEqual([])
    expect(rep.canSend).toBe(true)
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

  it('a block beside the missing anchor still holds', async () => {
    const r = await verify(NTT.MANAGER, NTT.TOKEN)
    for (const [code, mutate] of Object.entries(all.find((x) => x.name === 'NTT')!.blockers)) {
      if (code === 'manager_unverified') continue // replaces the verification this test is about
      const rep = runNttGuards(nttInput({ verification: r, ...mutate() } as never))
      expect(rep.canSend, code).toBe(false)
      expect(codesOf(rep.blocks), code).toContain(code)
    }
  })

  it('no committed list exists any more: nothing in the source reads one', () => {
    for (const f of ['src/protocols/wormhole-ntt/verify.ts', 'src/protocols/lz-risk/v2.ts', 'src/protocols/lz-risk/v1.ts', 'src/protocols/lz-risk/risk.ts']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/lockingHubs|locking-hubs|adapters\.json|reviewedAdapter|listedLockingHub/)
    }
  })
})

// -------------------------------------------------- 3. recipient = a contract ----

describe('3. a recipient that is a contract of this very route is a red note, on every protocol', () => {
  const contractsOf = (h: Harness) => h.contractsInPlay.map((c) => [`${h.name}: ${c.label}`, h, c.address] as const)

  it('for every contract in play: noted red, never held', () => {
    const cases = all.flatMap(contractsOf)
    expect(cases.length).toBeGreaterThanOrEqual(14)
    for (const [label, h, address] of cases) {
      const rep = h.run(h.recipientOverride(address))
      expect(codesOf(rep.notes), label).toContain('recipient_is_contract')
      expect(codesOf(rep.blocks), label).not.toContain('recipient_is_contract')
      expect(rep.canSend, label).toBe(true)
    }
  })

  it('whatever case the address is typed in', () => {
    for (const h of all) {
      for (const c of h.contractsInPlay) {
        const lower = h.run(h.recipientOverride(c.address.toLowerCase() as Address))
        expect(codesOf(lower.notes), `${h.name}: ${c.label}`).toContain('recipient_is_contract')
      }
    }
  })

  it('the code is a red note in the table', () => {
    expect(guardSeverity('recipient_is_contract')).toBe('note')
    expect(noteLevel('recipient_is_contract')).toBe('red')
  })

  it('an address that is none of them, typed and confirmed, has nothing said about it', () => {
    const ordinary = getAddress('0x9999999999999999999999999999999999999999')
    for (const h of all) {
      const rep = h.run(h.recipientOverride(ordinary))
      expect(codesOf(rep.blocks), h.name).toEqual([])
      expect(codesOf(rep.notes), h.name).toEqual([])
      expect(rep.canSend, h.name).toBe(true)
    }
  })
})

// ----------------------------------------- 4. the look-alike of a saved address ----

describe('4. a twin of a saved address is a red note; the book itself never launders one', () => {
  const saved = '0x1234000000000000000000000000000000005678'
  const twin = getAddress('0x1234ffffffffffffffffffffffffffffffff5678')
  const book = (): AddressBook => addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'Exchange', address: saved, family: 'evm' }, 1_700_000_000_000, 'e1')

  it('the book calls it a look-alike, and that is what the screens hand to the guards', () => {
    const v = lookUp(book(), 'evm', twin)
    expect(v.kind).toBe('lookalike')
    expect(bookRefuses(v)).toBe(true)
    expect(bookConfirms(v)).toBe(false)
  })

  it('on every protocol: noted red with the tail confirmed, and the send is possible', () => {
    const refuse = bookRefuses(lookUp(book(), 'evm', twin))
    for (const h of all) {
      const rep = h.run({ ...h.recipientOverride(twin), recipientLookalike: refuse })
      expect(codesOf(rep.notes), h.name).toContain('recipient_lookalike')
      expect(rep.canSend, h.name).toBe(true)
    }
  })

  it('the code is a red note in the table', () => {
    expect(guardSeverity('recipient_lookalike')).toBe('note')
    expect(noteLevel('recipient_lookalike')).toBe('red')
  })

  it('the saved address itself is not a twin of itself, and needs no second confirmation', () => {
    const v = lookUp(book(), 'evm', saved)
    expect(v.kind).toBe('known')
    expect(bookRefuses(v)).toBe(false)
    expect(bookConfirms(v)).toBe(true)
  })

  it('an imported copy of the twin does not launder it: without its own confirmation it is not imported and stays a twin', () => {
    const p = previewImport({ version: 1, entries: [{ label: 'Fake', address: twin, family: 'evm' }] }, book())
    const merged = applyImport(book(), p!)
    expect(merged.entries).toHaveLength(1)
    const v = lookUp(merged, 'evm', twin)
    expect(v.kind).toBe('lookalike')
    expect(bookRefuses(v)).toBe(true)
  })

  it('an imported twin the user confirmed row by row is imported, so the tail is still owed', () => {
    const p = previewImport({ version: 1, entries: [{ label: 'Other', address: twin, family: 'evm' }] }, book())!
    const merged = applyImport(book(), p, new Set([p.add[0]!.id]))
    const v = lookUp(merged, 'evm', twin)
    expect(v.kind).toBe('imported')
    expect(bookConfirms(v)).toBe(false)
    expect(bookRefuses(v)).toBe(false)
    // The screens compute recipientConfirmed = bookConfirms(v) || confirmsTail(...). With neither,
    // the recipient is not entered yet on every protocol: that is input, and it holds.
    for (const h of all) {
      const rep = h.run({ ...h.recipientOverride(twin), customRecipientConfirmed: false, recipientLookalike: bookRefuses(v) })
      expect(codesOf(rep.blocks), h.name).toContain('recipient_unconfirmed')
      expect(rep.canSend, h.name).toBe(false)
    }
  })

  it('a twin that is in the book without anyone having confirmed the pair is a twin on every protocol', () => {
    // A hand-edited store, or any path that skipped the question.
    const stored = { version: 1, entries: [{ id: 'e1', label: 'Exchange', address: saved, family: 'evm' }, { id: 'e2', label: 'Fake', address: twin, family: 'evm' }] }
    const v = lookUp(applyImportless(stored), 'evm', twin)
    expect(v.kind).toBe('lookalike')
    for (const h of all) {
      const rep = h.run({ ...h.recipientOverride(twin), recipientLookalike: bookRefuses(v) })
      expect(codesOf(rep.notes), h.name).toContain('recipient_lookalike')
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
   * The guards are pure functions over an address and cannot tell a contract from an EOA — no
   * guard reads code — so there is nothing to say. This pins the half that exists: a contract that
   * is not part of the route is neither held nor noted.
   */
  const SOME_SAFE = getAddress('0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552')

  it('is not a block, and not a note, on any protocol', () => {
    for (const h of all) {
      const rep = h.run(h.recipientOverride(SOME_SAFE))
      expect(codesOf(rep.blocks), h.name).toEqual([])
      expect(rep.notes, h.name).toEqual([])
      expect(rep.canSend, h.name).toBe(true)
    }
  })

  it('the guard modules never read code — the distinction cannot be drawn there', () => {
    for (const f of ['src/core/guards.ts', 'src/protocols/lz-v1/guards.ts', 'src/protocols/wormhole-ntt/guards.ts', 'src/protocols/ccip/guards.ts']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/getCode|getBytecode|eth_getCode/)
    }
  })
})

// --------------------------------------------------- 6. blocks are only the impossible ----

describe('6. the button is held by the impossible and by nothing else', () => {
  it('every blocker of every protocol produces its own code in the blocks', () => {
    let n = 0
    for (const h of all) {
      for (const [code, mutate] of Object.entries(h.blockers)) {
        const rep = h.run(mutate())
        expect(codesOf(rep.blocks), `${h.name}: ${code}`).toContain(code)
        expect(rep.canSend, `${h.name}: ${code}`).toBe(false)
        n++
      }
    }
    expect(n).toBeGreaterThanOrEqual(40)
  })

  it('every noter of every protocol produces its own code in the notes, and the send stays possible', () => {
    let n = 0
    for (const h of all) {
      for (const [code, mutate] of Object.entries(h.noters)) {
        const rep = h.run(mutate())
        expect(codesOf(rep.notes), `${h.name}: ${code}`).toContain(code)
        expect(codesOf(rep.blocks), `${h.name}: ${code}`).toEqual([])
        expect(rep.canSend, `${h.name}: ${code}`).toBe(true)
        n++
      }
    }
    expect(n).toBeGreaterThanOrEqual(16)
  })

  it('every code the table calls blocking or pending keeps the button down', () => {
    const codes = [...emittedCodes()].filter((c) => isBlockingCode(c) || isPendingCode(c))
    expect(codes.length).toBeGreaterThan(30)
    for (const code of codes) {
      const failed: FailedGuard = { ok: false, code }
      expect(verdictOf([failed]).canSend, code).toBe(false)
      expect(verdictOf([failed]).blocks, code).toEqual([failed])
    }
  })

  it('a note alone never holds; a note beside a block changes nothing', () => {
    for (const code of DELIBERATE_NOTES) {
      const failed: FailedGuard = { ok: false, code }
      expect(verdictOf([failed]).canSend, code).toBe(true)
      expect(verdictOf([failed]).notes, code).toEqual([failed])
      expect(verdictOf([failed, { ok: false, code: 'insufficient_balance' }]).canSend, code).toBe(false)
    }
  })

  it('there is no tick anywhere: no guard input and no screen reads one', () => {
    const seen: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
        else if (/\.(ts|tsx)$/.test(name) && /risksAccepted|warningsCleared|approveReady|useRiskTick|RiskWarnings|highFeeAccepted|noGasAccepted|peerBackAccepted|pdaAccepted|storedPayloadAccepted/.test(readFileSync(join(ROOT, rel), 'utf8'))) seen.push(rel)
      }
    }
    walk('src')
    expect(seen).toEqual([])
  })

  it('a plan made for another sender is refused: the refund goes to plan.sender, and the wallet is who signs', () => {
    const other = getAddress('0x9999999999999999999999999999999999999999')
    for (const h of all) {
      const rep = h.run({ walletAddress: other })
      // The recipient defaults to "my wallet", so a swapped wallet trips the recipient guard too;
      // what this pins is that the sender mismatch is reported on its own.
      expect(codesOf(rep.blocks), h.name).toContain('chain_mismatch')
      expect(rep.canSend, h.name).toBe(false)
    }
  })

  it('every send handler judges the guards of the render it is called from, not of an earlier one', () => {
    // A memoised onSend keeps the guardInput of the render it was created in: the balance and the
    // simulation would be stale at the moment of the click.
    for (const f of ['BridgeApp', 'BridgeV1', 'NttApp', 'CcipApp']) {
      const src = readFileSync(join(ROOT, 'src/ui', `${f}.tsx`), 'utf8')
      expect(src, f).not.toMatch(/onSend\s*=\s*useCallback/)
      expect(src, f).not.toMatch(/onApprove\s*=\s*useCallback/)
    }
  })

  it('the calldata is a function of the plan alone: the same plan encodes to the same bytes', async () => {
    const { assembleSendArgs, encodeSendCalldata } = await import('@/core/plan')
    const { treadPlan } = await import('./fixtures')
    const plan = treadPlan()
    expect(encodeSendCalldata(assembleSendArgs(plan))).toBe(encodeSendCalldata(assembleSendArgs(plan)))
  })
})

// ------------------------------------------------ 7. the approve is a step, not a problem ----

describe('7. the approve is the next step: offered when only the allowance is short', () => {
  const AFTER_APPROVE = { allowance: 2n ** 200n }

  it('needs_approve is a step: it holds canSend, but is never shown as a problem', () => {
    expect(isStepCode('needs_approve')).toBe(true)
    expect(guardSeverity('needs_approve')).toBe('block')
    for (const h of all) {
      const rep = h.run(h.blockers['needs_approve']!())
      expect(rep.canSend, h.name).toBe(false)
      expect(codesOf(rep.blocks), h.name).toEqual(['needs_approve'])
      expect(shownFailures(rep.blocks, { dropPending: true, dropSteps: true }), h.name).toEqual([])
      // The button is Approve, enabled.
      expect(waitsOnlyForApprove(rep.blocks), h.name).toBe(true)
    }
  })

  it('the approve is NOT offered while the transfer is impossible — no allowance for a transfer that cannot happen', () => {
    for (const h of all) {
      for (const other of ['insufficient_balance', 'chain_mismatch', 'wallet_not_connected']) {
        const rep = h.run({ ...h.blockers['needs_approve']!(), ...h.blockers[other]!() })
        expect(waitsOnlyForApprove(rep.blocks), `${h.name}+${other}`).toBe(false)
      }
    }
  })

  it('a red or yellow route does not stand between the user and the approve', () => {
    for (const h of all) {
      for (const [code, mutate] of Object.entries(h.noters)) {
        const rep = h.run({ ...h.blockers['needs_approve']!(), ...mutate() })
        expect(waitsOnlyForApprove(rep.blocks), `${h.name}+${code}`).toBe(true)
      }
    }
  })

  it('a fresh adapter with allowance 0: Approve now; Send once the allowance is read back', () => {
    for (const name of ['OFT V2', 'OFT v1']) {
      const h = all.find((x) => x.name === name)!
      const step = { ...h.blockers['needs_approve']!(), risk: riskOf({ adapter: { lockedBps: 247, outboundNonce: 5n } }) }
      const before = h.run(step)
      expect(codesOf(before.notes), name).toContain('risk_unverified')
      expect(codesOf(before.blocks), name).toEqual(['needs_approve'])
      expect(waitsOnlyForApprove(before.blocks), name).toBe(true)
      const after = h.run({ ...step, ...AFTER_APPROVE })
      expect(codesOf(after.blocks), name).toEqual([])
      expect(after.canSend, name).toBe(true)
    }
  })

  it('the screens offer the approve on that rule and put the impossibility in one line under the button', () => {
    for (const f of ['BridgeApp', 'BridgeV1', 'NttApp', 'CcipApp']) {
      const src = readFileSync(join(ROOT, 'src/ui', `${f}.tsx`), 'utf8')
      expect(src, f).toContain('shownFailures(report.blocks, { dropPending: true, dropSteps: true })[0]')
      expect(src, f).toMatch(/enabled: waitsOnlyForApprove\(report\.blocks\)/)
      expect(src, f).toContain('useApproveFlow(')
      // No red block, no tick, no "test amount only" anywhere on the screen.
      expect(src, f).not.toMatch(/type="checkbox"[^\n]*(accept|Accept|risk)/)
    }
    const dict = readFileSync(join(ROOT, 'src/i18n/en.ts'), 'utf8')
    for (const gone of ['test amount only', 'cannot be sent', 'Route unverified', 'issue(s) to fix', 'I understand the risks', 'adapterReminder']) {
      expect(dict, gone).not.toContain(gone)
    }
  })
})

// ------------------------------------------ 8. a failed simulation is a note, with its reason ----

describe('8. a failed simulation is a yellow note that says what the node said, on every protocol', () => {
  const REASON = 'Error("LzApp: destination chain is not a trusted source")'
  /** The failed simulation in each protocol's own shape, all decoding to REASON. */
  const failed: Record<string, Record<string, unknown>> = {
    'OFT V2': { simulation: { ok: false, reason: REASON } },
    'OFT v1': { simulation: { status: 'reverted', revert: { kind: 'string', message: 'LzApp: destination chain is not a trusted source', meaning: 'generic' } } },
    NTT: { simulation: { ok: false, reason: REASON } },
    CCIP: { simulation: { ok: false, reason: REASON } },
  }

  it('is classified as a yellow note, never a block', () => {
    expect(guardSeverity('simulation_failed')).toBe('note')
    expect(guardSeverity('simulation_unavailable')).toBe('note')
    expect(noteLevel('simulation_failed')).toBe('yellow')
    expect(noteLevel('simulation_unavailable')).toBe('yellow')
  })

  it('carries the decoded reason, and the send is possible', () => {
    for (const h of all) {
      const over = failed[h.name]
      expect(over, h.name).toBeDefined()
      const rep = h.run(over!)
      expect(codesOf(rep.blocks), h.name).not.toContain('simulation_failed')
      const w = rep.notes.find((r) => !r.ok && r.code === 'simulation_failed') as FailedGuard | undefined
      expect(w, h.name).toBeDefined()
      expect(w!.detail, h.name).toBe(REASON)
      expect(rep.canSend, h.name).toBe(true)
    }
  })

  it('the indicator prints that reason under the sentence', () => {
    const src = readFileSync(join(ROOT, 'src/ui/components/RouteIndicator.tsx'), 'utf8')
    expect(src).toMatch(/r\.detail/)
  })
})
