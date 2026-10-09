/**
 * Status tab, CCIP side.
 *
 * The rule under test: the off-ramp that answers is the one the DESTINATION router lists for the
 * source chain AND that names the on-ramp which emitted the message. A router that lists two
 * off-ramps for one source (a lane mid-upgrade) must not have the wrong one's counter read.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, pad, type Abi, type Address, type Hex } from 'viem'
import type { ReadClient } from '@/core/client'
import { ccipEventsAbi, ccipExecutionState, ccipRamp2EventsAbi } from '@/protocols/ccip/abi'
import { ccipConfig } from '@/protocols/ccip/chains'
import { diagnoseCcip, findCcipSends, lookupCcipStatus, resolveCcipDestination } from '@/protocols/ccip/status'
import { makeLog } from './logs'

const ON_RAMP = getAddress('0x1111111111111111111111111111111111111111')
const OTHER_RAMP = getAddress('0x2222222222222222222222222222222222222222')
const OFF_15 = getAddress('0x3333333333333333333333333333333333333333')
const OFF_16 = getAddress('0x4444444444444444444444444444444444444444')
const OFF_20 = getAddress('0x5555555555555555555555555555555555555555')
const SENDER = getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9')
const MESSAGE_ID: Hex = `0x${'cd'.repeat(32)}`
const ETH = ccipConfig('ethereum')!.selector
const BASE = ccipConfig('base')!.selector

const sent16 = (seq = 42n, dest = BASE) =>
  makeLog(ON_RAMP, ccipEventsAbi as Abi, 'CCIPMessageSent', {
    destChainSelector: dest,
    sequenceNumber: seq,
    message: {
      header: { messageId: MESSAGE_ID, sourceChainSelector: ETH, destChainSelector: dest, sequenceNumber: seq, nonce: 1n },
      sender: SENDER,
      data: '0x',
      receiver: pad(SENDER, { size: 32 }),
      extraArgs: '0x',
      feeToken: `0x${'0'.repeat(40)}`,
      feeTokenAmount: 0n,
      feeValueJuels: 0n,
      tokenAmounts: [],
    },
  })

const sent20 = (dest = BASE) =>
  makeLog(ON_RAMP, ccipRamp2EventsAbi as Abi, 'CCIPMessageSent', {
    destChainSelector: dest,
    sender: SENDER,
    messageId: MESSAGE_ID,
    feeToken: `0x${'0'.repeat(40)}`,
    tokenAmountBeforeTokenPoolFees: 0n,
    encodedMessage: '0x',
    receipts: [],
    verifierBlobs: [],
  })

const sent15 = (seq = 7n) =>
  makeLog(ON_RAMP, ccipEventsAbi as Abi, 'CCIPSendRequested', {
    message: {
      sourceChainSelector: ETH,
      sender: SENDER,
      receiver: SENDER,
      sequenceNumber: seq,
      gasLimit: 200_000n,
      strict: false,
      nonce: 1n,
      feeToken: `0x${'0'.repeat(40)}`,
      feeTokenAmount: 0n,
      data: '0x',
      tokenAmounts: [],
      sourceTokenData: [],
      messageId: MESSAGE_ID,
    },
  })

/** Answers reads by (address, functionName); a thrown value is a failed read. Unlisted reads fail. */
type Handler = (address: Address, fn: string, args: readonly unknown[] | undefined) => unknown
function fakeClient(handle: Handler): ReadClient {
  return {
    readContract: async (p: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const v = handle(getAddress(p.address), p.functionName, p.args)
      if (v === undefined) throw new Error(`no answer for ${p.functionName} at ${p.address}`)
      if (v instanceof Error) throw v
      return v
    },
  } as unknown as ReadClient
}

const BASE_ROUTER = getAddress(ccipConfig('base')!.router)
const ETH_ROUTER = getAddress(ccipConfig('ethereum')!.router)

