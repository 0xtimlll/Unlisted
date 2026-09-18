import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Hex } from 'viem'
import { oftAbi } from '@/core/abi'
import { ZERO_ADDRESS } from '@/core/encoding'
import {
  approvePlan,
  g1Chain,
  g2Peer,
  g3Recipient,
  g4RecipientNotContract,
  g5Amount,
  g6MinAmount,
  g7Fee,
  g8Native,
  g9Quote,
  g10Allowance,
  g11NoApprove,
  g12Spender,
  g13Simulation,
  g14SelfCheck,
  g15ExecutorGas,
  runGuards,
  selfCheck,
  type GuardInput,
  type GuardResult,
} from '@/core/guards'
import { assembleSendArgs, encodeSendCalldata } from '@/core/plan'
import {
  ENDPOINT_HYPER,
  ETH_EID,
  goodInput,
  HYPER_CHAIN_ID,
  HYPER_EID,
  OTHER,
  quoteFor,
  TREAD_ADAPTER,
  TREAD_OFT,
  treadAdapterInfo,
  treadOftInfo,
  treadPlan,
  WALLET,
} from './fixtures'

const code = (r: GuardResult) => (r.ok ? 'ok' : r.code)

describe('runGuards on a good snapshot', () => {
  it('passes everything and enables Send', () => {
    const rep = runGuards(goodInput())
    expect(rep.results).toHaveLength(16)
    expect(rep.results.map(code)).toEqual(Array(16).fill('ok'))
    expect(rep.canSend).toBe(true)
    expect(rep.warnings).toEqual([])
    expect(rep.needsNoGasConfirmation).toBe(false)
  })

  it('a single failing guard disables Send', () => {
    const rep = runGuards(goodInput({ simulation: { ok: false, reason: 'revert' } }))
    expect(rep.canSend).toBe(false)
    expect(rep.results.filter((r) => !r.ok).map((r) => r.id)).toEqual([13])
  })

  it('with nothing loaded, everything but 16 fails and Send is disabled', () => {
    const rep = runGuards(
      goodInput({
        walletAddress: undefined,
        walletChainId: undefined,
        info: undefined,
        plan: undefined,
        tokenBalance: undefined,
        nativeBalance: undefined,
        allowance: undefined,
        gasCostWei: undefined,
        simulation: undefined,
        selfCheck: undefined,
      }),
    )
    expect(rep.canSend).toBe(false)
    expect(rep.results.filter((r) => r.ok).map((r) => r.id)).toEqual([16])
  })
})

describe('1. chain match', () => {
  it('fails when not connected', () => {
    expect(code(g1Chain(goodInput({ walletAddress: undefined })))).toBe('wallet_not_connected')
    expect(code(g1Chain(goodInput({ walletChainId: undefined })))).toBe('wallet_not_connected')
  })
  it('fails on mismatch', () => {
    expect(code(g1Chain(goodInput({ walletChainId: 1 })))).toBe('chain_mismatch')
  })
  it('fails when plan.srcEid does not belong to srcChainId', () => {
    expect(code(g1Chain(goodInput({ plan: treadPlan({ srcEid: ETH_EID }) })))).toBe('chain_mismatch')
  })
  it('fails on unknown chain', () => {
    expect(code(g1Chain(goodInput({ walletChainId: 4242, srcChainId: 4242 })))).toBe('chain_mismatch')
  })
  it('passes when equal', () => {
    expect(code(g1Chain(goodInput()))).toBe('ok')
  })
})

describe('2. peer exists', () => {
  it('fails without probe', () => {
    expect(code(g2Peer(goodInput({ info: undefined })))).toBe('oft_missing')
  })
  it('fails when destination has no peer', () => {
    expect(code(g2Peer(goodInput({ plan: treadPlan({ dstEid: 30110 }) })))).toBe('peer_missing')
  })
  it('fails when peer is zero', () => {
    const info = treadOftInfo({ routes: [{ eid: ETH_EID, peer: ZERO_ADDRESS }] })
    expect(code(g2Peer(goodInput({ info })))).toBe('peer_missing')
  })
  it('fails when plan.oft != info.oft', () => {
    expect(code(g2Peer(goodInput({ plan: treadPlan({ oft: OTHER }) })))).toBe('oft_missing')
  })
  it('passes with a peer', () => {
    expect(code(g2Peer(goodInput()))).toBe('ok')
  })
})

