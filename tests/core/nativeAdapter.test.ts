/**
 * NativeOFTAdapter (LayerZero devtools, packages/oft-evm/contracts/NativeOFTAdapter.sol): the OFT
 * shape whose `token()` is the zero address and whose `send` takes the amount out of msg.value next
 * to the fee — `msg.value == fee.nativeFee + removeDust(amountLD)`, exactly, or it reverts.
 *
 * Modelled on XPL on Plasma (0x405F…26b0 → BNB Chain), read on chain on 2026-10-12: token() = 0x0,
 * approvalRequired() = false, sharedDecimals() = 6, 264 871 655 XPL held.
 *
 * What is pinned here: the probe tells a native adapter apart from "no code", "not an OFT" and
 * "names a token that is not an ERC-20"; the plan carries the amount in msg.value and nowhere
 * else; the guards hold the coin balance to amount + fee, forbid an approve, and keep the ERC-20
 * paths exactly as they were.
 */
import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Hex } from 'viem'
import { oftAbi } from '@/core/abi'
import type { ReadClient } from '@/core/client'
import { addressToBytes32 } from '@/core/encoding'
import { approvePlan, g11NoApprove, g5Amount, g7Fee, g8Native, runGuards, selfCheck } from '@/core/guards'
import { assembleSendArgs, buildSendPlan, msgValue } from '@/core/plan'
import { probeOft, ProbeError } from '@/core/probe'
import { evmRecipient } from '@/core/recipient'
import { isNativeAdapter } from '@/core/types'
import { adapterSignsOk } from '@/protocols/lz-risk/adapters'
import { BSC_EID, ENDPOINT_PLASMA, goodInput, OWNER, treadOftInfo, treadPlan, WALLET, XPL_ADAPTER, xplNativeInfo, xplPlan } from './fixtures'

const ZERO = '0x0000000000000000000000000000000000000000'
const BSC_PEER: Hex = addressToBytes32(XPL_ADAPTER)

type Answer = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }
const ok = (result: unknown): Answer => ({ status: 'success', result })
const revert = (what: string): Answer => ({ status: 'failure', error: new Error(`execution reverted: ${what}`) })

/**
 * Answers the multicalls probeOft makes, keyed by functionName. `token` is what token() answers;
 * `erc20` whether the named token answers as one; `code` whether there is code at the address.
 */
function fakeClient(p: { token?: string; erc20?: boolean; code?: boolean; tokenFails?: boolean; balance?: bigint } = {}): ReadClient {
  const token = p.token ?? ZERO
  return {
    chain: { nativeCurrency: { name: 'XPL', symbol: 'XPL', decimals: 18 } },
    getCode: async () => (p.code === false ? '0x' : '0x6001'),
    getStorageAt: async () => `0x${'0'.repeat(64)}`,
    getBalance: async () => p.balance ?? 264_871_655n * 10n ** 18n,
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
      contracts.map((c): Answer => {
        switch (c.functionName) {
          case 'token': return p.tokenFails ? revert('token') : ok(token)
          case 'approvalRequired': return ok(false)
          case 'sharedDecimals': return ok(6)
          case 'decimalConversionRate': return ok(10n ** 12n)
          case 'endpoint': return ok(ENDPOINT_PLASMA)
          case 'owner': return ok(OWNER)
          case 'oftVersion': return ok(['0x02e49c2c', 1n])
          case 'peers': return ok(c.args![0] === BSC_EID ? BSC_PEER : `0x${'0'.repeat(64)}`)
          case 'enforcedOptions': return ok('0x')
          case 'decimals': return p.erc20 === false ? revert('decimals') : ok(18)
          case 'symbol': return p.erc20 === false ? revert('symbol') : ok('TKN')
          case 'name': return p.erc20 === false ? revert('name') : ok('Token')
          case 'balanceOf': return p.erc20 === false ? revert('balanceOf') : ok(5n)
          default: return revert(c.functionName)
        }
      }),
  } as unknown as ReadClient
}

