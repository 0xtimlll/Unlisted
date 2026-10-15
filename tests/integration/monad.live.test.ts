/**
 * Monad (143) against mainnet, one describe per protocol tab.
 *
 * Every number in `src/core/chains.ts` and the protocol tables is checked against the chain itself
 * rather than against the document it was copied from: the eid is read off the LayerZero endpoint
 * the OFT names, the Wormhole chain id off the core bridge, the Hyperlane domain off the registry
 * Mailbox, and the CCIP router is asked whether it really carries the routes the directory claims.
 *
 * Read-only — nothing here signs or sends. Public RPCs are flaky, so this project is not part of
 * `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, parseAbi } from 'viem'
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
import { warpRouteHints } from '@/protocols/hyperlane/warpRoutes'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'

/**
 * USD₮0 on Monad: the OFT the Plasma USD₮0 adapter names as its peer for eid 30390 — found by
 * following `peers(30390)` from a contract already verified there, not taken from any list. An
 * adapter over the token that needs no approve, peered to Ethereum, Arbitrum and Plasma.
 */
const USDT0_OFT_MONAD = getAddress('0x9151434b16b9763660705744891fA906F660EcC5')
const USDT0_TOKEN_MONAD = getAddress('0xe7cd86e13AC4309349F30B3435a9d337750fC82D')

/**
 * GHO on Monad, from the CCIP Directory data file (`monad-mainnet`): its pool lists Arbitrum,
 * Base and Ink among its destinations.
 */
const GHO_MONAD = getAddress('0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73')
const GHO_POOL_MONAD = getAddress('0xA5AE05b71c3F170E12E7620Fdf7679721aec1EC8')

/**
 * ezETH on Monad from the registry's `EZETH/renzo-prod` route: a HypXERC20 over the xERC20
 * `0x2416…Eea5`, naming the registry Mailbox and routers on Ethereum, Arbitrum and Base.
 */
const EZETH_WARP_ROUTER_MONAD = getAddress('0x7A911b0bD4F067FB8DAFF734A78E7A72865100d8')
const EZETH_MONAD = getAddress('0x2416092f143378750bb29b79eD961ab195CcEea5')

const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const monad = () => makeReadClient(evmByKey('monad'))
const ethereum = () => makeReadClient(evmByKey('ethereum'))
const arbitrum = () => makeReadClient(evmByKey('arbitrum'))

describe('Monad: the registry entry itself', () => {
  it('every RPC in the registry answers for chain 143', async () => {
    for (const url of evmByKey('monad').rpcUrls) {
      const c = makeReadClient({ ...evmByKey('monad'), rpcUrls: [url] })
      expect(await c.getChainId(), url).toBe(143)
    }
  })

  it('the eid comes from the endpoint the OFT names, not from a table', async () => {
    const { info } = await probeOft(monad(), USDT0_OFT_MONAD, evmByKey('monad').endpointV2)
    expect(info.endpoint.toLowerCase()).toBe(evmByKey('monad').endpointV2.toLowerCase())
    expect(byEid(30390)?.key).toBe('monad')
  })

  it('the Wormhole core bridge answers chain id 48 and carries the same guardian set as Ethereum', async () => {
    const abi = parseAbi(['function chainId() view returns (uint16)', 'function getCurrentGuardianSetIndex() view returns (uint32)', 'function wormhole() view returns (address)'])
    const cfg = WORMHOLE_CHAINS.monad!
    const core = getAddress(cfg.coreBridge)
    expect(await monad().readContract({ address: core, abi, functionName: 'chainId' })).toBe(48)
    const [here, there] = await Promise.all([
      monad().readContract({ address: core, abi, functionName: 'getCurrentGuardianSetIndex' }),
      ethereum().readContract({ address: getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge), abi, functionName: 'getCurrentGuardianSetIndex' }),
    ])
    expect(here).toBe(there)
    const tb = getAddress(cfg.tokenBridge!)
    expect(await monad().readContract({ address: tb, abi, functionName: 'chainId' })).toBe(48)
    expect((await monad().readContract({ address: tb, abi, functionName: 'wormhole' })).toLowerCase()).toBe(core.toLowerCase())
  })
})