describe('3. recipient', () => {
  it('default recipient == wallet passes without confirmation', () => {
    expect(code(g3Recipient(goodInput()))).toBe('ok')
  })
  it('custom recipient requires flag AND confirmation', () => {
    const plan = treadPlan({ recipient: OTHER })
    expect(code(g3Recipient(goodInput({ plan })))).toBe('recipient_unconfirmed')
    expect(code(g3Recipient(goodInput({ plan, recipientIsCustom: true })))).toBe('recipient_unconfirmed')
    expect(code(g3Recipient(goodInput({ plan, customRecipientConfirmed: true })))).toBe('recipient_unconfirmed')
    expect(code(g3Recipient(goodInput({ plan, recipientIsCustom: true, customRecipientConfirmed: true })))).toBe('ok')
  })
  it('invalid address fails', () => {
    expect(code(g3Recipient(goodInput({ plan: treadPlan({ recipient: '0x123' as never }) })))).toBe('recipient_invalid')
  })
  it('wallet address in different case is still "self"', () => {
    const plan = treadPlan({ recipient: WALLET.toUpperCase().replace('0X', '0x') as never })
    expect(code(g3Recipient(goodInput({ plan })))).toBe('ok')
  })
})

describe('4. recipient is not zero / a contract we know', () => {
  const custom = { recipientIsCustom: true, customRecipientConfirmed: true }
  it('zero address fails', () => {
    expect(code(g4RecipientNotContract(goodInput({ ...custom, plan: treadPlan({ recipient: ZERO_ADDRESS }) })))).toBe('recipient_zero')
  })
  it.each([
    ['oft', TREAD_OFT],
    ['endpoint', ENDPOINT_HYPER],
  ])('%s address fails', (_, addr) => {
    expect(code(g4RecipientNotContract(goodInput({ ...custom, plan: treadPlan({ recipient: addr }) })))).toBe('recipient_is_contract')
  })
  it('token address of an adapter fails', () => {
    const info = treadAdapterInfo()
    expect(code(g4RecipientNotContract(goodInput({ ...custom, info, plan: treadPlan({ recipient: info.token }) })))).toBe('recipient_is_contract')
  })
  it('a normal address passes', () => {
    expect(code(g4RecipientNotContract(goodInput({ ...custom, plan: treadPlan({ recipient: OTHER }) })))).toBe('ok')
  })
})

describe('5. amount > 0 and <= balance', () => {
  it('zero amount fails', () => {
    expect(code(g5Amount(goodInput({ plan: treadPlan({}, '0') })))).toBe('amount_zero')
  })
  it('dust-only amount (trims to zero) fails', () => {
    expect(code(g5Amount(goodInput({ plan: treadPlan({}, '0.0000000001') })))).toBe('amount_zero')
  })
  it('unknown balance fails', () => {
    expect(code(g5Amount(goodInput({ tokenBalance: undefined })))).toBe('balance_unknown')
  })
  it('amount > balance fails; == balance passes', () => {
    const plan = treadPlan()
    expect(code(g5Amount(goodInput({ plan, tokenBalance: plan.amounts.amountLD - 1n })))).toBe('insufficient_balance')
    expect(code(g5Amount(goodInput({ plan, tokenBalance: plan.amounts.amountLD })))).toBe('ok')
  })
})

