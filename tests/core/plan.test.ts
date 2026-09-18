import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import { erc20Abi, WRITE_WHITELIST } from '@/core/abi'
import { addressToBytes32 } from '@/core/encoding'
import {
  assembleSendArgs,
  buildSendParam,
  computeAmounts,
  computeValue,
  decodeSendCalldata,
  DEFAULT_FEE_BUFFER_BPS,
  encodeSendCalldata,
} from '@/core/plan'
import { ETH_EID, HYPER_FEE_STEP, NATIVE_FEE, OTHER, treadPlan, WALLET } from './fixtures'

const RATE = 10n ** 12n

describe('computeAmounts', () => {
  it('slippage 0: min == amount, both multiples of rate', () => {
    const a = computeAmounts('19.82', 18, RATE, 0)
    expect(a.amountLD).toBe(19_820000000000000000n)
    expect(a.minAmountLD).toBe(a.amountLD)
    expect(a.dustTrimmed).toBe(0n)
    expect(a.amountLD % RATE).toBe(0n)
  })

  it('trims dust below shared decimals and reports it', () => {
    const a = computeAmounts('1.1234567891', 18, RATE, 0)
    expect(a.amountRaw).toBe(1_123456789100000000n)
    expect(a.amountLD).toBe(1_123456000000000000n)
    expect(a.dustTrimmed).toBe(789100000000n)
    expect(a.minAmountLD).toBe(a.amountLD)
  })

  it('slippage 50 bps: min = 99.5% rounded down to rate', () => {
    const a = computeAmounts('100', 18, RATE, 50)
    expect(a.amountLD).toBe(100n * 10n ** 18n)
    expect(a.minAmountLD).toBe(99_500000000000000000n)
    expect(a.minAmountLD % RATE).toBe(0n)
    expect(a.minAmountLD <= a.amountLD).toBe(true)
  })

  it('slippage on an amount where 99.5% is not a multiple of rate rounds down', () => {
    const a = computeAmounts('0.000001', 18, RATE, 50) // exactly 1 shared unit
    expect(a.amountLD).toBe(RATE)
    expect(a.minAmountLD).toBe(0n) // 99.5% of one unit -> 0
  })

  it('rate 1 (decimals == shared) leaves everything intact', () => {
    const a = computeAmounts('1.123456', 6, 1n, 0)
    expect(a.amountLD).toBe(1_123456n)
    expect(a.dustTrimmed).toBe(0n)
  })

  it('rejects bad slippage', () => {
    expect(() => computeAmounts('1', 18, RATE, -1)).toThrow()
    expect(() => computeAmounts('1', 18, RATE, 10001)).toThrow()
    expect(() => computeAmounts('1', 18, RATE, 0.5)).toThrow()
  })
})

describe('computeValue', () => {
  it('matches the §8 example: 0.0208 * 1.4 = 0.02912 -> 0.03', () => {
    expect(computeValue(NATIVE_FEE, DEFAULT_FEE_BUFFER_BPS, HYPER_FEE_STEP)).toBe(30_000000000000000n)
  })
  it('buffer 0 and step 1 is identity', () => {
    expect(computeValue(12345n, 0, 1n)).toBe(12345n)
  })
  it('never below nativeFee', () => {
    for (const fee of [1n, 999n, 10n ** 15n + 1n, 10n ** 18n]) {
      for (const buf of [0, 1000, 4000]) {
        const v = computeValue(fee, buf, HYPER_FEE_STEP)
        expect(v >= fee).toBe(true)
        expect(v % HYPER_FEE_STEP).toBe(0n)
      }
    }
  })
  it('rejects bad input', () => {
    expect(() => computeValue(-1n, 0, 1n)).toThrow()
    expect(() => computeValue(1n, -1, 1n)).toThrow()
  })
})

describe('buildSendParam / assembleSendArgs', () => {
  it('pads recipient, empties options, fee == value, refund == sender', () => {
    const plan = treadPlan()
    const [sp, fee, refund] = assembleSendArgs(plan)
    expect(sp.dstEid).toBe(ETH_EID)
    expect(sp.to).toBe(addressToBytes32(WALLET))
    expect(sp.amountLD).toBe(plan.amounts.amountLD)
    expect(sp.minAmountLD).toBe(plan.amounts.minAmountLD)
    expect(sp.extraOptions).toBe('0x')
    expect(sp.composeMsg).toBe('0x')
    expect(sp.oftCmd).toBe('0x')
    expect(fee.nativeFee).toBe(plan.value)
    expect(fee.lzTokenFee).toBe(0n)
    expect(refund.toLowerCase()).toBe(WALLET.toLowerCase())
  })

  it('carries extraOptions through when set', () => {
    const sp = buildSendParam({ dstEid: 1, recipient: WALLET, amountLD: 1n, minAmountLD: 1n, extraOptions: '0xdead' })
    expect(sp.extraOptions).toBe('0xdead')
  })
})

describe('encode/decode send calldata', () => {
  it('round-trips', () => {
    const plan = treadPlan({ extraOptions: '0x00030100110100000000000000000000000000030d40' })
    const args = assembleSendArgs(plan)
    const data = encodeSendCalldata(args)
    expect(data.startsWith('0x')).toBe(true)
    const d = decodeSendCalldata(data)
    expect(d.functionName).toBe('send')
    expect(d.sendParam).toEqual(args[0])
    expect(d.fee).toEqual(args[1])
    expect(d.refundAddress.toLowerCase()).toBe(WALLET.toLowerCase())
  })

  it('rejects non-send calldata', () => {
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [OTHER, 1n] })
    expect(() => decodeSendCalldata(approveData)).toThrow(/not a send/)
    expect(() => decodeSendCalldata('0x12345678')).toThrow()
  })

  it('send selector is the canonical LayerZero V2 one', () => {
    const data = encodeSendCalldata(assembleSendArgs(treadPlan()))
    // keccak("send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)")
    expect(data.slice(0, 10)).toBe('0xc7c7f5b3')
  })
})

describe('write whitelist', () => {
  it('is exactly approve + send', () => {
    expect([...WRITE_WHITELIST]).toEqual(['approve', 'send'])
  })
})
