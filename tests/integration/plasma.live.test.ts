/**
 * Plasma (9745) against mainnet, one describe per protocol tab.
 *
 * Every number in `src/core/chains.ts` and the protocol tables is checked against the chain itself
 * rather than against the document it was copied from: the eid is read off the LayerZero endpoint
 * the OFT names, the Hyperlane domain off the registry Mailbox, and the CCIP router is asked whether
 * it really carries the routes the directory claims.
 *
 * Read-only — nothing here signs or sends. Public RPCs are flaky, so this project is not part of
 * `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { byEid, evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { bytes32ToAddress } from '@/core/encoding'
import { buildSendPlan } from '@/core/plan'
import { probeOft } from '@/core/probe'
import { evmRecipient } from '@/core/recipient'
import { ccipConfig } from '@/protocols/ccip/chains'
import { discoverCcipToken, readRemoteSide } from '@/protocols/ccip/discover'
import { mailboxAbi } from '@/protocols/hyperlane/abi'
import { hyperlaneConfig } from '@/protocols/hyperlane/chains'
import { discoverWarpRoute, readRemoteWarp } from '@/protocols/hyperlane/discover'
import { buildHyperlanePlan } from '@/protocols/hyperlane/plan'
import { warpRouteHints } from '@/protocols/hyperlane/warpRoutes'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'

/**
 * USD₮0 on Plasma: an OFT adapter over the token, and the busiest EVM-bound sender on the chain's
 * own EndpointV2 — found by decoding `PacketSent` there (30 of the packets in 120 000 blocks), not
 * taken from any list. Its peers include Ethereum (30101) and Arbitrum (30110).
 */
const USDT0_ADAPTER_PLASMA = getAddress('0x02ca37966753bDdDf11216B73B16C1dE756A7CF9')
const USDT0_TOKEN_PLASMA = getAddress('0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb')

/** sUSDe on Plasma: a self-OFT (token() is itself) that sends to Ethereum. Found the same way. */
const SUSDE_PLASMA = getAddress('0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2')

/**
 * GHO on Plasma, from the CCIP Directory data file (`plasma-mainnet`): its pool lists Arbitrum,
 * Base and Ink among its destinations.
 */
const GHO_PLASMA = getAddress('0xb77E872A68C62CfC0dFb02C067Ecc3DA23B4bbf3')
const GHO_POOL_PLASMA = getAddress('0x360d8aa8F6b09B7BC57aF34db2Eb84dD87bf4d12')

/**
 * The Hyperlane registry lists a `USDT/oft` route holding USD₮0 on Plasma. On chain that contract
 * (core 11.0.2) answers `wrappedToken()` but neither `mailbox()` nor `routers()`: it is one of
 * Hyperlane's OFT-bridge adapters, not a Mailbox router, so the hint is refused by the probe —
 * exactly the "a list narrows the search and never raises trust" rule at work.
 */
const USDT_OFT_BRIDGE_PLASMA = getAddress('0x93bfFA2231fbA5029997603fb68D9aC08024Baa2')

/**
 * ezETH on Plasma from the registry's `EZETH/renzo-prod` route: a HypXERC20 (core 9.0.10) over
 * the xERC20 `0x2416…Eea5`, naming the registry Mailbox and routers on Ethereum, Arbitrum and Base.
 */
const EZETH_WARP_ROUTER_PLASMA = getAddress('0xcD78A32Da8cfe9452cD2F50F547c11B979Afcf1b')
const EZETH_PLASMA = getAddress('0x2416092f143378750bb29b79eD961ab195CcEea5')

const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const plasma = () => makeReadClient(evmByKey('plasma'))
const ethereum = () => makeReadClient(evmByKey('ethereum'))
const arbitrum = () => makeReadClient(evmByKey('arbitrum'))

describe('Plasma: the registry entry itself', () => {
  it('every RPC in the registry answers for chain 9745', async () => {
    for (const url of evmByKey('plasma').rpcUrls) {
      const c = makeReadClient({ ...evmByKey('plasma'), rpcUrls: [url] })
      expect(await c.getChainId(), url).toBe(9745)
    }
  })

  it('the eid comes from the endpoint the OFT names, not from a table', async () => {
    const { info } = await probeOft(plasma(), USDT0_ADAPTER_PLASMA, evmByKey('plasma').endpointV2)
    expect(info.endpoint.toLowerCase()).toBe(evmByKey('plasma').endpointV2.toLowerCase())
    expect(byEid(30383)?.key).toBe('plasma')
  })

  it('Wormhole numbers Plasma 58 but publishes no mainnet core bridge, so NTT is unavailable', () => {
    expect(WORMHOLE_CHAINS.plasma?.wormholeChainId).toBe(58)
    expect(WORMHOLE_CHAINS.plasma?.coreBridge).toBe('')
  })
})

