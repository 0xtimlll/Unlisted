/**
 * Wormhole NTT: amount trimming, the four-part manager gate, the guards and the self-check.
 *
 * The gate is the reason this module may ever produce an approve, so the test that matters most is
 * the last one in "the four-part gate": a fake manager that answers everything correctly and even
 * has its own matching pair of peers must still be refused, because the token never vouches for it.
 */
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, getAddress, pad, type Address, type Hex } from 'viem'
import { nttManagerAbi } from '@/protocols/wormhole-ntt/abi'
import { checkAmount, receivedAmount, trimAmount, trimmedUnits, trimPlan } from '@/protocols/wormhole-ntt/amounts'
import { nttApprovePlan, runNttGuards, type NttGuardInput } from '@/protocols/wormhole-ntt/guards'
import { assembleNttTransferArgs, nttSelfCheck, NO_TRANSCEIVER_INSTRUCTIONS, type NttPlan } from '@/protocols/wormhole-ntt/plan'
import { parseNttOperations, wormholescanTxUrl } from '@/protocols/wormhole-ntt/track'
import { findListedToken, listedChains, parseTokenList } from '@/protocols/wormhole-ntt/tokenList'
import { verifyNttManager, type NttVerification, verifyNttManagerQuorum } from '@/protocols/wormhole-ntt/verify'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'
import type { ReadClient } from '@/core/client'

// Synthetic on purpose: a test about the rule must not depend on any real deployment.
const MANAGER = getAddress('0xaaaaaaa000000000000000000000000000000001')
const DST_MANAGER = getAddress('0xbbbbbbb000000000000000000000000000000002')
const TOKEN = getAddress('0xccccccc000000000000000000000000000000003')
const DST_TOKEN = getAddress('0x1111111111111111111111111111111111111111')
const TRANSCEIVER = getAddress('0x6c55f346c20ca2b0c62e30790907f0a41c978ccc')
const WALLET = getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9')
const ETH_CORE = getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge)
const ETH_WH = 2
const BSC_WH = 4
const MINTER_ROLE: Hex = `0x${'aa'.repeat(32)}`

// ---------------------------------------------------------------- amounts ----

describe('NTT amount trimming', () => {
  it('keeps at most 8 decimals, and no more than either side has', () => {
    expect(trimPlan(18, 18)).toMatchObject({ trimmedDecimals: 8, step: 10n ** 10n })
    expect(trimPlan(18, 6)).toMatchObject({ trimmedDecimals: 6, step: 10n ** 12n })
    expect(trimPlan(6, 18)).toMatchObject({ trimmedDecimals: 6, step: 1n })
    expect(trimPlan(8, 8)).toMatchObject({ trimmedDecimals: 8, step: 1n })
  })

  it('rounds down, because the manager reverts on dust instead of trimming', () => {
    const plan = trimPlan(18, 18)
    const raw = 1_234567890123456789n
    const amount = trimAmount(raw, plan)
    expect(amount % plan.step).toBe(0n)
    expect(raw - amount).toBe(123456789n)
    expect(checkAmount(raw, plan)).toEqual({ ok: true, amount, dust: 123456789n })
  })

  it('converts into the destination token’s own units', () => {
    // 18 decimals here, 6 there: one whole token arrives as 1e6.
    const plan = trimPlan(18, 6)
    expect(trimmedUnits(10n ** 18n, plan)).toBe(1_000000n)
    expect(receivedAmount(10n ** 18n, plan, 6)).toBe(1_000000n)
    // and the other way round
    const back = trimPlan(6, 18)
    expect(receivedAmount(1_000000n, back, 18)).toBe(10n ** 18n)
  })

  it('refuses an amount that would not fit a uint64 on the wire', () => {
    const plan = trimPlan(18, 18)
    const tooBig = (plan.maxAmount / plan.step + 1n) * plan.step
    expect(checkAmount(tooBig, plan)).toMatchObject({ ok: false, reason: 'too_large' })
    expect(checkAmount(plan.step - 1n, plan)).toMatchObject({ ok: false, reason: 'zero' })
  })
})

// -------------------------------------------------------------- token list ----

describe('the official token list', () => {
  const list = parseTokenList([
    { symbol: 'W', coingecko_id: 'w', platforms: { ethereum: TOKEN.toLowerCase(), 'binance-smart-chain': DST_TOKEN.toLowerCase() } },
    { symbol: 'broken', platforms: null },
    { nonsense: true },
  ])

  it('keeps well-formed entries and drops the rest', () => {
    expect(list).toHaveLength(1)
    expect(list[0]?.symbol).toBe('W')
  })

  it('matches a token only by an exact address on the right chain', () => {
    expect(findListedToken(list, 'ethereum', TOKEN)?.address).toBe(TOKEN)
    expect(findListedToken(list, 'ethereum', TOKEN.toLowerCase())?.address).toBe(TOKEN)
    expect(findListedToken(list, 'bsc', TOKEN)).toBeUndefined() // right token, wrong chain
    expect(findListedToken(list, 'ethereum', DST_TOKEN)).toBeUndefined()
    expect(findListedToken(list, 'polygon', TOKEN)).toBeUndefined()
  })

  it('offers only the chains the token is actually listed on', () => {
    expect(listedChains(list[0]!, ['ethereum', 'bsc', 'base'])).toEqual(['ethereum', 'bsc'])
  })
})

