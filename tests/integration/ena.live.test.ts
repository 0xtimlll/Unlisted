/**
 * The bug this fixes: ENA (Ethena) bridges Ethereum -> Solana through the EARLIER generation of
 * LayerZero's Solana OFT program, whose store is an `OftConfig` account, not an `OFTStore`. The
 * decoder only knew the current layout and reported "not a LayerZero OFT Store" for a route that
 * demonstrably works — LayerZero Scan shows tx 0x24340415…88b5 as DELIVERED.
 *
 * Read-only. Not part of `npm test`.
 */
import { describe, expect, it } from 'vitest'
import { evmByKey, byKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { addressToBytes32 } from '@/core/encoding'
import { probeOft } from '@/core/probe'
import { checkPeerBackSvm, discoverSvmOft } from '@/core/svm/discover'
import { SvmRpc } from '@/core/svm/rpc'

const ENA_ETHEREUM = '0x58538e6A46E07434d7E7375Bc268D3cb839C0133'
const ENA_SOLANA_STORE = 'D2hZiYnFqNS9YgNRoDtK7zajKjxc68139niZ1MmD8aae'
const SOLANA_EID = 30168
const ETHEREUM_EID = 30101

const rpc = () => new SvmRpc([...byKey('solana').rpcUrls])

describe('ENA: Ethereum -> Solana on the earlier Solana OFT program', () => {
  it('the EVM side has a Solana peer, and it is this store', async () => {
    const { info } = await probeOft(makeReadClient(evmByKey('ethereum')), ENA_ETHEREUM, [SOLANA_EID])
    const sol = info.routes.find((r) => r.eid === SOLANA_EID)
    expect(sol).toBeDefined()
    expect(sol!.peer).toBe('0xb2bbb09b62e3f8d58cf1bb1b5318477f53f453ae67638eff27987642bbeaff9b')
  }, 60_000)

  it('the store is recognised as the earlier OftConfig layout, not rejected', async () => {
    const { info } = await probeOft(makeReadClient(evmByKey('ethereum')), ENA_ETHEREUM, [SOLANA_EID])
    const sol = info.routes.find((r) => r.eid === SOLANA_EID)!
    const found = await discoverSvmOft(rpc(), sol.peer, ETHEREUM_EID)

    expect(found.recognised).toBe(true)
    if (!found.recognised) throw new Error(`still unrecognised: ${JSON.stringify(found.store)}`)
    const svm = found.info
    expect(svm.layout).toBe('OftConfig')
    expect(svm.oftStore).toBe(ENA_SOLANA_STORE)
    expect(svm.ownerIsProgram).toBe(true)
    expect(svm.oftType).toBe('native')
    expect(['token', 'token2022']).toContain(svm.tokenProgram)
    expect(svm.decimals).toBeGreaterThan(0)
    expect(svm.ld2sdRate).toBeGreaterThan(0n)
    // Fields this layout simply does not have are reported as absent, not invented.
    expect(svm.tokenEscrow).toBeUndefined()
    expect(svm.paused).toBe(false)
    expect(svm.tvlLd).toBe(0n)
  }, 60_000)

  it('the back-link resolves: the Solana peer names the ENA adapter on Ethereum', async () => {
    const { info } = await probeOft(makeReadClient(evmByKey('ethereum')), ENA_ETHEREUM, [SOLANA_EID])
    const sol = info.routes.find((r) => r.eid === SOLANA_EID)!
    const found = await discoverSvmOft(rpc(), sol.peer, ETHEREUM_EID)
    if (!found.recognised) throw new Error('expected a recognised store')

    expect(found.info.peer.configured).toBe(true)
    if (found.info.peer.configured) {
      expect(found.info.peer.peerAddress.toLowerCase()).toBe(addressToBytes32(ENA_ETHEREUM).toLowerCase())
    }
    expect(checkPeerBackSvm(found.info, ENA_ETHEREUM)).toEqual({ status: 'ok' })
    // A different contract is not this store's peer.
    expect(checkPeerBackSvm(found.info, '0xd5EE1c81fE161e985dce6b90713c965f9979cf80').status).toBe('mismatch')
  }, 60_000)

  it('a peer address with no account behind it is still a hard error', async () => {
    const nowhere = `0x${'11'.repeat(32)}` as const
    await expect(discoverSvmOft(rpc(), nowhere, ETHEREUM_EID)).rejects.toThrow(/store_missing|no account/)
  }, 60_000)
})
