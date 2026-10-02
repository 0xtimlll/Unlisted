/**
 * The line between "the contract said no" and "the provider did not answer". Every optional read
 * in the gates (NTT anchors, lz-v1 standard detection, CCIP pool facts) rests on it: only the
 * first may become a verdict about the contract.
 */
import { describe, expect, it } from 'vitest'
import { BaseError, ContractFunctionExecutionError, ContractFunctionZeroDataError, HttpRequestError, TimeoutError } from 'viem'
import { isContractRefusal, readOptional, UnreadableError } from '@/core/rpcErrors'

const zeroData = () =>
  new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName: 'minter' }), { abi: [], functionName: 'minter' })
const http = () => new HttpRequestError({ url: 'https://rpc.example', status: 429, details: 'rate limited' })
const timeout = () => new TimeoutError({ body: {}, url: 'https://rpc.example' })

describe('isContractRefusal', () => {
  it('a revert or empty return data is the contract answering', () => {
    expect(isContractRefusal(zeroData())).toBe(true)
    expect(isContractRefusal(new Error('execution reverted'))).toBe(true)
    expect(isContractRefusal(new BaseError('The contract function "x" returned no data ("0x").'))).toBe(true)
  })
  it('a transport failure is not an answer', () => {
    expect(isContractRefusal(http())).toBe(false)
    expect(isContractRefusal(timeout())).toBe(false)
    expect(isContractRefusal(new Error('fetch failed'))).toBe(false)
    expect(isContractRefusal(new Error('HTTP request failed: 429'))).toBe(false)
  })
})

describe('readOptional', () => {
  it('returns the value, undefined on refusal, and throws UnreadableError on an outage', async () => {
    await expect(readOptional('x', async () => 7)).resolves.toBe(7)
    await expect(readOptional('x', async () => { throw zeroData() })).resolves.toBeUndefined()
    await expect(readOptional('token.minter()', async () => { throw http() })).rejects.toBeInstanceOf(UnreadableError)
    await expect(readOptional('token.minter()', async () => { throw http() })).rejects.toMatchObject({ what: 'token.minter()' })
  })
})
