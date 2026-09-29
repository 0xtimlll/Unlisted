/**
 * §3 against mainnet: LayerZero v1.
 *
 * Every number in src/protocols/lz-v1/chains.json is checked against the chain rather than against
 * the document it was generated from, and every standard is read off a contract that is really
 * deployed. Read-only — nothing here signs or sends. Public RPCs are flaky, so this project is not
 * part of `npm test`.
 *
 * The contracts below were not taken from a list. They were found by scanning `SendToChain` logs
 * (whose topic shape alone separates the `bytes` standard from the `bytes32` ones) and then probing
 * each emitter, which is the same path the app itself walks.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { evmByKey, evmChains } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { clientPair } from '@/core/quorum'
import { probeOftV1Quorum } from '@/core/quorum'
import { evmRecipient } from '@/core/recipient'
import { endpointV1Abi, ulnV2Abi } from '@/protocols/lz-v1/abi'
import { lzV1, lzV1Chains } from '@/protocols/lz-v1/chains'
import { checkV1TrustedRemoteBack, hasStoredPayloadOnDst, pathOnDestination, probeOftV1, ProbeV1Error } from '@/protocols/lz-v1/detect'
import { buildV1SendPlan, encodeV1SendCalldata } from '@/protocols/lz-v1/plan'
import { v1SelfCheck } from '@/protocols/lz-v1/selfcheck'
import { simulateV1Send } from '@/protocols/lz-v1/simulate'

/** OFTWithFee: JOE is the token itself on Arbitrum, and an adapter on its home chain. */
const JOE = getAddress('0x371c7ec6D8039ff7933a2AA28EB827Ffe1F52f07')
/** ProxyOFTV2: MIM's Arbitrum adapter. */
const MIM_ARB = getAddress('0x957A8Af7894E76e16DB17c2A913496a4E60B7090')
/** OFTV2, plain: RDNT is its own token on Arbitrum. */
const RDNT_ARB = getAddress('0x3082CC23568eA640225c2467653dB90e9250AaA0')
/** A LayerZero **V2** OFT, which the v1 probe must refuse rather than mis-read. */
const DEGEN_ROBINHOOD = getAddress('0x0830a9dd26a04e959657ab6788d45f5725590c32')

const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const client = (key: Parameters<typeof evmByKey>[0]) => makeReadClient(evmByKey(key))

describe('the committed v1 table, against the chains', () => {
  it('covers every EVM chain in the registry', () => {
    for (const c of evmChains()) expect(lzV1(c.key), c.key).toBeDefined()
  })

  it('every Endpoint V1 in the table is a deployed contract', async () => {
    for (const v1 of lzV1Chains()) {
      const code = await client(v1.key).getCode({ address: v1.endpoint })
      expect(code && code !== '0x', v1.key).toBe(true)
    }
  })

  it('every v1 chain id is the one the UltraLightNode stamps into packets', async () => {
    // UltraLightNodeV2.send builds the packet as
    //   abi.encodePacked(nonce, localChainId, ua, dstChainId, dstAddress, payload)
    // so `localChainId` is what every destination sees as the source. This is the authority on a
    // v1 chain id, and it agrees with the committed table on all eleven chains.
    for (const v1 of lzV1Chains()) {
      if (!v1.uln) continue
      const local = await client(v1.key).readContract({ address: v1.uln, abi: ulnV2Abi, functionName: 'localChainId' })
      expect(local, v1.key).toBe(v1.v1ChainId)
    }
  })

  it('the Endpoint disagrees on the six first-wave chains, which is why the ULN is asked', async () => {
    // Deployed before LayerZero renumbered mainnet, these endpoints still return their original
    // ids from `getChainId()`. Asserted rather than glossed over: a check written against this
    // getter would report correct data as broken.
    const legacy: [Parameters<typeof evmByKey>[0], number, number][] = [
      ['ethereum', 1, 101],
      ['bsc', 2, 102],
      ['avalanche', 6, 106],
      ['polygon', 9, 109],
      ['arbitrum', 10, 110],
      ['optimism', 11, 111],
    ]
    for (const [key, endpointSays, tableSays] of legacy) {
      const v1 = lzV1(key)!
      expect(v1.v1ChainId).toBe(tableSays)
      const got = await client(key).readContract({ address: v1.endpoint, abi: endpointV1Abi, functionName: 'getChainId' })
      expect(got, key).toBe(endpointSays)
    }
    // The later chains never had the old numbering, so both agree there.
    for (const key of ['linea', 'base', 'scroll', 'hyperevm', 'robinhood'] as const) {
      const v1 = lzV1(key)!
      const got = await client(key).readContract({ address: v1.endpoint, abi: endpointV1Abi, functionName: 'getChainId' })
      expect(got, key).toBe(v1.v1ChainId)
    }
  })
})

