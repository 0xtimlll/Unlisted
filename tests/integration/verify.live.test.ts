/** Live: peer back-link and two-RPC quorum on real contracts. */
import { describe, expect, it } from 'vitest'
import { byKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { clientPair, decodeTxQuorum, probeOftQuorum } from '@/core/quorum'
import { checkPeerBack } from '@/core/verify'

const TREAD_OFT = '0xd5EE1c81fE161e985dce6b90713c965f9979cf80'
const TREAD_ADAPTER = '0xe68AD53cf0D5E49CF83FBC003672f6D0eBcAe311'
const USDT0_OFT = '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98'
const REAL_SEND = '0x59443176b832dcf3b19aa54ce815089d7951496903bedd59174cf6944047bcbc'

describe('peer back-link on real contracts', () => {
  it('TREAD: Ethereum adapter names the HyperEVM OFT back', async () => {
    const eth = makeReadClient(byKey('ethereum'))
    expect(await checkPeerBack(eth, TREAD_ADAPTER, 30367, TREAD_OFT)).toEqual({ status: 'ok' })
  })
  it('TREAD: HyperEVM OFT names the Ethereum adapter back', async () => {
    const hyper = makeReadClient(byKey('hyperevm'))
    expect(await checkPeerBack(hyper, TREAD_OFT, 30101, TREAD_ADAPTER)).toEqual({ status: 'ok' })
  })
  it('a fake adapter would be caught: the real adapter does not point at a random address', async () => {
    const eth = makeReadClient(byKey('ethereum'))
    const r = await checkPeerBack(eth, TREAD_ADAPTER, 30367, USDT0_OFT)
    expect(r.status).toBe('mismatch')
  })
})

describe('two-RPC quorum on real contracts', () => {
  it('TREAD OFT is cross-checked and agreed', async () => {
    const r = await probeOftQuorum(clientPair(byKey('hyperevm')), TREAD_OFT)
    expect(r.crossChecked).toBe(true)
    expect(r.info.routes.find((x) => x.eid === 30101)?.peer).toBe(TREAD_ADAPTER)
  }, 60_000)
  it('a real send tx is cross-checked and agreed', async () => {
    const r = await decodeTxQuorum(clientPair(byKey('hyperevm')), REAL_SEND)
    expect(r.crossChecked).toBe(true)
    expect(r.oft).toBe(TREAD_OFT)
    expect(r.droppedOptions).toEqual([])
    expect(r.optionsMalformed).toBe(false)
  }, 60_000)
})
