/**
 * CCIP against mainnet.
 *
 * The fixture is a token the CCIP Directory itself lists on both Ethereum and Base
 * (smartcontractkit/documentation, src/config/data/ccip/v1_2_0/mainnet/tokens.json), so the pool
 * the TokenAdminRegistry returns can be compared with the directory's own answer.
 *
 * Read-only; public RPCs are flaky, so this project is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { evmRecipient } from '@/core/recipient'
import { ccipConfig } from '@/protocols/ccip/chains'
import { discoverCcipToken, readRemoteSide } from '@/protocols/ccip/discover'
import { buildCcipPlan } from '@/protocols/ccip/plan'

/** AISTR: listed on Ethereum and Base in the CCIP Directory. */
const TOKEN = getAddress('0xBD4CaeE14EFDE2888F167130AF84D613D64618Da')
const EXPECTED_POOL = getAddress('0xe4a9fa29E3d88660577E4ACD9bf88Ef2DF4F8D7C')
/** DAI: a real, heavily used token that CCIP has no pool for on Ethereum. (USDT and WETH do
 *  have pools — checked, rather than assumed.) */
const DAI = getAddress('0x6b175474e89094c44da98b954eedeac495271d0f')
const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const eth = () => makeReadClient(evmByKey('ethereum'))
const base = () => makeReadClient(evmByKey('base'))

describe('CCIP against mainnet', () => {
  it('finds the pool the directory lists, and the chains it reaches', async () => {
    const d = await discoverCcipToken(eth(), 'ethereum', TOKEN)
    expect(d.kind).toBe('token')
    if (d.kind !== 'token') return
    expect(d.pool).toBe(EXPECTED_POOL)
    expect(d.decimals).toBe(18)
    expect(d.routes.map((r) => r.chain)).toContain('base')
    // Every route the pool reports must be a chain we have a selector for.
    for (const r of d.routes) expect(ccipConfig(r.chain)?.selector).toBe(r.selector)
  })

  it('says plainly when CCIP has no pool for a token', async () => {
    const d = await discoverCcipToken(eth(), 'ethereum', DAI)
    expect(d.kind).toBe('no_pool')
  })

  it('reads the other side: the remote token, its decimals and its pool', async () => {
    const d = await discoverCcipToken(eth(), 'ethereum', TOKEN)
    if (d.kind !== 'token') throw new Error('expected a pool')
    const remote = await readRemoteSide(eth(), base(), d.pool, 'base', ccipConfig('base')!.selector)
    expect(remote.token).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(remote.decimals).toBeGreaterThan(0)
    expect(remote.pool).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('quotes a real transfer, with msg.value equal to the fee and both buckets read', async () => {
    const d = await discoverCcipToken(eth(), 'ethereum', TOKEN)
    if (d.kind !== 'token') throw new Error('expected a pool')
    const remote = await readRemoteSide(eth(), base(), d.pool, 'base', ccipConfig('base')!.selector)

    const plan = await buildCcipPlan({
      chain: 'ethereum',
      dstChain: 'base',
      dstSelector: ccipConfig('base')!.selector,
      token: d.token,
      tokenSymbol: 'AISTR',
      decimals: d.decimals,
      pool: d.pool,
      remote,
      sender: SOMEONE,
      recipient: evmRecipient(SOMEONE),
      amount: 10n ** 18n,
      srcClient: eth(),
      dstClient: base(),
    })

    expect(plan.router).toBe(getAddress(ccipConfig('ethereum')!.router))
    expect(plan.fee).toBeGreaterThan(0n)
    // No buffer anywhere: Router.ccipSend keeps the whole msg.value.
    expect(plan.value).toBe(plan.fee)
    expect(plan.message.data).toBe('0x')
    expect(plan.message.tokenAmounts).toEqual([{ token: d.token, amount: 10n ** 18n }])
    expect(plan.outbound).toBeDefined()
    expect(plan.inbound).toBeDefined()
    expect(plan.received).toBeGreaterThan(0n)
  })
})
