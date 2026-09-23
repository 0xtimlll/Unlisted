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
import { verifyNttManager, type NttVerification } from '@/protocols/wormhole-ntt/verify'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'
import type { ReadClient } from '@/core/client'

const MANAGER = getAddress('0x7926d63feb9b950908b297cc995b6853bca21847')
const DST_MANAGER = getAddress('0xbc51f76178a56811fdfe95d3897e6ac2b11dbb62')
const TOKEN = getAddress('0x88909d489678dd17aa6d9609f89b0419bf78fd9a')
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

  it('confirms a locking hub through the anchor on the burning side', async () => {
    const r = await verify(
      // The hub locks; its token has no minter at all.
      srcAnswers({ [`${MANAGER.toLowerCase()}.getMode`]: 0, [`${TOKEN.toLowerCase()}.minter`]: new Error('no minter') }),
      dstAnswers({ [`${DST_TOKEN.toLowerCase()}.minter`]: DST_MANAGER }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.verified.mode).toBe('locking')
      expect(r.verified.anchor).toEqual({ side: 'destination', kind: 'minter' })
    }
  })

  it('refuses a token that is not in the official list', async () => {
    const r = await verify(srcAnswers({ [`${MANAGER.toLowerCase()}.token`]: DST_TOKEN }), dstAnswers())
    expect(r).toMatchObject({ ok: false, code: 'token_not_listed' })
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

  it('REFUSES a fake manager with the right token(), its own matching peers, and a real-looking history', async () => {
    // Everything a fake can control is correct here: it reports the real token, its own peer on the
    // other side points back at it, it has a Wormhole transceiver on the real core bridge, and it
    // could easily have one self-made transfer indexed by Wormholescan. The one thing it cannot
    // forge is the token naming it — so it is refused, and no approve is ever offered.
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
    expect(r).toMatchObject({ ok: false, code: 'no_token_anchor' })
    // …and with no verification there is no approve to give.
    expect(nttApprovePlan(r, planFixture(), 0n)).toBeNull()
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
    mode: 'burning',
    tokenDecimals: 18,
    dst: { chain: 'bsc', wormholeChainId: BSC_WH, manager: DST_MANAGER, tokenDecimals: 18 },
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
    dst: { chain: 'bsc', wormholeChainId: BSC_WH, manager: DST_MANAGER, tokenDecimals: 18 },
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
    const r = runNttGuards(guardInput({ verification: { ok: false, code: 'no_token_anchor' } }))
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