describe('6. minAmountLD <= amountLD, both multiples of rate', () => {
  it('min > amount fails', () => {
    const p = treadPlan()
    p.amounts = { ...p.amounts, minAmountLD: p.amounts.amountLD + 10n ** 12n }
    expect(code(g6MinAmount(goodInput({ plan: p })))).toBe('min_gt_amount')
  })
  it('non-multiple amount fails', () => {
    const p = treadPlan()
    p.amounts = { ...p.amounts, amountLD: p.amounts.amountLD + 1n }
    expect(code(g6MinAmount(goodInput({ plan: p })))).toBe('not_multiple_of_rate')
  })
  it('non-multiple min fails', () => {
    const p = treadPlan()
    p.amounts = { ...p.amounts, minAmountLD: p.amounts.minAmountLD - 1n }
    expect(code(g6MinAmount(goodInput({ plan: p })))).toBe('not_multiple_of_rate')
  })
  it('passes for computed amounts', () => {
    expect(code(g6MinAmount(goodInput()))).toBe('ok')
  })
})

describe('7. fee.nativeFee === value, lzTokenFee === 0', () => {
  it('passes for an assembled plan', () => {
    expect(code(g7Fee(goodInput()))).toBe('ok')
  })
  it('value below quoted nativeFee fails', () => {
    const p = treadPlan()
    p.value = p.quote.nativeFee - 1n
    expect(code(g7Fee(goodInput({ plan: p })))).toBe('fee_mismatch')
  })
  it('assembled fee equals plan.value by construction', () => {
    const p = treadPlan()
    const [, fee] = assembleSendArgs(p)
    expect(fee.nativeFee).toBe(p.value)
    expect(fee.lzTokenFee).toBe(0n)
  })
})

describe('8. value + gas <= native balance', () => {
  it('unknown balance/gas fails', () => {
    expect(code(g8Native(goodInput({ nativeBalance: undefined })))).toBe('native_balance_unknown')
    expect(code(g8Native(goodInput({ gasCostWei: undefined })))).toBe('native_balance_unknown')
  })
  it('exact balance passes, one wei short fails', () => {
    const p = treadPlan()
    const gas = 10n ** 15n
    expect(code(g8Native(goodInput({ plan: p, gasCostWei: gas, nativeBalance: p.value + gas })))).toBe('ok')
    expect(code(g8Native(goodInput({ plan: p, gasCostWei: gas, nativeBalance: p.value + gas - 1n })))).toBe('insufficient_native')
  })
})

describe('9. quoteOFT vs minAmountLD and limits', () => {
  it('received < min fails (rate limiter / fee)', () => {
    const p = treadPlan()
    p.quote = quoteFor(p.amounts.amountLD, { amountReceivedLD: p.amounts.minAmountLD - 1n })
    expect(code(g9Quote(goodInput({ plan: p })))).toBe('received_lt_min')
  })
  it('amount above max limit fails', () => {
    const p = treadPlan()
    p.quote = quoteFor(p.amounts.amountLD, { limitMaxLD: p.amounts.amountLD - 1n })
    expect(code(g9Quote(goodInput({ plan: p })))).toBe('amount_out_of_limits')
  })
  it('amount below min limit fails', () => {
    const p = treadPlan()
    p.quote = quoteFor(p.amounts.amountLD, { limitMinLD: p.amounts.amountLD + 1n })
    expect(code(g9Quote(goodInput({ plan: p })))).toBe('amount_out_of_limits')
  })
  it('received == min passes', () => {
    expect(code(g9Quote(goodInput()))).toBe('ok')
  })
})

