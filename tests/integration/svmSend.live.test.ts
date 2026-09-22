/**
 * Solana → EVM against mainnet, read-only: source discovery, a real quote, the assembled `send`
 * transaction decoded back by SDK-free code, and a dry run. Nothing is signed or submitted.
 */
import { describe, expect, it } from 'vitest'
import { byKey } from '@/core/chains'
import { addressToBytes32 } from '@/core/encoding'
import { runGuards, type GuardInput } from '@/core/guards'
import { evmRecipient } from '@/core/recipient'
import { decodeTokenAccount } from '@/core/svm/layouts'
import { decodeSvmSendData, encodeSvmSendData, LZ_MAINNET_LOOKUP_TABLE, MAX_COMPUTE_UNITS, selfCheckSvm, svmSendDataFor } from '@/core/svm/plan'
import { ataFor } from '@/core/svm/recipient'
import { SvmRpc } from '@/core/svm/rpc'
import { assembleSvmTransaction, buildSvmSendPlan, createSvmSendContext, simulateSvm, svmTxFeeLamports } from '@/core/svm/send'
import { probeSvmOft } from '@/core/svm/source'
import { decodeSvmTx } from '@/core/svm/decode'

const PENGU_STORE = 'qMNo1RFo11J9ZLGuq7dVmWAssuCZaNsSamk8g2q4UZA'
const PENGU_PROGRAM = 'EfRMrTJWU2CYm52kHmRYozQNdF8RH5aTi3xyeSuLAX2Y'
const PENGU_MINT = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv'
const PENGU_HYPEREVM = '0xfa44c2634ff17cbe26dc3007d36bd61c79068c14'
const HYPER_EID = 30367
// Wallets seen sending PENGU through the OFT recently; the first one with a balance is the sender.
const CANDIDATES = ['2hCc738iscpDVahFvwjNwUq1WZQ7xRTeitebgWtkkp1h', '5Tibp4jqdRo4ejyMExkcQrmRnRFBeDDmyvPk5b3kEdLg', 'HRZqQddx23vwpCFbpJJK93mvwzjHnoJVi31FxyCg6FXf']
const RECIPIENT = '0x1111111111111111111111111111111111111111'

const urls = [...byKey('solana').rpcUrls]
const rpc = new SvmRpc(urls)

