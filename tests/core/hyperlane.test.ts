/**
 * Hyperlane: the Mailbox table, the message layout, the three route shapes, the plan's charge and
 * scale, the guards and the self-check.
 *
 * The test that matters most is the spender one: an approve exists only on a collateral route, it
 * names the router the discovery verified against the registry Mailbox, and it is for the CHARGE —
 * the amount plus the route's own fee — because that is what the router pulls.
 */
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, getAddress, keccak256, pad, toFunctionSelector, type Abi, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { noteLevel } from '@/core/indicator'
import { evmRecipient } from '@/core/recipient'
import { isBlockingCode, isNoteCode, isPendingCode } from '@/core/severity'
import { reverseHyperlane } from '@/core/reverse'
import { linkTarget } from '@/core/link'
import {
  bytes32ToEvmAddress,
  evmAddressToBytes32,
  HYPERLANE_TOPICS,
  MESSAGE_HEADER_BYTES,
  parseHyperlaneMessage,
  parseTokenMessage,
  warpRouteAbi,
} from '@/protocols/hyperlane/abi'
import { chainOfHyperlaneDomain, HYPERLANE_CHAINS, hyperlaneConfig, hyperlaneDomain, isHyperlaneMailbox } from '@/protocols/hyperlane/chains'
import { discoverWarpRoute, discoverWarpRouteQuorum, readRemoteWarp, UNSCALED, warpStandingOk, type RemoteWarp } from '@/protocols/hyperlane/discover'
import { hyperlaneApprovePlan, runHyperlaneGuards } from '@/protocols/hyperlane/guards'
import { assembleTransferRemoteArgs, buildHyperlanePlan, HyperlanePlanError, routeFeeBps, scaleIn, scaleOut } from '@/protocols/hyperlane/plan'
import { encodeTransferRemote, hyperlaneSelfCheck, TRANSFER_REMOTE_SELECTOR } from '@/protocols/hyperlane/preview'
import { hyperlaneMessageUrl, hyperlaneTxUrl } from '@/protocols/hyperlane/track'
import { nativeWarpRouteHints, warpRouteHints } from '@/protocols/hyperlane/warpRoutes'
import { HL, hyperlaneInput, hyperlaneMessageBytes, hyperlanePlan, remoteWarp, warpRouter } from './hyperlaneFixtures'

// ------------------------------------------------------------------ config ----

describe('Hyperlane configuration', () => {
  it('covers every EVM chain we support, with a mailbox and a domain', () => {
    for (const [key, cfg] of Object.entries(HYPERLANE_CHAINS)) {
      expect(cfg, key).toBeDefined()
      expect(cfg!.mailbox, key).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(cfg!.domain, key).toBeGreaterThan(0)
      expect(cfg!.registryName, key).toMatch(/^[a-z]+$/)
    }
    expect(Object.keys(HYPERLANE_CHAINS)).toHaveLength(13)
  })

  it('domains round-trip to chains and are unique', () => {
    const seen = new Set<number>()
    for (const [key, cfg] of Object.entries(HYPERLANE_CHAINS)) {
      expect(seen.has(cfg!.domain)).toBe(false)
      seen.add(cfg!.domain)
      expect(chainOfHyperlaneDomain(cfg!.domain)).toBe(key)
      expect(chainOfHyperlaneDomain(BigInt(cfg!.domain))).toBe(key)
    }
    expect(hyperlaneDomain('ethereum')).toBe(1)
    expect(hyperlaneDomain('solana')).toBeUndefined()
    expect(chainOfHyperlaneDomain(424242)).toBeUndefined()
  })

  it('recognises the registry mailbox, and only it, on its own chain', () => {
    const eth = hyperlaneConfig('ethereum')!
    expect(isHyperlaneMailbox('ethereum', eth.mailbox)).toBe(true)
    expect(isHyperlaneMailbox('ethereum', eth.mailbox.toLowerCase())).toBe(true)
    expect(isHyperlaneMailbox('base', eth.mailbox)).toBe(false)
    expect(isHyperlaneMailbox('ethereum', HL.OTHER)).toBe(false)
  })
})

// ---------------------------------------------------------------- messages ----