describe('Plasma: LayerZero OFT', () => {
  it('USD₮0 is an adapter over the token that needs no approve, peered to Ethereum and Arbitrum', async () => {
    const { info } = await probeOft(plasma(), USDT0_ADAPTER_PLASMA, evmByKey('plasma').endpointV2)
    expect(info.vm).toBe('evm')
    if (info.vm !== 'evm') return
    expect(info.token).toBe(USDT0_TOKEN_PLASMA)
    expect(info.decimals).toBe(6)
    expect(info.approvalRequired).toBe(false)
    const eids = info.routes.map((r) => r.eid)
    expect(eids).toContain(30101)
    expect(eids).toContain(30110)
    const eth = info.routes.find((r) => r.eid === 30101)!
    expect(bytes32ToAddress(eth.peer as `0x${string}`)).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('sUSDe is a self-OFT that sends to Ethereum', async () => {
    const { info } = await probeOft(plasma(), SUSDE_PLASMA, evmByKey('plasma').endpointV2)
    if (info.vm !== 'evm') throw new Error('expected evm')
    expect(info.token).toBe(SUSDE_PLASMA)
    expect(info.routes.map((r) => r.eid)).toContain(30101)
  })

  it('quotes a real USD₮0 send to Ethereum', async () => {
    const { info } = await probeOft(plasma(), USDT0_ADAPTER_PLASMA, evmByKey('plasma').endpointV2)
    const plan = await buildSendPlan(plasma(), {
      info,
      src: evmByKey('plasma'),
      dstEid: 30101,
      amountInput: '1',
      sender: SOMEONE,
      recipient: evmRecipient(SOMEONE),
    })
    expect(plan.quote.nativeFee).toBeGreaterThan(0n)
    expect(plan.quote.amountReceivedLD).toBeGreaterThan(0n)
    expect(plan.value).toBeGreaterThanOrEqual(plan.quote.nativeFee)
    // The ceiling is a confirmation, not a refusal — but an ordinary quote must sit well under it.
    expect(plan.value).toBeLessThan(evmByKey('plasma').feeCeiling)
  })
})

describe('Plasma: Chainlink CCIP', () => {
  it('the router and registry answer with the versions the table records, and the lanes exist both ways', async () => {
    const cfg = ccipConfig('plasma')!
    const abi = [{ type: 'function', name: 'typeAndVersion', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const
    const router = await plasma().readContract({ address: getAddress(cfg.router), abi, functionName: 'typeAndVersion' })
    expect(router).toBe(`Router ${cfg.routerVersion}`)
    const tar = await plasma().readContract({ address: getAddress(cfg.tokenAdminRegistry), abi, functionName: 'typeAndVersion' })
    expect(tar).toBe(`TokenAdminRegistry ${cfg.tokenAdminRegistryVersion}`)
    const supported = [{ type: 'function', name: 'isChainSupported', stateMutability: 'view', inputs: [{ type: 'uint64' }], outputs: [{ type: 'bool' }] }] as const
    expect(await plasma().readContract({ address: getAddress(cfg.router), abi: supported, functionName: 'isChainSupported', args: [ccipConfig('ethereum')!.selector] })).toBe(true)
    expect(await ethereum().readContract({ address: getAddress(ccipConfig('ethereum')!.router), abi: supported, functionName: 'isChainSupported', args: [cfg.selector] })).toBe(true)
  })

  it('finds the GHO pool the directory lists, reaching Arbitrum', async () => {
    const d = await discoverCcipToken(plasma(), 'plasma', GHO_PLASMA)
    expect(d.kind).toBe('token')
    if (d.kind !== 'token') return
    expect(d.pool).toBe(GHO_POOL_PLASMA)
    expect(d.routes.map((r) => r.chain)).toContain('arbitrum')
    const remote = await readRemoteSide(plasma(), arbitrum(), d.pool, 'arbitrum', ccipConfig('arbitrum')!.selector)
    expect(remote.token).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(remote.pool).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('Plasma: Hyperlane', () => {
  it('the registry Mailbox answers its domain and version', async () => {
    const cfg = hyperlaneConfig('plasma')!
    expect(await plasma().readContract({ address: getAddress(cfg.mailbox), abi: mailboxAbi, functionName: 'localDomain' })).toBe(cfg.domain)
    expect(await plasma().readContract({ address: getAddress(cfg.mailbox), abi: mailboxAbi, functionName: 'VERSION' })).toBe(3)
  })

  it('a registry hint that is not a Mailbox router is refused by the probe, not offered', async () => {
    const hints = warpRouteHints('plasma', USDT0_TOKEN_PLASMA)
    expect(hints.map((h) => h.router)).toContain(USDT_OFT_BRIDGE_PLASMA)
    const d = await discoverWarpRoute(plasma(), 'plasma', USDT_OFT_BRIDGE_PLASMA)
    expect(d).toEqual({ kind: 'unknown', reason: 'not_a_router' })
  })

  it('ezETH pasted as a token is matched to its xERC20 warp route, which holds exactly it and points back', async () => {
    const hints = warpRouteHints('plasma', EZETH_PLASMA)
    expect(hints.map((h) => h.router)).toContain(EZETH_WARP_ROUTER_PLASMA)
    const d = await discoverWarpRoute(plasma(), 'plasma', EZETH_WARP_ROUTER_PLASMA)
    expect(d.kind).toBe('router')
    if (d.kind !== 'router') return
    expect(d.warpKind).toBe('collateral')
    expect(d.token).toBe(EZETH_PLASMA)
    expect(d.mailbox).toBe(getAddress(hyperlaneConfig('plasma')!.mailbox))
    expect(d.domain).toBe(9745)
    expect(d.routes.map((r) => r.chain)).toEqual(expect.arrayContaining(['ethereum', 'arbitrum', 'base']))
    const route = d.routes.find((r) => r.chain === 'arbitrum')!
    const remote = await readRemoteWarp(arbitrum(), 'arbitrum', route.router, 'plasma', d.router)
    expect(remote.readable).toBe(true)
    expect(remote.mailboxOk).toBe(true)
    expect(remote.pointsBack).toBe(true)
    const plan = await buildHyperlanePlan({ chain: 'plasma', dstChain: 'arbitrum', router: d, remote, sender: SOMEONE, recipient: evmRecipient(SOMEONE), amount: 10n ** 18n, srcClient: plasma() })
    expect(plan.fee).toBeGreaterThan(0n)
    expect(plan.charge).toBeGreaterThanOrEqual(plan.amount)
    expect(plan.value).toBe(plan.fee)
  })
})
