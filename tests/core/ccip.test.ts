/**
 * Chainlink CCIP: the message, the decimal shift, the guards and the self-check.
 *
 * The test that matters most is the spender one: the router comes from the config and from nowhere
 * else, so a plan carrying some other router cannot turn into an approve.
 */
import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, getAddress, type Abi, type Address } from 'viem'
import { ccipRouterAbi, EVM_EXTRA_ARGS_V2_TAG } from '@/protocols/ccip/abi'
import { CCIP_CHAINS, ccipConfig, ccipSelector, chainOfCcipSelector, isCcipRouter } from '@/protocols/ccip/chains'
import { ccipApprovePlan, runCcipGuards, type CcipGuardInput } from '@/protocols/ccip/guards'
import {
  assembleCcipSendArgs,
  buildCcipMessage,
  encodeExtraArgsV2,
  scaleAmount,
  type CcipPlan,
} from '@/protocols/ccip/plan'
import { ccipSelfCheck, encodeCcipSend } from '@/protocols/ccip/preview'
import { ccipMessageUrl } from '@/protocols/ccip/track'

const ETH = ccipConfig('ethereum')!
const BASE = ccipConfig('base')!
const ROUTER = getAddress(ETH.router)
const TOKEN = getAddress('0x1111111111111111111111111111111111111111')
const POOL = getAddress('0x2222222222222222222222222222222222222222')
const DST_POOL = getAddress('0x3333333333333333333333333333333333333333')
const WALLET = getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9')
const OTHER = getAddress('0x4444444444444444444444444444444444444444')

// ------------------------------------------------------------------ config ----

describe('CCIP configuration', () => {
  it('covers every EVM chain we support, with a router and a registry', () => {
    for (const [key, cfg] of Object.entries(CCIP_CHAINS)) {
      expect(cfg, key).toBeDefined()
      expect(cfg!.router, key).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(cfg!.tokenAdminRegistry, key).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(cfg!.selector, key).toBeGreaterThan(0n)
    }
  })

  it('selectors round-trip to chains and are unique', () => {
    const seen = new Set<bigint>()
    for (const [key, cfg] of Object.entries(CCIP_CHAINS)) {
      expect(seen.has(cfg!.selector)).toBe(false)
      seen.add(cfg!.selector)
      expect(chainOfCcipSelector(cfg!.selector)).toBe(key)
    }
    expect(ccipSelector('ethereum')).toBe(5009297550715157269n)
    expect(chainOfCcipSelector(1n)).toBeUndefined()
  })

  it('recognises the official router, and only it', () => {
    expect(isCcipRouter('ethereum', ETH.router)).toBe(true)
    expect(isCcipRouter('ethereum', ETH.router.toLowerCase())).toBe(true)
    expect(isCcipRouter('base', ETH.router)).toBe(false) // right router, wrong chain
    expect(isCcipRouter('ethereum', OTHER)).toBe(false)
  })
})

// ----------------------------------------------------------------- message ----

describe('the message', () => {
  it('is a plain token transfer to an address', () => {
    const m = buildCcipMessage({ recipient: WALLET, token: TOKEN, amount: 5n })
    expect(m.data).toBe('0x')
    expect(m.tokenAmounts).toEqual([{ token: TOKEN, amount: 5n }])
    expect(m.feeToken).toBe(`0x${'0'.repeat(40)}`)
    // receiver is the address, abi-encoded, so a non-EVM destination could carry its own format.
    expect(m.receiver).toBe(encodeAbiParameters([{ type: 'address' }], [WALLET]))
  })

  it('carries the documented extraArgs for an EOA: V2, gasLimit 0, out-of-order allowed', () => {
    const m = buildCcipMessage({ recipient: WALLET, token: TOKEN, amount: 5n })
    expect(m.extraArgs.startsWith(EVM_EXTRA_ARGS_V2_TAG)).toBe(true)
    expect(m.extraArgs).toBe(encodeExtraArgsV2(0n, true))
    // tag + two words
    expect(m.extraArgs).toHaveLength(2 + 8 + 128)
  })

  it('the tag is keccak("CCIP EVMExtraArgsV2"), not a copied constant', async () => {
    const { keccak_256 } = await import('@noble/hashes/sha3')
    const hex = `0x${Buffer.from(keccak_256(new TextEncoder().encode('CCIP EVMExtraArgsV2'))).toString('hex').slice(0, 8)}`
    expect(EVM_EXTRA_ARGS_V2_TAG).toBe(hex)
  })
})