/** A Base router listing both generations for Ethereum, and the three off-ramps behind it. */
function baseSide(p: { state15?: number; state16?: number; state20?: number; onRamp15?: Address; onRamp16?: Hex; onRamps20?: Hex[]; ramps?: { sourceChainSelector: bigint; offRamp: Address }[] } = {}): ReadClient {
  return fakeClient((address, fn, args) => {
    if (address === BASE_ROUTER && fn === 'getOffRamps') {
      return (
        p.ramps ?? [
          { sourceChainSelector: ETH, offRamp: OFF_15 },
          { sourceChainSelector: ETH, offRamp: OFF_16 },
          { sourceChainSelector: ETH, offRamp: OFF_20 },
          { sourceChainSelector: 1n, offRamp: OTHER_RAMP },
        ]
      )
    }
    if (fn === 'typeAndVersion') return address === OFF_15 ? 'EVM2EVMOffRamp 1.5.0' : address === OFF_16 ? 'OffRamp 1.6.0' : address === OFF_20 ? 'OffRamp 2.0.0' : 'Something 9.9.9'
    if (address === OFF_15) {
      if (fn === 'getStaticConfig') return { commitStore: OTHER_RAMP, chainSelector: BASE, sourceChainSelector: ETH, onRamp: p.onRamp15 ?? ON_RAMP, prevOffRamp: `0x${'0'.repeat(40)}`, rmnProxy: OTHER_RAMP, tokenAdminRegistry: OTHER_RAMP }
      if (fn === 'getExecutionState' && args?.length === 1) return p.state15 ?? 0
    }
    if (address === OFF_16) {
      if (fn === 'getSourceChainConfig') return { router: BASE_ROUTER, isEnabled: true, minSeqNr: 1n, isRMNVerificationDisabled: false, onRamp: p.onRamp16 ?? pad(ON_RAMP, { size: 32 }) }
      if (fn === 'getExecutionState' && args?.length === 2) return p.state16 ?? 0
    }
    if (address === OFF_20) {
      if (fn === 'getSourceChainConfig') return { router: BASE_ROUTER, isEnabled: true, onRamps: p.onRamps20 ?? [pad(ON_RAMP, { size: 32 })], defaultCCVs: [], laneMandatedCCVs: [] }
      if (fn === 'getExecutionState' && args?.length === 1 && typeof args[0] === 'string') return p.state20 ?? 0
    }
    return undefined
  })
}

describe('finding CCIP messages in a transaction', () => {
  it('reads each on-ramp generation: what it says and what it does not', () => {
    const [v16] = findCcipSends([sent16()], 'ethereum')
    expect(v16).toMatchObject({ version: '1.6', onRamp: ON_RAMP, messageId: MESSAGE_ID, sequenceNumber: 42n, srcSelector: ETH, destSelector: BASE, dstChain: 'base', sender: SENDER })
    const [v20] = findCcipSends([sent20()], 'ethereum')
    expect(v20).toMatchObject({ version: '2.0', messageId: MESSAGE_ID, sequenceNumber: undefined, destSelector: BASE, dstChain: 'base' })
    const [v15] = findCcipSends([sent15()], 'ethereum')
    expect(v15).toMatchObject({ version: '1.5', messageId: MESSAGE_ID, sequenceNumber: 7n, destSelector: undefined, dstChain: undefined })
  })

  it('a destination this app does not serve is kept, with no chain', () => {
    expect(findCcipSends([sent16(1n, 123n)], 'ethereum')[0]).toMatchObject({ destSelector: 123n, dstChain: undefined })
  })

  it('finds nothing on a chain CCIP does not serve here', () => {
    expect(findCcipSends([sent16()], 'solana')).toHaveLength(0)
  })

  it('resolves a 1.5 destination through the source router’s own on-ramp list', async () => {
    const src = fakeClient((address, fn, args) => (address === ETH_ROUTER && fn === 'getOnRamp' ? (args?.[0] === BASE ? ON_RAMP : OTHER_RAMP) : undefined))
    const found = findCcipSends([sent15()], 'ethereum')[0]!
    expect(await resolveCcipDestination(found, src)).toMatchObject({ destSelector: BASE, dstChain: 'base' })
    // An on-ramp the router no longer names stays unresolved.
    const none = fakeClient((address, fn) => (address === ETH_ROUTER && fn === 'getOnRamp' ? OTHER_RAMP : undefined))
    expect((await resolveCcipDestination(found, none)).dstChain).toBeUndefined()
  })
})

