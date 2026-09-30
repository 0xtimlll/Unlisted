/**
 * Robinhood Chain (4663) against mainnet, one describe per protocol tab.
 *
 * Every number in `src/core/chains.ts` and the two protocol tables is checked against the chain
 * itself rather than against the document it was copied from: the eid is read off the LayerZero
 * endpoint the OFT names, the Wormhole chain id off the core bridge, and the CCIP router is asked
 * whether it really carries the routes the directory claims.
 *
 * Read-only — nothing here signs or sends. Public RPCs are flaky, so this project is not part of
 * `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, parseAbi } from 'viem'
import { byEid, evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { buildSendPlan } from '@/core/plan'
import { probeOft } from '@/core/probe'
import { clientPair, probeOftQuorum } from '@/core/quorum'
import { evmRecipient } from '@/core/recipient'
import { ccipConfig } from '@/protocols/ccip/chains'
import { discoverCcipToken, readRemoteSide } from '@/protocols/ccip/discover'
import { buildCcipPlan } from '@/protocols/ccip/plan'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'

/**
 * DEGEN on Robinhood Chain: a plain OFT (token() is itself) with peers on both Ethereum and
 * Arbitrum, found by decoding the senders of `PacketSent` on the chain's own EndpointV2 rather
 * than taken from any list — LayerZero's curated OFT list has no Robinhood entry at all.
 */
const DEGEN_ROBINHOOD = getAddress('0x0830a9dd26a04e959657ab6788d45f5725590c32')
const DEGEN_ETHEREUM = getAddress('0xfee293840d23b0b2de8c55e1cf7a9f01c157767c')
const DEGEN_ARBITRUM = getAddress('0x9f07f8a82cb1af1466252e505b7b7ddee103bc91')

/**
 * BWLK (Boardwalk): its Robinhood pool is the one that actually answers `getSupportedChains()`
 * with both Ethereum and Arbitrum. Being listed on two chains in the CCIP Directory is not the
 * same as the two pools being wired to each other — syrupUSDC is listed on Robinhood and Arbitrum
 * but its pool here reaches only Ethereum, so the chain, not the directory, decides.
 */
const BWLK = getAddress('0x8b7dAF8ca650Ab30dF4c686e1E3689E9248732C6')

const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const robinhood = () => makeReadClient(evmByKey('robinhood'))
const ethereum = () => makeReadClient(evmByKey('ethereum'))
const arbitrum = () => makeReadClient(evmByKey('arbitrum'))

describe('Robinhood Chain: the registry entry itself', () => {
  it('every RPC in the registry answers for chain 4663', async () => {
    for (const url of evmByKey('robinhood').rpcUrls) {
      const c = makeReadClient({ ...evmByKey('robinhood'), rpcUrls: [url] })
      expect(await c.getChainId(), url).toBe(4663)
    }
  })

  it('the eid comes from the endpoint the OFT names, not from a table', async () => {
    const { info } = await probeOft(robinhood(), DEGEN_ROBINHOOD, evmByKey('robinhood').endpointV2)
    const eid = await robinhood().readContract({
      address: info.endpoint,
      abi: parseAbi(['function eid() view returns (uint32)']),
      functionName: 'eid',
    })
    expect(eid).toBe(evmByKey('robinhood').eid)
    expect(eid).toBe(30416)
  })

  it('Multicall3 is deployed, so batched reads are real batches', async () => {
    const code = await robinhood().getCode({ address: '0xcA11bde05977b3631167028862bE2a173976CA11' })
    expect(code && code !== '0x').toBe(true)
  })
})

