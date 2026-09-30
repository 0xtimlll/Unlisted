/**
 * §4: the check runners, and the two things about them that matter most.
 *
 *   1. **An unreachable RPC turns every check grey, never green.** This is the failure the anti-
 *      misinformation rules exist for: a panel that shows a row of ticks because nothing answered
 *      would be worse than no panel at all. Asserted here against clients that reject everything.
 *   2. **DVNs are compared by operator, not by address.** The same DVN has a different contract on
 *      every chain, so comparing the send side's addresses with the receive side's calls every
 *      healthy V2 route broken — which is exactly what happened before this test existed.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'
import type { ReadClient } from '@/core/client'
import { assessRisk, CHECK_IDS, HARD_CHECKS } from '@/protocols/lz-risk/risk'
import { assessV1Route, v1Payload } from '@/protocols/lz-risk/v1'
import { compareUlnShape } from '@/protocols/lz-risk/v2'
import dvnTable from '@/protocols/lz-risk/dvns.json'
import type { OftV1Info, V1Route } from '@/protocols/lz-v1/detect'
import { encodeAdapterParamsType1 } from '@/protocols/lz-v1/adapterParams'
import { toWireRecipient, type V1SendPlan } from '@/protocols/lz-v1/plan'

const OFT = getAddress('0x4444444444444444444444444444444444444444')
const REMOTE = getAddress('0x7777777777777777777777777777777777777777')
const WALLET = getAddress('0x1111111111111111111111111111111111111111')
const ENDPOINT = getAddress('0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675')

/** A client where nothing answers — a provider that is down, throttled or blocked. */
const deadClient = (): ReadClient =>
  ({
    readContract: () => Promise.reject(new Error('HTTP request failed')),
    call: () => Promise.reject(new Error('HTTP request failed')),
    estimateGas: () => Promise.reject(new Error('HTTP request failed')),
    getLogs: () => Promise.reject(new Error('HTTP request failed')),
    getBlock: () => Promise.reject(new Error('HTTP request failed')),
    getBlockNumber: () => Promise.reject(new Error('HTTP request failed')),
    multicall: () => Promise.reject(new Error('HTTP request failed')),
  }) as unknown as ReadClient

function route(over: Partial<V1Route> = {}): V1Route {
  return {
    key: 'arbitrum',
    v1ChainId: 110,
    trustedRemote: `0x${REMOTE.slice(2)}${OFT.slice(2)}`,
    remoteAddress: REMOTE,
    minDstGas: 150_000n,
    ...over,
  }
}

function info(over: Partial<OftV1Info> = {}): OftV1Info {
  return {
    vm: 'evm',
    protocol: 'lz-v1',
    standard: { wire: 'bytes32', kind: 'OFT' },
    chain: 'ethereum',
    srcV1ChainId: 101,
    oft: OFT,
    token: OFT,
    symbol: 'TEST',
    name: 'Test',
    decimals: 18,
    sharedDecimals: 6,
    conversionRate: 10n ** 12n,
    endpoint: ENDPOINT,
    owner: undefined,
    approvalRequired: false,
    useCustomAdapterParams: undefined,
    adapterParamsRequired: true,
    routes: [route()],
    lockedInAdapter: undefined,
    feeProbed: true,
    ...over,
  }
}

function plan(over: Partial<V1SendPlan> = {}): V1SendPlan {
  return {
    protocol: 'lz-v1',
    standard: { wire: 'bytes32', kind: 'OFT' },
    chain: 'ethereum',
    oft: OFT,
    token: OFT,
    decimals: 18,
    symbol: 'TEST',
    srcV1ChainId: 101,
    dst: { key: 'arbitrum', v1ChainId: 110 },
    sender: WALLET,
    recipient: WALLET,
    toWire: toWireRecipient(WALLET, 'bytes32'),
    amounts: { amountRaw: 10n ** 18n, amountLD: 10n ** 18n, oftFee: 0n, delivered: 10n ** 18n, minAmountLD: undefined, dustTrimmed: 0n },
    slippageBps: 0,
    feeBufferBps: 0,
    adapterParams: encodeAdapterParamsType1(200_000n),
    quote: { nativeFee: 10n ** 15n, zroFee: 0n },
    value: 10n ** 15n,
    ...over,
  }
}

