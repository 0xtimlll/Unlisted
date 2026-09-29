/**
 * §3: LayerZero v1.
 *
 * The centre of this file is the recipient. The three v1 standards disagree about what
 * `_toAddress` even is, and the destination contract reads it without ever checking that it got
 * what the sender meant — a 32-byte address in a `bytes` field is delivered to twelve zero bytes
 * and the funds are gone. So every one of those confusions gets a test that asserts it is BLOCKED,
 * not merely that the happy path works.
 */
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { evmChains } from '@/core/chains'
import {
  abiOfWire,
  oftV1Abi,
  oftV2OnV1Abi,
  oftWithFeeAbi,
  SEND_FROM_SELECTOR,
  standardLabel,
  WIRE_OF_SELECTOR,
  type V1Wire,
} from '@/protocols/lz-v1/abi'
import {
  AdapterParamsError,
  decodeAdapterParams,
  encodeAdapterParamsType1,
  judgeAdapterParams,
  MAX_V1_GAS,
} from '@/protocols/lz-v1/adapterParams'
import { byV1ChainId, lzV1, lzV1Chains, v1Destinations } from '@/protocols/lz-v1/chains'
import { localOf, remoteOf } from '@/protocols/lz-v1/detect'
import { assembleV1SendArgs, callParamsOf, encodeV1SendCalldata, toWireRecipient, type V1SendPlan } from '@/protocols/lz-v1/plan'
import { decodeV1SendCalldata, readRecipient, v1SelfCheck, V1DecodeError } from '@/protocols/lz-v1/selfcheck'

const WALLET = getAddress('0x1111111111111111111111111111111111111111')
const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222')
const STRANGER = getAddress('0x3333333333333333333333333333333333333333')
const OFT = getAddress('0x4444444444444444444444444444444444444444')
const TOKEN = getAddress('0x5555555555555555555555555555555555555555')
const ZERO = `0x${'0'.repeat(40)}` as Address

const GAS = 200_000n
const ADAPTER = encodeAdapterParamsType1(GAS)

/** A plan is just data here: no RPC is involved in encoding or checking one. */
function plan(wire: V1Wire, over: Partial<V1SendPlan> = {}): V1SendPlan {
  return {
    protocol: 'lz-v1',
    standard: { wire, kind: 'OFT' },
    chain: 'ethereum',
    oft: OFT,
    token: TOKEN,
    decimals: 18,
    symbol: 'TEST',
    srcV1ChainId: 101,
    dst: { key: 'arbitrum', v1ChainId: 110 },
    sender: WALLET,
    recipient: RECIPIENT,
    toWire: toWireRecipient(RECIPIENT, wire),
    amounts: {
      amountRaw: 1_000n,
      amountLD: 1_000n,
      oftFee: 0n,
      delivered: 1_000n,
      minAmountLD: wire === 'bytes32_fee' ? 1_000n : undefined,
      dustTrimmed: 0n,
    },
    slippageBps: 0,
    feeBufferBps: 0,
    adapterParams: ADAPTER,
    quote: { nativeFee: 10n ** 15n, zroFee: 0n },
    value: 10n ** 15n,
    ...over,
  }
}

const WIRES: V1Wire[] = ['bytes', 'bytes32', 'bytes32_fee']