describe('10–12. approve rules', () => {
  const adapter = treadAdapterInfo()
  const plan = treadPlan({ oft: TREAD_ADAPTER, srcEid: ETH_EID, dstEid: HYPER_EID })
  const base = (over: Partial<GuardInput> = {}) =>
    goodInput({ info: adapter, plan, walletChainId: 1, srcChainId: 1, ...over })

  it('10: approvalRequired=false -> allowance irrelevant', () => {
    expect(code(g10Allowance(goodInput({ allowance: undefined })))).toBe('ok')
    expect(code(g10Allowance(goodInput({ allowance: 0n })))).toBe('ok')
  })
  it('10: approvalRequired=true -> allowance must cover amountLD', () => {
    expect(code(g10Allowance(base({ allowance: undefined })))).toBe('allowance_unknown')
    expect(code(g10Allowance(base({ allowance: plan.amounts.amountLD - 1n })))).toBe('needs_approve')
    expect(code(g10Allowance(base({ allowance: plan.amounts.amountLD })))).toBe('ok')
    expect(code(g10Allowance(base({ allowance: 2n ** 256n - 1n })))).toBe('ok')
  })
  it('10: an approve intent with a different amount is rejected', () => {
    const r = g10Allowance(base({ allowance: 0n, approveIntent: { spender: TREAD_ADAPTER, amount: 2n ** 256n - 1n } }))
    expect(code(r)).toBe('approve_amount_mismatch')
    const r2 = g10Allowance(base({ allowance: 0n, approveIntent: { spender: TREAD_ADAPTER, amount: plan.amounts.amountLD } }))
    expect(code(r2)).toBe('needs_approve') // correct intent, still needs to be mined
  })
  it('11: approvalRequired=false forbids any approve', () => {
    expect(code(g11NoApprove(goodInput({ approveIntent: { spender: TREAD_OFT, amount: 1n } })))).toBe('approve_forbidden')
    expect(code(g11NoApprove(goodInput()))).toBe('ok')
    expect(code(g11NoApprove(base({ approveIntent: { spender: TREAD_ADAPTER, amount: 1n } })))).toBe('ok')
  })
  it('12: spender must be probeOft().oft', () => {
    expect(code(g12Spender(base({ approveIntent: { spender: OTHER, amount: 1n } })))).toBe('approve_wrong_spender')
    expect(code(g12Spender(base({ approveIntent: { spender: adapter.token, amount: 1n } })))).toBe('approve_wrong_spender')
    expect(code(g12Spender(base({ approveIntent: { spender: TREAD_ADAPTER, amount: 1n } })))).toBe('ok')
  })

  describe('approvePlan', () => {
    it('returns null when approvalRequired=false, even with zero allowance', () => {
      expect(approvePlan(treadOftInfo(), treadPlan(), 0n)).toBeNull()
      expect(approvePlan(treadOftInfo(), treadPlan(), undefined)).toBeNull()
    })
    it('returns exactly amountLD to exactly info.oft', () => {
      const a = approvePlan(adapter, plan, 0n)
      expect(a).toEqual({ spender: TREAD_ADAPTER, amount: plan.amounts.amountLD })
      expect(a!.amount).not.toBe(2n ** 256n - 1n)
    })
    it('returns null when allowance already covers', () => {
      expect(approvePlan(adapter, plan, plan.amounts.amountLD)).toBeNull()
      expect(approvePlan(adapter, plan, plan.amounts.amountLD - 1n)).not.toBeNull()
    })
    it('returns an intent when allowance is unknown (UI must refetch before sending)', () => {
      expect(approvePlan(adapter, plan, undefined)).not.toBeNull()
    })
  })
})

describe('13. simulation', () => {
  it('missing / failed / ok', () => {
    expect(code(g13Simulation(goodInput({ simulation: undefined })))).toBe('simulation_missing')
    expect(code(g13Simulation(goodInput({ simulation: { ok: false, reason: 'x' } })))).toBe('simulation_failed')
    expect(code(g13Simulation(goodInput()))).toBe('ok')
  })
})

