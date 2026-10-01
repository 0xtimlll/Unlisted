/**
 * §4 for V2, against a scripted pair of clients: what the checks ask, and whom.
 *
 * The thread through every case is CLAUDE.md rule 3. The destination contract is reached through
 * the source's `peers()`, so what it says — its endpoint, its events — is the examined party's own
 * claim. The checks here are held to the committed registry endpoint for every destination read,
 * to the endpoint's own `quote` for the fee, and to the endpoint's `inboundNonce` for history.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { evmByKey } from '@/core/chains'
import { addressToBytes32 } from '@/core/encoding'
import { assessRisk } from '@/protocols/lz-risk/risk'
import { assessV2Route, combineOptionsV2, type V2RiskContext } from '@/protocols/lz-risk/v2'
import { ENDPOINT_HYPER, ETH_EID, NATIVE_FEE, OTHER, TREAD_ADAPTER, TREAD_OFT, treadOftInfo, treadPlan } from './fixtures'

const REGISTRY_ETH_ENDPOINT = evmByKey('ethereum').endpointV2
const DVN_A = getAddress('0x589dEDbD617e0CBcB916A9223F4d1300c294236b') // LayerZero Labs on Ethereum, in the committed table
const DVN_B = getAddress('0x2f55C492897526677C5B68fb199ea31E2c126416') // not in the table for HyperEVM: the shape is 'unknown', a caution at most

type Read = { address: Address; functionName: string; args?: readonly unknown[] }
type Script = (r: Read) => unknown

/** A client whose reads follow a script and whose other calls are benign; every read is logged. */
function client(script: Script, log: Read[] = []): ReadClient {
  return {
    readContract: async (r: Read) => {
      log.push(r)
      const v = script(r)
      if (v instanceof Error) throw v
      if (v === undefined) throw new Error(`unscripted read: ${r.functionName} on ${r.address}`)
      return v
    },
    call: async () => ({ data: '0x' }),
    estimateGas: async () => 120_000n,
    getLogs: async () => [],
    getBlockNumber: async () => 1_000_000n,
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 30 * 86_400) }),
  } as unknown as ReadClient
}

const uln = { confirmations: 15n, requiredDVNCount: 1, optionalDVNCount: 0, optionalDVNThreshold: 0, requiredDVNs: [] as Address[], optionalDVNs: [] as Address[] }

/** A clean route on both sides. `over` patches single answers by functionName. */
function ctx(over: { src?: Partial<Record<string, unknown>>; dst?: Partial<Record<string, unknown>> } = {}, logs: { src: Read[]; dst: Read[] } = { src: [], dst: [] }): V2RiskContext {
  const info = treadOftInfo()
  const plan = treadPlan()
  const src: Record<string, unknown> = {
    outboundNonce: 7n,
    getSendLibrary: OTHER,
    getUlnConfig: { ...uln, requiredDVNs: [DVN_B] },
    paused: new Error('execution reverted'),
    quote: { nativeFee: NATIVE_FEE, lzTokenFee: 0n },
    ...over.src,
  }
  const dst: Record<string, unknown> = {
    peers: addressToBytes32(info.oft),
    endpoint: REGISTRY_ETH_ENDPOINT,
    inboundNonce: 7n,
    getReceiveLibrary: [TREAD_OFT, true],
    getUlnConfig: { ...uln, requiredDVNs: [DVN_A] },
    token: TREAD_ADAPTER,
    paused: new Error('execution reverted'),
    ...over.dst,
  }
  return {
    info,
    plan,
    srcChain: 'hyperevm',
    dstChain: 'ethereum',
    srcClient: client((r) => src[r.functionName], logs.src),
    dstClient: client((r) => dst[r.functionName], logs.dst),
    dstOft: TREAD_ADAPTER,
  }
}

describe('combineOptionsV2 follows OAppOptionsType3.combineOptions', () => {
  it('enforced alone, extra alone, or enforced ++ extra minus its type word', () => {
    expect(combineOptionsV2('0x', '0x0003aa')).toBe('0x0003aa')
    expect(combineOptionsV2('0x0003bb', '0x')).toBe('0x0003bb')
    expect(combineOptionsV2('0x0003bb', '0x0003aa')).toBe('0x0003bbaa')
  })
})

