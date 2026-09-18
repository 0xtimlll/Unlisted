import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Hash } from 'viem'
import { erc20Abi } from '@/core/abi'
import type { ReadClient } from '@/core/client'
import { decodeTx, DecodeTxError, isTxHash } from '@/core/decodeTx'
import { assembleSendArgs, encodeSendCalldata } from '@/core/plan'
import { ETH_EID, OTHER, TREAD_OFT, treadPlan, WALLET } from './fixtures'

const HASH: Hash = `0x${'11'.repeat(32)}`

function clientWithTx(tx: Record<string, unknown> | null | Error): ReadClient {
  return {
    getTransaction: async () => {
      if (tx instanceof Error) throw tx
      return tx
    },
  } as unknown as ReadClient
}

describe('isTxHash', () => {
  it('accepts 32-byte hex only', () => {
    expect(isTxHash(HASH)).toBe(true)
    expect(isTxHash('0x1234')).toBe(false)
    expect(isTxHash(HASH + '0')).toBe(false)
    expect(isTxHash('')).toBe(false)
  })
})

describe('decodeTx', () => {
  it('prefills contract, dstEid, extraOptions — and NOT recipient/refund/fee', async () => {
    // Someone else's tx: recipient and refund are OTHER, fee is whatever they paid.
    const theirs = treadPlan({ sender: OTHER, recipient: OTHER, extraOptions: '0x0003010011010000000000000000000000000000ea60' })
    const input = encodeSendCalldata(assembleSendArgs(theirs))
    const client = clientWithTx({ to: TREAD_OFT.toLowerCase(), from: OTHER, input, value: theirs.value })

    const p = await decodeTx(client, HASH)
    expect(p.oft).toBe(TREAD_OFT) // checksummed
    expect(p.dstEid).toBe(ETH_EID)
    expect(p.extraOptions).toBe('0x0003010011010000000000000000000000000000ea60')
    // Nothing recipient-like leaks into the prefill.
    expect(JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('recipient')
    expect(p).not.toHaveProperty('recipient')
    expect(p).not.toHaveProperty('refundAddress')
    expect(p.observed.from).toBe(OTHER)
    expect(p.observed.amountLD).toBe(theirs.amounts.amountLD)
    expect(p.observed.nativeFee).toBe(theirs.value)
    expect(p.observed.hadComposeMsg).toBe(false)
    expect(p.observed.hadOftCmd).toBe(false)
    expect(p.observed.from).not.toBe(WALLET)
  })

  it('rejects a non-send tx with a clear code', async () => {
    const input = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [OTHER, 1n] })
    const client = clientWithTx({ to: TREAD_OFT, from: OTHER, input, value: 0n })
    await expect(decodeTx(client, HASH)).rejects.toMatchObject({ code: 'not_send' })
  })

  it('rejects bad hash / missing tx / contract creation', async () => {
    await expect(decodeTx(clientWithTx(null), 'nope')).rejects.toMatchObject({ code: 'invalid_hash' })
    await expect(decodeTx(clientWithTx(null), HASH)).rejects.toMatchObject({ code: 'tx_not_found' })
    await expect(decodeTx(clientWithTx(new Error('not found')), HASH)).rejects.toMatchObject({ code: 'tx_not_found' })
    await expect(decodeTx(clientWithTx({ to: null, from: OTHER, input: '0x', value: 0n }), HASH)).rejects.toMatchObject({ code: 'no_to' })
    await expect(decodeTx(clientWithTx({ to: null, from: OTHER, input: '0x', value: 0n }), HASH)).rejects.toBeInstanceOf(DecodeTxError)
  })
})
