/**
 * A reverting contract's own error ABI, from Sourcify.
 *
 * Everything the network returns is treated as untrusted: only well-formed `error` entries survive,
 * an unverified contract is an ordinary answer, and an unreachable Sourcify never becomes a
 * statement about the transaction.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { encodeErrorResult, type Abi } from 'viem'
import { decodeRevert, enrichRevert } from '@/core/sim/revert'
import {
  clearSourcifyCache,
  fetchContractErrorAbi,
  parseSourcifyResponse,
  sanitizeErrorAbi,
  sourcifyCacheSize,
  sourcifyUrl,
  type SourcifyFetch,
} from '@/core/sim/sourcify'

const CONTRACT = '0x1111111111111111111111111111111111111111'
const PROXY = '0x2222222222222222222222222222222222222222'
const IMPL = '0x3333333333333333333333333333333333333333'

const TRANSFER_BLOCKED = { type: 'error', name: 'TransferBlocked', inputs: [{ name: 'who', type: 'address' }] }

/** A fetch that answers from a table and counts calls. */
function mockFetch(table: Record<string, unknown>, calls: string[] = []): SourcifyFetch {
  return async (url: string) => {
    calls.push(url)
    const addr = url.match(/contract\/\d+\/(0x[0-9a-f]+)/)?.[1] ?? ''
    const body = table[addr]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ match: null }) }
    return { ok: true, status: 200, json: async () => body }
  }
}

beforeEach(() => clearSourcifyCache())

describe('the request', () => {
  it('sends the chain id and the address, and nothing else', () => {
    const url = sourcifyUrl(1, CONTRACT.toUpperCase().replace('0X', '0x'))
    expect(url).toBe(`https://sourcify.dev/server/v2/contract/1/${CONTRACT}?fields=abi,proxyResolution`)
    expect(url).not.toMatch(/key|token|account|amount/i)
    expect(() => sourcifyUrl(1, 'nope')).toThrow()
    expect(() => sourcifyUrl(0, CONTRACT)).toThrow()
  })
})

describe('what comes back is untrusted', () => {
  it('keeps only well-formed error entries', () => {
    const abi = sanitizeErrorAbi([
      TRANSFER_BLOCKED,
      { type: 'function', name: 'transfer', inputs: [] }, // not an error
      { type: 'error', name: '1bad', inputs: [] }, // not an identifier
      { type: 'error', name: 'Weird', inputs: [{ name: 'x', type: 'uint257' }] }, // impossible type
      { type: 'error', name: 'NoInputs' },
      { type: 'error', name: 'Nested', inputs: [{ name: 't', type: 'tuple', components: [{ name: 'a', type: 'uint256' }] }] },
    ])
    expect(abi.map((e) => (e as { name: string }).name)).toEqual(['TransferBlocked', 'NoInputs', 'Nested'])
  })

  it('refuses anything that is not a verified match', () => {
    expect(parseSourcifyResponse({ match: null, abi: [TRANSFER_BLOCKED] })).toBeUndefined()
    expect(parseSourcifyResponse({ match: 'pending', abi: [TRANSFER_BLOCKED] })).toBeUndefined()
    // Sourcify's two verified levels — full and partial — are both accepted.
    expect(parseSourcifyResponse({ match: 'exact_match', abi: [TRANSFER_BLOCKED] })?.abi).toHaveLength(1)
    expect(parseSourcifyResponse({ match: 'match', abi: [TRANSFER_BLOCKED] })?.abi).toHaveLength(1)
    expect(parseSourcifyResponse('nonsense')).toBeUndefined()
  })

  it('reads the implementation out of a proxy', () => {
    const p = parseSourcifyResponse({
      match: 'match',
      abi: [],
      proxyResolution: { isProxy: true, proxyType: 'EIP1967Proxy', implementations: [{ address: IMPL, name: 'V2' }] },
    })
    expect(p?.implementation).toBe(IMPL)
    expect(parseSourcifyResponse({ match: 'match', abi: [], proxyResolution: { isProxy: false, implementations: [] } })?.implementation).toBeUndefined()
  })
})

