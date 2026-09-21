/**
 * The invariant of §4.3, enforced by core, not by a component: an EVM wallet address can never
 * become a Solana recipient, and buildSendPlan() refuses a recipient built for the wrong VM.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import type { ReadClient } from '@/core/client'
import { addressToBytes32 } from '@/core/encoding'
import { runGuards } from '@/core/guards'
import { buildSendPlan, PlanError } from '@/core/plan'
import { evmRecipient, RecipientError, svmRecipient, tryRecipient, type Recipient } from '@/core/recipient'
import { evmByKey } from '@/core/chains'
import { encodeBase58 } from '@/core/svm/base58'
import { goodInput, OTHER, TREAD_ADAPTER, TREAD_OFT, treadOftInfo, treadPlan, WALLET } from './fixtures'

const SOLANA_EID = 30168
const SOL_PEER = `0x${'c3'.repeat(32)}` as const
// A plausible Solana wallet: 32 arbitrary bytes, base58-encoded.
const SOL_WALLET_BYTES = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)
const SOL_WALLET = encodeBase58(SOL_WALLET_BYTES)

describe('evmRecipient / svmRecipient constructors', () => {
  it('evmRecipient pads a 20-byte address into bytes32 and checksums the display', () => {
    const r = evmRecipient(WALLET)
    expect(r).toEqual({ vm: 'evm', to: addressToBytes32(WALLET), display: getAddress(WALLET) })
    expect(evmRecipient(WALLET.toUpperCase().replace('0X', '0x')).to).toBe(r.to)
  })
  it('svmRecipient decodes base58 into exactly 32 bytes', () => {
    const r = svmRecipient(SOL_WALLET)
    expect(r.vm).toBe('svm')
    expect(r.display).toBe(SOL_WALLET)
    expect(r.to).toHaveLength(66)
    expect(r.to.slice(2)).toBe([...SOL_WALLET_BYTES].map((b) => b.toString(16).padStart(2, '0')).join(''))
  })
  it.each([
    [WALLET, 'looks_like_evm'],
    [WALLET.slice(2), 'looks_like_evm'], // bare 40 hex chars
    [addressToBytes32(WALLET), 'looks_like_evm'], // bytes32 hex
    [addressToBytes32(WALLET).slice(2), 'looks_like_evm'],
    ['', 'empty'],
    ['0OIl', 'not_base58'], // characters outside the alphabet
    ['abc', 'bad_length'],
    [encodeBase58(new Uint8Array(20)), 'bad_length'], // 20 zero bytes → "111…" of the wrong length
  ])('svmRecipient(%s) is refused with %s', (input, code) => {
    expect(() => svmRecipient(input)).toThrow(RecipientError)
    try {
      svmRecipient(input)
    } catch (e) {
      expect((e as RecipientError).code).toBe(code)
    }
  })
  it('evmRecipient refuses base58 and garbage', () => {
    expect(() => evmRecipient(SOL_WALLET)).toThrow(RecipientError)
    expect(() => evmRecipient('0x123')).toThrow(RecipientError)
    expect(() => evmRecipient('')).toThrow(RecipientError)
  })
  it('tryRecipient never throws and reports the code', () => {
    expect(tryRecipient('svm', WALLET)).toEqual({ ok: false, code: 'looks_like_evm' })
    expect(tryRecipient('evm', SOL_WALLET)).toEqual({ ok: false, code: 'not_an_address' })
    expect(tryRecipient('svm', SOL_WALLET).ok).toBe(true)
    expect(tryRecipient('evm', WALLET).ok).toBe(true)
  })
})

describe('buildSendPlan refuses a recipient built for the wrong VM (before touching any RPC)', () => {
  const info = treadOftInfo({ routes: [{ eid: 30101, peer: addressToBytes32(TREAD_ADAPTER) }, { eid: SOLANA_EID, peer: SOL_PEER }] })
  const neverCalled = {
    readContract: async () => {
      throw new Error('RPC must not be reached')
    },
  } as unknown as ReadClient
  const base = { info, src: evmByKey('hyperevm'), amountInput: '1', sender: WALLET }

  it('Solana destination + EVM recipient (the wallet default) → recipient_vm_mismatch', async () => {
    for (const r of [evmRecipient(WALLET), evmRecipient(OTHER)]) {
      await expect(buildSendPlan(neverCalled, { ...base, dstEid: SOLANA_EID, recipient: r })).rejects.toMatchObject({ code: 'recipient_vm_mismatch' } satisfies Partial<PlanError>)
    }
  })
  it('EVM destination + Solana recipient → recipient_vm_mismatch', async () => {
    await expect(buildSendPlan(neverCalled, { ...base, dstEid: 30101, recipient: svmRecipient(SOL_WALLET) })).rejects.toMatchObject({ code: 'recipient_vm_mismatch' })
  })
  it('there is no way to express "EVM address as Solana recipient" in the type at all', () => {
    // A hand-built object with the Solana tag but an EVM-shaped 32-byte value is the only
    // remaining path; guard 19 does not care about shape, but svmRecipient() is the sole
    // constructor and it rejects every hex form (tested above). Type-level: `Recipient`'s
    // `vm` is a literal union, so `{ vm: 'svm', ... }` cannot be produced from an `Address`
    // without an explicit cast — which the whitelist/lint forbids in src/.
    const r: Recipient = svmRecipient(SOL_WALLET)
    expect(r.vm).toBe('svm')
  })
})

describe('guard 19/20 on a Solana destination', () => {
  const info = treadOftInfo({ routes: [{ eid: 30101, peer: addressToBytes32(TREAD_ADAPTER) }, { eid: SOLANA_EID, peer: SOL_PEER }] })
  const svmPlan = () => {
    const p = treadPlan({ dstEid: SOLANA_EID })
    return { ...p, recipient: svmRecipient(SOL_WALLET).to, recipientDisplay: SOL_WALLET, recipientVm: 'svm' as const }
  }
  const base = () => goodInput({ info, plan: svmPlan(), recipientIsCustom: true, customRecipientConfirmed: true, svmRecipientClass: 'wallet', svmDestinationKnown: true })
  const codeOf = (id: number, i: Parameters<typeof runGuards>[0]) => {
    const r = runGuards(i).results.find((x) => x.id === id)!
    return r.ok ? 'ok' : r.code
  }

  it('19: an EVM-tagged plan aimed at Solana is blocked even if the UI produced it', () => {
    const p = { ...svmPlan(), recipientVm: 'evm' as const, recipient: addressToBytes32(WALLET), recipientDisplay: WALLET }
    expect(codeOf(19, goodInput({ info, plan: p, svmRecipientClass: 'wallet' }))).toBe('recipient_vm_mismatch')
  })
  it('19: token account → blocked; PDA → blocked until accepted; missing → ok (soft warning elsewhere)', () => {
    expect(codeOf(19, base())).toBe('ok')
    expect(codeOf(19, { ...base(), svmRecipientClass: 'token_account' })).toBe('recipient_token_account')
    expect(codeOf(19, { ...base(), svmRecipientClass: 'program_owned' })).toBe('recipient_pda_unconfirmed')
    expect(codeOf(19, { ...base(), svmRecipientClass: 'program_owned', svmRecipientPdaAccepted: true })).toBe('ok')
    expect(codeOf(19, { ...base(), svmRecipientClass: 'missing' })).toBe('ok')
    expect(codeOf(19, { ...base(), svmRecipientClass: undefined })).toBe('recipient_class_unknown')
  })
  it('19: EVM destination ignores the Solana classification', () => {
    expect(codeOf(19, goodInput({ svmRecipientClass: undefined }))).toBe('ok')
  })
  it('20: Solana side must be discovered before sending; EVM unaffected', () => {
    expect(codeOf(20, { ...base(), svmDestinationKnown: false })).toBe('svm_dest_unknown')
    expect(codeOf(20, base())).toBe('ok')
    expect(codeOf(20, goodInput())).toBe('ok')
  })
  it('15: with no CU anywhere a Solana send is a hard block, no checkbox; EVM keeps the checkbox', () => {
    const noEnforced = treadOftInfo({ routes: info.routes, enforced: {} })
    const i = { ...base(), info: noEnforced }
    expect(codeOf(15, i)).toBe('no_executor_options_svm')
    expect(codeOf(15, { ...i, noExecutorGasAccepted: true })).toBe('no_executor_options_svm')
    const evm = goodInput({ info: treadOftInfo({ enforced: {} }) })
    expect(codeOf(15, evm)).toBe('no_executor_gas_unconfirmed')
    expect(codeOf(15, { ...evm, noExecutorGasAccepted: true })).toBe('ok')
    // enforced CU on the EVM side satisfies 15 for the Solana route
    const withEnforced = treadOftInfo({ routes: info.routes, enforced: { [SOLANA_EID]: '0x00030100210100000000000000000000000000030d40000000000000000000000000002625a0' } })
    expect(codeOf(15, { ...base(), info: withEnforced })).toBe('ok')
  })
  it('a fully discovered, funded Solana plan can send (canSend true)', () => {
    const withEnforced = treadOftInfo({ routes: info.routes, enforced: { [SOLANA_EID]: '0x00030100210100000000000000000000000000030d40000000000000000000000000002625a0' } })
    expect(runGuards({ ...base(), info: withEnforced }).canSend).toBe(true)
  })
  it('the golden EVM plan is untouched by the new fields', () => {
    expect(treadPlan().recipientVm).toBe('evm')
    expect(treadPlan().recipient).toBe(addressToBytes32(WALLET))
    void TREAD_OFT
  })
})
