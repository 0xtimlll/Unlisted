/**
 * Ink (57073) against mainnet, one describe per protocol tab.
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
import { bytes32ToAddress } from '@/core/encoding'
import { buildSendPlan } from '@/core/plan'
import { probeOft } from '@/core/probe'
import { clientPair, probeOftQuorum } from '@/core/quorum'
import { evmRecipient } from '@/core/recipient'
import { ccipConfig } from '@/protocols/ccip/chains'
import { discoverCcipToken, readRemoteSide } from '@/protocols/ccip/discover'
import { buildCcipPlan } from '@/protocols/ccip/plan'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'

/**
 * USD₮0 on Ink: an OFT adapter over the token, and by far the busiest sender on the chain's own
 * EndpointV2 — found by decoding `PacketSent` there (29 of the 58 packets in two days), not taken
 * from any list. Its peers include Ethereum (30101) and Arbitrum (30110).
 */
const USDT0_ADAPTER_INK = getAddress('0x1cB6De532588fCA4a21B7209DE7C456AF8434A65')
const USDT0_TOKEN_INK = getAddress('0x0200C29006150606B650577BBE7B6248F58470c1')

/** rsETH on Ink: a self-OFT (token() is itself) that sends to Ethereum. Found the same way. */
const RSETH_INK = getAddress('0xc3eACf0612346366Db554C991D7858716db09f58')

/**
 * GHO on Ink, from the CCIP Directory data file (`ethereum-mainnet-ink-1`): its pool answers
 * `getSupportedChains()` with Ethereum and Arbitrum among nine selectors, which is what makes the
 * two routes below real rather than listed.
 */
const GHO_INK = getAddress('0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73')
const GHO_POOL_INK = getAddress('0xDe6539018B095353A40753Dc54C91C68c9487D4E')

const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const ink = () => makeReadClient(evmByKey('ink'))
const ethereum = () => makeReadClient(evmByKey('ethereum'))
const arbitrum = () => makeReadClient(evmByKey('arbitrum'))

describe('Ink: the registry entry itself', () => {
  it('every RPC in the registry answers for chain 57073', async () => {
    for (const url of evmByKey('ink').rpcUrls) {
      const c = makeReadClient({ ...evmByKey('ink'), rpcUrls: [url] })
      expect(await c.getChainId(), url).toBe(57073)
    }
  })

  it('the eid comes from the endpoint the OFT names, not from a table', async () => {
    const { info } = await probeOft(ink(), USDT0_ADAPTER_INK, evmByKey('ink').endpointV2)
    const eid = await ink().readContract({
      address: info.endpoint,
      abi: parseAbi(['function eid() view returns (uint32)']),
      functionName: 'eid',
    })
    expect(eid).toBe(evmByKey('ink').eid)
    expect(eid).toBe(30339)
  })

  it('Multicall3 is deployed, so batched reads are real batches', async () => {
    const code = await ink().getCode({ address: '0xcA11bde05977b3631167028862bE2a173976CA11' })
    expect(code && code !== '0x').toBe(true)
  })

  it('produces a block about every second, which the ETA hint relies on', async () => {
    const c = ink()
    const latest = await c.getBlock()
    const earlier = await c.getBlock({ blockNumber: latest.number - 60n })
    const secondsPerBlock = Number(latest.timestamp - earlier.timestamp) / 60
    expect(secondsPerBlock).toBeGreaterThan(0.5)
    expect(secondsPerBlock).toBeLessThan(2)
  })
})

describe('Ink: the OFT tab', () => {
  it('reads a real OFT adapter from its address alone, with Ethereum and Arbitrum among its routes', async () => {
    const r = await probeOftQuorum(clientPair(evmByKey('ink')), USDT0_ADAPTER_INK)
    expect(r.info.kind).toBe('OFTAdapter')
    expect(r.info.token).toBe(USDT0_TOKEN_INK)
    expect(r.info.decimals).toBe(6)
    // Read, never assumed: USD₮0's OFT is a `token() != self` contract that nevertheless burns the
    // token directly and answers approvalRequired() false — so the app shows no Approve step.
    expect(r.info.approvalRequired, 'approvalRequired').toBe(false)
    // Two unrelated operators (Gelato, QuickNode or drpc) had to agree before this address could
    // ever be a spender.
    expect(r.crossChecked, 'crossChecked').toBe(true)

    const eids = r.info.routes.map((x) => x.eid)
    expect(eids).toContain(30101)
    expect(eids).toContain(30110)
  })

  it('reads a self-OFT too', async () => {
    const { info } = await probeOft(ink(), RSETH_INK, evmByKey('ink').endpointV2)
    expect(info.kind).toBe('OFT')
    expect(info.symbol).toBe('rsETH')
    expect(info.routes.map((x) => x.eid)).toContain(30101)
  })

  it('quotes Ink -> Ethereum and Ink -> Arbitrum without sending anything', async () => {
    const client = ink()
    const { info } = await probeOft(client, USDT0_ADAPTER_INK, evmByKey('ink').endpointV2)
    for (const dstEid of [30101, 30110]) {
      const plan = await buildSendPlan(client, {
        info,
        src: evmByKey('ink'),
        dstEid,
        amountInput: '1',
        sender: SOMEONE,
        recipient: evmRecipient(SOMEONE),
      })
      expect(plan.quote.nativeFee, `eid ${dstEid}`).toBeGreaterThan(0n)
      expect(plan.quote.amountReceivedLD, `eid ${dstEid}`).toBeGreaterThan(0n)
      // The ceiling is a confirmation, not a refusal — but an ordinary quote must sit well under it.
      expect(plan.value, `eid ${dstEid}`).toBeLessThan(evmByKey('ink').feeCeiling)
      expect(byEid(dstEid)?.vm).toBe('evm')
    }
  })

  it('is reachable from the other side: the peers on Ethereum and Arbitrum peer back to 30339', async () => {
    const { info } = await probeOft(ink(), USDT0_ADAPTER_INK, evmByKey('ink').endpointV2)
    const peerOn = (eid: number) => {
      const peer = info.routes.find((x) => x.eid === eid)?.peer
      const addr = peer ? bytes32ToAddress(peer) : undefined
      if (!addr) throw new Error(`no EVM peer for ${eid}`)
      return addr
    }
    const fromEth = await probeOft(ethereum(), peerOn(30101), evmByKey('ethereum').endpointV2)
    const fromArb = await probeOft(arbitrum(), peerOn(30110), evmByKey('arbitrum').endpointV2)
    expect(fromEth.info.routes.map((r) => r.eid)).toContain(30339)
    expect(fromArb.info.routes.map((r) => r.eid)).toContain(30339)
  })
})