describe('the message', () => {
  it('is read off the offsets Message.sol packs it at, and its id is keccak256 of the bytes', () => {
    const raw = hyperlaneMessageBytes({ nonce: 42, origin: 1, sender: HL.ROUTER, destination: 8453, recipient: HL.DST_ROUTER, body: { recipient: HL.WALLET, amount: 123n } })
    const m = parseHyperlaneMessage(raw)
    expect(m.version).toBe(3)
    expect(m.nonce).toBe(42)
    expect(m.origin).toBe(1)
    expect(m.destination).toBe(8453)
    expect(bytes32ToEvmAddress(m.sender)).toBe(HL.ROUTER)
    expect(bytes32ToEvmAddress(m.recipient)).toBe(HL.DST_ROUTER)
    expect(m.id).toBe(keccak256(raw))
    const body = parseTokenMessage(m.body)!
    expect(bytes32ToEvmAddress(body.recipient)).toBe(HL.WALLET)
    expect(body.amount).toBe(123n)
    expect(body.metadata).toBe('0x')
  })

  it('refuses bytes shorter than the header rather than reading fields off wrong offsets', () => {
    expect(() => parseHyperlaneMessage(`0x${'00'.repeat(MESSAGE_HEADER_BYTES - 1)}`)).toThrow()
    expect(parseHyperlaneMessage(`0x${'00'.repeat(MESSAGE_HEADER_BYTES)}`).body).toBe('0x')
    expect(parseTokenMessage('0x1234')).toBeUndefined()
  })

  it('an address survives the bytes32 round trip only when its upper twelve bytes are zero', () => {
    expect(bytes32ToEvmAddress(evmAddressToBytes32(HL.WALLET))).toBe(HL.WALLET)
    expect(bytes32ToEvmAddress(`0x01${'00'.repeat(11)}${HL.WALLET.slice(2)}`)).toBeUndefined()
    expect(bytes32ToEvmAddress('0x1234')).toBeUndefined()
  })

  it('the topics are computed from the signatures', () => {
    expect(HYPERLANE_TOPICS.Dispatch).toMatch(/^0x[0-9a-f]{64}$/)
    expect(new Set(Object.values(HYPERLANE_TOPICS)).size).toBe(5)
  })

  it('the selector is computed, and equals what the contract answers to', () => {
    expect(TRANSFER_REMOTE_SELECTOR).toBe(toFunctionSelector('function transferRemote(uint32,bytes32,uint256)'))
    expect(TRANSFER_REMOTE_SELECTOR).toBe('0x81b4e8b4')
  })
})

// ------------------------------------------------------------------- scale ----

describe('the scale', () => {
  it('multiplies on the way out and divides on the way in, rounding down', () => {
    const s = { numerator: 10n ** 12n, denominator: 1n, source: 'scale' as const }
    expect(scaleOut(5n, s)).toBe(5n * 10n ** 12n)
    expect(scaleIn(5n * 10n ** 12n, s)).toBe(5n)
    expect(scaleIn(999n, s)).toBe(0n)
    expect(scaleOut(7n, UNSCALED)).toBe(7n)
  })

  it('the route fee in basis points', () => {
    expect(routeFeeBps({ amount: 10n ** 18n, routeFee: 10n ** 15n })).toBe(10n)
    expect(routeFeeBps({ amount: 10n ** 18n, routeFee: 0n })).toBe(0n)
    expect(routeFeeBps({ amount: 0n, routeFee: 5n })).toBe(0n)
  })
})

// ------------------------------------------------------------------- plans ----

type Answers = Record<string, unknown>

/** Answers `${address}.${functionName}`; anything unset reverts, like a function the contract lacks. */
function mockClient(answers: Answers, code = '0x6001'): ReadClient {
  return {
    getCode: async () => code,
    getBlockNumber: async () => 1_000_000n,
    getBalance: async ({ address }: { address: string }) => (answers[`${address.toLowerCase()}.balance`] as bigint | undefined) ?? 0n,
    getLogs: async () => (answers['logs'] as unknown[] | undefined) ?? [],
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
      const key = `${address.toLowerCase()}.${functionName}`
      const v = key in answers ? answers[key] : answers[`${key}(${(args ?? []).join(',')})`]
      if (v === undefined) throw new Error(`execution reverted: no answer for ${key}`)
      if (v instanceof Error) throw v
      return typeof v === 'function' ? (v as (a: unknown[] | undefined) => unknown)(args) : v
    },
  } as unknown as ReadClient
}

const m = (a: string) => a.toLowerCase()

/** A core 7.x collateral router on Ethereum, peered to a synthetic on Base. */
const collateralAnswers = (over: Answers = {}): Answers => ({
  [`${m(HL.ROUTER)}.mailbox`]: HL.MAILBOX_ETH,
  [`${m(HL.ROUTER)}.localDomain`]: 1,
  [`${m(HL.ROUTER)}.domains`]: [8453, 42161, 424242],
  [`${m(HL.ROUTER)}.wrappedToken`]: HL.TOKEN,
  [`${m(HL.ROUTER)}.scale`]: 1n,
  [`${m(HL.ROUTER)}.PACKAGE_VERSION`]: '7.1.0',
  [`${m(HL.ROUTER)}.owner`]: HL.OTHER,
  [`${m(HL.ROUTER)}.hook`]: `0x${'0'.repeat(40)}`,
  [`${m(HL.ROUTER)}.interchainSecurityModule`]: `0x${'0'.repeat(40)}`,
  [`${m(HL.ROUTER)}.routers`]: (args: unknown[] | undefined) => (args?.[0] === 8453 ? pad(HL.DST_ROUTER, { size: 32 }) : pad(`0x${'0'.repeat(40)}`, { size: 32 })),
  [`${m(HL.ROUTER)}.quoteGasPayment`]: 10n ** 15n,
  [`${m(HL.ROUTER)}.destinationGas`]: 64_000n,
  [`${m(HL.TOKEN)}.decimals`]: 18,
  [`${m(HL.TOKEN)}.symbol`]: 'TKN',
  ...over,
})

