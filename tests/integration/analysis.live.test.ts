/**
 * The analysis against real, already-mined transactions on public RPCs.
 *
 * The fixtures were taken from the LayerZero Scan API for the PENGU OFT adapter on HyperEVM
 * (`/v1/messages/oapp/30367/0xfa44…8c14`), so each one is a message the scanner itself lists:
 *
 *   0x356cb6e5…dfd7  HyperEVM -> Solana, a send that went through a router contract
 *   0xcd8ced52…2d74  Solana -> HyperEVM, the receiving side of a transfer
 *   0xff9825e7…7a3e  the GUID of the first message
 *
 * The other protocols come from their own explorers:
 *   0xa4a6bd5f…bbef  Ethereum, Wormhole NTT -> BNB Chain   (Wormholescan /api/v1/operations,
 *   0x255fa1b5…8ebd  Ethereum, Wormhole NTT -> Arbitrum     appId=NATIVE_TOKEN_TRANSFER)
 *   0xa2360083…fd39  Base, Chainlink CCIP v1.6              (found by its CCIPMessageSent topic)
 *
 * Read-only. Public RPCs are flaky, so this project is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { analyzeTx } from '@/core/analysis/analyze'
import { fetchEvmTx } from '@/core/analysis/evmTx'
import { searchTx } from '@/core/analysis/search'
import { evmChains, evmByKey, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { classifyLzAddress } from '@/core/lz/classify'
import { buildSendPlan, assembleSendArgs } from '@/core/plan'
import { probeOft } from '@/core/probe'
import { evmRecipient } from '@/core/recipient'
import { simulateSend } from '@/core/sim/preview'
import { revertMeaning } from '@/core/sim/revert'
import { fetchStatusByGuid } from '@/core/track'

const SEND = '0x356cb6e5fed806ea986046b6f2438a5c10012fafda066f1cc3581e9d0a00dfd7'
const RECEIVE = '0xcd8ced520bcb7c611c6187e9aaf8eeb64fe49b8292e46752fb2992ae4b452d74'
const GUID = '0xff9825e753f4ae611e65bc5f4a2455bf906febb74fae48ce8ad360bab3a57a3e'
const PENGU_HYPEREVM = '0xfa44c2634ff17cbe26dc3007d36bd61c79068c14'
const NTT_TO_BSC = '0xa4a6bd5fb664702bc81d5b52214e31727ae9964306adf39506cf4d988708bbef'
const NTT_TO_ARBITRUM = '0x255fa1b55e7a2d63e452a3fa3081e9115db9eb9354b6da8a61843aa81e6e8ebd'
const CCIP_ON_BASE = '0xa2360083ee189f6d3a9f483816a4ad3182ee34dcb44cefd028d15ae39398fd39'
const SOLANA_EID = 30168

const fetchAcrossChains = async (hash: string, selected?: ChainKey) =>
  searchTx(hash, {
    ...(selected ? { selected } : {}),
    chains: evmChains().map((c) => c.key),
    fetch: (chain, h) => fetchEvmTx(makeReadClient(evmByKey(chain)), h),
  })

describe('analysis on real transactions', () => {
  it('finds a send on the chain it actually happened on, not the selected one', async () => {
    const found = await fetchAcrossChains(SEND, 'ethereum')
    expect(found.status).toBe('found')
    if (found.status !== 'found') return
    expect(found.chain).toBe('hyperevm')

    const [r] = analyzeTx(found.tx, { chain: found.chain, selected: 'ethereum' })
    expect(r).toMatchObject({ verdict: 'can_bridge', code: 'lz_oft_send', protocol: 'lz-oft' })
    expect(r?.target?.address.toLowerCase()).toBe(PENGU_HYPEREVM)
    expect(r?.target?.dstChain).toBe('solana')
    expect(r?.action).toEqual({ kind: 'switch_chain', chain: 'hyperevm' })
    // This particular transfer was submitted through another contract: the OFT is in the logs.
    expect(r?.details.indirect).toBe(true)
    expect(r?.details.to?.toLowerCase()).not.toBe(PENGU_HYPEREVM)
  })

  it('reads the receiving side and names the OFT on this chain', async () => {
    const found = await fetchAcrossChains(RECEIVE, 'hyperevm')
    expect(found.status).toBe('found')
    if (found.status !== 'found') return

    const [r] = analyzeTx(found.tx, { chain: found.chain, selected: found.chain })
    expect(r).toMatchObject({ verdict: 'can_bridge', code: 'lz_oft_receive' })
    expect(r?.target?.address.toLowerCase()).toBe(PENGU_HYPEREVM)
    expect(r?.details.fields?.['srcEid']).toBe(String(SOLANA_EID))
  })

  it('resolves a message GUID through the LayerZero Scan API', async () => {
    const state = await fetchStatusByGuid(GUID)
    expect(state.phase).not.toBe('no_data')
    expect(state.srcEid).toBe(30367)
    expect(state.dstEid).toBe(SOLANA_EID)
    expect(state.sender?.toLowerCase()).toBe(PENGU_HYPEREVM)
  })

  it('a hash no chain has is "not found", never "cannot bridge"', async () => {
    const found = await fetchAcrossChains(`0x${'ab'.repeat(32)}`)
    expect(found.status).toBe('not_found')
  })

  it('recognises a real Wormhole NTT transfer and hands it to its tab', async () => {
    const tx = await fetchEvmTx(makeReadClient(evmByKey('ethereum')), NTT_TO_BSC)
    expect(tx).not.toBeNull()
    const [r] = analyzeTx(tx!, { chain: 'ethereum', selected: 'ethereum' })
    expect(r?.protocol).toBe('wormhole-ntt')
    expect(r?.action).toEqual({ kind: 'open_tab', protocol: 'wormhole-ntt' })
    expect(r?.target?.dstChain).toBe('bsc')
    expect(r?.code).toBe('switch_protocol')
  })

  it('reads the destination out of a second NTT transfer', async () => {
    const tx = await fetchEvmTx(makeReadClient(evmByKey('ethereum')), NTT_TO_ARBITRUM)
    const [r] = analyzeTx(tx!, { chain: 'ethereum' })
    expect(r?.protocol).toBe('wormhole-ntt')
    expect(r?.target?.dstChain).toBe('arbitrum')
  })

  it('recognises a real CCIP v1.6 send with its messageId and tokens', async () => {
    const tx = await fetchEvmTx(makeReadClient(evmByKey('base')), CCIP_ON_BASE)
    expect(tx).not.toBeNull()
    const [r] = analyzeTx(tx!, { chain: 'base', selected: 'base' })
    expect(r?.protocol).toBe('ccip')
    expect(r?.details.fields?.['version']).toBe('1.6')
    expect(r?.details.fields?.['messageId']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(r?.details.fields?.['destChainSelector']).toBeDefined()
  })

  it('a send that cannot work comes back decoded, not as hex', async () => {
    // An address with no PENGU: the simulation must fail, and the failure must be a NAMED error
    // (or, at worst, a selector we admit we do not know) — never an opaque blob.
    const client = makeReadClient(evmByKey('hyperevm'))
    const { info } = await probeOft(client, PENGU_HYPEREVM, [30101])
    const empty = '0x000000000000000000000000000000000000dEaD' as const
    const plan = await buildSendPlan(client, {
      info,
      src: evmByKey('hyperevm'),
      dstEid: 30101,
      amountInput: '1000000',
      sender: empty,
      recipient: evmRecipient(empty),
    })
    const outcome = await simulateSend(client, { account: empty, oft: info.oft, sendArgs: assembleSendArgs(plan), value: plan.value })
    expect(outcome.ok).not.toBe(true)
    if (outcome.ok !== false) return
    expect(outcome.reason).not.toMatch(/^0x[0-9a-f]{8,}$/) // not raw bytes
    expect(revertMeaning(outcome.revert)).toBeDefined()
    expect(outcome.step).toBe('send')
  })

  it('classifies the OFT itself, and its endpoint as a non-OFT contract', async () => {
    const client = makeReadClient(evmByKey('hyperevm'))
    const oft = await classifyLzAddress(client, PENGU_HYPEREVM, [SOLANA_EID])
    expect(oft.kind).toBe('oft')
    if (oft.kind !== 'oft') return

    // The endpoint the OFT itself names: a real contract, but not an OApp and not an OFT.
    // (Its address differs per chain, so it is read from the contract rather than written down.)
    const endpoint = await classifyLzAddress(client, oft.probe.info.endpoint, [SOLANA_EID])
    expect(endpoint.kind).toBe('not_lz')
  })
})
