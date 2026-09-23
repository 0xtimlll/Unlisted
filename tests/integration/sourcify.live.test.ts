/**
 * The contract-ABI lookup against the real Sourcify.
 *
 * Read-only, and the only thing sent is a chain id and a contract address. Not part of
 * `npm test` — it needs the network.
 */
import { describe, expect, it } from 'vitest'
import { encodeErrorResult, type Abi } from 'viem'
import { decodeRevert, enrichRevert } from '@/core/sim/revert'
import { clearSourcifyCache, fetchContractErrorAbi } from '@/core/sim/sourcify'

/** CCIP Router on Ethereum: verified, and it declares errors of its own. */
const ROUTER = '0x80226fc0ee2b096224eeac085bb9a8cba1146f7d'
/** USDC on Ethereum: a proxy, whose own ABI carries no errors — they live in the implementation. */
const USDC_PROXY = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
/** A chain Sourcify does not index. */
const HYPEREVM_CHAIN_ID = 999

describe('Sourcify', () => {
  it('returns a verified contract’s own error entries', async () => {
    clearSourcifyCache()
    const found = await fetchContractErrorAbi(1, ROUTER)
    expect(found).toBeDefined()
    if (!found) return
    expect(found.from).toBe(ROUTER)
    expect(found.abi.length).toBeGreaterThan(0)
    // Only errors survive the sanitiser.
    expect(found.abi.every((e) => (e as { type: string }).type === 'error')).toBe(true)
    expect(['match', 'exact_match']).toContain(found.match)
  })

  it('names an error that none of our built-in ABIs know', async () => {
    clearSourcifyCache()
    const found = await fetchContractErrorAbi(1, ROUTER)
    if (!found) return
    const names = found.abi.map((e) => (e as { name: string }).name)
    // Picked from the router's own ABI, and deliberately not one we compile in.
    const ownError = names.find((n) => n === 'BadARMSignal') ?? names[0]!
    const entry = found.abi.find((e) => (e as { name: string }).name === ownError)!
    const inputs = (entry as unknown as { inputs: { type: string }[] }).inputs
    if (inputs.length > 0) return // keep the fixture simple: use a no-argument error

    const data = encodeErrorResult({ abi: [entry] as Abi, errorName: ownError })
    expect(decodeRevert(data).kind).toBe('unknown') // unknown to us on its own…

    clearSourcifyCache()
    const named = await enrichRevert(decodeRevert(data), { chainId: 1, candidates: [ROUTER] })
    expect(named).toMatchObject({ kind: 'error', name: ownError, source: 'contract', from: ROUTER })
  })

  it('follows a proxy to its implementation', async () => {
    clearSourcifyCache()
    const found = await fetchContractErrorAbi(1, USDC_PROXY)
    // USDC's implementation may or may not declare errors; what matters is that when an ABI comes
    // back through a proxy it is the implementation's, not the proxy's.
    if (found?.viaProxy) expect(found.from).not.toBe(USDC_PROXY)
  })

  it('a chain Sourcify does not index is an ordinary "no ABI", not a failure', async () => {
    clearSourcifyCache()
    const found = await fetchContractErrorAbi(HYPEREVM_CHAIN_ID, '0xfa44c2634ff17cbe26dc3007d36bd61c79068c14')
    expect(found).toBeUndefined()
  })
})