describe('discovering a warp route', () => {
  it('a 7.x collateral route: the token, the mailbox, the domain, the scale and the routes we serve', async () => {
    const d = await discoverWarpRoute(mockClient(collateralAnswers()), 'ethereum', HL.ROUTER)
    expect(d.kind).toBe('router')
    if (d.kind !== 'router') return
    expect(d.warpKind).toBe('collateral')
    expect(d.token).toBe(HL.TOKEN)
    expect(d.decimals).toBe(18)
    expect(d.symbol).toBe('TKN')
    expect(d.mailbox).toBe(HL.MAILBOX_ETH)
    expect(d.domain).toBe(1)
    expect(d.scale).toEqual({ numerator: 1n, denominator: 1n, source: 'scale' })
    expect(d.version).toBe('7.1.0')
    expect(d.feeTokenIsNative).toBe(true)
    // Arbitrum is served but its router is zero; 424242 is not a chain we have: neither is a route.
    expect(d.routes).toEqual([{ chain: 'base', domain: 8453, router: HL.DST_ROUTER }])
  })

  it('a 12+ native route: token() is zero, the scale is a fraction, the fee recipient is read', async () => {
    const answers = collateralAnswers({
      [`${m(HL.ROUTER)}.wrappedToken`]: undefined,
      [`${m(HL.ROUTER)}.token`]: `0x${'0'.repeat(40)}`,
      [`${m(HL.ROUTER)}.scale`]: undefined,
      [`${m(HL.ROUTER)}.scaleNumerator`]: 1n,
      [`${m(HL.ROUTER)}.scaleDenominator`]: 1n,
      [`${m(HL.ROUTER)}.feeRecipient`]: HL.OTHER,
      [`${m(HL.ROUTER)}.feeToken`]: `0x${'0'.repeat(40)}`,
    })
    delete answers[`${m(HL.ROUTER)}.wrappedToken`]
    delete answers[`${m(HL.ROUTER)}.scale`]
    const d = await discoverWarpRoute(mockClient(answers), 'ethereum', HL.ROUTER)
    expect(d).toMatchObject({ kind: 'router', warpKind: 'native', token: undefined, decimals: 18, symbol: 'ETH', feeRecipient: HL.OTHER })
    if (d.kind === 'router') expect(d.scale.source).toBe('fraction')
  })

  it('a 5.x synthetic route: no wrappedToken, no token(), but it answers decimals() — it is the token', async () => {
    const answers = collateralAnswers({ [`${m(HL.ROUTER)}.decimals`]: 6, [`${m(HL.ROUTER)}.symbol`]: 'SYN' })
    delete answers[`${m(HL.ROUTER)}.wrappedToken`]
    delete answers[`${m(HL.ROUTER)}.scale`]
    const d = await discoverWarpRoute(mockClient(answers), 'ethereum', HL.ROUTER)
    expect(d).toMatchObject({ kind: 'router', warpKind: 'synthetic', token: HL.ROUTER, decimals: 6, symbol: 'SYN' })
    if (d.kind === 'router') expect(d.scale).toEqual(UNSCALED)
  })

  it('a 12+ route whose fee is charged in the token is read, and marked as one this app will not build', async () => {
    const d = await discoverWarpRoute(mockClient(collateralAnswers({ [`${m(HL.ROUTER)}.feeToken`]: HL.TOKEN })), 'ethereum', HL.ROUTER)
    expect(d).toMatchObject({ kind: 'router', feeTokenIsNative: false })
  })

  it('refuses a router that names another mailbox, or another domain — whatever else it says', async () => {
    expect(await discoverWarpRoute(mockClient(collateralAnswers({ [`${m(HL.ROUTER)}.mailbox`]: HL.OTHER })), 'ethereum', HL.ROUTER)).toEqual({ kind: 'unknown', reason: 'foreign_mailbox' })
    expect(await discoverWarpRoute(mockClient(collateralAnswers({ [`${m(HL.ROUTER)}.localDomain`]: 8453 })), 'ethereum', HL.ROUTER)).toEqual({ kind: 'unknown', reason: 'wrong_domain' })
    // The Base mailbox is the registry's — on Base. On Ethereum it is a foreign one.
    expect(await discoverWarpRoute(mockClient(collateralAnswers({ [`${m(HL.ROUTER)}.mailbox`]: HL.MAILBOX_BASE })), 'ethereum', HL.ROUTER)).toEqual({ kind: 'unknown', reason: 'foreign_mailbox' })
  })

  it('a plain ERC-20 is reported as a token, so the hints can say who may hold it', async () => {
    const d = await discoverWarpRoute(mockClient({ [`${m(HL.TOKEN)}.decimals`]: 18, [`${m(HL.TOKEN)}.symbol`]: 'TKN' }), 'ethereum', HL.TOKEN)
    expect(d).toEqual({ kind: 'token', token: HL.TOKEN, decimals: 18, symbol: 'TKN' })
  })

  it('says what it could not do: no contract, not a router, an unsupported chain, a bad address', async () => {
    expect(await discoverWarpRoute(mockClient({}, '0x'), 'ethereum', HL.ROUTER)).toEqual({ kind: 'unknown', reason: 'not_a_contract' })
    expect(await discoverWarpRoute(mockClient({}), 'ethereum', HL.ROUTER)).toEqual({ kind: 'unknown', reason: 'not_a_router' })
    expect(await discoverWarpRoute(mockClient({}), 'solana', HL.ROUTER)).toEqual({ kind: 'unknown', reason: 'chain_unsupported' })
    expect(await discoverWarpRoute(mockClient({}), 'ethereum', 'nope')).toEqual({ kind: 'unknown', reason: 'invalid_address' })
  })

  it('a provider that does not answer is "unreadable", never a verdict about the router', async () => {
    const d = await discoverWarpRoute(mockClient(collateralAnswers({ [`${m(HL.ROUTER)}.mailbox`]: new Error('HTTP request failed: 429') })), 'ethereum', HL.ROUTER)
    expect(d).toEqual({ kind: 'unknown', reason: 'unreadable' })
  })

  describe('asked twice (RPC quorum)', () => {
    const quorum = (primary: Answers, second?: Answers) =>
      discoverWarpRouteQuorum(mockClient(primary), second ? mockClient(second) : undefined, 'ethereum', HL.ROUTER)

    it('finds the route and flags that nobody confirmed it', async () => {
      const r = await quorum(collateralAnswers())
      expect(r).toMatchObject({ kind: 'router', router: HL.ROUTER, crossChecked: false })
    })

    it('marks it cross-checked when two providers agree', async () => {
      expect((await quorum(collateralAnswers(), collateralAnswers())).crossChecked).toBe(true)
    })

    it('does NOT block when the second provider is simply down', async () => {
      const r = await quorum(collateralAnswers(), collateralAnswers({ [`${m(HL.ROUTER)}.mailbox`]: new Error('fetch failed') }))
      expect(r).toMatchObject({ kind: 'router', crossChecked: false })
    })

    it('blocks when the second provider names a different token or mailbox', async () => {
      const otherToken = await quorum(collateralAnswers(), collateralAnswers({ [`${m(HL.ROUTER)}.wrappedToken`]: HL.OTHER, [`${m(HL.OTHER)}.decimals`]: 18, [`${m(HL.OTHER)}.symbol`]: 'X' }))
      expect(otherToken.kind).toBe('unknown')
      expect(otherToken.crossChecked).toBe(true)
      const foreign = await quorum(collateralAnswers(), collateralAnswers({ [`${m(HL.ROUTER)}.mailbox`]: HL.OTHER }))
      expect(foreign).toMatchObject({ kind: 'unknown', reason: 'foreign_mailbox', crossChecked: true })
    })

    it('ignores a route one provider has not indexed yet — that is lag, not disagreement', async () => {
      const r = await quorum(collateralAnswers(), collateralAnswers({ [`${m(HL.ROUTER)}.domains`]: [] }))
      expect(r).toMatchObject({ kind: 'router', crossChecked: true })
    })
  })
})

