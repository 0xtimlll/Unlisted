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
import { discoverNtt, readNttPeers } from '@/protocols/wormhole-ntt/discover'
import { fetchNttManagerIndex } from '@/protocols/wormhole-ntt/managerIndex'
import { buildNttPlan, shouldQueueFor } from '@/protocols/wormhole-ntt/plan'
import { evmRecipient } from '@/core/recipient'
import { fetchNttTokenList, findListedToken } from '@/protocols/wormhole-ntt/tokenList'
import { tokenAnchor, verifyNttManager } from '@/protocols/wormhole-ntt/verify'
import { wormholeChainId } from '@/protocols/wormhole-ntt/chains'

const HUB_TOKEN = getAddress('0x88909d489678dd17aa6d9609f89b0419bf78fd9a')
const HUB_MANAGER = getAddress('0x7926d63feb9b950908b297cc995b6853bca21847')
const SPOKE_MANAGER = getAddress('0xbc51f76178a56811fdfe95d3897e6ac2b11dbb62')
const USDT = getAddress('0xdac17f958d2ee523a2206206994597c13d831ec7')
const SOMEONE = getAddress('0x000000000000000000000000000000000000dEaD')

/**
 * Atlantis (ATL) on Monad, the 2026-10-15 case: listed by Wormholescan on Monad only, a burn-and-mint
 * manager on each side (NTT 2.0.0, so NO relayer — the Wormhole Executor delivers), and a token
 * that answers OpenZeppelin's `isMinter(manager)` rather than `minter()`. Found through the
 * transfer index; its only peer is BNB Chain.
 */
const ATL_MONAD = getAddress('0xc65ed58eC6DAD0c4320F3c94D22D49737328e94a')
const ATL_MANAGER_MONAD = getAddress('0x25553fa6a7703d589b42d0f28df39bd6c044f74f')
const ATL_MANAGER_BSC = getAddress('0xfef74fb43bf17b55307bcca2e7d949ec902c766a')

const eth = () => makeReadClient(evmByKey('ethereum'))
const bsc = () => makeReadClient(evmByKey('bsc'))
const monad = () => makeReadClient(evmByKey('monad'))

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

  it('verifies the hub — from the committed list, not from the far side', async () => {
    const list = await fetchNttTokenList()
    const r = await verifyNttManager({ srcChain: 'ethereum', dstChain: 'bsc', manager: HUB_MANAGER, srcClient: eth(), dstClient: bsc(), tokenList: list })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.verified.token).toBe(HUB_TOKEN)
    expect(r.verified.mode).toBe('locking')
    expect(r.verified.dst.manager).toBe(SPOKE_MANAGER)
    // The hub mints nothing, so no token can vouch for it. It used to be accepted on the spoke's
    // anchor, which we reach only through this hub's own getPeer() — the hole that let a fake
    // manager supply both halves. Now nothing vouches (`anchor: null`) and what tells a hub from a
    // fake is money: the share of the token's supply it holds (guard 2b, >= 0.1%). The far-side
    // anchor survives only as context.
    expect(r.verified.anchor).toBeNull()
    expect(r.verified.lockedBps).toBeGreaterThanOrEqual(10)
    expect(r.verified.alsoOnDestination).toBe(true)
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
    expect(plan.shouldQueue).toBe(shouldQueueFor(plan.amount, plan.outboundCapacity))
    expect(plan.rateLimitDuration).toBeDefined()
    expect(plan.transceiverInstructions).toBe('0x00')
    // Whatever the fee is, msg.value must cover it; the manager refunds the rest.
    expect(plan.value).toBeGreaterThanOrEqual(plan.fee)
    expect(plan.outboundCapacity).toBeGreaterThan(0n)
    expect(plan.inboundCapacity).toBeDefined()
  })

  it('the hub also appears in Wormholescan’s transfer index for Ethereum — and the index is a hint, verified by token()', async () => {
    const index = await fetchNttManagerIndex(wormholeChainId('ethereum')!)
    const candidates = index.get(HUB_TOKEN.toLowerCase()) ?? []
    // Quiet weeks happen; the index only says whom to ask. When the hub is in it, discovery needs no destination.
    if (candidates.length === 0) return
    expect(candidates).toContain(HUB_MANAGER)
    const list = await fetchNttTokenList()
    expect(await discoverNtt(eth(), 'ethereum', HUB_TOKEN, list, undefined, candidates)).toMatchObject({ kind: 'manager', manager: HUB_MANAGER, via: 'index' })
  })

  it('the hub names its spoke: BNB Chain is among the destinations read from the manager', async () => {
    const peers = await readNttPeers(eth(), HUB_MANAGER, 'ethereum')
    expect(peers.chains).toContain('bsc')
  })
})

describe('Atlantis on Monad: a burn-and-mint NTT v2 token the catalogue lists on one chain only', () => {
  it('is found through the transfer index, confirmed by token() on chain, with no destination chosen', async () => {
    const index = await fetchNttManagerIndex(wormholeChainId('monad')!)
    const candidates = index.get(ATL_MONAD.toLowerCase()) ?? []
    expect(candidates).toContain(ATL_MANAGER_MONAD)
    const list = await fetchNttTokenList()
    expect(findListedToken(list, 'monad', ATL_MONAD)?.address).toBe(ATL_MONAD)
    const r = await discoverNtt(monad(), 'monad', ATL_MONAD, list, undefined, candidates)
    expect(r).toMatchObject({ kind: 'manager', manager: ATL_MANAGER_MONAD, token: ATL_MONAD, via: 'index' })
  })

  it('the token vouches for the manager through isMinter(), not minter()', async () => {
    expect(await tokenAnchor(monad(), ATL_MONAD, ATL_MANAGER_MONAD)).toBe('isMinter')
  })

  it('its destinations are read from the manager: BNB Chain and nothing else we serve', async () => {
    expect(await readNttPeers(monad(), ATL_MANAGER_MONAD, 'monad')).toEqual({ chains: ['bsc'], complete: true })
  })

  it('is refused as an NTT v2 route: the 2.0.0 transceiver has no relayer, the Executor delivers', async () => {
    const list = await fetchNttTokenList()
    const r = await verifyNttManager({ srcChain: 'monad', dstChain: 'bsc', manager: ATL_MANAGER_MONAD, srcClient: monad(), dstClient: bsc(), tokenList: list })
    expect(r).toMatchObject({ ok: false, code: 'executor_required', detail: '2.0.0' })
    // The peers do point at each other; it is only the delivery this tab cannot arrange.
    const back = await bsc().readContract({ address: ATL_MANAGER_BSC, abi: [{ type: 'function', name: 'getPeer', stateMutability: 'view', inputs: [{ type: 'uint16' }], outputs: [{ type: 'tuple', components: [{ name: 'peerAddress', type: 'bytes32' }, { name: 'tokenDecimals', type: 'uint8' }] }] }] as const, functionName: 'getPeer', args: [wormholeChainId('monad')!] })
    expect(back.peerAddress.toLowerCase()).toBe(`0x${'0'.repeat(24)}${ATL_MANAGER_MONAD.slice(2).toLowerCase()}`)
  })
})
