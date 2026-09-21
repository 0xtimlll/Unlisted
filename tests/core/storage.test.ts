/** localStorage shape: EVM and Solana identifiers are both accepted, anything else is dropped. */
import { describe, expect, it } from 'vitest'
import { sanitize } from '@/ui/storage'

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