describe('Solana source: PENGU', () => {
  it('probeSvmOft reads the store, mint, metadata and routes from chain', async () => {
    const r = await probeSvmOft(rpc, PENGU_STORE)
    const i = r.info
    expect(i.vm).toBe('svm')
    expect(i.oftStore).toBe(PENGU_STORE)
    expect(i.programId).toBe(PENGU_PROGRAM)
    expect(i.tokenMint).toBe(PENGU_MINT)
    expect(i.tokenProgram).toBe('token')
    expect(i.decimals).toBe(6)
    expect(i.conversionRate).toBe(1n)
    expect(i.sharedDecimals).toBe(6)
    expect(i.symbol).toBe('PENGU')
    expect(i.approvalRequired).toBe(false)
    const hyper = i.routes.find((x) => x.eid === HYPER_EID)
    expect(hyper?.peer).toBe(addressToBytes32(PENGU_HYPEREVM))
    // PeerConfig for HyperEVM: enforced lzReceive(100_000)
    expect(i.enforced[HYPER_EID]).toBe('0x000301001101000000000000000000000000000186a0')
    // Both registry URLs are the same provider, so still cross-checked byte-for-byte.
    expect(r.crossChecked).toBe(true)
  }, 60_000)

  it('rejects a store address that is not an OFT Store', async () => {
    await expect(probeSvmOft(rpc, PENGU_MINT)).rejects.toMatchObject({ code: 'not_oft_store' })
    await expect(probeSvmOft(rpc, '0x' + 'ab'.repeat(20))).rejects.toMatchObject({ code: 'bad_peer' })
  }, 60_000)

  it('quotes, assembles, decodes and dry-runs a send to HyperEVM', async () => {
    const { info } = await probeSvmOft(rpc, PENGU_STORE)
    const ctx = await createSvmSendContext(urls)
    expect(ctx.lookupTable.addresses.length).toBeGreaterThan(10)

    // Pick a funded sender.
    let sender = CANDIDATES[0]!
    let balance = 0n
    for (const c of CANDIDATES) {
      const acc = await rpc.getAccountInfo(ataFor(c, PENGU_MINT, 'token'))
      const amount = acc ? decodeTokenAccount(acc.data).amount : 0n
      if (amount >= 1_000_000n) {
        sender = c
        balance = amount
        break
      }
    }

    const plan = await buildSvmSendPlan(ctx, { info, dstEid: HYPER_EID, amountInput: '1', sender, recipient: evmRecipient(RECIPIENT) })
    expect(plan.vm).toBe('svm')
    expect(plan.amounts.amountLD).toBe(1_000_000n)
    expect(plan.recipient).toBe(addressToBytes32(RECIPIENT))
    expect(plan.quote.nativeFee).toBeGreaterThan(0n)
    expect(plan.quote.nativeFee).toBeLessThan(100_000_000n) // < 0.1 SOL
    expect(plan.value).toBeGreaterThanOrEqual(plan.quote.nativeFee)
    expect(plan.value % 10_000n).toBe(0n)
    expect(plan.quote.amountReceivedLD).toBe(1_000_000n)
    expect(plan.lookupTable).toBe(LZ_MAINNET_LOOKUP_TABLE)
    expect(plan.computeUnitPrice).toBeGreaterThanOrEqual(10_000n)
    expect(svmTxFeeLamports(plan)).toBeLessThan(2_000_000n)

    console.log(`sender ${sender} balance ${balance} nativeFee ${plan.quote.nativeFee} value ${plan.value} CU ${plan.computeUnitLimit} price ${plan.computeUnitPrice}`)
    const { tx, view } = await assembleSvmTransaction(ctx, plan)
    expect(view.instructions).toHaveLength(3)
    expect(view.signers).toEqual([sender])
    expect(view.instructions[2]!.programId).toBe(PENGU_PROGRAM)
    expect(view.instructions[2]!.accounts.length).toBeGreaterThan(40)
    // The SDK's bytes are exactly our codec's bytes for the plan.
    expect(Buffer.from(view.instructions[2]!.data).toString('hex')).toBe(Buffer.from(encodeSvmSendData(svmSendDataFor(plan))).toString('hex'))
    expect(decodeSvmSendData(view.instructions[2]!.data)).toEqual(svmSendDataFor(plan))
    expect(selfCheckSvm(plan, view)).toEqual({ ok: true })
    // Serialized size fits only because of the lookup table.
    expect(ctx.umi.transactions.serialize(tx).length).toBeLessThanOrEqual(1232)

    const sim = await simulateSvm(ctx, tx)
    console.log(`simulation err ${JSON.stringify(sim.err)} units ${sim.unitsConsumed}`)
    if (balance >= 1_000_000n) {
      expect(sim.err).toBeNull()
      expect(sim.unitsConsumed).toBeGreaterThan(100_000)
      expect(plan.computeUnitLimit).toBeLessThan(MAX_COMPUTE_UNITS)
    } else {
      // No PENGU on the candidate wallets right now: the dry run must fail for that reason only.
      expect(sim.logs.join('\n')).toMatch(/insufficient funds/)
    }

    // Guards over the plan behave like the EVM ones.
    const input: GuardInput = {
      walletAddress: undefined,
      walletChainId: undefined,
      srcChainId: 0,
      svmWalletAddress: sender,
      info,
      plan,
      recipientIsCustom: true,
      customRecipientConfirmed: true,
      tokenBalance: balance,
      nativeBalance: 10n ** 9n,
      allowance: undefined,
      gasCostWei: svmTxFeeLamports(plan),
      simulation: { ok: true },
      selfCheck: selfCheckSvm(plan, view),
      noExecutorGasAccepted: false,
      flags: [],
      peerBack: { status: 'ok' },
      peerBackUnavailableAccepted: false,
    }
    const report = runGuards(input)
    const failing = report.results.filter((r) => !r.ok)
    if (balance >= 1_000_000n) expect(failing).toEqual([])
    else expect(failing.map((r) => (r.ok ? '' : r.code))).toEqual(['insufficient_balance'])
    // Tampering with the view is caught.
    const bad = structuredClone(view)
    bad.instructions[2]!.data[12] = (bad.instructions[2]!.data[12] ?? 0) ^ 1
    expect(selfCheckSvm(plan, bad).ok).toBe(false)
    const badSigner = structuredClone(view)
    badSigner.instructions[2]!.accounts[20]!.isSigner = true
    expect(selfCheckSvm(plan, badSigner)).toMatchObject({ ok: false })
  }, 120_000)

  it('decodes a real PENGU send signature into a prefill that matches the probed store', async () => {
    // BzCcx7… : 2 980 863.708 PENGU from 5Tibp4… to HyperEVM, options 0x0003 (empty type-3 header).
    const sig = 'BzCcx7hf2hb4S8GBoBjiRDLv4McVj2t2UbxNwk4KUzrARZ7R8YRY3EdhceXnN18q6q84vYy1XXAx7XEf5P4XBzQ'
    const d = await decodeSvmTx(rpc, sig)
    expect(d).toMatchObject({ oftStore: PENGU_STORE, programId: PENGU_PROGRAM, dstEid: HYPER_EID, extraOptions: '0x', droppedOptions: [], optionsMalformed: false, crossChecked: true })
    expect(d.observed).toMatchObject({ from: '5Tibp4jqdRo4ejyMExkcQrmRnRFBeDDmyvPk5b3kEdLg', amountLD: 2_980_863_708_000n, minAmountLD: 2_951_055_070_920n, nativeFee: 231_700n, hadComposeMsg: false, failed: false })
    expect(d.observed.to).toBe(addressToBytes32('0x1ebeb39ead138a5a1aa9a2bce759cfa0b5f14bf4'))
    const { info } = await probeSvmOft(rpc, d.oftStore)
    expect(info.programId).toBe(d.programId)
    expect(info.routes.some((r) => r.eid === d.dstEid)).toBe(true)
    await expect(decodeSvmTx(rpc, sig.slice(0, 40))).rejects.toMatchObject({ code: 'invalid_hash' })
    // A signature that does not exist.
    await expect(decodeSvmTx(rpc, '1'.repeat(87))).rejects.toMatchObject({ code: 'tx_not_found' })
  }, 60_000)

  it('refuses an EVM-shaped recipient object for the wrong VM and a Solana recipient for an EVM destination', async () => {
    const { info } = await probeSvmOft(rpc, PENGU_STORE)
    const ctx = await createSvmSendContext(urls)
    const { svmRecipient } = await import('@/core/recipient')
    await expect(
      buildSvmSendPlan(ctx, { info, dstEid: HYPER_EID, amountInput: '1', sender: CANDIDATES[0]!, recipient: svmRecipient(CANDIDATES[1]!) }),
    ).rejects.toMatchObject({ code: 'recipient_vm_mismatch' })
  }, 60_000)
})
