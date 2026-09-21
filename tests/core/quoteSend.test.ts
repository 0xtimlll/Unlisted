/**
 * §5.2: the SendParam handed to quoteOFT/quoteSend must be BYTE-IDENTICAL to the one that goes
 * into send(). A fake client records the quoted struct; assembleSendArgs(plan) rebuilds the sent
 * one; both are ABI-encoded and compared.
 */
import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, type Hex } from 'viem'
import { evmByKey } from '@/core/chains'
import type { ReadClient } from '@/core/client'
import { addressToBytes32 } from '@/core/encoding'
import { encodeLzReceive } from '@/core/options'
import { assembleSendArgs, buildSendPlan, type SendParam } from '@/core/plan'
import { evmRecipient, svmRecipient } from '@/core/recipient'
import { encodeBase58 } from '@/core/svm/base58'
import { OTHER, TREAD_ADAPTER, treadOftInfo, WALLET } from './fixtures'

const SEND_PARAM_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'dstEid', type: 'uint32' },
      { name: 'to', type: 'bytes32' },
      { name: 'amountLD', type: 'uint256' },
      { name: 'minAmountLD', type: 'uint256' },
      { name: 'extraOptions', type: 'bytes' },
      { name: 'composeMsg', type: 'bytes' },
      { name: 'oftCmd', type: 'bytes' },
    ],
  },
] as const
const enc = (sp: SendParam): Hex => encodeAbiParameters(SEND_PARAM_ABI, [sp])

function recordingClient(quoted: SendParam[]): ReadClient {
  return {
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      const sp = args[0] as SendParam
      quoted.push(sp)
      if (functionName === 'quoteOFT') return [{ minAmountLD: 0n, maxAmountLD: 2n ** 128n }, [], { amountSentLD: sp.amountLD, amountReceivedLD: sp.amountLD }]
      if (functionName === 'quoteSend') return { nativeFee: 12_345_678_901_234_567n, lzTokenFee: 0n }
      throw new Error('unexpected ' + functionName)
    },
  } as unknown as ReadClient
}

describe('quoted SendParam === sent SendParam', () => {
  const SOL_WALLET = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff))
  const info = treadOftInfo({
    routes: [{ eid: 30101, peer: addressToBytes32(TREAD_ADAPTER) }, { eid: 30168, peer: `0x${'c3'.repeat(32)}` }],
    enforced: { 30101: '0x0003010011010000000000000000000000000000ea60', 30168: encodeLzReceive(200000n, 2500000n) },
  })

  it.each([
    ['EVM → EVM, default recipient, no options', { dstEid: 30101, recipient: evmRecipient(WALLET), extraOptions: undefined }],
    ['EVM → EVM, custom recipient, sample options', { dstEid: 30101, recipient: evmRecipient(OTHER), extraOptions: '0x0003010011010000000000000000000000000000ea60' as Hex }],
    ['EVM → Solana, ATA missing → rent added', { dstEid: 30168, recipient: svmRecipient(SOL_WALLET), extraOptions: encodeLzReceive(0n, 2_039_280n) }],
    ['EVM → Solana, no extra', { dstEid: 30168, recipient: svmRecipient(SOL_WALLET), extraOptions: undefined }],
  ])('%s', async (_, c) => {
    const quoted: SendParam[] = []
    const plan = await buildSendPlan(recordingClient(quoted), {
      info,
      src: evmByKey('hyperevm'),
      dstEid: c.dstEid,
      amountInput: '19.82',
      sender: WALLET,
      recipient: c.recipient,
      ...(c.extraOptions ? { extraOptions: c.extraOptions } : {}),
    })
    expect(quoted).toHaveLength(2) // quoteOFT + quoteSend
    const [sent] = assembleSendArgs(plan)
    for (const q of quoted) expect(enc(q)).toBe(enc(sent))
    expect(sent.to).toBe(c.recipient.to)
    expect(sent.extraOptions).toBe(c.extraOptions ?? '0x')
    expect(plan.recipientVm).toBe(c.recipient.vm)
  })
})