describe('the decimal shift', () => {
  it('scales exactly, in both directions', () => {
    expect(scaleAmount(10n ** 18n, 18, 6)).toBe(1_000000n)
    expect(scaleAmount(1_000000n, 6, 18)).toBe(10n ** 18n)
    expect(scaleAmount(12345n, 8, 8)).toBe(12345n)
  })

  it('can round a small amount away entirely — which the guards then catch', () => {
    expect(scaleAmount(999n, 18, 6)).toBe(0n)
  })
})

// ------------------------------------------------------------------- plans ----

function planFixture(over: Partial<CcipPlan> = {}): CcipPlan {
  const amount = 10n ** 18n
  return {
    protocol: 'ccip',
    chain: 'ethereum',
    router: ROUTER,
    token: TOKEN,
    tokenSymbol: 'TKN',
    decimals: 18,
    pool: POOL,
    sender: WALLET,
    amount,
    received: amount,
    dst: { chain: 'base', selector: BASE.selector, token: TOKEN, decimals: 18, pool: DST_POOL },
    recipient: WALLET,
    message: buildCcipMessage({ recipient: WALLET, token: TOKEN, amount }),
    fee: 10n ** 15n,
    value: 10n ** 15n,
    outbound: { tokens: amount * 10n, capacity: amount * 100n, isEnabled: true },
    inbound: { tokens: amount * 10n, capacity: amount * 100n, isEnabled: true },
    ...over,
  }
}