describe('the destination endpoint is the registry’s, never the contract’s claim', () => {
  it('asks the committed EndpointV2 for the nonce, the receive library and the credit, whatever dstOft.endpoint() says', async () => {
    const logs = { src: [] as Read[], dst: [] as Read[] }
    await assessV2Route(ctx({ dst: { endpoint: OTHER } }, logs))
    const endpointReads = logs.dst.filter((r) => ['inboundNonce', 'getReceiveLibrary'].includes(r.functionName))
    expect(endpointReads.length).toBeGreaterThan(0)
    for (const r of endpointReads) expect(r.address.toLowerCase()).toBe(REGISTRY_ETH_ENDPOINT.toLowerCase())
    expect(logs.dst.some((r) => r.address === OTHER)).toBe(false)
  })

  it('a destination wired to another endpoint fails the peers check, and the route is BLOCKED', async () => {
    const input = await assessV2Route(ctx({ dst: { endpoint: OTHER } }))
    expect(input.checks.peers.status).toBe('fail')
    expect(assessRisk({ ...input, linkCrossChecked: true }).tier).toBe('BLOCKED')
  })
})

describe('the fee is the endpoint’s own quote', () => {
  it('a clean route passes peers with the fee confirmed', async () => {
    const input = await assessV2Route(ctx())
    expect(input.checks.peers).toEqual({ status: 'pass', note: 'peers match; the fee is the endpoint’s own quote' })
  })

  it('an OFT whose quoteSend asks for more than the endpoint prices the packet at is a hard failure', async () => {
    const input = await assessV2Route(ctx({ src: { quote: { nativeFee: NATIVE_FEE / 2n, lzTokenFee: 0n } } }))
    expect(input.checks.peers.status).toBe('fail')
    expect(input.checks.peers.status === 'fail' && input.checks.peers.reason).toMatch(/the difference stays with the contract/)
    expect(assessRisk({ ...input, linkCrossChecked: true }).tier).toBe('BLOCKED')
  })

  it('asks the SOURCE endpoint (probeOft’s committed one) for this exact packet, as the OFT itself', async () => {
    const logs = { src: [] as Read[], dst: [] as Read[] }
    await assessV2Route(ctx({}, logs))
    const q = logs.src.find((r) => r.functionName === 'quote')
    expect(q?.address).toBe(ENDPOINT_HYPER)
    const [params, sender] = q!.args as [{ dstEid: number; receiver: string; message: string; options: string; payInLzToken: boolean }, Address]
    expect(sender).toBe(treadOftInfo().oft)
    expect(params.dstEid).toBe(ETH_EID)
    expect(params.receiver.toLowerCase()).toBe(addressToBytes32(TREAD_ADAPTER).toLowerCase())
    expect(params.options).toBe(treadOftInfo().enforced[ETH_EID])
    expect(params.payInLzToken).toBe(false)
    expect(params.message).toHaveLength(2 + 80)
  })

  it('an endpoint that does not answer leaves peers passed with the fee called unchecked', async () => {
    const input = await assessV2Route(ctx({ src: { quote: new Error('HTTP request failed') } }))
    expect(input.checks.peers.status).toBe('pass')
    expect(input.checks.peers.status === 'pass' && input.checks.peers.note).toMatch(/could not be checked/)
  })
})

describe('history is the endpoint’s nonce, not the contract’s events', () => {
  const found = { getLogs: async () => [{ blockNumber: 999_000n }] }
  const withLogs = (c: V2RiskContext): V2RiskContext => ({ ...c, dstClient: Object.assign(Object.create(Object.getPrototypeOf(c.dstClient)), c.dstClient, found) as ReadClient })

  it('OFTReceived logs with an inboundNonce of zero are a failed check and a route nothing was ever delivered on', async () => {
    const input = await assessV2Route(withLogs(ctx({ dst: { inboundNonce: 0n } })))
    expect(input.checks.history.status).toBe('fail')
    expect(input.history).toEqual({ kind: 'never' })
  })

  it('logs backed by a nonce are a delivery', async () => {
    const input = await assessV2Route(withLogs(ctx()))
    expect(input.checks.history.status).toBe('pass')
    expect(input.history.kind).toBe('delivered')
  })

  it('no logs in the window but a nonce above zero: delivered before the window, said as such', async () => {
    const input = await assessV2Route(ctx())
    expect(input.checks.history.status).toBe('pass')
    expect(input.checks.history.status === 'pass' && input.checks.history.note).toMatch(/none in the window searched/)
  })
})

describe('recent changes: a window shorter than the rule says nothing', () => {
  it('no PeerSet in a two-hour window is unchecked, not a pass', async () => {
    const c = ctx()
    const short = { getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 2 * 3600) }) }
    const input = await assessV2Route({ ...c, srcClient: Object.assign(Object.create(Object.getPrototypeOf(c.srcClient)), c.srcClient, short) as ReadClient })
    expect(input.checks.recent_changes.status).toBe('unchecked')
    expect(input.checks.recent_changes.status === 'unchecked' && input.checks.recent_changes.reason).toMatch(/hour/)
  })

  it('no PeerSet in a thirty-day window is a pass', async () => {
    const input = await assessV2Route(ctx())
    expect(input.checks.recent_changes.status).toBe('pass')
  })
})