describe('the committed v1 chain table', () => {
  it('covers every EVM chain in the registry, with a uint16 id and a checksummed endpoint', () => {
    for (const c of evmChains()) {
      const v1 = lzV1(c.key)
      expect(v1, c.key).toBeDefined()
      expect(v1!.v1ChainId).toBeGreaterThan(0)
      expect(v1!.v1ChainId).toBeLessThanOrEqual(0xffff)
      expect(v1!.endpoint).toBe(getAddress(v1!.endpoint))
    }
  })

  it('agrees with LayerZero on the ids that have been public for years', () => {
    expect(lzV1('ethereum')?.v1ChainId).toBe(101)
    expect(lzV1('bsc')?.v1ChainId).toBe(102)
    expect(lzV1('avalanche')?.v1ChainId).toBe(106)
    expect(lzV1('polygon')?.v1ChainId).toBe(109)
    expect(lzV1('arbitrum')?.v1ChainId).toBe(110)
    expect(lzV1('optimism')?.v1ChainId).toBe(111)
    expect(lzV1('robinhood')?.v1ChainId).toBe(416)
  })

  it('never confuses a v1 chain id with a V2 eid', () => {
    for (const c of lzV1Chains()) {
      const registry = evmChains().find((x) => x.key === c.key)!
      expect(c.v1ChainId).not.toBe(registry.eid)
      // Every v1 mainnet id is its V2 eid minus 30000 — asserted, not assumed.
      expect(registry.eid - 30_000).toBe(c.v1ChainId)
    }
  })

  it('looks a chain up by its v1 id and never offers the source as its own destination', () => {
    expect(byV1ChainId(110)?.key).toBe('arbitrum')
    expect(byV1ChainId(65_535)).toBeUndefined()
    expect(v1Destinations('ethereum').some((d) => d.key === 'ethereum')).toBe(false)
  })
})

describe('the selector table is derived, not typed', () => {
  it('gives the three standards three different selectors', () => {
    const all = new Set(Object.values(SEND_FROM_SELECTOR))
    expect(all.size).toBe(3)
    for (const s of all) expect(s).toMatch(/^0x[0-9a-f]{8}$/)
  })

  it('matches what viem computes from the ABI the module actually encodes with', () => {
    for (const wire of WIRES) {
      const abi = abiOfWire(wire)
      const data = encodeFunctionData({
        abi,
        functionName: 'sendFrom',
        args:
          wire === 'bytes'
            ? [WALLET, 110, toWireRecipient(RECIPIENT, wire), 1n, WALLET, ZERO, ADAPTER]
            : wire === 'bytes32'
              ? [WALLET, 110, toWireRecipient(RECIPIENT, wire), 1n, { refundAddress: WALLET, zroPaymentAddress: ZERO, adapterParams: ADAPTER }]
              : [WALLET, 110, toWireRecipient(RECIPIENT, wire), 1n, 1n, { refundAddress: WALLET, zroPaymentAddress: ZERO, adapterParams: ADAPTER }],
      } as never)
      expect(data.slice(0, 10)).toBe(SEND_FROM_SELECTOR[wire])
      expect(WIRE_OF_SELECTOR.get(data.slice(0, 10) as Hex)).toBe(wire)
    }
  })

  it('names the standard the way the review screen prints it', () => {
    expect(standardLabel({ wire: 'bytes', kind: 'OFT' })).toBe('LayerZero v1 · OFT')
    expect(standardLabel({ wire: 'bytes32', kind: 'Proxy' })).toBe('LayerZero v1 · OFTV2 · Proxy')
    expect(standardLabel({ wire: 'bytes32_fee', kind: 'OFT' })).toBe('LayerZero v1 · OFTWithFee')
  })
})

