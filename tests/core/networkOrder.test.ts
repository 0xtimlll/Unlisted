/** The network picker's order and the persisted preference behind it. */
import { describe, expect, it } from 'vitest'
import { CHAINS, type ChainKey } from '@/core/chains'
import { byPopularity, orderNetworks, pushRecentChain, RECENT_MAX } from '@/ui/networkOrder'
import { EMPTY, load, sanitize, save } from '@/ui/storage'

const keys = CHAINS.map((c) => c.key)

describe('orderNetworks', () => {
  it('popular: the registry order, which is DefiLlama TVL descending', () => {
    const shuffled = [...keys].reverse()
    expect(orderNetworks(shuffled, 'popular', [])).toEqual(keys)
    expect(byPopularity(['solana', 'ethereum'] as ChainKey[])).toEqual(['ethereum', 'solana'])
    expect(orderNetworks(keys, 'popular', ['monad', 'ink'] as ChainKey[])).toEqual(keys) // recent picks do not move anything here
  })

  it('recent first: the last picks on top, newest first, then everyone else by popularity', () => {
    const recent = ['ink', 'monad', 'bsc'] as ChainKey[]
    const out = orderNetworks(keys, 'recent', recent)
    expect(out.slice(0, 3)).toEqual(recent)
    expect(out.slice(3)).toEqual(keys.filter((k) => !recent.includes(k)))
    expect(out).toHaveLength(keys.length)
  })

  it('lifts at most RECENT_MAX, only those the list has, and never duplicates', () => {
    const recent = ['ink', 'monad', 'bsc', 'base', 'linea', 'plasma', 'scroll'] as ChainKey[]
    const out = orderNetworks(keys, 'recent', recent)
    expect(out.slice(0, RECENT_MAX)).toEqual(recent.slice(0, RECENT_MAX))
    expect(new Set(out).size).toBe(out.length)
    // A recent pick the list does not offer (no route there) is not conjured into it.
    const few = ['ethereum', 'base'] as ChainKey[]
    expect(orderNetworks(few, 'recent', ['monad', 'base'] as ChainKey[])).toEqual(['base', 'ethereum'])
  })

  it('pushRecentChain keeps the list unique, newest first and capped', () => {
    let r: ChainKey[] = []
    for (const k of ['ethereum', 'base', 'ethereum', 'ink', 'monad', 'bsc', 'linea', 'plasma'] as ChainKey[]) r = pushRecentChain(r, k)
    expect(r).toEqual(['plasma', 'linea', 'bsc', 'monad', 'ink'])
    expect(r).toHaveLength(RECENT_MAX)
  })
})

describe('the preference survives a reload', () => {
  it('sanitize keeps a valid order and recent list and drops anything else', () => {
    const s = sanitize({ networkOrder: 'recent', recentChains: ['ink', 'nope', 'constructor', 7, 'monad', 'ink'] })
    expect(s.networkOrder).toBe('recent')
    expect(s.recentChains).toEqual(['ink', 'monad'])
    expect(sanitize({ networkOrder: 'weird' }).networkOrder).toBe('popular')
    expect(sanitize({}).recentChains).toEqual([])
    expect(EMPTY.networkOrder).toBe('popular')
  })

  it('save → load round-trips through localStorage, and a broken store reads as the defaults', () => {
    const store = new Map<string, string>()
    const g = globalThis as { localStorage?: unknown }
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
    try {
      save({ ...EMPTY, networkOrder: 'recent', recentChains: ['monad', 'ink'] as ChainKey[] })
      const back = load()
      expect(back.networkOrder).toBe('recent')
      expect(back.recentChains).toEqual(['monad', 'ink'])
      g.localStorage = {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
        removeItem: () => {},
      }
      expect(load().networkOrder).toBe('popular')
      expect(() => save({ ...EMPTY, networkOrder: 'recent' })).not.toThrow()
    } finally {
      delete g.localStorage
    }
  })
})
