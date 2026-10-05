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
import { ETH_EID, HYPER_FEE_STEP, NATIVE_FEE, OTHER, treadOftInfo, treadPlan, WALLET } from './fixtures'
import { buildSendPlan, PlanError } from '@/core/plan'
import { evmByKey } from '@/core/chains'
import { evmRecipient } from '@/core/recipient'
import type { ReadClient } from '@/core/client'

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

  it('rejects a `to` that is not bytes32 (a bare address must be padded by the caller)', () => {
    expect(() => buildSendParam({ dstEid: 1, to: WALLET, amountLD: 1n, minAmountLD: 1n })).toThrow(/bytes32/)
  })

  it('carries extraOptions through when set', () => {
    const sp = buildSendParam({ dstEid: 1, to: addressToBytes32(WALLET), amountLD: 1n, minAmountLD: 1n, extraOptions: '0xdead' })
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

describe('buildSendPlan quotes in two phases, so an issuer fee is read instead of reverting', () => {
  type Call = { functionName: string; args: readonly unknown[] }
  /** A contract with a fee: it delivers `received` of whatever is sent; quoteSend reverts when minAmountLD > received. */
  function feeContract(received: (sent: bigint) => bigint, opts: { noQuoteOft?: boolean } = {}) {
    const calls: Call[] = []
    const client = {
      readContract: async ({ functionName, args }: Call) => {
        calls.push({ functionName, args })
        const sp = args[0] as { amountLD: bigint; minAmountLD: bigint }
        if (functionName === 'quoteOFT') {
          if (opts.noQuoteOft) throw new Error('execution reverted')
          const r = received(sp.amountLD)
          return [{ minAmountLD: 0n, maxAmountLD: 2n ** 128n }, [{ feeAmountLD: r - sp.amountLD, description: 'Bridge fee' }], { amountSentLD: sp.amountLD, amountReceivedLD: r }] as const
        }
        if (functionName === 'quoteSend') {
          if (sp.minAmountLD > received(sp.amountLD)) throw new Error('execution reverted: SlippageExceeded')
          return { nativeFee: NATIVE_FEE, lzTokenFee: 0n }
        }
        throw new Error('unexpected ' + functionName)
      },
    } as unknown as ReadClient
    return { client, calls }
  }
  const info = treadOftInfo({ routes: [{ eid: ETH_EID, peer: addressToBytes32(OTHER) }] })
  const input = (over: Partial<Parameters<typeof buildSendPlan>[1]> = {}) => ({ info, src: evmByKey('hyperevm'), dstEid: ETH_EID, amountInput: '6000', sender: WALLET, recipient: evmRecipient(WALLET), ...over })

  it('an 84% fee: quoteOFT is asked with no minimum, the minimum is 99.5% of the quoted receive, quoteSend gets that minimum', async () => {
    const { client, calls } = feeContract((sent) => (sent * 16n) / 100n)
    const plan = await buildSendPlan(client, input({ slippageBps: 50 }))
    expect(calls.map((c) => c.functionName)).toEqual(['quoteOFT', 'quoteSend'])
    expect((calls[0]!.args[0] as { minAmountLD: bigint }).minAmountLD).toBe(0n)
    const sent = plan.amounts.amountLD
    const received = (sent * 16n) / 100n
    expect(plan.quote.amountReceivedLD).toBe(received)
    expect(plan.amounts.minAmountLD).toBe((received * 9950n) / 10_000n)
    expect((calls[1]!.args[0] as { minAmountLD: bigint }).minAmountLD).toBe(plan.amounts.minAmountLD)
    // What is signed is what was quoted: the same minimum goes into send().
    expect(assembleSendArgs(plan)[0].minAmountLD).toBe(plan.amounts.minAmountLD)
    expect(plan.quote.unavailable).toBeUndefined()
    expect(plan.quote.feeDetails[0]?.description).toBe('Bridge fee')
  })

  it('no fee: the minimum is the slippage below the amount, exactly as before', async () => {
    const { client } = feeContract((sent) => sent)
    const plan = await buildSendPlan(client, input({ slippageBps: 50 }))
    expect(plan.quote.amountReceivedLD).toBe(plan.amounts.amountLD)
    expect(plan.amounts.minAmountLD).toBe((plan.amounts.amountLD * 9950n) / 10_000n)
  })

  it('a contract with no quoteOFT: the receive is marked unknown, not assumed, and quoteSend is still asked', async () => {
    const { client, calls } = feeContract((sent) => sent, { noQuoteOft: true })
    const plan = await buildSendPlan(client, input({ slippageBps: 50 }))
    expect(plan.quote.unavailable).toMatch(/reverted/)
    expect(plan.quote.amountReceivedLD).toBe(plan.amounts.amountLD)
    expect(plan.amounts.minAmountLD).toBe((plan.amounts.amountLD * 9950n) / 10_000n)
    expect(calls.map((c) => c.functionName)).toEqual(['quoteOFT', 'quoteSend'])
  })

  it('quoteSend refusing the final SendParam is still a plan error', async () => {
    const { client } = feeContract((sent) => sent, { noQuoteOft: true })
    // With no quote the minimum is 100% of the amount at slippage 0; a contract that actually keeps a
    // fee then refuses — which is the honest answer when it would not say how much it keeps.
    const feeButNoQuote = { readContract: async ({ functionName, args }: Call) => {
      if (functionName === 'quoteOFT') throw new Error('execution reverted')
      const sp = args[0] as { amountLD: bigint; minAmountLD: bigint }
      if (sp.minAmountLD > sp.amountLD / 2n) throw new Error('execution reverted: SlippageExceeded')
      return { nativeFee: NATIVE_FEE, lzTokenFee: 0n }
    } } as unknown as ReadClient
    void client
    await expect(buildSendPlan(feeButNoQuote, input({ slippageBps: 0 }))).rejects.toBeInstanceOf(PlanError)
  })
})