describe('the far side', () => {
  const dstAnswers = (over: Answers = {}): Answers => ({
    [`${m(HL.DST_ROUTER)}.mailbox`]: HL.MAILBOX_BASE,
    [`${m(HL.DST_ROUTER)}.routers`]: pad(HL.ROUTER, { size: 32 }),
    [`${m(HL.DST_ROUTER)}.decimals`]: 18,
    [`${m(HL.DST_ROUTER)}.symbol`]: 'TKN',
    [`${m(HL.DST_ROUTER)}.scale`]: 1n,
    ...over,
  })

  it('a synthetic far side that names the registry mailbox and points back', async () => {
    const r = await readRemoteWarp(mockClient(dstAnswers()), 'base', HL.DST_ROUTER, 'ethereum', HL.ROUTER)
    expect(r).toMatchObject({ readable: true, mailboxOk: true, pointsBack: true, warpKind: 'synthetic', token: HL.DST_ROUTER, decimals: 18 })
  })

  it('says when it names another mailbox, or another peer — and reads nothing into a refusal', async () => {
    expect((await readRemoteWarp(mockClient(dstAnswers({ [`${m(HL.DST_ROUTER)}.mailbox`]: HL.OTHER })), 'base', HL.DST_ROUTER, 'ethereum', HL.ROUTER)).mailboxOk).toBe(false)
    expect((await readRemoteWarp(mockClient(dstAnswers({ [`${m(HL.DST_ROUTER)}.routers`]: pad(HL.OTHER, { size: 32 }) })), 'base', HL.DST_ROUTER, 'ethereum', HL.ROUTER)).pointsBack).toBe(false)
    const refused = dstAnswers()
    delete refused[`${m(HL.DST_ROUTER)}.routers`]
    expect((await readRemoteWarp(mockClient(refused), 'base', HL.DST_ROUTER, 'ethereum', HL.ROUTER)).pointsBack).toBeUndefined()
  })

  it('an unreachable provider is unreadable, with every field undefined', async () => {
    const r = await readRemoteWarp(mockClient(dstAnswers({ [`${m(HL.DST_ROUTER)}.mailbox`]: new Error('timeout') })), 'base', HL.DST_ROUTER, 'ethereum', HL.ROUTER)
    expect(r).toMatchObject({ readable: false, mailboxOk: undefined, pointsBack: undefined })
  })
})

