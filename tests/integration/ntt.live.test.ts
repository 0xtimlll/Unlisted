/**
 * The NTT gate against a real deployment on mainnet.
 *
 * The fixture is the token behind the NTT transfer used in analysis.live.test.ts
 * (0xa4a6bd5f…bbef, Ethereum -> BNB Chain). It is a hub-and-spoke deployment:
 *
 *   Ethereum  0x88909d48…fd9a   token, LOCKING side — no minter of its own, by design
 *             0x7926d63f…1847   NttManager (the hub)
 *   BNB Chain 0x46777c76…6c59   token, BURNING side — minter() == the manager below
 *             0xbc51f761…bb62   NttManager (the spoke)
 *
 * Which is exactly the case the gate has to get right: the hub can only be vouched for through
 * the spoke. Read-only; public RPCs are flaky, so this project is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { discoverNtt } from '@/protocols/wormhole-ntt/discover'
import { buildNttPlan } from '@/protocols/wormhole-ntt/plan'
import { evmRecipient } from '@/core/recipient'
import { fetchNttTokenList, findListedToken } from '@/protocols/wormhole-ntt/tokenList'
import { verifyNttManager } from '@/protocols/wormhole-ntt/verify'
import { wormholeChainId } from '@/protocols/wormhole-ntt/chains'

const HUB_TOKEN = getAddress('0x88909d489678dd17aa6d9609f89b0419bf78fd9a')
const HUB_MANAGER = getAddress('0x7926d63feb9b950908b297cc995b6853bca21847')
const SPOKE_MANAGER = getAddress('0xbc51f76178a56811fdfe95d3897e6ac2b11dbb62')
const USDT = getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7')
const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

const eth = () => makeReadClient(evmByKey('ethereum'))
const bsc = () => makeReadClient(evmByKey('bsc'))

describe('NTT against mainnet', () => {
  it('the official token list answers, and knows this token on both chains', async () => {
    const list = await fetchNttTokenList()
    expect(list.length).toBeGreaterThan(50)
    expect(findListedToken(list, 'ethereum', HUB_TOKEN)?.address).toBe(HUB_TOKEN)
    expect(findListedToken(list, 'bsc', HUB_TOKEN)).toBeUndefined() // same token, different address there
    // Something that is not an NTT token at all.
    expect(findListedToken(list, 'ethereum', USDT)).toBeUndefined()
  })

  it('finds the locking hub through the burning side, not from the hub itself', async () => {
    const list = await fetchNttTokenList()
    const srcWormholeChainId = wormholeChainId('ethereum')!

    // Without a destination there is nothing to walk in from.
    const alone = await discoverNtt(eth(), 'ethereum', HUB_TOKEN, list)
    expect(alone).toMatchObject({ kind: 'token_without_minter' })

    const withDst = await discoverNtt(eth(), 'ethereum', HUB_TOKEN, list, { chain: 'bsc', client: bsc(), srcWormholeChainId })
    expect(withDst).toMatchObject({ kind: 'manager', manager: HUB_MANAGER, via: 'peer' })
  })

  it('verifies the hub, anchored by the token on the spoke', async () => {
    const list = await fetchNttTokenList()
    const r = await verifyNttManager({ srcChain: 'ethereum', dstChain: 'bsc', manager: HUB_MANAGER, srcClient: eth(), dstClient: bsc(), tokenList: list })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.verified.token).toBe(HUB_TOKEN)
    expect(r.verified.mode).toBe('locking')
    expect(r.verified.dst.manager).toBe(SPOKE_MANAGER)
    // The hub mints nothing, so the anchor has to come from the other side.
    expect(r.verified.anchor).toEqual({ side: 'destination', kind: 'minter' })
  })

  it('refuses an address that is not this token’s manager', async () => {
    const list = await fetchNttTokenList()
    // USDT's own contract: not a manager, and not in the NTT list.
    const r = await verifyNttManager({ srcChain: 'ethereum', dstChain: 'bsc', manager: USDT, srcClient: eth(), dstClient: bsc(), tokenList: list })
    expect(r.ok).toBe(false)
  })

  it('quotes a transfer with the exact bytes the send will use', async () => {
    const list = await fetchNttTokenList()
    const v = await verifyNttManager({ srcChain: 'ethereum', dstChain: 'bsc', manager: HUB_MANAGER, srcClient: eth(), dstClient: bsc(), tokenList: list })
    expect(v.ok).toBe(true)
    if (!v.ok) return

    const plan = await buildNttPlan({
      verified: v.verified,
      srcClient: eth(),
      dstClient: bsc(),
      sender: SOMEONE,
      recipient: evmRecipient(SOMEONE),
      // Deliberately finer than the route carries: it must be rounded down, not revert.
      amountRaw: 1_234567890123456789n,
    })
    expect(plan.trim.trimmedDecimals).toBe(8)
    expect(plan.amount).toBe(1_234567890000000000n)
    expect(plan.dust).toBe(123456789n)
    expect(plan.amount % plan.trim.step).toBe(0n)
    expect(plan.shouldQueue).toBe(false)
    expect(plan.transceiverInstructions).toBe('0x00')
    // Whatever the fee is, msg.value must cover it; the manager refunds the rest.
    expect(plan.value).toBeGreaterThanOrEqual(plan.fee)
    expect(plan.outboundCapacity).toBeGreaterThan(0n)
    expect(plan.inboundCapacity).toBeDefined()
  })
})