describe('Robinhood Chain: the OFT tab', () => {
  it('reads a real OFT from its address alone, with both destinations', async () => {
    const r = await probeOftQuorum(clientPair(evmByKey('robinhood')), DEGEN_ROBINHOOD)
    expect(r.info.kind).toBe('OFT')
    expect(r.info.symbol).toBe('DEGEN')
    expect(r.info.decimals).toBe(18)
    expect(r.info.sharedDecimals).toBe(6)
    expect(r.info.approvalRequired).toBe(false)
    // Two unrelated providers had to agree before this address could ever be a spender.
    expect(r.crossChecked).toBe(true)

    const routes = new Map(r.info.routes.map((x) => [x.eid, x.peer]))
    expect(routes.has(30101)).toBe(true)
    expect(routes.has(30110)).toBe(true)
    // The peer is the same token on the other side, which is what makes the route real.
    expect(routes.get(30101)?.toLowerCase()).toContain(DEGEN_ETHEREUM.slice(2).toLowerCase())
    expect(routes.get(30110)?.toLowerCase()).toContain(DEGEN_ARBITRUM.slice(2).toLowerCase())
  })

  it('quotes Robinhood -> Ethereum and Robinhood -> Arbitrum without sending anything', async () => {
    const client = robinhood()
    const { info } = await probeOft(client, DEGEN_ROBINHOOD, evmByKey('robinhood').endpointV2)
    for (const dstEid of [30101, 30110]) {
      const plan = await buildSendPlan(client, {
        info,
        src: evmByKey('robinhood'),
        dstEid,
        amountInput: '1',
        sender: SOMEONE,
        recipient: evmRecipient(SOMEONE),
      })
      expect(plan.quote.nativeFee, `eid ${dstEid}`).toBeGreaterThan(0n)
      expect(plan.quote.amountReceivedLD, `eid ${dstEid}`).toBeGreaterThan(0n)
      // The ceiling is a confirmation, not a refusal — but an ordinary quote must sit well under it.
      expect(plan.value, `eid ${dstEid}`).toBeLessThan(evmByKey('robinhood').feeCeiling)
      expect(byEid(dstEid)?.vm).toBe('evm')
    }
  })

  it('is reachable from the other side: Ethereum and Arbitrum both peer back to 30416', async () => {
    const fromEth = await probeOft(ethereum(), DEGEN_ETHEREUM, evmByKey('ethereum').endpointV2)
    const fromArb = await probeOft(arbitrum(), DEGEN_ARBITRUM, evmByKey('arbitrum').endpointV2)
    expect(fromEth.info.routes.map((r) => r.eid)).toContain(30416)
    expect(fromArb.info.routes.map((r) => r.eid)).toContain(30416)
  })
})

describe('Robinhood Chain: the CCIP tab', () => {
  it('finds the pool through the registry in our config, and the chains it reaches', async () => {
    const d = await discoverCcipToken(robinhood(), 'robinhood', BWLK)
    expect(d.kind).toBe('token')
    if (d.kind !== 'token') return
    expect(d.decimals).toBe(18)
    const reached = d.routes.map((r) => r.chain)
    expect(reached).toContain('ethereum')
    expect(reached).toContain('arbitrum')
    for (const r of d.routes) expect(ccipConfig(r.chain)?.selector).toBe(r.selector)
  })

  it('quotes Robinhood -> Ethereum and Robinhood -> Arbitrum, msg.value exactly the fee', async () => {
    const src = robinhood()
    const d = await discoverCcipToken(src, 'robinhood', BWLK)
    if (d.kind !== 'token') throw new Error('expected a pool')

    for (const [dstChain, dst] of [['ethereum', ethereum()], ['arbitrum', arbitrum()]] as const) {
      const remote = await readRemoteSide(src, dst, d.pool, dstChain, ccipConfig(dstChain)!.selector)
      const plan = await buildCcipPlan({
        chain: 'robinhood',
        dstChain,
        dstSelector: ccipConfig(dstChain)!.selector,
        token: d.token,
        tokenSymbol: 'BWLK',
        decimals: d.decimals,
        pool: d.pool,
        remote,
        sender: SOMEONE,
        recipient: evmRecipient(SOMEONE),
        amount: 10n ** 18n,
        srcClient: src,
        dstClient: dst,
      })

      expect(plan.router, dstChain).toBe(getAddress(ccipConfig('robinhood')!.router))
      expect(plan.fee, dstChain).toBeGreaterThan(0n)
      expect(plan.value, dstChain).toBe(plan.fee) // the router keeps the whole msg.value
      expect(plan.message.data, dstChain).toBe('0x')
    }
  })
})

describe('Robinhood Chain: the NTT tab', () => {
  it('the core bridge in the table is the one that answers for chain 72', async () => {
    const cfg = WORMHOLE_CHAINS.robinhood!
    expect(cfg.wormholeChainId).toBe(72)
    const onChain = await robinhood().readContract({
      address: getAddress(cfg.coreBridge),
      abi: parseAbi(['function chainId() view returns (uint16)']),
      functionName: 'chainId',
    })
    expect(onChain).toBe(cfg.wormholeChainId)
  })

  it('the guardians that sign for this chain are the current set, not a stale one', async () => {
    const abi = parseAbi(['function getCurrentGuardianSetIndex() view returns (uint32)'])
    const [here, onEthereum] = await Promise.all([
      robinhood().readContract({ address: getAddress(WORMHOLE_CHAINS.robinhood!.coreBridge), abi, functionName: 'getCurrentGuardianSetIndex' }),
      ethereum().readContract({ address: getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge), abi, functionName: 'getCurrentGuardianSetIndex' }),
    ])
    expect(here).toBe(onEthereum)
  })
})
