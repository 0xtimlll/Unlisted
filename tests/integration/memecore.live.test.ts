/**
 * MemeCore (4352): a chain WITHOUT Multicall3 at its canonical address. Before the registry learned
 * that (networks.ts `multicall3`), every batched read there failed and a real OFT read as "not an
 * OFT". The fixture is the native-coin adapter for M, found from PacketSent logs on MemeCore's own
 * EndpointV2 (routes to Base and BNB Chain), so the probe, the plan and the simulation below all go
 * through the deployless batch.
 *
 * Read-only. MemeCore has one public RPC operator, so the cross-check cannot run there.
 */
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { evmByKey } from '@/core/chains'
import { makeReadClient, toViemChain } from '@/core/client'
import { assembleSendArgs, buildSendPlan, msgValue } from '@/core/plan'
import { clientPair, probeOftQuorum } from '@/core/quorum'
import { evmRecipient } from '@/core/recipient'
import { simulateSend } from '@/core/sim/preview'

const M_ADAPTER = '0x7675fa143b2b8175292e7a9f6e31030aafeeb1e1' as Address
const SOMEONE = '0x000000000000000000000000000000000000dEaD' as Address

describe('MemeCore: no Multicall3, reads batch deploylessly', () => {
  const memecore = evmByKey('memecore' as never)

  it('the registry knows there is no Multicall3, and the viem chain does not claim one', () => {
    expect(memecore.multicall3).toBe(false)
    expect(toViemChain(memecore).contracts?.multicall3).toBeUndefined()
  })

  it('probes the native M adapter: the batched reads answer', async () => {
    const r = await probeOftQuorum(clientPair(memecore), M_ADAPTER)
    expect(r.info.kind).toBe('NativeOFTAdapter')
    expect(r.info.endpoint.toLowerCase()).toBe(memecore.endpointV2.toLowerCase())
    expect(r.info.routes.map((x) => x.eid)).toContain(evmByKey('base').eid)
  })

  it('quotes and simulates a 1 M send to Base', async () => {
    const r = await probeOftQuorum(clientPair(memecore), M_ADAPTER)
    const client = makeReadClient(memecore)
    const plan = await buildSendPlan(client, { info: r.info, src: memecore, dstEid: evmByKey('base').eid, amountInput: '1', sender: SOMEONE, recipient: evmRecipient(SOMEONE) })
    expect(plan.nativeAmountLD).toBe(10n ** 18n)
    expect(plan.value > 0n).toBe(true)
    const sim = await simulateSend(client, { account: SOMEONE, oft: plan.oft, sendArgs: assembleSendArgs(plan), value: msgValue(plan), chainId: memecore.chainId })
    // 0xdead holds no M, so the run reverts or the node says it cannot pay — either way the node
    // ANSWERED the batched reads that built the plan, which is what this file exists to prove.
    expect(['unknown', true, false]).toContain(sim.ok)
  })
})
