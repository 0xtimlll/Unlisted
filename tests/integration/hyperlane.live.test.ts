/**
 * Hyperlane against mainnet.
 *
 * The fixtures are routes the Hyperlane registry itself lists (hyperlane-xyz/hyperlane-registry,
 * deployments/warp_routes): PAXG, a core 7.x collateral route on Ethereum peered to a synthetic on
 * Arbitrum, and ETH, a core 10+ native route on Ethereum with a fee recipient — so what the
 * discovery and the plan read can be compared with what the registry says, and both generations
 * of quote are exercised.
 *
 * Read-only; public RPCs are flaky, so this project is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { evmByKey, CHAINS, isEvm } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { evmRecipient } from '@/core/recipient'
import { mailboxAbi } from '@/protocols/hyperlane/abi'
import { HYPERLANE_CHAINS, hyperlaneConfig } from '@/protocols/hyperlane/chains'
import { discoverWarpRoute, readRemoteWarp, readWarpStanding } from '@/protocols/hyperlane/discover'
import { buildHyperlanePlan } from '@/protocols/hyperlane/plan'
import { warpRouteHints } from '@/protocols/hyperlane/warpRoutes'

/** PAXG/arbitrum-ethereum: the collateral router on Ethereum and the token it holds. */
const PAXG_ROUTER = getAddress('0x68A593C7F42e0f6616F9356dCb1CFd130e4e7694')
const PAXG = getAddress('0x45804880De22913dAFE09f4980848ECE6EcbAf78')
const PAXG_ARBITRUM = getAddress('0xE7eFb127249Ec17B484B5Bb0Ea5f79A14A6d0721')
/** ETH/viction: a core 10+ HypNative on Ethereum with a fee recipient, peered to Robinhood among others. */
const ETH_NATIVE_ROUTER = getAddress('0x7DCA030594C6695fc24b874917d0beAA38715639')
const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const eth = () => makeReadClient(evmByKey('ethereum'))
const arb = () => makeReadClient(evmByKey('arbitrum'))

describe('Hyperlane against mainnet', () => {
  it('every mailbox in the table answers its own domain and version 3', async () => {
    for (const c of CHAINS) {
      if (!isEvm(c)) continue
      const cfg = HYPERLANE_CHAINS[c.key]
      if (!cfg) continue // Hyperlane serves 36 of the registry's chains; the rest have no row
      const client = makeReadClient(c)
      const [domain, version] = await Promise.all([
        client.readContract({ address: getAddress(cfg!.mailbox), abi: mailboxAbi, functionName: 'localDomain' }),
        client.readContract({ address: getAddress(cfg!.mailbox), abi: mailboxAbi, functionName: 'VERSION' }),
      ])
      expect(domain, c.key).toBe(cfg!.domain)
      expect(version, c.key).toBe(3)
    }
  })

  it('finds the PAXG collateral route from the token, through the registry hint', async () => {
    const hints = warpRouteHints('ethereum', PAXG)
    expect(hints.map((h) => h.router)).toContain(PAXG_ROUTER)
    const token = await discoverWarpRoute(eth(), 'ethereum', PAXG)
    expect(token).toMatchObject({ kind: 'token', token: PAXG, decimals: 18, symbol: 'PAXG' })

    const d = await discoverWarpRoute(eth(), 'ethereum', PAXG_ROUTER)
    expect(d.kind).toBe('router')
    if (d.kind !== 'router') return
    expect(d.warpKind).toBe('collateral')
    expect(d.token).toBe(PAXG)
    expect(d.mailbox).toBe(getAddress(hyperlaneConfig('ethereum')!.mailbox))
    expect(d.domain).toBe(1)
    expect(d.routes.find((r) => r.chain === 'arbitrum')?.router).toBe(PAXG_ARBITRUM)
  })

  it('the synthetic on Arbitrum names the registry mailbox there and points back', async () => {
    const remote = await readRemoteWarp(arb(), 'arbitrum', PAXG_ARBITRUM, 'ethereum', PAXG_ROUTER)
    expect(remote.readable).toBe(true)
    expect(remote.mailboxOk).toBe(true)
    expect(remote.pointsBack).toBe(true)
    expect(remote.warpKind).toBe('synthetic')
    expect(remote.decimals).toBe(18)
  })

  it('quotes a 7.x transfer: quoteGasPayment, the amount as the charge, value = fee', async () => {
    const d = await discoverWarpRoute(eth(), 'ethereum', PAXG_ROUTER)
    if (d.kind !== 'router') throw new Error('expected a router')
    const remote = await readRemoteWarp(arb(), 'arbitrum', PAXG_ARBITRUM, 'ethereum', PAXG_ROUTER)
    const plan = await buildHyperlanePlan({ chain: 'ethereum', dstChain: 'arbitrum', router: d, remote, sender: SOMEONE, recipient: evmRecipient(SOMEONE), amount: 10n ** 18n, srcClient: eth() })
    expect(plan.quoteSource).toBe('quoteGasPayment')
    expect(plan.fee).toBeGreaterThan(0n)
    expect(plan.charge).toBe(10n ** 18n)
    expect(plan.routeFee).toBe(0n)
    expect(plan.value).toBe(plan.fee)
    expect(plan.received).toBe(10n ** 18n)
    expect(plan.dst.router).toBe(PAXG_ARBITRUM)
  })

  it('reads the standing of the collateral route: the locked share and the dispatch history', async () => {
    const d = await discoverWarpRoute(eth(), 'ethereum', PAXG_ROUTER)
    if (d.kind !== 'router') throw new Error('expected a router')
    const s = await readWarpStanding(eth(), 'ethereum', d)
    expect(s.held).toBeDefined()
    expect(s.lockedBps).toBeDefined()
    // The window is whatever the provider served; the count is a number, not a guess.
    if (s.dispatches !== undefined) expect(s.window).toBeDefined()
  })

  it('quotes a 10+ native transfer: three quotes, the route fee on top of the amount, value = fee + charge', async () => {
    const d = await discoverWarpRoute(eth(), 'ethereum', ETH_NATIVE_ROUTER)
    expect(d.kind).toBe('router')
    if (d.kind !== 'router') return
    expect(d.warpKind).toBe('native')
    expect(d.feeRecipient).toBeDefined()
    const route = d.routes.find((r) => r.chain === 'robinhood') ?? d.routes[0]
    if (!route) throw new Error('expected a served destination')
    const plan = await buildHyperlanePlan({ chain: 'ethereum', dstChain: route.chain, router: d, remote: undefined, sender: SOMEONE, recipient: evmRecipient(SOMEONE), amount: 10n ** 18n, srcClient: eth() })
    expect(plan.quoteSource).toBe('quoteTransferRemote')
    expect(plan.charge).toBeGreaterThanOrEqual(plan.amount)
    expect(plan.routeFee).toBe(plan.charge - plan.amount)
    expect(plan.value).toBe(plan.fee + plan.charge)
  })
})
