/** fetchEvmTx: "not here" is null, an outage throws, and the fan-out asks for the receipt only on a hit. */
import { describe, expect, it } from 'vitest'
import type { ReadClient } from '@/core/client'
import { fetchEvmTx } from '@/core/analysis/evmTx'

const HASH = `0x${'ab'.repeat(32)}`
const notFound = () => Object.assign(new Error('Transaction could not be found'), { name: 'TransactionNotFoundError' })
const receiptNotFound = () => Object.assign(new Error('Transaction receipt could not be found'), { name: 'TransactionReceiptNotFoundError' })

function client(tx: 'hit' | 'miss' | 'down') {
  const calls: string[] = []
  const c = {
    getTransaction: async () => {
      calls.push('tx')
      if (tx === 'down') throw new Error('HTTP request failed')
      if (tx === 'miss') throw notFound()
      return { from: '0x0000000000000000000000000000000000000001', to: '0x0000000000000000000000000000000000000002', input: '0x12345678' }
    },
    getTransactionReceipt: async () => {
      calls.push('receipt')
      if (tx !== 'hit') throw receiptNotFound()
      return { to: '0x0000000000000000000000000000000000000002', logs: [] }
    },
  } as unknown as ReadClient
  return { c, calls }
}

describe('fetchEvmTx', () => {
  it('txFirst: a chain without the hash costs one request', async () => {
    const { c, calls } = client('miss')
    expect(await fetchEvmTx(c, HASH, { txFirst: true })).toBeNull()
    expect(calls).toEqual(['tx'])
  })

  it('txFirst: a hit reads the receipt once, the transaction once', async () => {
    const { c, calls } = client('hit')
    const r = await fetchEvmTx(c, HASH, { txFirst: true })
    expect(r?.input).toBe('0x12345678')
    expect(calls).toEqual(['tx', 'receipt'])
  })

  it('an outage throws in both modes — "could not look" is never "not here"', async () => {
    await expect(fetchEvmTx(client('down').c, HASH, { txFirst: true })).rejects.toThrow()
    await expect(fetchEvmTx(client('down').c, HASH)).rejects.toThrow()
  })

  it('default: both at once', async () => {
    const { c, calls } = client('miss')
    expect(await fetchEvmTx(c, HASH)).toBeNull()
    expect(calls.sort()).toEqual(['receipt', 'tx'])
  })
})