describe('probeOft tells the four answers apart', () => {
  it('token() == 0x0 is a native adapter: the coin of the chain, no ERC-20 asked, the held coin read', async () => {
    const { info, flags } = await probeOft(fakeClient(), XPL_ADAPTER, ENDPOINT_PLASMA, [BSC_EID, 30101])
    expect(info.kind).toBe('NativeOFTAdapter')
    expect(info.token).toBe(ZERO)
    expect(info.symbol).toBe('XPL')
    expect(info.decimals).toBe(18)
    expect(info.sharedDecimals).toBe(6)
    expect(info.approvalRequired).toBe(false)
    expect(info.lockedInAdapter).toBe(264_871_655n * 10n ** 18n)
    expect(info.routes).toEqual([{ eid: BSC_EID, peer: BSC_PEER }])
    expect(flags).not.toContain('adapter_empty')
    expect(isNativeAdapter(info)).toBe(true)
  })

  it('a native adapter holding nothing is flagged empty, like any lockbox', async () => {
    const { flags } = await probeOft(fakeClient({ balance: 0n }), XPL_ADAPTER, ENDPOINT_PLASMA, [BSC_EID])
    expect(flags).toContain('adapter_empty')
  })

  it('no code at the address is not_contract', async () => {
    await expect(probeOft(fakeClient({ code: false }), XPL_ADAPTER, ENDPOINT_PLASMA, [BSC_EID])).rejects.toMatchObject({ code: 'not_contract' })
  })

  it('a contract whose token() reverts is not_oft', async () => {
    await expect(probeOft(fakeClient({ tokenFails: true }), XPL_ADAPTER, ENDPOINT_PLASMA, [BSC_EID])).rejects.toMatchObject({ code: 'not_oft' })
  })

  it('a contract naming a token that is not an ERC-20 is token_unreadable, and says which address', async () => {
    const e = await probeOft(fakeClient({ token: WALLET, erc20: false }), XPL_ADAPTER, ENDPOINT_PLASMA, [BSC_EID]).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ProbeError)
    expect((e as ProbeError).code).toBe('token_unreadable')
    expect((e as ProbeError).message.toLowerCase()).toContain(WALLET.toLowerCase())
  })

  it('an ERC-20 adapter and a plain OFT read exactly as before', async () => {
    const adapter = await probeOft(fakeClient({ token: WALLET }), XPL_ADAPTER, ENDPOINT_PLASMA, [BSC_EID])
    expect(adapter.info.kind).toBe('OFTAdapter')
    expect(adapter.info.token.toLowerCase()).toBe(WALLET.toLowerCase())
    expect(adapter.info.symbol).toBe('TKN')
    expect(isNativeAdapter(adapter.info)).toBe(false)
    const plain = await probeOft(fakeClient({ token: XPL_ADAPTER }), XPL_ADAPTER, ENDPOINT_PLASMA, [BSC_EID])
    expect(plain.info.kind).toBe('OFT')
  })
})

describe('the plan of a native adapter', () => {
  /** quoteOFT / quoteSend as the XPL adapter answers them: no fee details, ~3 XPL of gas. */
  const quoting = {
    readContract: async ({ functionName }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === 'quoteOFT') return [{ minAmountLD: 0n, maxAmountLD: 2n ** 256n - 1n }, [], { amountSentLD: 10n ** 18n, amountReceivedLD: 10n ** 18n }]
      if (functionName === 'quoteSend') return { nativeFee: 2_998_170_187_307_073_488n, lzTokenFee: 0n }
      throw new Error(`unexpected ${functionName}`)
    },
  } as unknown as ReadClient
  const src = { eid: 30383, feeStepWei: 10n ** 16n, vm: 'evm' } as Parameters<typeof buildSendPlan>[1]['src']

  it('carries the amount in msg.value, dust-free, and the fee alone in fee.nativeFee', async () => {
    const plan = await buildSendPlan(quoting, { info: xplNativeInfo(), src, dstEid: BSC_EID, amountInput: '1.0000001234', sender: WALLET, recipient: evmRecipient(WALLET), feeBufferBps: 0 })
    // 1.0000001234 trimmed to shared decimals (6): the dust stays in the wallet, not in msg.value.
    expect(plan.amounts.amountLD).toBe(1_000000n * 10n ** 12n)
    expect(plan.nativeAmountLD).toBe(plan.amounts.amountLD)
    expect(plan.value).toBe(2_998_170_187_307_073_488n + (10n ** 16n - (2_998_170_187_307_073_488n % 10n ** 16n)))
    expect(msgValue(plan)).toBe(plan.value + plan.amounts.amountLD)
    // The calldata is untouched: fee.nativeFee is the fee, the amount is in SendParam.
    const [sendParam, fee] = assembleSendArgs(plan)
    expect(fee.nativeFee).toBe(plan.value)
    expect(sendParam.amountLD).toBe(plan.amounts.amountLD)
    expect(selfCheck(plan, encodeFunctionData({ abi: oftAbi, functionName: 'send', args: [sendParam, fee, WALLET] }))).toEqual({ ok: true })
  })

  it('an ERC-20 plan carries nothing in msg.value beyond the fee', async () => {
    const plan = await buildSendPlan(quoting, { info: treadOftInfo(), src, dstEid: BSC_EID, amountInput: '1', sender: WALLET, recipient: evmRecipient(WALLET) }).catch(() => undefined)
    // TREAD has no BSC route; the fixture plan says the same thing directly.
    expect(plan).toBeUndefined()
    expect(treadPlan().nativeAmountLD).toBe(0n)
    expect(msgValue(treadPlan())).toBe(treadPlan().value)
  })
})