describe('fetching', () => {
  it('returns the contract’s errors when it is verified', async () => {
    const abi = await fetchContractErrorAbi(1, CONTRACT, mockFetch({ [CONTRACT]: { match: 'exact_match', abi: [TRANSFER_BLOCKED] } }))
    expect(abi?.abi).toHaveLength(1)
    expect(abi?.from).toBe(CONTRACT)
    expect(abi?.viaProxy).toBe(false)
  })

  it('follows a proxy to the implementation, because the proxy carries no errors', async () => {
    const calls: string[] = []
    const abi = await fetchContractErrorAbi(
      1,
      PROXY,
      mockFetch(
        {
          [PROXY]: { match: 'match', abi: [], proxyResolution: { isProxy: true, implementations: [{ address: IMPL }] } },
          [IMPL]: { match: 'match', abi: [TRANSFER_BLOCKED] },
        },
        calls,
      ),
    )
    expect(abi?.from).toBe(IMPL)
    expect(abi?.viaProxy).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('an unverified contract and an unreachable Sourcify both mean "no ABI", not an error', async () => {
    expect(await fetchContractErrorAbi(1, CONTRACT, mockFetch({}))).toBeUndefined()
    const throwing: SourcifyFetch = async () => {
      throw new Error('network down')
    }
    expect(await fetchContractErrorAbi(1, CONTRACT, throwing)).toBeUndefined()
  })

  it('asks once per contract per session, misses included', async () => {
    const calls: string[] = []
    const fetchImpl = mockFetch({ [CONTRACT]: { match: 'match', abi: [TRANSFER_BLOCKED] } }, calls)
    await fetchContractErrorAbi(1, CONTRACT, fetchImpl)
    await fetchContractErrorAbi(1, CONTRACT.toUpperCase().replace('0X', '0x'), fetchImpl)
    expect(calls).toHaveLength(1)

    const missCalls: string[] = []
    const missFetch = mockFetch({}, missCalls)
    await fetchContractErrorAbi(1, PROXY, missFetch)
    await fetchContractErrorAbi(1, PROXY, missFetch)
    expect(missCalls).toHaveLength(1)
    expect(sourcifyCacheSize()).toBeGreaterThan(0)
  })
})

describe('naming an unknown selector', () => {
  const data = encodeErrorResult({ abi: [TRANSFER_BLOCKED] as Abi, errorName: 'TransferBlocked', args: [CONTRACT] })

  it('turns four bytes of hex into the contract’s own error name', async () => {
    const raw = decodeRevert(data)
    expect(raw.kind).toBe('unknown')

    const named = await enrichRevert(raw, {
      chainId: 1,
      candidates: [CONTRACT],
      fetchImpl: mockFetch({ [CONTRACT]: { match: 'match', abi: [TRANSFER_BLOCKED] } }),
    })
    expect(named).toMatchObject({ kind: 'error', name: 'TransferBlocked', source: 'contract', from: CONTRACT })
  })

  it('tries each candidate in order and stops at the first that decodes', async () => {
    const calls: string[] = []
    const named = await enrichRevert(decodeRevert(data), {
      chainId: 1,
      candidates: [PROXY, PROXY, CONTRACT], // the duplicate must not cost a second request
      fetchImpl: mockFetch({ [CONTRACT]: { match: 'match', abi: [TRANSFER_BLOCKED] } }, calls),
    })
    expect(named.kind).toBe('error')
    expect(calls).toHaveLength(2)
  })

  it('leaves the raw selector and its link alone when nothing is verified', async () => {
    const raw = decodeRevert(data)
    const still = await enrichRevert(raw, { chainId: 1, candidates: [CONTRACT], fetchImpl: mockFetch({}) })
    expect(still).toEqual(raw)
    expect(still.kind).toBe('unknown')
  })

  it('never re-labels an error we already know ourselves', async () => {
    const calls: string[] = []
    const known = decodeRevert(encodeErrorResult({ abi: [{ type: 'error', name: 'NoPeer', inputs: [{ type: 'uint32' }] }] as Abi, errorName: 'NoPeer', args: [30101] }))
    expect(known).toMatchObject({ kind: 'error', source: 'known' })
    const after = await enrichRevert(known, { chainId: 1, candidates: [CONTRACT], fetchImpl: mockFetch({}, calls) })
    expect(after).toEqual(known)
    expect(calls).toHaveLength(0) // a known error costs no request at all
  })
})
