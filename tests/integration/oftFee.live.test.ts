/**
 * An OFT whose owner keeps a fee, against mainnet: BRLA on HyperEVM, which keeps 84% of a transfer
 * to Robinhood Chain. The point of the two-phase quote (plan.ts): the fee is read from `quoteOFT`
 * and said, instead of turning `quoteSend` into a SlippageExceeded revert the user cannot read.
 *
 * Read-only. Public RPCs are flaky, so this project is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { runGuards, type GuardInput } from '@/core/guards'
import { classifyFee, issuerFee } from '@/core/oftFee'
import { buildSendPlan } from '@/core/plan'
import { probeOft } from '@/core/probe'
import { evmRecipient } from '@/core/recipient'

const BRLA_OFT = getAddress('0xA996d8800b6F791f45c22f99424BC41e58F5c8F9')
const BRLA_TOKEN = getAddress('0xA300c891157803e72370d15A30CcEDfFc7153142')
const ROBINHOOD_EID = 30416
const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

describe('BRLA HyperEVM → Robinhood: an 84% issuer fee is read, shown and never hidden behind a revert', () => {
  it('quotes 6000 BRLA: 5040 kept (84%), 960 delivered, quoteSend answers with the real minimum', async () => {
    const client = makeReadClient(evmByKey('hyperevm'))
    const { info } = await probeOft(client, BRLA_OFT, evmByKey('hyperevm').endpointV2)
    expect(info.token).toBe(BRLA_TOKEN)
    expect(info.decimals).toBe(8)
    const plan = await buildSendPlan(client, { info, src: evmByKey('hyperevm'), dstEid: ROBINHOOD_EID, amountInput: '6000', sender: SOMEONE, recipient: evmRecipient(SOMEONE), slippageBps: 50 })
    expect(plan.quote.unavailable).toBeUndefined()
    expect(plan.quote.amountSentLD).toBe(6000n * 10n ** 8n)
    const fee = issuerFee(plan.quote)
    expect(fee.feeLD).toBe(5040n * 10n ** 8n)
    expect(fee.feeBps).toBe(8400n)
    expect(classifyFee(fee.feeBps)).toBe('extreme')
    expect(plan.quote.amountReceivedLD).toBe(960n * 10n ** 8n)
    expect(plan.quote.feeDetails.map((f) => f.description)).toContain('Bridge fee')
    // The minimum is the slippage below what the contract delivers, and quoteSend accepted it.
    expect(plan.amounts.minAmountLD).toBe((960n * 10n ** 8n * 9950n) / 10_000n)
    expect(plan.quote.nativeFee).toBeGreaterThan(0n)
    expect(plan.value).toBeLessThan(evmByKey('hyperevm').feeCeiling)

    // Guards: the fee is a red note; nothing holds the button because of it.
    const input: GuardInput = {
      walletAddress: SOMEONE,
      walletChainId: evmByKey('hyperevm').chainId,
      srcChainId: evmByKey('hyperevm').chainId,
      info,
      plan,
      recipientIsCustom: false,
      recipientConfirmed: true,
      tokenBalance: plan.amounts.amountLD,
      nativeBalance: plan.value * 10n,
      allowance: plan.amounts.amountLD,
      flags: [],
      peerBack: undefined,
      simulation: undefined,
      selfCheck: undefined,
    } as unknown as GuardInput
    const rep = runGuards(input)
    expect(rep.notes.map((n) => !n.ok && n.code)).toContain('oft_fee_extreme')
    expect(rep.blocks.map((b) => !b.ok && b.code)).not.toContain('oft_fee_extreme')
    expect(rep.blocks.map((b) => !b.ok && b.code)).not.toContain('slippage_too_high')
    expect(rep.blocks.map((b) => !b.ok && b.code)).not.toContain('received_lt_min')
  }, 60_000)
})