describe('adapterParams follow RelayerV2, not our convenience', () => {
  it('encodes txType 1 as exactly 34 bytes', () => {
    const h = encodeAdapterParamsType1(GAS)
    expect(h.slice(2).length / 2).toBe(34)
    expect(h.slice(0, 6)).toBe('0x0001')
    expect(decodeAdapterParams(h)).toEqual({ txType: 1, extraGas: GAS })
  })

  it('refuses zero gas and anything over the cap', () => {
    expect(() => encodeAdapterParamsType1(0n)).toThrow(AdapterParamsError)
    expect(() => encodeAdapterParamsType1(MAX_V1_GAS + 1n)).toThrow(AdapterParamsError)
  })

  it('treats empty as a real answer, because the ULN substitutes its defaults for it', () => {
    expect(judgeAdapterParams('0x')).toEqual({ kind: 'empty' })
  })

  it('refuses a txType 2 native drop outright', () => {
    // uint16(2) ++ uint256(gas) ++ uint256(amount) ++ 20-byte address — 86 bytes, RelayerV2's shape.
    const drop = `0x0002${GAS.toString(16).padStart(64, '0')}${(10n ** 18n).toString(16).padStart(64, '0')}${STRANGER.slice(2)}` as Hex
    const d = decodeAdapterParams(drop)
    expect(d.txType).toBe(2)
    const v = judgeAdapterParams(drop)
    expect(v).toMatchObject({ kind: 'refused', reason: 'native_drop' })
  })

  it('refuses lengths the relayer itself would reject', () => {
    expect(judgeAdapterParams('0x0001')).toMatchObject({ kind: 'refused', reason: 'malformed' })
    // 35 bytes: neither 34 nor > 66.
    expect(judgeAdapterParams(`0x0001${'00'.repeat(33)}`)).toMatchObject({ kind: 'refused', reason: 'malformed' })
  })
})

describe('the wire recipient, and reading it back the way the destination does', () => {
  it('puts 20 raw bytes in a `bytes` field and left-pads for bytes32', () => {
    expect(toWireRecipient(RECIPIENT, 'bytes')).toBe(RECIPIENT.toLowerCase())
    expect(toWireRecipient(RECIPIENT, 'bytes32')).toBe(`0x${'0'.repeat(24)}${RECIPIENT.slice(2).toLowerCase()}`)
    expect(toWireRecipient(RECIPIENT, 'bytes32_fee')).toBe(toWireRecipient(RECIPIENT, 'bytes32'))
  })

  it('reads the first 20 bytes for `bytes` and the last 20 for bytes32', () => {
    expect(readRecipient('bytes', toWireRecipient(RECIPIENT, 'bytes')).toLowerCase()).toBe(RECIPIENT.toLowerCase())
    expect(readRecipient('bytes32', toWireRecipient(RECIPIENT, 'bytes32')).toLowerCase()).toBe(RECIPIENT.toLowerCase())
  })

  it('refuses a 32-byte left-padded address in a `bytes` field — the loss this app exists to prevent', () => {
    const padded = `0x${'0'.repeat(24)}${RECIPIENT.slice(2)}` as Hex
    expect(() => readRecipient('bytes', padded)).toThrow(V1DecodeError)
    expect(() => readRecipient('bytes', padded)).toThrow(/exactly 20/)
  })

  it('refuses a right-padded bytes32, which the contract would silently read as another address', () => {
    const rightPadded = `0x${RECIPIENT.slice(2)}${'0'.repeat(24)}` as Hex
    expect(() => readRecipient('bytes32', rightPadded)).toThrow(/left-padded/)
  })
})

