/** localStorage shape: EVM and Solana identifiers are both accepted, anything else is dropped. */
import { describe, expect, it } from 'vitest'
import { activeTransfer, entryProtocol, filterHistory, sanitize, type HistoryEntry } from '@/ui/storage'

const EVM = '0xfa44c2634ff17cbe26dc3007d36bd61c79068c14'
const STORE = 'qMNo1RFo11J9ZLGuq7dVmWAssuCZaNsSamk8g2q4UZA'
const HASH = `0x${'ab'.repeat(32)}`
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'

describe('storage.sanitize', () => {
  it('keeps EVM and Solana history entries and recent contracts', () => {
    const s = sanitize({
      history: [
        { srcChain: 'hyperevm', dstEid: 30168, oft: EVM, txHash: HASH, at: 1 },
        { srcChain: 'solana', dstEid: 30367, oft: STORE, txHash: SIG, at: 2, status: 'delivered' },
      ],
      recentContracts: [
        { chain: 'ethereum', address: EVM },
        { chain: 'solana', address: STORE },
      ],
    })
    expect(s.history).toHaveLength(2)
    expect(s.history[1]).toEqual({ srcChain: 'solana', dstEid: 30367, oft: STORE, txHash: SIG, at: 2, status: 'delivered' })
    expect(s.recentContracts).toEqual([
      { chain: 'ethereum', address: EVM },
      { chain: 'solana', address: STORE },
    ])
  })

  it('drops malformed identifiers', () => {
    const s = sanitize({
      history: [
        { srcChain: 'solana', dstEid: 30367, oft: 'javascript:alert(1)', txHash: SIG, at: 2 },
        { srcChain: 'solana', dstEid: 30367, oft: STORE, txHash: '0OIl' + SIG, at: 2 },
        { srcChain: 'solana', dstEid: 30367, oft: STORE, txHash: HASH.slice(0, 20), at: 2 },
      ],
      recentContracts: [{ chain: 'solana', address: '0x' + 'zz'.repeat(20) }, { chain: 'solana', address: 'short' }],
    })
    expect(s.history).toEqual([])
    expect(s.recentContracts).toEqual([])
  })
})

describe('storage: protocol on a history entry', () => {
  it('keeps a known protocol and drops an unknown one', () => {
    const s = sanitize({
      history: [
        { srcChain: 'base', dstEid: 30101, protocol: 'ccip', oft: EVM, txHash: HASH, at: 3 },
        { srcChain: 'base', dstEid: 30101, protocol: 'made-up', oft: EVM, txHash: `0x${'cd'.repeat(32)}`, at: 4 },
      ],
    })
    expect(s.history[0]?.protocol).toBe('ccip')
    expect(s.history[1]).not.toHaveProperty('protocol')
  })

  it('entries written before protocols existed are LayerZero OFT', () => {
    const old: HistoryEntry = { srcChain: 'hyperevm', dstEid: 30101, oft: EVM, txHash: HASH, at: 1 }
    expect(entryProtocol(old)).toBe('lz-oft')
    expect(entryProtocol({ ...old, protocol: 'wormhole-ntt' })).toBe('wormhole-ntt')
  })

  it('filters by protocol', () => {
    const entries: HistoryEntry[] = [
      { srcChain: 'base', dstEid: 30101, oft: EVM, txHash: HASH, at: 1 },
      { srcChain: 'base', dstEid: 30101, protocol: 'ccip', oft: EVM, txHash: `0x${'cd'.repeat(32)}`, at: 2 },
    ]
    expect(filterHistory(entries, 'all')).toHaveLength(2)
    expect(filterHistory(entries, 'lz-oft').map((e) => e.at)).toEqual([1])
    expect(filterHistory(entries, 'ccip').map((e) => e.at)).toEqual([2])
    expect(filterHistory(entries, 'wormhole-ntt')).toEqual([])
  })

  it('a tab only re-opens its own in-flight transfer', () => {
    const now = Date.now()
    const stored = sanitize({
      history: [
        { srcChain: 'base', dstEid: 30101, protocol: 'ccip', oft: EVM, txHash: HASH, at: now },
        { srcChain: 'base', dstEid: 30101, oft: EVM, txHash: `0x${'cd'.repeat(32)}`, at: now },
      ],
    })
    expect(activeTransfer(stored, 'ccip')?.txHash).toBe(HASH)
    expect(activeTransfer(stored, 'lz-oft')?.at).toBe(now)
    expect(activeTransfer(stored, 'wormhole-ntt')).toBeUndefined()
    // A delivered transfer is never re-opened.
    const done = sanitize({ history: [{ srcChain: 'base', dstEid: 30101, oft: EVM, txHash: HASH, at: now, status: 'delivered' }] })
    expect(activeTransfer(done, 'lz-oft')).toBeUndefined()
  })
})

describe('shortError', () => {
  it('keeps the node’s own words next to viem’s generic label', async () => {
    const { shortError } = await import('@/ui/hooks')
    // viem wraps JSON-RPC -32003 as "Transaction creation failed." — useless on its own.
    expect(shortError({ shortMessage: 'Transaction creation failed.', details: 'insufficient funds for gas * price + value' })).toBe(
      'Transaction creation failed. insufficient funds for gas * price + value',
    )
    expect(shortError({ shortMessage: 'Execution reverted.', details: 'Execution reverted.' })).toBe('Execution reverted.')
    expect(shortError({ details: 'only details' })).toBe('only details')
    expect(shortError({ message: 'line one\nline two' })).toBe('line one')
    expect(shortError(undefined)).toBe('')
    expect(shortError({ shortMessage: 'x'.repeat(400) })).toHaveLength(240)
  })
})
