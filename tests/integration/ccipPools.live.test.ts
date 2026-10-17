/**
 * CCIP pools of every generation on BNB Chain, read the way the CCIP tab reads them (2026-10-17).
 *
 *   elizaOS  BurnMintTokenPool 1.6.1         — lanes to Solana only (the CCIP Directory agrees):
 *                                             no EVM route, and Solana named as "not available here"
 *   SolvBTC  BurnMintTokenPool 1.5.1         — getSupportedChains with a dozen EVM chains
 *   BETS     BurnMintTokenPoolAndProxy 1.5.0 — no getTokenDecimals(): the token's own decimals
 *   LBTC     LombardTokenPool 2.1.0          — no getRouter(): the router is getDynamicConfig()[0]
 *
 * Read-only. Each must come back as a token with a cross-checked pool, never "unreadable".
 */
import { describe, expect, it } from 'vitest'
import { evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { clientPair, independentSecondaries } from '@/core/quorum'
import { discoverCcipTokenQuorum } from '@/protocols/ccip/discover'

const bsc = evmByKey('bsc')
const discover = (token: string) => discoverCcipTokenQuorum(makeReadClient(bsc), independentSecondaries(clientPair(bsc)), 'bsc', token)

describe('CCIP pools on BNB Chain, by generation', () => {
  it('elizaOS: a 1.6.1 pool whose only lane is Solana names it, and offers nothing it cannot send', async () => {
    const r = await discover('0xea17Df5Cf6D172224892B5477A16ACb111182478')
    expect(r.kind).toBe('token')
    if (r.kind !== 'token') return
    expect(r.poolVersion).toBe('BurnMintTokenPool 1.6.1')
    expect(r.routes).toEqual([])
    expect(r.otherDestinations.map((o) => o.name)).toEqual(['solana-mainnet'])
  })

  it('SolvBTC: a 1.5.1 pool lists Ethereum and Base among its routes', async () => {
    const r = await discover('0x4aae823a6a0b376De6A78e74eCC5b079d38cBCf7')
    expect(r.kind).toBe('token')
    if (r.kind === 'token') expect(r.routes.map((x) => x.chain)).toEqual(expect.arrayContaining(['ethereum', 'base']))
  })

  it('BETS: a 1.5.0 *AndProxy pool without getTokenDecimals still reads, with the token’s decimals', async () => {
    const r = await discover('0x94025780a1aB58868D9B2dBBB775f44b32e8E6e5')
    expect(r).toMatchObject({ kind: 'token', decimals: 18 })
  })

  it('LBTC: a 2.1.0 pool without getRouter is matched to the official router through getDynamicConfig', async () => {
    const r = await discover('0xecAc9C5F704e954931349Da37F60E39f515c11c1')
    expect(r.kind).toBe('token')
    if (r.kind === 'token') expect(r.routes.map((x) => x.chain)).toContain('ethereum')
  })
})
