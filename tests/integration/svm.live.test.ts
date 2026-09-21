/**
 * Live: a real OFT with a Solana peer. PENGU (Pudgy Penguins) on HyperEVM ↔ Solana.
 * Discovered from LayerZero Scan traffic, nothing hardcoded beyond the EVM contract address
 * that a user would paste. The Solana side is derived entirely from peers(30168).
 */
import { describe, expect, it } from 'vitest'
import { byKey, evmByKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { addressToBytes32, peerToAddress } from '@/core/encoding'
import { planSvmOptions } from '@/core/options'
import { buildSendPlan } from '@/core/plan'
import { probeOft } from '@/core/probe'
import { svmRecipient } from '@/core/recipient'
import { decodeBase58, encodeBase58 } from '@/core/svm/base58'
import { checkPeerBackSvm, discoverSvmOft } from '@/core/svm/discover'
import { PROGRAM, pubkeyFromHex } from '@/core/svm/pubkey'
import { checkSvmRecipient } from '@/core/svm/recipient'
import { SvmRpc } from '@/core/svm/rpc'

const PENGU_HYPEREVM = '0xfa44c2634ff17cbe26dc3007d36bd61c79068c14'
const SOLANA_EID = 30168
const rpc = new SvmRpc(byKey('solana').rpcUrls)

describe('PENGU: HyperEVM OFT with a Solana peer', () => {
  it('routes contain a 32-byte Solana peer that is NOT an EVM address', async () => {
    const { info } = await probeOft(makeReadClient(evmByKey('hyperevm')), PENGU_HYPEREVM)
    const sol = info.routes.find((r) => r.eid === SOLANA_EID)
    expect(sol).toBeDefined()
    expect(sol!.peer).toHaveLength(66)
    expect(peerToAddress(sol!.peer)).toBeUndefined()
    // base58 of the peer is the OFT Store; it must round-trip.
    const b58 = encodeBase58(pubkeyFromHex(sol!.peer))
    expect(decodeBase58(b58)).toHaveLength(32)
  }, 60_000)

  it('discovery reaches program, mint, escrow, token program; PeerConfig points back', async () => {
    const { info } = await probeOft(makeReadClient(evmByKey('hyperevm')), PENGU_HYPEREVM)
    const sol = info.routes.find((r) => r.eid === SOLANA_EID)!
    const svm = await discoverSvmOft(rpc, sol.peer, evmByKey('hyperevm').eid)

    expect(svm.programId).not.toBe(PROGRAM.system)
    expect(['token', 'token2022']).toContain(svm.tokenProgram)
    expect(svm.decimals).toBe(6) // PENGU
    expect(svm.ld2sdRate).toBeGreaterThan(0n)
    expect(svm.tokenMint).not.toBe(svm.tokenEscrow)
    expect(svm.paused).toBe(false)
    expect(svm.peer.configured).toBe(true)
    if (svm.peer.configured) {
      expect(svm.peer.peerAddress.toLowerCase()).toBe(addressToBytes32(PENGU_HYPEREVM).toLowerCase())
      expect(svm.peer.enforcedSend.length).toBeGreaterThan(2) // enforced lzReceive CU is set on a real deployment
    }
    expect(checkPeerBackSvm(svm, PENGU_HYPEREVM)).toEqual({ status: 'ok' })
    // A different EVM contract is not this store's peer.
    expect(checkPeerBackSvm(svm, '0xd5EE1c81fE161e985dce6b90713c965f9979cf80').status).toBe('mismatch')
  }, 60_000)

  it('recipient classification: escrow is a token account, mint is program-owned, a fresh key is missing', async () => {
    const { info } = await probeOft(makeReadClient(evmByKey('hyperevm')), PENGU_HYPEREVM)
    const sol = info.routes.find((r) => r.eid === SOLANA_EID)!
    const svm = await discoverSvmOft(rpc, sol.peer, evmByKey('hyperevm').eid)
    const escrow = await checkSvmRecipient(rpc, svm.tokenEscrow, svm.tokenMint, svm.tokenProgram)
    expect(escrow.class).toBe('token_account')
    expect(escrow.tokenAccountMint).toBe(svm.tokenMint)
    const mint = await checkSvmRecipient(rpc, svm.tokenMint, svm.tokenMint, svm.tokenProgram)
    expect(mint.class).toBe('token_account') // a mint is owned by the token program too — never a valid recipient
    const fresh = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff))
    const f = await checkSvmRecipient(rpc, fresh, svm.tokenMint, svm.tokenProgram)
    expect(f.class).toBe('missing')
    expect(f.ataExists).toBe(false)
  }, 60_000)
})

describe('EVM → Solana plan on the live HyperEVM contract', () => {
  it('quotes a send to a fresh Solana wallet; enforced options already fund the ATA, so extra is empty', async () => {
    const hyper = makeReadClient(evmByKey('hyperevm'))
    const { info } = await probeOft(hyper, PENGU_HYPEREVM)
    const fresh = encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff))
    const opts = planSvmOptions({ enforced: info.enforced[SOLANA_EID] ?? '0x', ataExists: false })
    expect(opts.error).toBeUndefined()
    expect(opts.extraOptions).toBe('0x')
    expect(opts.total.gas).toBeGreaterThan(0n)
    expect(opts.total.value).toBeGreaterThanOrEqual(2_039_280n)
    const plan = await buildSendPlan(hyper, {
      info, src: evmByKey('hyperevm'), dstEid: SOLANA_EID, amountInput: '1.5', sender: '0x1111111111111111111111111111111111111111',
      recipient: svmRecipient(fresh), extraOptions: opts.extraOptions,
    })
    expect(plan.recipientVm).toBe('svm')
    expect(plan.recipient).toBe(svmRecipient(fresh).to)
    expect(plan.quote.nativeFee).toBeGreaterThan(0n)
    expect(plan.value).toBeGreaterThanOrEqual(plan.quote.nativeFee)
    // Solana shared decimals: dust below ld2sd is trimmed on the EVM side too (18 → 6)
    const dusty = await buildSendPlan(hyper, {
      info, src: evmByKey('hyperevm'), dstEid: SOLANA_EID, amountInput: '1.1234567891', sender: '0x1111111111111111111111111111111111111111',
      recipient: svmRecipient(fresh),
    })
    expect(dusty.amounts.dustTrimmed).toBeGreaterThan(0n)
    expect(dusty.amounts.amountLD % info.conversionRate).toBe(0n)
  }, 90_000)
})