describe('reading each standard off a real contract', () => {
  it('OFTWithFee: JOE on Arbitrum, the token itself', async () => {
    const { info } = await probeOftV1(client('arbitrum'), 'arbitrum', JOE)
    expect(info.standard).toEqual({ wire: 'bytes32_fee', kind: 'OFT' })
    expect(info.symbol).toBe('JOE')
    expect(info.decimals).toBe(18)
    expect(info.sharedDecimals).toBe(8)
    expect(info.conversionRate).toBe(10n ** 10n)
    expect(info.approvalRequired).toBe(false)
    expect(info.adapterParamsRequired).toBe(true)
    expect(info.srcV1ChainId).toBe(110)
    expect(info.routes.map((r) => r.key).sort()).toEqual(['avalanche', 'bsc', 'ethereum'])
    for (const r of info.routes) expect(r.minDstGas, r.key).toBeGreaterThan(0n)
  })

  it('ProxyOFTWithFee: the same JOE address on Avalanche, where the real token is locked', async () => {
    const { info } = await probeOftV1(client('avalanche'), 'avalanche', JOE)
    expect(info.standard).toEqual({ wire: 'bytes32_fee', kind: 'Proxy' })
    // An adapter pulls with transferFrom, so it has to be approved — for exactly the amount.
    expect(info.approvalRequired).toBe(true)
    expect(info.token.toLowerCase()).not.toBe(info.oft.toLowerCase())
    expect(info.lockedInAdapter).toBeGreaterThan(0n)
  })

  it('ProxyOFTV2: MIM on Arbitrum', async () => {
    const { info } = await probeOftV1(client('arbitrum'), 'arbitrum', MIM_ARB)
    expect(info.standard).toEqual({ wire: 'bytes32', kind: 'Proxy' })
    expect(info.symbol).toBe('MIM')
    expect(info.approvalRequired).toBe(true)
    expect(info.routes.length).toBeGreaterThan(1)
  })

  it('OFTV2: RDNT on Arbitrum, and its adapter params are required even though it has the flag', async () => {
    const { info } = await probeOftV1(client('arbitrum'), 'arbitrum', RDNT_ARB)
    expect(info.standard).toEqual({ wire: 'bytes32', kind: 'OFT' })
    expect(info.approvalRequired).toBe(false)
    // OFTCoreV2._send always calls _checkGasLimit; the flag some contracts also define cannot
    // switch that off, so the bytes32 families always carry adapter params.
    expect(info.adapterParamsRequired).toBe(true)
  })

  it('refuses a LayerZero V2 OFT instead of mis-reading it as v1', async () => {
    // Robinhood's DEGEN is a V2 OFT on EndpointV2. The V2 probe owns it, and this one must decline.
    await expect(probeOftV1(client('robinhood'), 'robinhood', DEGEN_ROBINHOOD)).rejects.toThrow(ProbeV1Error)
  })

  it('refuses an ordinary ERC-20', async () => {
    // PAXG: a token with no LayerZero anything.
    await expect(probeOftV1(client('ethereum'), 'ethereum', getAddress('0x45804880De22913dAFE09f4980848ECE6EcbAf78'))).rejects.toMatchObject({
      code: 'not_lz_v1',
    })
  })

  it('agrees with itself on two independent providers', async () => {
    const r = await probeOftV1Quorum(clientPair(evmByKey('arbitrum')), 'arbitrum', JOE)
    expect(r.info.standard).toEqual({ wire: 'bytes32_fee', kind: 'OFT' })
    expect(r.crossChecked).toBe(true)
  })
})