describe('the guards of a native adapter', () => {
  const input = (over: Partial<Parameters<typeof runGuards>[0]> = {}) =>
    goodInput({
      info: xplNativeInfo(),
      plan: xplPlan(),
      walletChainId: 9745,
      srcChainId: 9745,
      // No ERC-20: the coin balance is the only balance there is.
      tokenBalance: undefined,
      nativeBalance: 10n * 10n ** 18n,
      allowance: undefined,
      ...over,
    })

  it('lets a funded native send through with no approve anywhere', () => {
    const rep = runGuards(input())
    expect(rep.canSend).toBe(true)
    expect(approvePlan(xplNativeInfo(), xplPlan(), undefined)).toBeNull()
  })

  it('guard 5 holds the amount against the COIN balance, not an ERC-20 one', () => {
    expect(g5Amount(input({ nativeBalance: 10n ** 17n })).ok).toBe(false)
    expect(g5Amount(input({ nativeBalance: 10n ** 17n }))).toMatchObject({ code: 'insufficient_balance' })
    expect(g5Amount(input({ nativeBalance: undefined }))).toMatchObject({ code: 'balance_unknown' })
    // An ERC-20 route still reads the token balance.
    expect(g5Amount(goodInput({ tokenBalance: 0n }))).toMatchObject({ code: 'insufficient_balance' })
  })

  it('guard 8 needs amount + fee + gas in the coin, since both leave in one value', () => {
    const plan = xplPlan()
    const justTheFee = plan.value + 10n ** 15n
    expect(g8Native(input({ nativeBalance: justTheFee }))).toMatchObject({ code: 'insufficient_native' })
    expect(g8Native(input({ nativeBalance: msgValue(plan) + 10n ** 15n })).ok).toBe(true)
    expect(g8Native(input({ nativeBalance: msgValue(plan) + 10n ** 14n }))).toMatchObject({ code: 'insufficient_native' })
  })

  it('guard 7 refuses a plan whose msg.value share is not the amount — and any such share on an ERC-20 route', () => {
    expect(g7Fee(input({ plan: xplPlan({ nativeAmountLD: 0n }) }))).toMatchObject({ code: 'fee_mismatch' })
    expect(g7Fee(input({ plan: xplPlan({ nativeAmountLD: xplPlan().amounts.amountLD + 1n }) }))).toMatchObject({ code: 'fee_mismatch' })
    expect(g7Fee(goodInput({ plan: treadPlan({ nativeAmountLD: 1n }) }))).toMatchObject({ code: 'fee_mismatch' })
    expect(g7Fee(goodInput()).ok).toBe(true)
  })

  it('guard 11 forbids an approve to a native adapter, as to any contract that needs none', () => {
    expect(g11NoApprove(input({ approveIntent: { spender: XPL_ADAPTER, amount: 1n } }))).toMatchObject({ code: 'approve_forbidden' })
    expect(g11NoApprove(input()).ok).toBe(true)
  })

  it('none of this moves an ERC-20 route: the TREAD snapshot still passes unchanged', () => {
    expect(runGuards(goodInput()).canSend).toBe(true)
  })
})

describe('the standing of a native adapter', () => {
  it('holds coin and has history: ordinary; empty or without history: fresh', () => {
    expect(adapterSignsOk({ lockedBps: undefined, outboundNonce: 20n, native: true, held: 1n })).toBe(true)
    expect(adapterSignsOk({ lockedBps: undefined, outboundNonce: 20n, native: true, held: 0n })).toBe(false)
    expect(adapterSignsOk({ lockedBps: undefined, outboundNonce: 19n, native: true, held: 10n ** 24n })).toBe(false)
    expect(adapterSignsOk({ lockedBps: undefined, outboundNonce: 20n, native: true, held: undefined })).toBe(false)
    // The ERC-20 rule is untouched.
    expect(adapterSignsOk({ lockedBps: 10, outboundNonce: 20n })).toBe(true)
    expect(adapterSignsOk({ lockedBps: undefined, outboundNonce: 20n })).toBe(false)
  })
})
