/** viem marks every call of a failed aggregate as `failure` with the NETWORK error; that is an outage, not the contract's answer. */
import { describe, expect, it } from 'vitest'
import { ContractFunctionRevertedError, HttpRequestError, parseAbi } from 'viem'
import { batchOutage } from '@/core/rpcErrors'

const abi = parseAbi(['function peers(uint32) view returns (bytes32)'])

describe('batchOutage', () => {
  it('a network error inside a multicall result is an outage', () => {
    const net = new HttpRequestError({ url: 'https://rpc.example', status: 429, body: {} })
    expect(batchOutage([{ status: 'success' }, { status: 'failure', error: net }])).toBe(net)
  })

  it('a contract that reverted is its answer, not an outage', () => {
    const reverted = new ContractFunctionRevertedError({ abi, functionName: 'peers' })
    expect(batchOutage([{ status: 'failure', error: reverted }, { status: 'success' }])).toBeUndefined()
    expect(batchOutage([{ status: 'failure', error: new Error('execution reverted') }])).toBeUndefined()
  })
})

import type { ReadClient } from '@/core/client'
import { probeOft, ProbeError } from '@/core/probe'
import { ENDPOINT_HYPER, TREAD_OFT } from './fixtures'

describe('probeOft when the provider drops a batch', () => {
  /** getCode answers; every multicall comes back the way viem reports a failed aggregate call. */
  const client = (error: unknown) =>
    ({
      getCode: async () => '0x6080',
      multicall: async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ status: 'failure', error, result: undefined })),
    }) as unknown as ReadClient

  it('a 429 on the batch is rpc_unavailable — never "not an OFT"', async () => {
    const net = new HttpRequestError({ url: 'https://rpc.example', status: 429, body: {} })
    await expect(probeOft(client(net), TREAD_OFT, ENDPOINT_HYPER)).rejects.toMatchObject({ code: 'rpc_unavailable' })
  })

  it('a contract that reverts on peers() is still "not an OFT"', async () => {
    const err = await probeOft(client(new ContractFunctionRevertedError({ abi, functionName: 'peers' })), TREAD_OFT, ENDPOINT_HYPER).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProbeError)
    expect((err as ProbeError).code).toBe('not_oft')
  })
})