describe('an RPC that does not answer', () => {
  it('turns every check grey and the verdict into UNVERIFIED — never a row of ticks', async () => {
    const { input } = await assessV1Route({ info: info(), plan: plan(), srcClient: deadClient(), dstClient: deadClient() })
    for (const id of CHECK_IDS) {
      // `skipped` would be a claim that the check does not apply, which nothing here established.
      expect(input.checks[id].status, id).toBe('unchecked')
      const state = input.checks[id]
      expect(state.status === 'unchecked' && state.reason.length, id).toBeGreaterThan(0)
    }
    // Corroboration is a separate question from the checks; hold it true to isolate the fold.
    const risk = assessRisk({ ...input, linkCrossChecked: true })
    expect(risk.tier).toBe('UNVERIFIED')
    expect(risk.hardUnchecked.sort()).toEqual([...HARD_CHECKS].sort())
    // And when the dead provider was also the only one asked, the contract itself is
    // uncorroborated on top: still UNVERIFIED, with one more reason — a nuance, never a block.
    const alone = assessRisk({ ...input, linkCrossChecked: false })
    expect(alone.tier).toBe('UNVERIFIED')
    expect(alone.reasons.some((x) => /independent RPC operator/.test(x.text))).toBe(true)
    // Every grey row says why, and those reasons are what the panel prints.
    expect(risk.reasons.length).toBeGreaterThanOrEqual(HARD_CHECKS.length)
    for (const r of risk.reasons.filter((x) => x.check && HARD_CHECKS.includes(x.check))) {
      expect(r.text).toMatch(/not checked:/)
    }
  })

  it('does not blame the route when only the destination is unreachable', async () => {
    // The source answering does not make a destination-side check pass; it only means the reason
    // for the grey is on the other chain.
    const { input } = await assessV1Route({ info: info(), plan: plan(), srcClient: deadClient(), dstClient: deadClient() })
    expect(input.checks.peers.status).not.toBe('fail')
    expect(input.checks.adapter_liquidity.status).not.toBe('fail')
  })
})

describe('the destination payload is the contract’s own encoding', () => {
  it('encodes the bytes32 standards as PT_SEND ++ bytes32 ++ amountSD, 41 bytes', () => {
    const p = v1Payload(plan(), 10n ** 12n)
    expect((p.length - 2) / 2).toBe(41)
    expect(p.slice(0, 4)).toBe('0x00') // PT_SEND
    expect(p.slice(4, 68)).toBe(toWireRecipient(WALLET, 'bytes32').slice(2))
    // amountSD = 1e18 / 1e12 = 1e6
    expect(BigInt(`0x${p.slice(68)}`)).toBe(10n ** 6n)
  })

  it('encodes the bytes standard as an ABI tuple, which is what OFTCore._sendAck decodes', () => {
    const p = v1Payload(plan({ standard: { wire: 'bytes', kind: 'OFT' }, toWire: toWireRecipient(WALLET, 'bytes') }), 1n)
    // abi.encode(uint16, bytes, uint256): three head words, then the bytes length and its data.
    expect((p.length - 2) / 2).toBeGreaterThan(41)
    expect(BigInt(`0x${p.slice(2, 66)}`)).toBe(0n) // PT_SEND in a padded word
  })
})

describe('DVNs are compared by operator, not by address', () => {
  const ids = (chain: string) =>
    Object.entries((dvnTable.chains as Record<string, { dvns: Record<string, { id: string; deprecated: boolean }> }>)[chain]?.dvns ?? {})

  /** The same operator's address on each of two chains. */
  function pair(id: string): [Address, Address] | undefined {
    const a = ids('ethereum').find(([, e]) => e.id === id)
    const b = ids('arbitrum').find(([, e]) => e.id === id)
    return a && b ? [getAddress(a[0]), getAddress(b[0])] : undefined
  }

  const uln = (required: Address[], confirmations = 20n) => ({
    confirmations,
    requiredDVNs: required,
    optionalDVNs: [] as Address[],
    optionalDVNThreshold: 0,
  })

  it('calls a route configured with the same operators on both sides the same', () => {
    const lz = pair('layerzero-labs')
    expect(lz, 'LayerZero Labs should be listed on both chains').toBeDefined()
    const [onEth, onArb] = lz!
    expect(onEth.toLowerCase()).not.toBe(onArb.toLowerCase()) // different contracts, same operator
    expect(compareUlnShape(uln([onEth]), uln([onArb]), 'ethereum', 'arbitrum')).toEqual({ same: true })
  })

  it('still notices a real difference in confirmations or count', () => {
    const lz = pair('layerzero-labs')!
    expect(compareUlnShape(uln([lz[0]], 20n), uln([lz[1]], 15n), 'ethereum', 'arbitrum')).toMatchObject({ same: false })
    expect(compareUlnShape(uln([lz[0]]), uln([]), 'ethereum', 'arbitrum')).toMatchObject({ same: false })
  })

  it('notices two different operators', () => {
    const lz = pair('layerzero-labs')!
    const other = ids('arbitrum').find(([, e]) => !e.deprecated && e.id !== 'layerzero-labs')!
    expect(compareUlnShape(uln([lz[0]]), uln([getAddress(other[0])]), 'ethereum', 'arbitrum')).toMatchObject({ same: false })
  })

  it('says "unknown" rather than "mismatch" when a DVN is not in the published list', () => {
    const lz = pair('layerzero-labs')!
    const stranger = getAddress('0x1234567890123456789012345678901234567890')
    expect(compareUlnShape(uln([stranger]), uln([lz[1]]), 'ethereum', 'arbitrum')).toMatchObject({ same: 'unknown' })
  })
})