// ------------------------------------------------------------------- gate ----

type Answers = Record<string, unknown>

/** A read client that answers `${address}.${functionName}`; anything unset throws, like a revert. */
function mockClient(answers: Answers): ReadClient {
  return {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      const key = `${address.toLowerCase()}.${functionName}`
      if (!(key in answers)) throw new Error(`no answer for ${key}`)
      const v = answers[key]
      if (v instanceof Error) throw v
      return v
    },
  } as unknown as ReadClient
}

const listWithBoth = parseTokenList([
  { symbol: 'W', coingecko_id: 'w', platforms: { ethereum: TOKEN.toLowerCase(), 'binance-smart-chain': DST_TOKEN.toLowerCase() } },
])

const srcAnswers = (over: Answers = {}): Answers => ({
  [`${MANAGER.toLowerCase()}.token`]: TOKEN,
  [`${MANAGER.toLowerCase()}.chainId`]: ETH_WH,
  [`${MANAGER.toLowerCase()}.getMode`]: 1, // BURNING
  [`${MANAGER.toLowerCase()}.tokenDecimals`]: 18,
  [`${MANAGER.toLowerCase()}.getPeer`]: { peerAddress: pad(DST_MANAGER.toLowerCase() as Address, { size: 32 }), tokenDecimals: 18 },
  [`${MANAGER.toLowerCase()}.getTransceivers`]: [TRANSCEIVER],
  [`${TRANSCEIVER.toLowerCase()}.getTransceiverType`]: 'wormhole',
  [`${TRANSCEIVER.toLowerCase()}.wormhole`]: ETH_CORE,
  [`${TRANSCEIVER.toLowerCase()}.isWormholeRelayingEnabled`]: true,
  [`${TRANSCEIVER.toLowerCase()}.isSpecialRelayingEnabled`]: false,
  [`${TOKEN.toLowerCase()}.minter`]: MANAGER,
  ...over,
})

const dstAnswers = (over: Answers = {}): Answers => ({
  [`${DST_MANAGER.toLowerCase()}.getPeer`]: { peerAddress: pad(MANAGER.toLowerCase() as Address, { size: 32 }), tokenDecimals: 18 },
  [`${DST_MANAGER.toLowerCase()}.token`]: DST_TOKEN,
  ...over,
})

const verify = (src: Answers, dst: Answers) =>
  verifyNttManager({
    srcChain: 'ethereum',
    dstChain: 'bsc',
    manager: MANAGER,
    srcClient: mockClient(src),
    dstClient: mockClient(dst),
    tokenList: listWithBoth,
  })