describe('what the destination off-ramp says', () => {
  const v16 = () => findCcipSends([sent16()], 'ethereum')[0]!
  const v20 = () => findCcipSends([sent20()], 'ethereum')[0]!
  const v15 = async () =>
    resolveCcipDestination(findCcipSends([sent15()], 'ethereum')[0]!, fakeClient((a, fn, args) => (a === ETH_ROUTER && fn === 'getOnRamp' && args?.[0] === BASE ? ON_RAMP : OTHER_RAMP)))

  it('maps the four execution states', () => {
    expect(ccipExecutionState(0)).toBe('UNTOUCHED')
    expect(ccipExecutionState(2)).toBe('SUCCESS')
    expect(ccipExecutionState(3)).toBe('FAILURE')
    expect(ccipExecutionState(4)).toBeUndefined()
  })

  it('a 1.6 message is answered by the 1.6 off-ramp that names its on-ramp — not by the 1.5 one listed beside it', async () => {
    const d = await diagnoseCcip(v16(), baseSide({ state16: 2, state15: 3 }))
    expect(d.state).toEqual({ kind: 'delivered', offRamp: OFF_16, offRampVersion: 'OffRamp 1.6.0' })
    expect((await diagnoseCcip(v16(), baseSide({ state16: 0 }))).state.kind).toBe('in_flight')
    expect((await diagnoseCcip(v16(), baseSide({ state16: 1 }))).state.kind).toBe('executing')
    expect((await diagnoseCcip(v16(), baseSide({ state16: 3 }))).state.kind).toBe('failed')
  })

  it('a 1.5 message is answered by the lane’s own EVM2EVMOffRamp, by sequence number', async () => {
    const d = await diagnoseCcip(await v15(), baseSide({ state15: 2, state16: 0 }))
    expect(d.state).toEqual({ kind: 'delivered', offRamp: OFF_15, offRampVersion: 'EVM2EVMOffRamp 1.5.0' })
  })

  it('a 2.0 message is answered by message id', async () => {
    const d = await diagnoseCcip(v20(), baseSide({ state20: 2 }))
    expect(d.state).toEqual({ kind: 'delivered', offRamp: OFF_20, offRampVersion: 'OffRamp 2.0.0' })
  })

  it('the on-ramp may be named as 32 abi-encoded bytes or as the bare address', async () => {
    expect((await diagnoseCcip(v16(), baseSide({ state16: 2, onRamp16: ON_RAMP }))).state.kind).toBe('delivered')
    expect((await diagnoseCcip(v20(), baseSide({ state20: 2, onRamps20: [ON_RAMP] }))).state.kind).toBe('delivered')
  })

  it('an off-ramp that names a different on-ramp is not asked — a different lane’s counter is not this message', async () => {
    const d = await diagnoseCcip(v16(), baseSide({ state16: 2, onRamp16: pad(OTHER_RAMP, { size: 32 }) }))
    expect(d.state.kind).toBe('unknown')
    expect((d.state as { reason: string }).reason).toMatch(/names the on-ramp/)
    const d15 = await diagnoseCcip(await v15(), baseSide({ state15: 2, onRamp15: OTHER_RAMP }))
    expect(d15.state.kind).toBe('unknown')
  })

  it('a router that lists no off-ramp for the source is unknown, with the reason', async () => {
    const d = await diagnoseCcip(v16(), baseSide({ ramps: [{ sourceChainSelector: 1n, offRamp: OTHER_RAMP }] }))
    expect(d.state).toMatchObject({ kind: 'unknown' })
    expect((d.state as { reason: string }).reason).toMatch(/no off-ramp/)
  })

  it('a read the provider did not answer is unknown with its reason — never a state', async () => {
    const d = await diagnoseCcip(v16(), fakeClient((address, fn) => (address === BASE_ROUTER && fn === 'getOffRamps' ? new Error('rpc timeout') : undefined)))
    expect((d.state as { reason: string }).reason).toContain('rpc timeout')
  })

  it('an unresolved 1.5 destination is reported, not hidden', async () => {
    const r = await lookupCcipStatus([sent15()], 'ethereum', fakeClient((a, fn) => (a === ETH_ROUTER && fn === 'getOnRamp' ? OTHER_RAMP : undefined)), () => undefined)
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]?.state.kind).toBe('unknown')
    expect(r.unserved).toHaveLength(0)
  })

  it('lookupCcipStatus separates served from unserved destinations', async () => {
    const r = await lookupCcipStatus([sent16(), sent16(2n, 123n)], 'ethereum', undefined, (c) => (c === 'base' ? baseSide({ state16: 2 }) : undefined))
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]?.state.kind).toBe('delivered')
    expect(r.unserved).toHaveLength(1)
  })
})