describe('14. self-check', () => {
  it('guard reflects the result', () => {
    expect(code(g14SelfCheck(goodInput({ selfCheck: undefined })))).toBe('selfcheck_missing')
    expect(code(g14SelfCheck(goodInput({ selfCheck: { ok: false, mismatches: ['to'] } })))).toBe('selfcheck_failed')
    expect(code(g14SelfCheck(goodInput()))).toBe('ok')
  })

  it('selfCheck passes on our own calldata', () => {
    const plan = treadPlan()
    expect(selfCheck(plan, encodeSendCalldata(assembleSendArgs(plan)))).toEqual({ ok: true })
  })

  const tamper = (mut: (args: ReturnType<typeof assembleSendArgs>) => Parameters<typeof encodeFunctionData>[0]['args']) => {
    const plan = treadPlan()
    const args = assembleSendArgs(plan)
    const data = encodeFunctionData({ abi: oftAbi, functionName: 'send', args: mut(args) as never }) as Hex
    return selfCheck(plan, data)
  }

  it.each([
    ['dstEid', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [{ ...sp, dstEid: 30110 }, fee, r]],
    ['to', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [{ ...sp, to: `0x${'0'.repeat(24)}${OTHER.slice(2)}` }, fee, r]],
    ['amountLD', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [{ ...sp, amountLD: sp.amountLD + 1n }, fee, r]],
    ['minAmountLD', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [{ ...sp, minAmountLD: 0n }, fee, r]],
    ['extraOptions', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [{ ...sp, extraOptions: '0x01' }, fee, r]],
    ['composeMsg', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [{ ...sp, composeMsg: '0x01' }, fee, r]],
    ['oftCmd', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [{ ...sp, oftCmd: '0x01' }, fee, r]],
    ['fee.nativeFee', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [sp, { ...fee, nativeFee: fee.nativeFee + 1n }, r]],
    ['fee.lzTokenFee', ([sp, fee, r]: ReturnType<typeof assembleSendArgs>) => [sp, { ...fee, lzTokenFee: 1n }, r]],
    ['refundAddress', ([sp, fee]: ReturnType<typeof assembleSendArgs>) => [sp, fee, OTHER]],
  ])('detects tampered %s', (field, mut) => {
    const r = tamper(mut as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mismatches.join(',')).toContain(field)
  })

  it('rejects calldata that is not send()', () => {
    const r = selfCheck(treadPlan(), `0x095ea7b3${'00'.repeat(64)}`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mismatches[0]).toMatch(/decode/)
  })
})

describe('15. executor gas warning', () => {
  it('enforced options present -> no confirmation needed', () => {
    const rep = runGuards(goodInput())
    expect(rep.needsNoGasConfirmation).toBe(false)
    expect(code(g15ExecutorGas(goodInput()))).toBe('ok')
  })
  it('no enforced, no extra -> requires acceptance', () => {
    const info = treadOftInfo({ enforced: { [ETH_EID]: '0x' } })
    expect(code(g15ExecutorGas(goodInput({ info })))).toBe('no_executor_gas_unconfirmed')
    expect(runGuards(goodInput({ info })).needsNoGasConfirmation).toBe(true)
    expect(code(g15ExecutorGas(goodInput({ info, noExecutorGasAccepted: true })))).toBe('ok')
  })
  it('missing enforced entry counts as empty', () => {
    const info = treadOftInfo({ enforced: {} })
    expect(code(g15ExecutorGas(goodInput({ info })))).toBe('no_executor_gas_unconfirmed')
  })
  it('extraOptions set -> no confirmation needed', () => {
    const info = treadOftInfo({ enforced: {} })
    const plan = treadPlan({ extraOptions: '0x0003010011010000000000000000000000000000ea60' })
    expect(code(g15ExecutorGas(goodInput({ info, plan })))).toBe('ok')
  })
})

describe('16. suspicious flags never block', () => {
  it('surfaces warnings but canSend stays true', () => {
    const rep = runGuards(goodInput({ flags: ['owner_is_eoa', 'behind_proxy'] }))
    expect(rep.warnings).toEqual(['owner_is_eoa', 'behind_proxy'])
    expect(rep.canSend).toBe(true)
    expect(rep.results[15]).toEqual({ id: 16, ok: true })
  })
})

describe('chain id constant sanity', () => {
  it('HyperEVM fixtures match the registry', () => {
    expect(HYPER_CHAIN_ID).toBe(999)
    expect(HYPER_EID).toBe(30367)
  })
})