describe('the standing', () => {
  it('a collateral route needs both floors; a native route needs a balance and history; a synthetic route needs nothing', () => {
    expect(warpStandingOk('collateral', { lockedBps: 10, held: 1n, dispatches: 20, window: undefined })).toBe(true)
    expect(warpStandingOk('collateral', { lockedBps: 9, held: 1n, dispatches: 20, window: undefined })).toBe(false)
    expect(warpStandingOk('collateral', { lockedBps: 500, held: 1n, dispatches: 19, window: undefined })).toBe(false)
    expect(warpStandingOk('collateral', { lockedBps: undefined, held: 1n, dispatches: 50, window: undefined })).toBe(false)
    expect(warpStandingOk('native', { lockedBps: undefined, held: 1n, dispatches: 20, window: undefined })).toBe(true)
    expect(warpStandingOk('native', { lockedBps: undefined, held: 0n, dispatches: 20, window: undefined })).toBe(false)
    expect(warpStandingOk('synthetic', { lockedBps: undefined, held: undefined, dispatches: undefined, window: undefined })).toBe(true)
  })
})

describe('the plan', () => {
  const build = (client: ReadClient, over: Partial<Parameters<typeof buildHyperlanePlan>[0]> = {}) =>
    buildHyperlanePlan({
      chain: 'ethereum',
      dstChain: 'base',
      router: warpRouter(),
      remote: remoteWarp(),
      sender: HL.WALLET,
      recipient: evmRecipient(HL.WALLET),
      amount: 10n ** 18n,
      srcClient: client,
      ...over,
    })

  it('a 7.x route: the gas quote, the amount as the charge, no route fee, value = fee', async () => {
    const p = await build(mockClient(collateralAnswers()))
    expect(p.quoteSource).toBe('quoteGasPayment')
    expect(p.fee).toBe(10n ** 15n)
    expect(p.charge).toBe(p.amount)
    expect(p.routeFee).toBe(0n)
    expect(p.value).toBe(p.fee)
    expect(p.received).toBe(p.amount)
    expect(p.recipientBytes32).toBe(evmAddressToBytes32(HL.WALLET))
    expect(p.dst).toMatchObject({ chain: 'base', domain: 8453, router: HL.DST_ROUTER })
    expect(assembleTransferRemoteArgs(p)).toEqual([8453, evmAddressToBytes32(HL.WALLET), 10n ** 18n])
  })

  it('a 10+ route: the three quotes — the charge is the amount PLUS the route fee, in the token', async () => {
    const quotes = [
      { token: `0x${'0'.repeat(40)}`, amount: 2n * 10n ** 15n },
      { token: HL.TOKEN, amount: 10n ** 18n + 10n ** 15n },
      { token: HL.TOKEN, amount: 0n },
    ]
    const p = await build(mockClient(collateralAnswers({ [`${m(HL.ROUTER)}.quoteTransferRemote`]: quotes })))
    expect(p.quoteSource).toBe('quoteTransferRemote')
    expect(p.fee).toBe(2n * 10n ** 15n)
    expect(p.charge).toBe(10n ** 18n + 10n ** 15n)
    expect(p.routeFee).toBe(10n ** 15n)
    expect(p.value).toBe(p.fee)
  })

  it('a native route carries the charge in msg.value alongside the fee', async () => {
    const p = await build(mockClient(collateralAnswers()), { router: warpRouter({ warpKind: 'native', token: undefined, symbol: 'ETH' }) })
    expect(p.value).toBe(p.fee + p.charge)
  })

  it('scales out by this router and back in by the far one', async () => {
    const p = await build(mockClient(collateralAnswers()), {
      router: warpRouter({ scale: { numerator: 10n ** 12n, denominator: 1n, source: 'scale' } }),
      remote: remoteWarp({ scale: { numerator: 10n ** 12n, denominator: 1n, source: 'scale' }, decimals: 18 }),
      amount: 5n,
    })
    expect(p.messageAmount).toBe(5n * 10n ** 12n)
    expect(p.received).toBe(5n)
  })

  it('refuses a fee quoted in the token, a destination the router does not name, a zero amount', async () => {
    await expect(build(mockClient(collateralAnswers()), { router: warpRouter({ feeTokenIsNative: false }) })).rejects.toMatchObject({ code: 'fee_token_unsupported' })
    const tokenFee = [{ token: HL.TOKEN, amount: 1n }, { token: HL.TOKEN, amount: 10n ** 18n }, { token: HL.TOKEN, amount: 0n }]
    await expect(build(mockClient(collateralAnswers({ [`${m(HL.ROUTER)}.quoteTransferRemote`]: tokenFee })))).rejects.toMatchObject({ code: 'fee_token_unsupported' })
    await expect(build(mockClient(collateralAnswers()), { dstChain: 'arbitrum' })).rejects.toMatchObject({ code: 'route_missing' })
    await expect(build(mockClient(collateralAnswers()), { amount: 0n })).rejects.toMatchObject({ code: 'amount_zero' })
  })

  it('a provider that answers neither quote is a failed quote, not a free one', async () => {
    const none = collateralAnswers()
    delete none[`${m(HL.ROUTER)}.quoteGasPayment`]
    const e = await build(mockClient(none)).catch((x) => x)
    expect(e).toBeInstanceOf(HyperlanePlanError)
    expect(e.code).toBe('fee_failed')
  })
})

// ------------------------------------------------------------------ guards ----