describe('the self-check decodes our own calldata independently', () => {
  it.each(WIRES)('round-trips a correct %s send', (wire) => {
    const p = plan(wire)
    const data = encodeV1SendCalldata(p)
    const d = decodeV1SendCalldata(data, wire)
    expect(d.from).toBe(WALLET.toLowerCase())
    expect(d.dstChainId).toBe(110)
    expect(d.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase())
    expect(d.amount).toBe(1_000n)
    expect(d.minAmount).toBe(wire === 'bytes32_fee' ? 1_000n : undefined)
    expect(d.refundAddress).toBe(WALLET.toLowerCase())
    expect(d.zroPaymentAddress).toBe(ZERO)
    expect(d.adapterParams).toBe(ADAPTER.toLowerCase())
    expect(v1SelfCheck(p, data)).toEqual({ ok: true })
  })

  it.each(WIRES)('%s: assembles the argument list its own standard declares', (wire) => {
    const a = assembleV1SendArgs(plan(wire))
    expect(a.wire).toBe(wire)
    expect(a.args.length).toBe(wire === 'bytes' ? 7 : wire === 'bytes32' ? 5 : 6)
    if (wire !== 'bytes') expect(callParamsOf(plan(wire)).zroPaymentAddress).toBe(ZERO)
  })

  it('blocks a 32-byte address smuggled into the `bytes` standard', () => {
    const p = plan('bytes')
    const bad = encodeFunctionData({
      abi: oftV1Abi,
      functionName: 'sendFrom',
      args: [WALLET, 110, `0x${'0'.repeat(24)}${RECIPIENT.slice(2)}` as Hex, 1_000n, WALLET, ZERO, ADAPTER],
    })
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches.join(' ')).toMatch(/exactly 20/)
  })

  it('blocks a right-padded bytes32 recipient', () => {
    const p = plan('bytes32')
    const bad = encodeFunctionData({
      abi: oftV2OnV1Abi,
      functionName: 'sendFrom',
      args: [WALLET, 110, `0x${RECIPIENT.slice(2)}${'0'.repeat(24)}` as Hex, 1_000n, { refundAddress: WALLET, zroPaymentAddress: ZERO, adapterParams: ADAPTER }],
    })
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches.join(' ')).toMatch(/left-padded/)
  })

  it.each(WIRES)('%s: blocks a recipient that is not the one on screen', (wire) => {
    const p = plan(wire)
    const swapped = { ...p, recipient: STRANGER, toWire: toWireRecipient(STRANGER, wire) }
    const bad = encodeV1SendCalldata(swapped)
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('_toAddress')
    expect(!r.ok && r.mismatches).toContain('recipient the destination would credit')
  })

  it('blocks calldata built for another standard, even when every value is right', () => {
    // A contract detected as plain OFTV2, handed OFTWithFee's calldata: the argument lists differ
    // by one uint256, so the recipient and the call params would be read out of alignment.
    const p = plan('bytes32')
    const wrongStandard = encodeFunctionData({
      abi: oftWithFeeAbi,
      functionName: 'sendFrom',
      args: [WALLET, 110, toWireRecipient(RECIPIENT, 'bytes32'), 1_000n, 1_000n, { refundAddress: WALLET, zroPaymentAddress: ZERO, adapterParams: ADAPTER }],
    })
    const r = v1SelfCheck(p, wrongStandard)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches.join(' ')).toMatch(/bytes32_fee's sendFrom, but this contract is bytes32/)
  })

  it('blocks a selector that belongs to no v1 standard at all', () => {
    const r = v1SelfCheck(plan('bytes32'), '0xdeadbeef')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches.join(' ')).toMatch(/unknown_selector|0xdeadbeef/)
  })

  it.each(WIRES)('%s: blocks a refund address that is not the sender', (wire) => {
    const p = plan(wire)
    const data = encodeV1SendCalldata({ ...p, sender: WALLET })
    // Rebuild with a stranger as the refund address, leaving _from alone.
    const bad =
      wire === 'bytes'
        ? encodeFunctionData({ abi: oftV1Abi, functionName: 'sendFrom', args: [WALLET, 110, p.toWire, 1_000n, STRANGER, ZERO, ADAPTER] })
        : wire === 'bytes32'
          ? encodeFunctionData({
              abi: oftV2OnV1Abi,
              functionName: 'sendFrom',
              args: [WALLET, 110, p.toWire, 1_000n, { refundAddress: STRANGER, zroPaymentAddress: ZERO, adapterParams: ADAPTER }],
            })
          : encodeFunctionData({
              abi: oftWithFeeAbi,
              functionName: 'sendFrom',
              args: [WALLET, 110, p.toWire, 1_000n, 1_000n, { refundAddress: STRANGER, zroPaymentAddress: ZERO, adapterParams: ADAPTER }],
            })
    expect(v1SelfCheck(p, data).ok).toBe(true)
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('refundAddress != sender')
  })

  it.each(WIRES)('%s: blocks a non-zero zroPaymentAddress', (wire) => {
    const p = plan(wire)
    const bad =
      wire === 'bytes'
        ? encodeFunctionData({ abi: oftV1Abi, functionName: 'sendFrom', args: [WALLET, 110, p.toWire, 1_000n, WALLET, STRANGER, ADAPTER] })
        : wire === 'bytes32'
          ? encodeFunctionData({
              abi: oftV2OnV1Abi,
              functionName: 'sendFrom',
              args: [WALLET, 110, p.toWire, 1_000n, { refundAddress: WALLET, zroPaymentAddress: STRANGER, adapterParams: ADAPTER }],
            })
          : encodeFunctionData({
              abi: oftWithFeeAbi,
              functionName: 'sendFrom',
              args: [WALLET, 110, p.toWire, 1_000n, 1_000n, { refundAddress: WALLET, zroPaymentAddress: STRANGER, adapterParams: ADAPTER }],
            })
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('zroPaymentAddress is not zero')
  })

  it('blocks adapter params the plan did not commit to — a native drop swapped in at the last moment', () => {
    const p = plan('bytes32')
    const drop = `0x0002${GAS.toString(16).padStart(64, '0')}${(10n ** 18n).toString(16).padStart(64, '0')}${STRANGER.slice(2)}` as Hex
    const bad = encodeFunctionData({
      abi: oftV2OnV1Abi,
      functionName: 'sendFrom',
      args: [WALLET, 110, p.toWire, 1_000n, { refundAddress: WALLET, zroPaymentAddress: ZERO, adapterParams: drop }],
    })
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('adapterParams')
  })

  it('blocks the destination chain being changed under the plan', () => {
    const p = plan('bytes32')
    const bad = encodeV1SendCalldata({ ...p, dst: { key: 'base', v1ChainId: 184 } })
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('_dstChainId')
  })

  it.each(WIRES)('%s: blocks an amount that is not the one quoted', (wire) => {
    const p = plan(wire)
    const bad = encodeV1SendCalldata({ ...p, amounts: { ...p.amounts, amountLD: 999n } })
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('_amount')
  })

  it('blocks a lowered _minAmount on the fee standard', () => {
    const p = plan('bytes32_fee')
    const bad = encodeV1SendCalldata({ ...p, amounts: { ...p.amounts, minAmountLD: 1n } })
    const r = v1SelfCheck(p, bad)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('_minAmount')
  })

  it('blocks the zero address as a recipient', () => {
    const p = plan('bytes32', { recipient: ZERO, toWire: toWireRecipient(ZERO, 'bytes32') })
    const r = v1SelfCheck(p, encodeV1SendCalldata(p))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.mismatches).toContain('recipient is the zero address')
  })

  it('does not accept truncated calldata as a shorter transfer', () => {
    const full = encodeV1SendCalldata(plan('bytes32'))
    // Three head words where five are declared: the amount word is simply not there.
    expect(v1SelfCheck(plan('bytes32'), full.slice(0, 10 + 64 * 3) as Hex).ok).toBe(false)
    // And a call params offset pointing past the end of the calldata.
    expect(v1SelfCheck(plan('bytes32'), full.slice(0, 10 + 64 * 5) as Hex).ok).toBe(false)
  })
})

describe('trusted remote paths', () => {
  it('splits the packed path into remote and local halves', () => {
    const path = `0x${OFT.slice(2)}${TOKEN.slice(2)}` as Hex
    expect(remoteOf(path)).toBe(OFT)
    expect(localOf(path)).toBe(TOKEN)
  })

  it('returns undefined rather than guessing at a path that is not the EVM shape', () => {
    expect(remoteOf('0x')).toBeUndefined()
    expect(remoteOf(`0x${'ab'.repeat(32)}`)).toBeUndefined()
    expect(localOf(`0x${'ab'.repeat(20)}`)).toBeUndefined()
  })
})