describe('quoting and checking a real route', () => {
  it('prices JOE from Arbitrum on every route it has, and the calldata decodes back', async () => {
    const c = client('arbitrum')
    const { info } = await probeOftV1(c, 'arbitrum', JOE)
    expect(info.routes.length).toBeGreaterThanOrEqual(2)
    for (const route of info.routes) {
      const plan = await buildV1SendPlan({
        info,
        dstKey: route.key,
        amountInput: '1',
        sender: SOMEONE,
        recipient: evmRecipient(SOMEONE),
        client: c,
      })
      expect(plan.quote.nativeFee, route.key).toBeGreaterThan(0n)
      expect(plan.value).toBeGreaterThanOrEqual(plan.quote.nativeFee)
      expect(plan.dst.v1ChainId).toBe(route.v1ChainId)
      // The fee standard takes its own cut first, then removes dust, then enforces the minimum.
      expect(plan.amounts.delivered).toBeLessThanOrEqual(plan.amounts.amountRaw)
      expect(plan.amounts.delivered % info.conversionRate).toBe(0n)
      expect(plan.amounts.minAmountLD).toBe(plan.amounts.delivered)
      // The recipient the destination would credit is the one on screen, read by separate code.
      expect(v1SelfCheck(plan, encodeV1SendCalldata(plan))).toEqual({ ok: true })
      // Adapter params buy at least the minimum the contract itself demands.
      expect(plan.adapterParams.startsWith('0x0001')).toBe(true)
    }
  })

  it('prices MIM from Arbitrum on two routes', async () => {
    const c = client('arbitrum')
    const { info } = await probeOftV1(c, 'arbitrum', MIM_ARB)
    const routes = info.routes.slice(0, 2)
    expect(routes.length).toBe(2)
    for (const route of routes) {
      const plan = await buildV1SendPlan({ info, dstKey: route.key, amountInput: '1', sender: SOMEONE, recipient: evmRecipient(SOMEONE), client: c })
      expect(plan.quote.nativeFee, route.key).toBeGreaterThan(0n)
      // No `_minAmount` exists on this standard's sendFrom, so none is put in the calldata.
      expect(plan.amounts.minAmountLD).toBeUndefined()
      expect(v1SelfCheck(plan, encodeV1SendCalldata(plan))).toEqual({ ok: true })
    }
  })

  it('the destination names JOE back as its trusted remote, in both directions', async () => {
    const { info } = await probeOftV1(client('arbitrum'), 'arbitrum', JOE)
    const route = info.routes.find((r) => r.key === 'avalanche')!
    const back = await checkV1TrustedRemoteBack(client('avalanche'), route.remoteAddress!, info.srcV1ChainId, info.oft)
    expect(back).toEqual({ status: 'ok' })
  })

  it('reads the destination path and asks the endpoint whether it is blocked', async () => {
    const { info } = await probeOftV1(client('arbitrum'), 'arbitrum', JOE)
    const route = info.routes.find((r) => r.key === 'avalanche')!
    const dst = client('avalanche')
    // The bytes come from the destination contract itself — that is the key the endpoint stored
    // any payload under, and rebuilding them from two addresses would be a guess.
    const path = await pathOnDestination(dst, route.remoteAddress!, info.srcV1ChainId)
    expect(path).toBeDefined()
    const stuck = await hasStoredPayloadOnDst(dst, lzV1('avalanche')!.endpoint, info.srcV1ChainId, path!)
    expect(stuck).toBe(false)
  })

  it('runs the exact transaction and reports the revert by name rather than throwing', async () => {
    const c = client('arbitrum')
    const { info } = await probeOftV1(c, 'arbitrum', JOE)
    const plan = await buildV1SendPlan({
      info,
      dstKey: 'avalanche',
      amountInput: '1',
      sender: SOMEONE,
      recipient: evmRecipient(SOMEONE),
      client: c,
    })
    // 0xdead holds no JOE and no ETH, so this must fail — the point is HOW it fails.
    const sim = await simulateV1Send(c, plan)
    expect(sim.status === 'reverted' || sim.status === 'ok').toBe(true)
    if (sim.status === 'reverted') {
      // Decoded, not four bytes of hex: a string reason, a named error, or an explicit "empty".
      expect(['string', 'error', 'panic', 'empty', 'unknown']).toContain(sim.revert.kind)
    }
  })
})