describe('Hyperlane guards', () => {
  it('lets a fully checked transfer through', () => {
    expect(runHyperlaneGuards(hyperlaneInput()).canSend).toBe(true)
  })

  it('the approve exists only on a collateral route, names the verified router, and is for the charge', () => {
    const plan = hyperlanePlan({ charge: 10n ** 18n + 10n ** 15n, routeFee: 10n ** 15n })
    expect(hyperlaneApprovePlan(warpRouter(), plan, 0n)).toEqual({ token: HL.TOKEN, spender: HL.ROUTER, amount: plan.charge })
    // Enough allowance for the amount is not enough for the charge.
    expect(hyperlaneApprovePlan(warpRouter(), plan, 10n ** 18n)).not.toBeNull()
    expect(hyperlaneApprovePlan(warpRouter(), plan, plan.charge)).toBeNull()
    // A plan carrying some other router cannot turn into an approve for it.
    expect(hyperlaneApprovePlan(warpRouter(), hyperlanePlan({ router: HL.OTHER }), 0n)).toBeNull()
    expect(hyperlaneApprovePlan(warpRouter({ warpKind: 'synthetic', token: HL.ROUTER }), hyperlanePlan({ warpKind: 'synthetic', token: HL.ROUTER }), 0n)).toBeNull()
    expect(hyperlaneApprovePlan(warpRouter({ warpKind: 'native', token: undefined }), hyperlanePlan({ warpKind: 'native', token: undefined }), 0n)).toBeNull()
  })

  it('an approve on a synthetic or native route is forbidden; the wrong spender or amount is refused', () => {
    const synthetic = hyperlanePlan({ warpKind: 'synthetic', token: HL.ROUTER })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: synthetic, approveIntent: { token: HL.ROUTER, spender: HL.ROUTER, amount: synthetic.charge } })).results.find((r) => r.id === 10)).toMatchObject({ code: 'approve_forbidden' })
    expect(runHyperlaneGuards(hyperlaneInput({ allowance: 0n, approveIntent: { token: HL.TOKEN, spender: HL.OTHER, amount: 10n ** 18n } })).results.find((r) => r.id === 10)).toMatchObject({ code: 'approve_wrong_spender' })
    expect(runHyperlaneGuards(hyperlaneInput({ allowance: 0n, approveIntent: { token: HL.TOKEN, spender: HL.ROUTER, amount: 1n } })).results.find((r) => r.id === 10)).toMatchObject({ code: 'approve_amount_mismatch' })
    expect(runHyperlaneGuards(hyperlaneInput({ allowance: 0n })).results.find((r) => r.id === 9)).toMatchObject({ code: 'needs_approve' })
    // A synthetic route never waits on an allowance.
    expect(runHyperlaneGuards(hyperlaneInput({ plan: synthetic, allowance: undefined })).results.find((r) => r.id === 9)?.ok).toBe(true)
  })

  it('the wallet must hold the charge, not just the amount', () => {
    const plan = hyperlanePlan({ charge: 10n ** 18n + 1n, routeFee: 1n })
    expect(runHyperlaneGuards(hyperlaneInput({ plan, tokenBalance: 10n ** 18n })).results.find((r) => r.id === 5)).toMatchObject({ code: 'insufficient_balance' })
    const native = hyperlanePlan({ warpKind: 'native', token: undefined, value: 10n ** 15n + 10n ** 18n })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: native, tokenBalance: undefined, nativeBalance: 10n ** 17n })).results.find((r) => r.id === 5)).toMatchObject({ code: 'insufficient_balance' })
  })

  it('msg.value is the fee — plus the charge on a native route — exactly', () => {
    expect(runHyperlaneGuards(hyperlaneInput({ plan: hyperlanePlan({ value: 2n * 10n ** 15n }) })).results.find((r) => r.id === 7)).toMatchObject({ code: 'fee_mismatch' })
    const native = hyperlanePlan({ warpKind: 'native', token: undefined, value: 10n ** 15n })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: native, nativeBalance: 10n ** 19n })).results.find((r) => r.id === 7)).toMatchObject({ code: 'fee_mismatch' })
    const ok = hyperlanePlan({ warpKind: 'native', token: undefined, value: 10n ** 15n + 10n ** 18n })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: ok, nativeBalance: 10n ** 19n })).results.find((r) => r.id === 7)?.ok).toBe(true)
  })

  it('the far side: pending while unread, a yellow note when unreachable, red when it does not point back or names another mailbox', () => {
    const r = (remote: RemoteWarp | undefined) => runHyperlaneGuards(hyperlaneInput({ remote })).results.find((x) => x.id === 6)!
    expect(r(undefined)).toMatchObject({ code: 'peer_back_unknown' })
    expect(isPendingCode('peer_back_unknown')).toBe(true)
    expect(r(remoteWarp({ readable: false, mailboxOk: undefined, pointsBack: undefined }))).toMatchObject({ code: 'peer_back_unavailable' })
    expect(isNoteCode('peer_back_unavailable')).toBe(true)
    expect(noteLevel('peer_back_unavailable')).toBe('yellow')
    expect(r(remoteWarp({ pointsBack: false }))).toMatchObject({ code: 'peer_back_mismatch' })
    expect(noteLevel('peer_back_mismatch')).toBe('red')
    expect(r(remoteWarp({ mailboxOk: false }))).toMatchObject({ code: 'peer_foreign_mailbox' })
    expect(isNoteCode('peer_foreign_mailbox')).toBe(true)
    expect(noteLevel('peer_foreign_mailbox')).toBe('red')
    // None of them holds the button.
    expect(runHyperlaneGuards(hyperlaneInput({ remote: remoteWarp({ pointsBack: false, mailboxOk: false }) })).canSend).toBe(true)
  })

  it('the route fee is a note at every size, red above 3% and above 20%', () => {
    const at = (bps: bigint) => hyperlanePlan({ routeFee: (10n ** 18n * bps) / 10_000n, charge: 10n ** 18n + (10n ** 18n * bps) / 10_000n })
    // Enough balance and allowance for the CHARGE, so only the fee itself is under test.
    const funded = { tokenBalance: 10n ** 19n, allowance: 10n ** 19n }
    expect(runHyperlaneGuards(hyperlaneInput({ plan: at(10n), ...funded })).results.find((r) => r.id === 11)?.ok).toBe(true)
    expect(runHyperlaneGuards(hyperlaneInput({ plan: at(50n), ...funded })).results.find((r) => r.id === 11)).toMatchObject({ code: 'route_fee_notice' })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: at(301n), ...funded })).results.find((r) => r.id === 11)).toMatchObject({ code: 'route_fee_high' })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: at(2001n), ...funded })).results.find((r) => r.id === 11)).toMatchObject({ code: 'route_fee_extreme' })
    expect(noteLevel('route_fee_notice')).toBe('yellow')
    expect(noteLevel('route_fee_high')).toBe('red')
    expect(noteLevel('route_fee_extreme')).toBe('red')
    expect(runHyperlaneGuards(hyperlaneInput({ plan: at(2001n), ...funded })).canSend).toBe(true)
    // Without the allowance for the charge, the approve is the next step — and the fee is still said.
    const short = runHyperlaneGuards(hyperlaneInput({ plan: at(2001n), tokenBalance: 10n ** 19n }))
    expect(short.results.find((r) => r.id === 9)).toMatchObject({ code: 'needs_approve' })
    expect(short.results.find((r) => r.id === 11)).toMatchObject({ code: 'route_fee_extreme' })
  })

  it('the route must be the registry’s: domain and mailbox from the config, a far router named', () => {
    expect(runHyperlaneGuards(hyperlaneInput({ plan: hyperlanePlan({ mailbox: HL.OTHER }) })).results.find((r) => r.id === 2)).toMatchObject({ code: 'route_unsupported' })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: hyperlanePlan({ dst: { chain: 'base', domain: 1, router: HL.DST_ROUTER } }) })).results.find((r) => r.id === 2)).toMatchObject({ code: 'route_unsupported' })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: hyperlanePlan({ dst: { chain: 'base', domain: 8453, router: `0x${'0'.repeat(40)}` } }) })).results.find((r) => r.id === 2)).toMatchObject({ code: 'route_missing' })
    expect(isBlockingCode('route_missing')).toBe(true)
  })

  it('an amount that would arrive as nothing after the scale is held', () => {
    expect(runHyperlaneGuards(hyperlaneInput({ plan: hyperlanePlan({ received: 0n }) })).results.find((r) => r.id === 5)).toMatchObject({ code: 'amount_rounds_to_zero' })
  })

  it('needs a confirmation for a recipient other than the wallet, and notes the contracts on both sides', () => {
    expect(runHyperlaneGuards(hyperlaneInput({ plan: hyperlanePlan({ recipient: HL.OTHER }) })).results.find((r) => r.id === 3)).toMatchObject({ code: 'recipient_unconfirmed' })
    for (const c of [HL.ROUTER, HL.TOKEN, HL.MAILBOX_ETH, HL.DST_ROUTER]) {
      const rep = runHyperlaneGuards(hyperlaneInput({ plan: hyperlanePlan({ recipient: c }), recipientIsCustom: true, customRecipientConfirmed: true }))
      expect(rep.results.find((r) => r.id === 4), c).toMatchObject({ code: 'recipient_is_contract' })
      expect(rep.canSend, c).toBe(true)
    }
  })

  it('a simulation the provider could not run is "not checked", not "fails"', () => {
    const rep = runHyperlaneGuards(hyperlaneInput({ simulation: { ok: false, reason: 'fetch failed', unavailable: true } }))
    expect(rep.results.find((r) => r.id === 12)).toMatchObject({ code: 'simulation_unavailable' })
    expect(rep.canSend).toBe(true)
  })

  it('the dispatch fee ceiling is about the fee, not the amount a native route carries', () => {
    const native = hyperlanePlan({ warpKind: 'native', token: undefined, amount: 10n ** 18n, charge: 10n ** 18n, value: 10n ** 15n + 10n ** 18n })
    expect(runHyperlaneGuards(hyperlaneInput({ plan: native, nativeBalance: 10n ** 19n })).results.find((r) => r.id === 14)?.ok).toBe(true)
    const high = hyperlanePlan({ fee: 5n * 10n ** 17n, value: 5n * 10n ** 17n })
    const rep = runHyperlaneGuards(hyperlaneInput({ plan: high }))
    expect(rep.results.find((r) => r.id === 14)).toMatchObject({ code: 'fee_above_ceiling' })
    expect(rep.canSend).toBe(true)
  })
})

