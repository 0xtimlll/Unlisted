/**
 * The Status tab's NTT and CCIP readers against mainnet.
 *
 * The fixtures are the transactions analysis.live.test.ts already relies on: an NTT transfer
 * Ethereum -> BNB Chain, one Ethereum -> Arbitrum, and a CCIP send on Base. All three were delivered
 * long ago, so each must come back `delivered` — read from the destination's own contracts, not
 * from an indexer — and the NTT digest computed from the published bytes must be the one the
 * source manager announced (for the manager that announces one).
 *
 * Read-only; public RPCs are flaky, so this project is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { evmByKey, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { lookupNttStatus } from '@/protocols/wormhole-ntt/status'
import { lookupCcipStatus } from '@/protocols/ccip/status'

const NTT_TO_BSC = '0xa4a6bd5fb664702bc81d5b52214e31727ae9964306adf39506cf4d988708bbef'
const NTT_TO_ARBITRUM = '0x255fa1b55e7a2d63e452a3fa3081e9115db9eb9354b6da8a61843aa81e6e8ebd'
const CCIP_ON_BASE = '0xa2360083ee189f6d3a9f483816a4ad3182ee34dcb44cefd028d15ae39398fd39'
/** A 2.0 send Base -> Robinhood Chain (OnRamp 2.0, OffRamp 2.0.0 — state keyed by messageId), long delivered. */
const CCIP_BASE_TO_ROBINHOOD = '0xf1cdb26c6b10c6bf85cd44be4f88e43edc7e980f059c8140619cda89b4946437'

const client = (c: ChainKey) => makeReadClient(evmByKey(c))
const logsOf = async (c: ChainKey, hash: string) => (await client(c).getTransactionReceipt({ hash: hash as `0x${string}` })).logs

describe('Status tab against mainnet', () => {
  it('an NTT transfer Ethereum -> BNB Chain: found from the core bridge’s log, delivered on the spoke', async () => {
    const r = await lookupNttStatus(await logsOf('ethereum', NTT_TO_BSC), 'ethereum', client)
    expect(r.unserved).toHaveLength(0)
    expect(r.reports).toHaveLength(1)
    const d = r.reports[0]!
    expect(d.transfer.dstChain).toBe('bsc')
    expect(d.transfer.srcManager?.toLowerCase()).toBe('0x7926d63feb9b950908b297cc995b6853bca21847')
    expect(d.transfer.dstManager?.toLowerCase()).toBe('0xbc51f76178a56811fdfe95d3897e6ac2b11dbb62')
    // A manager that announces its digest must agree with the one computed from the bytes.
    expect(d.transfer.digestConfirmed).not.toBe(false)
    expect(d.state).toEqual({ kind: 'delivered' })
    expect(d.peerOk).toBe(true)
  })

  it('an NTT transfer Ethereum -> Arbitrum: delivered', async () => {
    const r = await lookupNttStatus(await logsOf('ethereum', NTT_TO_ARBITRUM), 'ethereum', client)
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]!.transfer.dstChain).toBe('arbitrum')
    expect(r.reports[0]!.transfer.digestConfirmed).not.toBe(false)
    expect(r.reports[0]!.state).toEqual({ kind: 'delivered' })
  })

  it('a CCIP send on Base to a chain this app does not serve is reported as unserved, not as a state', async () => {
    const r = await lookupCcipStatus(await logsOf('base', CCIP_ON_BASE), 'base', client('base'), client)
    expect(r.reports).toHaveLength(0)
    expect(r.unserved).toHaveLength(1)
    expect(r.unserved[0]).toMatchObject({ version: '1.6', dstChain: undefined })
  })

  it('a CCIP 2.0 send Base -> Robinhood: found from the on-ramp’s log, delivered by the off-ramp the destination router lists', async () => {
    const r = await lookupCcipStatus(await logsOf('base', CCIP_BASE_TO_ROBINHOOD), 'base', client('base'), client)
    expect(r.unserved).toHaveLength(0)
    expect(r.reports).toHaveLength(1)
    const d = r.reports[0]!
    expect(d.send).toMatchObject({ version: '2.0', dstChain: 'robinhood', onRamp: '0xF75bf16b03aaE98677926F0987F195A2153996B9' })
    expect(d.state).toMatchObject({ kind: 'delivered', offRampVersion: 'OffRamp 2.0.0' })
  })
})