describe('Monad: LayerZero OFT', () => {
  it('USD₮0 is an adapter over the token that needs no approve, peered to Ethereum and Arbitrum', async () => {
    const { info } = await probeOft(monad(), USDT0_OFT_MONAD, evmByKey('monad').endpointV2)
    expect(info.vm).toBe('evm')
    if (info.vm !== 'evm') return
    expect(info.token).toBe(USDT0_TOKEN_MONAD)
    expect(info.decimals).toBe(6)
    expect(info.approvalRequired).toBe(false)
    const eids = info.routes.map((r) => r.eid)
    expect(eids).toContain(30101)
    expect(eids).toContain(30110)
    expect(eids).toContain(30383)
    const eth = info.routes.find((r) => r.eid === 30101)!
    expect(bytes32ToAddress(eth.peer as `0x${string}`)).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('quotes a real USD₮0 send to Ethereum, well under the chain ceiling', async () => {
    const { info } = await probeOft(monad(), USDT0_OFT_MONAD, evmByKey('monad').endpointV2)
    const plan = await buildSendPlan(monad(), {
      info,
      src: evmByKey('monad'),
      dstEid: 30101,
      amountInput: '1',
      sender: SOMEONE,
      recipient: evmRecipient(SOMEONE),
    })
    expect(plan.quote.nativeFee).toBeGreaterThan(0n)
    expect(plan.quote.amountReceivedLD).toBeGreaterThan(0n)
    expect(plan.value).toBeGreaterThanOrEqual(plan.quote.nativeFee)
    expect(plan.nativeAmountLD).toBe(0n)
    // The ceiling is a confirmation, not a refusal — but an ordinary quote must sit well under it.
    expect(plan.value).toBeLessThan(evmByKey('monad').feeCeiling)
  })
})

describe('Monad: Chainlink CCIP', () => {
  it('the router and registry answer with the versions the table records, and the lanes exist both ways', async () => {
    const cfg = ccipConfig('monad')!
    const abi = [{ type: 'function', name: 'typeAndVersion', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const
    expect(await monad().readContract({ address: getAddress(cfg.router), abi, functionName: 'typeAndVersion' })).toBe(`Router ${cfg.routerVersion}`)
    expect(await monad().readContract({ address: getAddress(cfg.tokenAdminRegistry), abi, functionName: 'typeAndVersion' })).toBe(`TokenAdminRegistry ${cfg.tokenAdminRegistryVersion}`)
    const supported = [{ type: 'function', name: 'isChainSupported', stateMutability: 'view', inputs: [{ type: 'uint64' }], outputs: [{ type: 'bool' }] }] as const
    expect(await monad().readContract({ address: getAddress(cfg.router), abi: supported, functionName: 'isChainSupported', args: [ccipConfig('ethereum')!.selector] })).toBe(true)
    expect(await ethereum().readContract({ address: getAddress(ccipConfig('ethereum')!.router), abi: supported, functionName: 'isChainSupported', args: [cfg.selector] })).toBe(true)
  })

  it('finds the GHO pool the directory lists, reaching Arbitrum', async () => {
    const d = await discoverCcipToken(monad(), 'monad', GHO_MONAD)
    expect(d.kind).toBe('token')
    if (d.kind !== 'token') return
    expect(d.pool).toBe(GHO_POOL_MONAD)
    expect(d.routes.map((r) => r.chain)).toContain('arbitrum')
    const remote = await readRemoteSide(monad(), arbitrum(), d.pool, 'arbitrum', ccipConfig('arbitrum')!.selector)
    expect(remote.token).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(remote.pool).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('Monad: Hyperlane', () => {
  it('the registry Mailbox answers its domain and version', async () => {
    const cfg = hyperlaneConfig('monad')!
    expect(await monad().readContract({ address: getAddress(cfg.mailbox), abi: mailboxAbi, functionName: 'localDomain' })).toBe(cfg.domain)
    expect(await monad().readContract({ address: getAddress(cfg.mailbox), abi: mailboxAbi, functionName: 'VERSION' })).toBe(3)
  })

  it('ezETH pasted as a token is matched to its xERC20 warp route, which holds exactly it and points back', async () => {
    const hints = warpRouteHints('monad', EZETH_MONAD)
    expect(hints.map((h) => h.router)).toContain(EZETH_WARP_ROUTER_MONAD)
    const d = await discoverWarpRoute(monad(), 'monad', EZETH_WARP_ROUTER_MONAD)
    expect(d.kind).toBe('router')
    if (d.kind !== 'router') return
    expect(d.warpKind).toBe('collateral')
    expect(d.token).toBe(EZETH_MONAD)
    expect(d.mailbox).toBe(getAddress(hyperlaneConfig('monad')!.mailbox))
    expect(d.domain).toBe(143)
    expect(d.routes.map((r) => r.chain)).toEqual(expect.arrayContaining(['ethereum', 'arbitrum']))
    const route = d.routes.find((r) => r.chain === 'arbitrum')!
    const remote = await readRemoteWarp(arbitrum(), 'arbitrum', route.router, 'monad', d.router)
    expect(remote.readable).toBe(true)
    expect(remote.mailboxOk).toBe(true)
    expect(remote.pointsBack).toBe(true)
  })
})