// -------------------------------------------------------------- self-check ----

describe('Hyperlane self-check', () => {
  it('accepts the calldata built from the plan', () => {
    const plan = hyperlanePlan()
    expect(hyperlaneSelfCheck(plan, encodeTransferRemote(plan))).toEqual({ ok: true })
  })

  it('catches a swapped destination, recipient and amount', () => {
    const plan = hyperlanePlan()
    const enc = (args: readonly [number, `0x${string}`, bigint]) => encodeFunctionData({ abi: warpRouteAbi as Abi, functionName: 'transferRemote', args })
    expect(hyperlaneSelfCheck(plan, enc([1, plan.recipientBytes32, plan.amount]))).toMatchObject({ ok: false, mismatches: expect.arrayContaining(['destination']) })
    expect(hyperlaneSelfCheck(plan, enc([8453, evmAddressToBytes32(HL.OTHER), plan.amount]))).toMatchObject({ ok: false, mismatches: expect.arrayContaining(['recipient']) })
    expect(hyperlaneSelfCheck(plan, enc([8453, plan.recipientBytes32, plan.amount + 1n]))).toMatchObject({ ok: false, mismatches: expect.arrayContaining(['amount']) })
  })

  it('refuses a recipient whose upper twelve bytes are not zero — the far side would not read it as an address', () => {
    const plan = hyperlanePlan()
    const dirty = `0x01${'00'.repeat(11)}${HL.WALLET.slice(2)}` as `0x${string}`
    const r = hyperlaneSelfCheck(plan, encodeFunctionData({ abi: warpRouteAbi as Abi, functionName: 'transferRemote', args: [8453, dirty, plan.amount] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mismatches.join(' ')).toMatch(/left-padded/)
  })

  it('refuses calldata that is not a transferRemote at all, or of another length', () => {
    expect(hyperlaneSelfCheck(hyperlanePlan(), '0xdeadbeef')).toMatchObject({ ok: false })
    const fiveArgs = encodeFunctionData({
      abi: [{ type: 'function', name: 'transferRemote', stateMutability: 'payable', inputs: [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'address' }], outputs: [] }] as Abi,
      functionName: 'transferRemote',
      args: [8453, hyperlanePlan().recipientBytes32, 1n, '0x', HL.OTHER],
    })
    expect(hyperlaneSelfCheck(hyperlanePlan(), fiveArgs)).toMatchObject({ ok: false })
  })
})

// --------------------------------------------------------- hints, links, reverse ----

describe('the registry hint table', () => {
  it('names candidate routers for a listed collateral token, checksummed, and nothing for a stranger', () => {
    // PAXG on Ethereum, from the registry's PAXG/arbitrum-ethereum route.
    const hints = warpRouteHints('ethereum', '0x45804880de22913dafe09f4980848ece6ecbaf78')
    expect(hints.length).toBeGreaterThanOrEqual(1)
    for (const h of hints) {
      expect(h.router).toBe(getAddress(h.router))
      expect(h.standard).toMatch(/^EvmHyp/)
      expect(h.route).toContain('PAXG')
    }
    expect(warpRouteHints('ethereum', HL.OTHER)).toEqual([])
    expect(warpRouteHints('solana', HL.OTHER)).toEqual([])
  })

  it('lists native routes per chain', () => {
    expect(nativeWarpRouteHints('ethereum').length).toBeGreaterThan(0)
    for (const h of nativeWarpRouteHints('ethereum')) expect(h.standard).toBe('EvmHypNative')
    expect(nativeWarpRouteHints('solana')).toEqual([])
  })
})

describe('links, reverse and tracking', () => {
  it('a /hyperlane link opens as a router target', () => {
    expect(linkTarget({ from: 'ethereum', token: HL.ROUTER, to: 'base' }, 'hyperlane')).toEqual({ chain: 'ethereum', address: HL.ROUTER, kind: 'hyperlane-router', dstChain: 'base', via: 'link' })
  })

  it('reverses onto the router this one names on the far side', () => {
    expect(reverseHyperlane('ethereum', 'base', HL.DST_ROUTER)).toMatchObject({ ok: true, chain: 'base', contract: HL.DST_ROUTER, dstChain: 'ethereum' })
    expect(reverseHyperlane('ethereum', undefined, HL.DST_ROUTER)).toEqual({ ok: false, reason: 'no_destination' })
    expect(reverseHyperlane('ethereum', 'base', undefined)).toEqual({ ok: false, reason: 'no_peer' })
  })

  it('links to the routes the explorer itself declares', () => {
    const id = `0x${'cd'.repeat(32)}`
    expect(hyperlaneMessageUrl(id)).toBe(`https://explorer.hyperlane.xyz/message/${id}`)
    expect(hyperlaneTxUrl(id)).toBe(`https://explorer.hyperlane.xyz/tx/${id}`)
    expect(() => hyperlaneMessageUrl('nope')).toThrow()
  })
})

// The fixture helpers are exercised above; this keeps the unused-import rule honest.
void (HL.WALLET as Address)