describe('the four-part gate', () => {
  it('passes a manager the token itself names as minter', async () => {
    const r = await verify(srcAnswers(), dstAnswers())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.verified).toMatchObject({
      manager: MANAGER,
      token: TOKEN,
      mode: 'burning',
      transceiver: TRANSCEIVER,
      anchor: { side: 'source', kind: 'minter' },
    })
    expect(r.verified.dst).toMatchObject({ chain: 'bsc', manager: DST_MANAGER, wormholeChainId: BSC_WH })
  })

  it('accepts an AccessControl token that grants the manager MINTER_ROLE', async () => {
    const r = await verify(
      srcAnswers({
        [`${TOKEN.toLowerCase()}.minter`]: new Error('no such function'),
        [`${TOKEN.toLowerCase()}.MINTER_ROLE`]: MINTER_ROLE,
        [`${TOKEN.toLowerCase()}.hasRole`]: true,
      }),
      dstAnswers(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toEqual({ side: 'source', kind: 'role' })
  })

  it('refuses a locking hub that only the far side vouches for — that anchor is reachable only through this manager', async () => {
    // This is the shape the old code accepted: no minter on the source token, but the destination
    // token names the destination manager. We reached that token through `manager.getPeer()`, so
    // an attacker supplies both halves. Now it takes the committed list instead.
    const r = await verify(
      srcAnswers({ [`${MANAGER.toLowerCase()}.getMode`]: 0, [`${TOKEN.toLowerCase()}.minter`]: new Error('no minter') }),
      dstAnswers({ [`${DST_TOKEN.toLowerCase()}.minter`]: DST_MANAGER }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()
  })

  it('verifies a token Wormhole has never listed, on the on-chain evidence alone', async () => {
    // An empty catalogue — the API is down, or simply does not know this token. Every on-chain
    // fact is unchanged, so the verdict is unchanged; only `listed` differs.
    const r = await verifyNttManager({
      srcChain: 'ethereum',
      dstChain: 'bsc',
      manager: MANAGER,
      srcClient: mockClient(srcAnswers()),
      dstClient: mockClient(dstAnswers()),
      tokenList: [],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.verified.listed).toBe(false)
      expect(r.verified.manager).toBe(MANAGER)
      expect(r.verified.anchor).toEqual({ side: 'source', kind: 'minter' })
    }
    // And the listed run reaches the same verdict, differing only in that flag.
    const listedRun = await verify(srcAnswers(), dstAnswers())
    expect(listedRun.ok).toBe(true)
    if (listedRun.ok && r.ok) {
      expect(listedRun.verified.listed).toBe(true)
      expect({ ...listedRun.verified, listed: false }).toEqual(r.verified)
    }
  })

  it('refuses a manager whose token does not name it back — on chain, not by catalogue', async () => {
    // The manager claims a token that never vouches for it. Wormhole's list has nothing to do
    // with this refusal; the missing anchor is the whole of it.
    const r = await verify(srcAnswers({ [`${MANAGER.toLowerCase()}.token`]: DST_TOKEN }), dstAnswers())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()
  })

  it('refuses when the peers do not point at each other', async () => {
    const r = await verify(srcAnswers(), dstAnswers({ [`${DST_MANAGER.toLowerCase()}.getPeer`]: { peerAddress: pad(WALLET.toLowerCase() as Address, { size: 32 }), tokenDecimals: 18 } }))
    expect(r).toMatchObject({ ok: false, code: 'peer_mismatch' })
  })

  it('refuses a transceiver pointing at something other than the chain’s core bridge', async () => {
    const r = await verify(srcAnswers({ [`${TRANSCEIVER.toLowerCase()}.wormhole`]: WALLET }), dstAnswers())
    expect(r).toMatchObject({ ok: false, code: 'transceiver_wrong_core_bridge' })
  })

  it('refuses a route that would need a manual redeem', async () => {
    const r = await verify(
      srcAnswers({ [`${TRANSCEIVER.toLowerCase()}.isWormholeRelayingEnabled`]: false, [`${TRANSCEIVER.toLowerCase()}.isSpecialRelayingEnabled`]: false }),
      dstAnswers(),
    )
    expect(r).toMatchObject({ ok: false, code: 'manual_delivery_only' })
  })

  it('refuses when a read cannot be completed at all — an outage is not a pass', async () => {
    const r = await verify(srcAnswers({ [`${MANAGER.toLowerCase()}.getPeer`]: new Error('RPC down') }), dstAnswers())
    expect(r).toMatchObject({ ok: false, code: 'unverifiable' })
  })

  it('leaves a fake manager UNVOUCHED FOR: right token(), matching peers, real-looking history, no anchor', async () => {
    // Everything a fake can control is correct here: it reports the real token, its own peer on the
    // other side points back at it, it has a Wormhole transceiver on the real core bridge, and it
    // could easily have one self-made transfer indexed by Wormholescan. The one thing it cannot
    // forge is the token naming it — and that is exactly what comes back as `anchor: null`.
    //
    // Unlisted informs rather than refuses (core/severity.ts), so verification succeeds and the
    // protection is guard 2b: `ntt_anchor_missing`, a note the indicator shows in red with one
    // visible line. The send stays possible; the person decides.
    const FAKE = getAddress('0xdeadbeef00000000000000000000000000000001')
    const FAKE_DST = getAddress('0xdeadbeef00000000000000000000000000000002')
    const src: Answers = {
      [`${FAKE.toLowerCase()}.token`]: TOKEN,
      [`${FAKE.toLowerCase()}.chainId`]: ETH_WH,
      [`${FAKE.toLowerCase()}.getMode`]: 1,
      [`${FAKE.toLowerCase()}.tokenDecimals`]: 18,
      [`${FAKE.toLowerCase()}.getPeer`]: { peerAddress: pad(FAKE_DST.toLowerCase() as Address, { size: 32 }), tokenDecimals: 18 },
      [`${FAKE.toLowerCase()}.getTransceivers`]: [TRANSCEIVER],
      [`${TRANSCEIVER.toLowerCase()}.getTransceiverType`]: 'wormhole',
      [`${TRANSCEIVER.toLowerCase()}.wormhole`]: ETH_CORE,
      [`${TRANSCEIVER.toLowerCase()}.isWormholeRelayingEnabled`]: true,
      [`${TRANSCEIVER.toLowerCase()}.isSpecialRelayingEnabled`]: false,
      // The real token names the REAL manager, not this one.
      [`${TOKEN.toLowerCase()}.minter`]: MANAGER,
      [`${TOKEN.toLowerCase()}.MINTER_ROLE`]: MINTER_ROLE,
      [`${TOKEN.toLowerCase()}.hasRole`]: false,
    }
    const dst: Answers = {
      [`${FAKE_DST.toLowerCase()}.getPeer`]: { peerAddress: pad(FAKE.toLowerCase() as Address, { size: 32 }), tokenDecimals: 18 },
      [`${FAKE_DST.toLowerCase()}.token`]: DST_TOKEN,
      [`${DST_TOKEN.toLowerCase()}.minter`]: DST_MANAGER,
      [`${DST_TOKEN.toLowerCase()}.MINTER_ROLE`]: MINTER_ROLE,
      [`${DST_TOKEN.toLowerCase()}.hasRole`]: false,
    }
    const r = await verifyNttManager({
      srcChain: 'ethereum',
      dstChain: 'bsc',
      manager: FAKE,
      srcClient: mockClient(src),
      dstClient: mockClient(dst),
      tokenList: listWithBoth,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()

    // The protection that remains, and the one that matters: guard 2b says so, in red.
    const rep = runNttGuards(guardInput({ verification: r }))
    expect(rep.notes.map((w) => !w.ok && w.code)).toContain('ntt_anchor_missing')
    // It is a NOTE, not a block — the owner's decision, see core/severity.ts.
    expect(rep.blocks.map((b) => !b.ok && b.code)).not.toContain('ntt_anchor_missing')
    expect(rep.canSend).toBe(true)
  })
})

// ----------------------------------------------------------------- plans ----

const verifiedFixture = (): NttVerification => ({
  ok: true,
  verified: {
    chain: 'ethereum',
    manager: MANAGER,
    token: TOKEN,
    tokenSymbol: 'W',
  listed: true,
  alsoOnDestination: true,
    mode: 'burning',
    tokenDecimals: 18,
    dst: { chain: 'bsc', wormholeChainId: BSC_WH, manager: DST_MANAGER, token: DST_TOKEN, tokenDecimals: 18 },
    transceiver: TRANSCEIVER,
    anchor: { side: 'source', kind: 'minter' },
  },
})

function planFixture(over: Partial<NttPlan> = {}): NttPlan {
  const trim = trimPlan(18, 18)
  const amount = 5n * trim.step
  return {
    protocol: 'wormhole-ntt',
    chain: 'ethereum',
    manager: MANAGER,
    token: TOKEN,
    tokenSymbol: 'W',
    mode: 'burning',
    sender: WALLET,
    amount,
    amountRaw: amount,
    dust: 0n,
    received: receivedAmount(amount, trim, 18),
    trim,
    dst: { chain: 'bsc', wormholeChainId: BSC_WH, manager: DST_MANAGER, token: DST_TOKEN, tokenDecimals: 18 },
    recipient: pad(WALLET.toLowerCase() as Address, { size: 32 }),
    recipientDisplay: WALLET,
    refundAddress: pad(WALLET.toLowerCase() as Address, { size: 32 }),
    transceiverInstructions: NO_TRANSCEIVER_INSTRUCTIONS,
    shouldQueue: false,
    fee: 10n ** 15n,
    value: 12n * 10n ** 14n,
    outboundCapacity: amount * 10n,
    inboundCapacity: amount * 10n,
    ...over,
  }
}

function guardInput(over: Partial<NttGuardInput> = {}): NttGuardInput {
  const plan = planFixture()
  return {
    walletAddress: WALLET,
    walletChainId: 1,
    srcChainId: 1,
    verification: verifiedFixture(),
    plan,
    recipientIsCustom: false,
    customRecipientConfirmed: false,
    tokenBalance: plan.amount * 2n,
    nativeBalance: 10n ** 18n,
    allowance: plan.amount,
    gasCostWei: 10n ** 14n,
    simulation: { ok: true },
    selfCheck: { ok: true },
    ...over,
  }
}

describe('NTT guards', () => {
  it('lets a fully checked transfer through', () => {
    expect(runNttGuards(guardInput()).canSend).toBe(true)
  })

  it('blocks everything while the manager is unverified', () => {
    const r = runNttGuards(guardInput({ verification: { ok: false, code: 'manager_unverified' as never } }))
    expect(r.canSend).toBe(false)
    expect(r.results.find((x) => x.id === 2)).toMatchObject({ ok: false, code: 'manager_unverified' })
  })

  it('never lets the approve name anything but the verified manager', () => {
    const wrong = runNttGuards(guardInput({ allowance: 0n, approveIntent: { token: TOKEN, spender: WALLET, amount: planFixture().amount } }))
    expect(wrong.results.find((x) => x.id === 10)).toMatchObject({ ok: false, code: 'approve_wrong_spender' })

    const wrongAmount = runNttGuards(guardInput({ allowance: 0n, approveIntent: { token: TOKEN, spender: MANAGER, amount: 1n } }))
    expect(wrongAmount.results.find((x) => x.id === 10)).toMatchObject({ ok: false, code: 'approve_amount_mismatch' })
  })

  it('builds an approve for exactly the amount, to exactly the manager', () => {
    expect(nttApprovePlan(verifiedFixture(), planFixture(), 0n)).toEqual({ token: TOKEN, spender: MANAGER, amount: planFixture().amount })
    // already approved
    expect(nttApprovePlan(verifiedFixture(), planFixture(), planFixture().amount)).toBeNull()
  })

  it('blocks on either rate limit, and on an unknown one', () => {
    const plan = planFixture()
    expect(runNttGuards(guardInput({ plan: planFixture({ outboundCapacity: plan.amount - 1n }) })).results.find((x) => x.id === 6)).toMatchObject({ code: 'over_outbound_capacity' })
    expect(runNttGuards(guardInput({ plan: planFixture({ inboundCapacity: 1n }) })).results.find((x) => x.id === 6)).toMatchObject({ code: 'over_inbound_capacity' })
    expect(runNttGuards(guardInput({ plan: planFixture({ inboundCapacity: undefined }) })).results.find((x) => x.id === 6)).toMatchObject({ code: 'inbound_capacity_unknown' })
  })

  it('refuses a queued transfer', () => {
    const r = runNttGuards(guardInput({ plan: planFixture({ shouldQueue: true }) }))
    expect(r.results.find((x) => x.id === 11)).toMatchObject({ ok: false, code: 'queueing_enabled' })
  })

  it('refuses an amount that still carries dust', () => {
    const plan = planFixture()
    const r = runNttGuards(guardInput({ plan: planFixture({ amount: plan.amount + 1n }) }))
    expect(r.results.find((x) => x.id === 5)).toMatchObject({ ok: false, code: 'amount_has_dust' })
  })

  it('needs an explicit confirmation for a recipient other than the wallet', () => {
    const other = pad(DST_TOKEN.toLowerCase() as Address, { size: 32 })
    expect(runNttGuards(guardInput({ plan: planFixture({ recipient: other }) })).results.find((x) => x.id === 3)).toMatchObject({ code: 'recipient_unconfirmed' })
    expect(runNttGuards(guardInput({ plan: planFixture({ recipient: other }), recipientIsCustom: true, customRecipientConfirmed: true })).results.find((x) => x.id === 3)?.ok).toBe(true)
  })

  it('refuses a recipient that is one of the contracts in play', () => {
    const r = runNttGuards(guardInput({ plan: planFixture({ recipient: pad(MANAGER.toLowerCase() as Address, { size: 32 }) }), recipientIsCustom: true, customRecipientConfirmed: true }))
    expect(r.results.find((x) => x.id === 4)).toMatchObject({ ok: false, code: 'recipient_is_contract' })
  })
})

// ------------------------------------------------------------- self-check ----

describe('NTT recipient is never a contract in play (guard 4)', () => {
  const asRecipient = (a: Address) => ({ plan: planFixture({ recipient: pad(a.toLowerCase() as Address, { size: 32 }) }), recipientIsCustom: true, customRecipientConfirmed: true })

  it('refuses each of the four contracts on both sides', () => {
    for (const c of [TOKEN, MANAGER, DST_MANAGER, DST_TOKEN]) {
      expect(runNttGuards(guardInput(asRecipient(c))).results.find((x) => x.id === 4)).toMatchObject({ ok: false, code: 'recipient_is_contract' })
    }
  })

  it('still allows an ordinary address', () => {
    expect(runNttGuards(guardInput(asRecipient(WALLET))).results.find((x) => x.id === 4)?.ok).toBe(true)
  })
})

describe('the gate, asked twice (RPC quorum)', () => {
  const SECOND_TRANSCEIVER = getAddress('0xabcdef0000000000000000000000000000000009')

  const quorum = (src: Answers, dst: Answers, second?: { src: Answers; dst: Answers }) =>
    verifyNttManagerQuorum(
      { srcChain: 'ethereum', dstChain: 'bsc', manager: MANAGER, srcClient: mockClient(src), dstClient: mockClient(dst), tokenList: listWithBoth },
      second ? { srcClient: mockClient(second.src), dstClient: mockClient(second.dst) } : undefined,
    )

  it('passes unflagged when the registry has no second provider to ask', async () => {
    const r = await quorum(srcAnswers(), dstAnswers())
    expect(r.ok).toBe(true)
    expect(r.crossChecked).toBe(false)
  })

  it('marks the verdict cross-checked when two providers agree', async () => {
    const r = await quorum(srcAnswers(), dstAnswers(), { src: srcAnswers(), dst: dstAnswers() })
    expect(r.ok).toBe(true)
    expect(r.crossChecked).toBe(true)
  })

  it('does NOT block when the second provider is simply down — an outage only drops the flag', async () => {
    // Every read throws, which is exactly what a throttled endpoint looks like: 'unverifiable'.
    const r = await quorum(srcAnswers(), dstAnswers(), { src: {}, dst: {} })
    expect(r.ok).toBe(true)
    expect(r.crossChecked).toBe(false)
  })

  it('blocks when the second provider names a different contract', async () => {
    const second = srcAnswers({
      [`${MANAGER.toLowerCase()}.getTransceivers`]: [SECOND_TRANSCEIVER],
      [`${SECOND_TRANSCEIVER.toLowerCase()}.getTransceiverType`]: 'wormhole',
      [`${SECOND_TRANSCEIVER.toLowerCase()}.wormhole`]: ETH_CORE,
      [`${SECOND_TRANSCEIVER.toLowerCase()}.isWormholeRelayingEnabled`]: true,
      [`${SECOND_TRANSCEIVER.toLowerCase()}.isSpecialRelayingEnabled`]: false,
    })
    const r = await quorum(srcAnswers(), dstAnswers(), { src: second, dst: dstAnswers() })
    expect(r).toMatchObject({ ok: false, code: 'unverifiable' })
    expect(r.crossChecked).toBe(true)
  })

  it('blocks when the two providers name different tokens — that is a fact, not a reason', async () => {
    const second = srcAnswers({ [`${MANAGER.toLowerCase()}.token`]: DST_TOKEN })
    const r = await quorum(srcAnswers(), dstAnswers(), { src: second, dst: dstAnswers() })
    expect(r).toMatchObject({ ok: false, code: 'unverifiable' })
    expect(r.crossChecked).toBe(true)
  })

  it('a disagreement about the ANCHOR lowers the verdict instead of refusing it', async () => {
    // One provider can read the token's minter and the other cannot — a flake, not a finding.
    // The facts still match, so the route stands; it simply loses what vouched for it.
    const blind = srcAnswers({ [`${TOKEN.toLowerCase()}.minter`]: new Error('rpc hiccup'), [`${TOKEN.toLowerCase()}.MINTER_ROLE`]: new Error('none') })
    const r = await quorum(srcAnswers(), dstAnswers(), { src: blind, dst: dstAnswers() })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.verified.anchor).toBeNull()
      expect(r.verified.manager).toBe(MANAGER)
    }
    expect(r.crossChecked).toBe(true)
  })

  it('never turns the primary’s rejection into a pass', async () => {
    const rejected = srcAnswers({ [`${TOKEN.toLowerCase()}.minter`]: WALLET, [`${TOKEN.toLowerCase()}.MINTER_ROLE`]: new Error('none') })
    const r = await quorum(rejected, dstAnswers({ [`${DST_TOKEN.toLowerCase()}.minter`]: WALLET, [`${DST_TOKEN.toLowerCase()}.MINTER_ROLE`]: new Error('none') }), {
      src: srcAnswers(),
      dst: dstAnswers(),
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()
  })
})

describe('NTT fee ceiling (guard 14)', () => {
  // Ethereum's ceiling is 0.1 ETH; the fixture pays 0.0012, and the wallet holds 1.
  const high = { fee: 4n * 10n ** 17n, value: 5n * 10n ** 17n }

  it('passes silently while the fee is ordinary', () => {
    const r = runNttGuards(guardInput())
    expect(r.results.find((x) => x.id === 14)?.ok).toBe(true)
  })

  it('notes a fee above the chain ceiling for the indicator, and holds nothing', () => {
    const r = runNttGuards(guardInput({ plan: planFixture(high) }))
    expect(r.results.find((x) => x.id === 14)).toMatchObject({ ok: false, code: 'fee_above_ceiling' })
    expect(r.notes.some((n) => !n.ok && n.code === 'fee_above_ceiling')).toBe(true)
    expect(r.canSend).toBe(true)
  })

  it('still notes a fee the balance could cover — the ceiling is not the balance', () => {
    // Guard 8 allows this: 0.5 + gas < 1 ETH. Guard 14 is the only thing that speaks, and it speaks.
    const r = runNttGuards(guardInput({ plan: planFixture(high) }))
    expect(r.results.find((x) => x.id === 8)?.ok).toBe(true)
    expect(r.results.find((x) => x.id === 14)?.ok).toBe(false)
  })
})

describe('NTT self-check', () => {
  const calldataFor = (args: ReturnType<typeof assembleNttTransferArgs>) =>
    encodeFunctionData({ abi: nttManagerAbi, functionName: 'transfer', args: [args[0], args[1], args[2], args[3], args[4], args[5]] })

  it('accepts the calldata built from the plan', () => {
    const plan = planFixture()
    expect(nttSelfCheck(plan, calldataFor(assembleNttTransferArgs(plan)))).toEqual({ ok: true })
  })

  it('catches a flipped shouldQueue — the field that would silently park the money', () => {
    const plan = planFixture()
    const args = assembleNttTransferArgs(plan)
    const tampered = calldataFor([args[0], args[1], args[2], args[3], true, args[5]] as const)
    expect(nttSelfCheck(plan, tampered)).toMatchObject({ ok: false, mismatches: ['shouldQueue must be false'] })
  })

  it('catches a swapped recipient and a changed amount', () => {
    const plan = planFixture()
    const args = assembleNttTransferArgs(plan)
    const other = pad(DST_TOKEN.toLowerCase() as Address, { size: 32 })
    expect(nttSelfCheck(plan, calldataFor([args[0], args[1], other, args[3], args[4], args[5]] as const))).toMatchObject({ mismatches: ['recipient'] })
    expect(nttSelfCheck(plan, calldataFor([args[0] + 1n, args[1], args[2], args[3], args[4], args[5]] as const))).toMatchObject({ mismatches: ['amount'] })
  })

  it('refuses calldata that is not a transfer at all', () => {
    expect(nttSelfCheck(planFixture(), '0xdeadbeef')).toMatchObject({ ok: false })
  })

  it('the instructions are the documented "zero instructions" byte', () => {
    expect(NO_TRANSCEIVER_INSTRUCTIONS).toBe('0x00')
  })
})

// ---------------------------------------------------------------- tracking ----

describe('NTT tracking', () => {
  it('links to the explorer route the explorer itself declares', () => {
    const hash = `0x${'ab'.repeat(32)}`
    expect(wormholescanTxUrl(hash)).toBe(`https://wormholescan.io/#/tx/${hash}`)
    expect(() => wormholescanTxUrl('nonsense')).toThrow()
  })

  it('reads a delivered operation, and treats an empty answer as "no data"', () => {
    expect(parseNttOperations({ operations: [] })).toEqual({ phase: 'no_data' })
    expect(parseNttOperations(null)).toEqual({ phase: 'no_data' })
    const state = parseNttOperations({
      operations: [
        {
          id: '2/000/3479',
          sourceChain: { transaction: { txHash: '0xaaa' } },
          targetChain: { transaction: { txHash: '0xbbb' } },
          content: { payload: { transceiverMessage: { sourceNttManager: '0xsrc', recipientNttManager: '0xdst' } } },
        },
      ],
    })
    expect(state).toMatchObject({ phase: 'delivered', sourceTxHash: '0xaaa', destinationTxHash: '0xbbb', sourceNttManager: '0xsrc' })
    expect(parseNttOperations({ operations: [{ sourceChain: { transaction: { txHash: '0xaaa' } } }] }).phase).toBe('pending')
  })
})

// ------------------------------------------------- the anchor rule (regression) ----

/**
 * The hole this block exists for.
 *
 * The gate used to accept a token-side anchor from EITHER side of the pair. The only route to the
 * destination is `manager.getPeer()` — the manager's own claim — so an attacker supplied both
 * halves: a fake manager naming real USDC, peered to a fake manager on the far side naming a token
 * the attacker also wrote, which duly named it back. Everything else passed, because a contract
 * returns the real core bridge address as easily as any other.
 *
 * CLAUDE.md rule 2 in four tests: only the source token, or the committed list, may say yes.
 */
describe('the anchor rule: only a fact the attacker cannot write about himself', () => {
  /** The real token the victim holds. It never vouches for the fake manager, because it cannot. */
  const REAL_TOKEN = getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')

  /** Exactly the attack from the security report. */
  const attackerSrc = (): Answers => ({
    // The fake manager names a real, valuable token...
    [`${MANAGER.toLowerCase()}.token`]: REAL_TOKEN,
    [`${MANAGER.toLowerCase()}.chainId`]: ETH_WH,
    [`${MANAGER.toLowerCase()}.getMode`]: 1,
    [`${MANAGER.toLowerCase()}.tokenDecimals`]: 6,
    [`${MANAGER.toLowerCase()}.getPeer`]: { peerAddress: pad(DST_MANAGER.toLowerCase() as Address, { size: 32 }), tokenDecimals: 6 },
    [`${MANAGER.toLowerCase()}.getTransceivers`]: [TRANSCEIVER],
    // ...and a contract can return the official core bridge address as easily as any other.
    [`${TRANSCEIVER.toLowerCase()}.getTransceiverType`]: 'wormhole',
    [`${TRANSCEIVER.toLowerCase()}.wormhole`]: ETH_CORE,
    [`${TRANSCEIVER.toLowerCase()}.isWormholeRelayingEnabled`]: true,
    [`${TRANSCEIVER.toLowerCase()}.isSpecialRelayingEnabled`]: false,
    // The real token grants the fake manager nothing. This is the one answer he cannot forge.
    [`${REAL_TOKEN.toLowerCase()}.minter`]: new Error('not a minter'),
    [`${REAL_TOKEN.toLowerCase()}.MINTER_ROLE`]: MINTER_ROLE,
    [`${REAL_TOKEN.toLowerCase()}.hasRole`]: false,
  })

  /** The far side, entirely the attacker's: his token names his manager back. */
  const attackerDst = (): Answers => ({
    [`${DST_MANAGER.toLowerCase()}.getPeer`]: { peerAddress: pad(MANAGER.toLowerCase() as Address, { size: 32 }), tokenDecimals: 6 },
    [`${DST_MANAGER.toLowerCase()}.token`]: DST_TOKEN,
    [`${DST_TOKEN.toLowerCase()}.minter`]: DST_MANAGER,
  })

  it('1. the reported attack is refused: peers match, the far token vouches, the real token does not', async () => {
    const r = await verifyNttManager({
      srcChain: 'ethereum',
      dstChain: 'bsc',
      manager: MANAGER,
      srcClient: mockClient(attackerSrc()),
      dstClient: mockClient(attackerDst()),
      tokenList: [],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()
    // And it must not become a pass just because the far side is consistent with itself.
    if (!r.ok) expect(r.code).not.toBe('unverifiable')
  })

  it('1b. claiming to be a locking hub does not rescue it — the mode is his claim too', async () => {
    const r = await verifyNttManager({
      srcChain: 'ethereum',
      dstChain: 'bsc',
      manager: MANAGER,
      srcClient: mockClient({ ...attackerSrc(), [`${MANAGER.toLowerCase()}.getMode`]: 0 }),
      dstClient: mockClient(attackerDst()),
      tokenList: [],
    })
    // Claiming `locking` changes nothing: the mode was never the reason. The missing anchor comes
    // back as `anchor: null`, which guard 2b turns into a loud warning.
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()
  })

  it('2. a burning manager the source token names is accepted', async () => {
    const r = await verify(srcAnswers(), dstAnswers())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.verified.anchor).toEqual({ side: 'source', kind: 'minter' })
      expect(r.verified.mode).toBe('burning')
    }
  })

  it('2b. MINTER_ROLE on the source token counts as the same anchor', async () => {
    const r = await verify(
      srcAnswers({
        [`${TOKEN.toLowerCase()}.minter`]: new Error('no minter()'),
        [`${TOKEN.toLowerCase()}.MINTER_ROLE`]: MINTER_ROLE,
        [`${TOKEN.toLowerCase()}.hasRole`]: true,
      }),
      dstAnswers(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toEqual({ side: 'source', kind: 'role' })
  })

  /** A destination whose peer points back at `m`, so tests can verify a manager other than MANAGER. */
  const dstPeeringBackAt = (m: Address): Answers => ({
    [`${DST_MANAGER.toLowerCase()}.getPeer`]: { peerAddress: pad(m.toLowerCase() as Address, { size: 32 }), tokenDecimals: 18 },
    [`${DST_MANAGER.toLowerCase()}.token`]: DST_TOKEN,
  })

  it('3. a locking hub verifies with no anchor: nothing on the source chain can vouch for it, and no list does either', async () => {
    const m = getAddress('0xdddddddd0000000000000000000000000000000d')
    const r = await verifyNttManager({
      srcChain: 'ethereum',
      dstChain: 'bsc',
      manager: m,
      srcClient: mockClient({
        [`${m.toLowerCase()}.token`]: REAL_TOKEN,
        [`${m.toLowerCase()}.chainId`]: ETH_WH,
        [`${m.toLowerCase()}.getMode`]: 0, // locking: nothing mints, so no token anchor exists
        [`${m.toLowerCase()}.tokenDecimals`]: 6,
        [`${m.toLowerCase()}.getPeer`]: { peerAddress: pad(DST_MANAGER.toLowerCase() as Address, { size: 32 }), tokenDecimals: 6 },
        [`${m.toLowerCase()}.getTransceivers`]: [TRANSCEIVER],
        [`${TRANSCEIVER.toLowerCase()}.getTransceiverType`]: 'wormhole',
        [`${TRANSCEIVER.toLowerCase()}.wormhole`]: ETH_CORE,
        [`${TRANSCEIVER.toLowerCase()}.isWormholeRelayingEnabled`]: true,
        [`${TRANSCEIVER.toLowerCase()}.isSpecialRelayingEnabled`]: false,
        [`${REAL_TOKEN.toLowerCase()}.minter`]: new Error('locking hub: nothing mints'),
        [`${REAL_TOKEN.toLowerCase()}.MINTER_ROLE`]: new Error('no role'),
      }),
      dstClient: mockClient(dstPeeringBackAt(m)),
      tokenList: [],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()
    // `getMode()` saying "locking" is the manager's own claim and changes nothing.
  })

  it('4. a locking manager with a destination-side anchor only is still unvouched for', async () => {
    const r = await verify(
      srcAnswers({ [`${MANAGER.toLowerCase()}.getMode`]: 0, [`${TOKEN.toLowerCase()}.minter`]: new Error('no minter') }),
      dstAnswers({ [`${DST_TOKEN.toLowerCase()}.minter`]: DST_MANAGER }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.verified.anchor).toBeNull()
  })

  it('the far-side anchor is still reported, but only as context', async () => {
    const r = await verify(srcAnswers(), dstAnswers({ [`${DST_TOKEN.toLowerCase()}.minter`]: DST_MANAGER }))
    expect(r.ok).toBe(true)
    // It is recorded...
    if (r.ok) expect(r.verified.alsoOnDestination).toBe(true)
    // ...and it is never the reason.
    if (r.ok) expect(r.verified.anchor?.side).toBe('source')
  })
})