describe('Ink: the CCIP tab', () => {
  it('finds the pool through the registry in our config, and the chains it reaches', async () => {
    const d = await discoverCcipToken(ink(), 'ink', GHO_INK)
    expect(d.kind).toBe('token')
    if (d.kind !== 'token') return
    expect(d.pool).toBe(GHO_POOL_INK)
    expect(d.decimals).toBe(18)
    const reached = d.routes.map((r) => r.chain)
    expect(reached).toContain('ethereum')
    expect(reached).toContain('arbitrum')
    for (const r of d.routes) expect(ccipConfig(r.chain)?.selector).toBe(r.selector)
  })

  it('the router carries Ink <-> Ethereum in both directions, as the directory claims', async () => {
    const abi = parseAbi(['function isChainSupported(uint64) view returns (bool)'])
    const [fromInk, fromEth] = await Promise.all([
      ink().readContract({ address: getAddress(ccipConfig('ink')!.router), abi, functionName: 'isChainSupported', args: [ccipConfig('ethereum')!.selector] }),
      ethereum().readContract({ address: getAddress(ccipConfig('ethereum')!.router), abi, functionName: 'isChainSupported', args: [ccipConfig('ink')!.selector] }),
    ])
    expect(fromInk).toBe(true)
    expect(fromEth).toBe(true)
  })

  it('quotes Ink -> Ethereum and Ink -> Arbitrum, msg.value exactly the fee', async () => {
    const src = ink()
    const d = await discoverCcipToken(src, 'ink', GHO_INK)
    if (d.kind !== 'token') throw new Error('expected a pool')

    for (const [dstChain, dst] of [['ethereum', ethereum()], ['arbitrum', arbitrum()]] as const) {
      const remote = await readRemoteSide(src, dst, d.pool, dstChain, ccipConfig(dstChain)!.selector)
      const plan = await buildCcipPlan({
        chain: 'ink',
        dstChain,
        dstSelector: ccipConfig(dstChain)!.selector,
        token: d.token,
        tokenSymbol: 'GHO',
        decimals: d.decimals,
        pool: d.pool,
        remote,
        sender: SOMEONE,
        recipient: evmRecipient(SOMEONE),
        amount: 10n ** 18n,
        srcClient: src,
        dstClient: dst,
      })

      expect(plan.router, dstChain).toBe(getAddress(ccipConfig('ink')!.router))
      expect(plan.fee, dstChain).toBeGreaterThan(0n)
      expect(plan.value, dstChain).toBe(plan.fee) // the router keeps the whole msg.value
      expect(plan.message.data, dstChain).toBe('0x')
    }
  })
})

describe('Ink: the NTT tab', () => {
  it('the core bridge in the table is the one that answers for chain 46', async () => {
    const cfg = WORMHOLE_CHAINS.ink!
    expect(cfg.wormholeChainId).toBe(46)
    const onChain = await ink().readContract({
      address: getAddress(cfg.coreBridge),
      abi: parseAbi(['function chainId() view returns (uint16)']),
      functionName: 'chainId',
    })
    expect(onChain).toBe(cfg.wormholeChainId)
  })

  it('the token bridge in the table names that core bridge, so Portal transfers can be told apart', async () => {
    const cfg = WORMHOLE_CHAINS.ink!
    const core = await ink().readContract({
      address: getAddress(cfg.tokenBridge!),
      abi: parseAbi(['function wormhole() view returns (address)']),
      functionName: 'wormhole',
    })
    expect(getAddress(core)).toBe(getAddress(cfg.coreBridge))
  })

  it('the guardians that sign for this chain are the current set, not a stale one', async () => {
    const abi = parseAbi(['function getCurrentGuardianSetIndex() view returns (uint32)'])
    const [here, onEthereum] = await Promise.all([
      ink().readContract({ address: getAddress(WORMHOLE_CHAINS.ink!.coreBridge), abi, functionName: 'getCurrentGuardianSetIndex' }),
      ethereum().readContract({ address: getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge), abi, functionName: 'getCurrentGuardianSetIndex' }),
    ])
    expect(here).toBe(onEthereum)
  })
})