function guardInput(over: Partial<CcipGuardInput> = {}): CcipGuardInput {
  const plan = planFixture()
  return {
    walletAddress: WALLET,
    walletChainId: 1,
    srcChainId: 1,
    srcChain: 'ethereum',
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

describe('CCIP guards', () => {
  it('lets a fully checked transfer through', () => {
    expect(runCcipGuards(guardInput()).canSend).toBe(true)
  })

  it('the approve spender is the configured router and nothing else', () => {
    // A plan that claims a different router does not get an approve for it.
    const wrongRouterPlan = planFixture({ router: OTHER })
    expect(runCcipGuards(guardInput({ plan: wrongRouterPlan })).results.find((r) => r.id === 2)).toMatchObject({
      ok: false,
      code: 'route_unsupported',
    })

    // And the intent itself is checked against the config, not against the plan.
    const bad = runCcipGuards(guardInput({ allowance: 0n, approveIntent: { token: TOKEN, spender: OTHER, amount: planFixture().amount } }))
    expect(bad.results.find((r) => r.id === 10)).toMatchObject({ ok: false, code: 'approve_wrong_spender' })
  })

  it('builds the approve from the config, ignoring whatever the plan says', () => {
    const intent = ccipApprovePlan('ethereum', planFixture({ router: OTHER }), 0n)
    expect(intent).toEqual({ token: TOKEN, spender: ETH.router, amount: planFixture().amount })
    expect(ccipApprovePlan('ethereum', planFixture(), planFixture().amount)).toBeNull()
  })

  it('msg.value must equal the fee exactly, because the router keeps the excess', () => {
    const over = runCcipGuards(guardInput({ plan: planFixture({ value: 2n * 10n ** 15n }) }))
    expect(over.results.find((r) => r.id === 7)).toMatchObject({ ok: false, code: 'fee_mismatch' })
  })

  it('blocks on either rate limit, and when one cannot be read', () => {
    const plan = planFixture()
    expect(runCcipGuards(guardInput({ plan: planFixture({ outbound: { tokens: 1n, capacity: 10n, isEnabled: true } }) })).results.find((r) => r.id === 6)).toMatchObject({ code: 'over_outbound_capacity' })
    expect(runCcipGuards(guardInput({ plan: planFixture({ inbound: { tokens: 1n, capacity: 10n, isEnabled: true } }) })).results.find((r) => r.id === 6)).toMatchObject({ code: 'over_inbound_capacity' })
    expect(runCcipGuards(guardInput({ plan: planFixture({ outbound: undefined }) })).results.find((r) => r.id === 6)).toMatchObject({ code: 'outbound_limit_unknown' })
    expect(runCcipGuards(guardInput({ plan: planFixture({ inbound: undefined }) })).results.find((r) => r.id === 6)).toMatchObject({ code: 'inbound_limit_unknown' })
    // A disabled bucket is not a limit at all.
    expect(runCcipGuards(guardInput({ plan: planFixture({ outbound: { tokens: 0n, capacity: 0n, isEnabled: false } }) })).results.find((r) => r.id === 6)?.ok).toBe(true)
    void plan
  })

  it('the inbound limit is compared in the destination token’s own units', () => {
    // 18 decimals here, 6 there: one token arrives as 1e6, which fits a bucket of 2e6.
    const plan = planFixture({
      dst: { chain: 'base', selector: BASE.selector, token: TOKEN, decimals: 6, pool: DST_POOL },
      inbound: { tokens: 2_000000n, capacity: 10_000000n, isEnabled: true },
      received: 1_000000n,
    })
    expect(runCcipGuards(guardInput({ plan })).results.find((r) => r.id === 6)?.ok).toBe(true)
    // …but not a bucket of 0.5e6.
    const tight = planFixture({
      dst: { chain: 'base', selector: BASE.selector, token: TOKEN, decimals: 6, pool: DST_POOL },
      inbound: { tokens: 500000n, capacity: 10_000000n, isEnabled: true },
      received: 1_000000n,
    })
    expect(runCcipGuards(guardInput({ plan: tight })).results.find((r) => r.id === 6)).toMatchObject({ code: 'over_inbound_capacity' })
  })

  it('refuses an amount that would arrive as nothing', () => {
    const plan = planFixture({
      amount: 999n,
      decimals: 18,
      dst: { chain: 'base', selector: BASE.selector, token: TOKEN, decimals: 6, pool: DST_POOL },
      received: 0n,
    })
    expect(runCcipGuards(guardInput({ plan })).results.find((r) => r.id === 5)).toMatchObject({ ok: false, code: 'amount_rounds_to_zero' })
  })

  it('refuses a message that is not a plain transfer', () => {
    const withData = planFixture()
    const tampered = planFixture({ message: { ...withData.message, data: '0xdeadbeef' } })
    expect(runCcipGuards(guardInput({ plan: tampered })).results.find((r) => r.id === 11)).toMatchObject({ ok: false, code: 'message_not_plain' })
  })

  it('needs a confirmation for a recipient other than the wallet, and refuses the contracts', () => {
    expect(runCcipGuards(guardInput({ plan: planFixture({ recipient: OTHER }) })).results.find((r) => r.id === 3)).toMatchObject({ code: 'recipient_unconfirmed' })
    const toRouter = planFixture({ recipient: ROUTER })
    expect(runCcipGuards(guardInput({ plan: toRouter, recipientIsCustom: true, customRecipientConfirmed: true })).results.find((r) => r.id === 4)).toMatchObject({ code: 'recipient_is_contract' })
  })
})

// -------------------------------------------------------------- self-check ----

describe('CCIP self-check', () => {
  it('accepts the calldata built from the plan', () => {
    const plan = planFixture()
    expect(ccipSelfCheck(plan, encodeCcipSend(plan))).toEqual({ ok: true })
  })

  it('catches a payload smuggled into an otherwise plain transfer', () => {
    const plan = planFixture()
    const [selector, message] = assembleCcipSendArgs(plan)
    const tampered = encodeFunctionData({
      abi: ccipRouterAbi as Abi,
      functionName: 'ccipSend',
      args: [selector, { ...message, data: '0xdeadbeef' }],
    })
    expect(ccipSelfCheck(plan, tampered)).toMatchObject({ ok: false, mismatches: ['data must be empty'] })
  })

  it('catches a swapped recipient, token, amount and destination', () => {
    const plan = planFixture()
    const [selector, message] = assembleCcipSendArgs(plan)
    const enc = (sel: bigint, m: typeof message) => encodeFunctionData({ abi: ccipRouterAbi as Abi, functionName: 'ccipSend', args: [sel, m] })

    const otherReceiver = { ...message, receiver: encodeAbiParameters([{ type: 'address' }], [OTHER]) }
    expect(ccipSelfCheck(plan, enc(selector, otherReceiver)).ok).toBe(false)

    const otherToken = { ...message, tokenAmounts: [{ token: OTHER as Address, amount: plan.amount }] }
    expect(ccipSelfCheck(plan, enc(selector, otherToken))).toMatchObject({ mismatches: ['token'] })

    const otherAmount = { ...message, tokenAmounts: [{ token: plan.token, amount: plan.amount + 1n }] }
    expect(ccipSelfCheck(plan, enc(selector, otherAmount))).toMatchObject({ mismatches: ['amount'] })

    expect(ccipSelfCheck(plan, enc(ETH.selector, message))).toMatchObject({ mismatches: ['destChainSelector'] })
  })

  it('refuses calldata that is not a ccipSend at all', () => {
    expect(ccipSelfCheck(planFixture(), '0xdeadbeef')).toMatchObject({ ok: false })
  })
})

describe('CCIP tracking', () => {
  it('links to the route the explorer itself declares', () => {
    const id = `0x${'cd'.repeat(32)}`
    expect(ccipMessageUrl(id)).toBe(`https://ccip.chain.link/msg/${id}`)
    expect(() => ccipMessageUrl('nope')).toThrow()
  })
})
