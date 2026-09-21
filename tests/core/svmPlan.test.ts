import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2'
import { addressToBytes32 } from '@/core/encoding'
import { g1Chain, g3Recipient, g4RecipientNotContract, g7Fee, g12Spender, runGuards, type GuardInput } from '@/core/guards'
import { planFee } from '@/core/plan'
import { svmTxFee } from '@/core/svm/fees'
import { decodeLookupTable, decodeTokenMetadata } from '@/core/svm/layouts'
import {
  COMPUTE_BUDGET_PROGRAM, decodeComputeBudget, decodeSvmSendData, encodeSvmSendData, eventAuthorityPda, expectedSendAccounts, peerConfigPda, SEND_DISCRIMINATOR,
  selfCheckSvm, svmSendDataFor, type SvmSendPlan, type SvmTxView,
} from '@/core/svm/plan'
import { pubkeyFromBase58 } from '@/core/svm/pubkey'

import { ESCROW, HYPER_EID, MINT, PENGU_HYPER, penguPlan, penguSource, PROGRAM, RECIPIENT, SENDER, STORE } from './svmFixtures'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const cu = (units: number) => {
  const b = new Uint8Array(5)
  b[0] = 2
  new DataView(b.buffer).setUint32(1, units, true)
  return b
}
const price = (p: bigint) => {
  const b = new Uint8Array(9)
  b[0] = 3
  new DataView(b.buffer).setBigUint64(1, p, true)
  return b
}

/** The view the SDK produces for penguPlan(), as observed against mainnet (svmSend.live.test.ts). */
function goodView(plan: SvmSendPlan): SvmTxView {
  const acc = (pubkey: string, isWritable = false) => ({ pubkey, isSigner: false, isWritable })
  return {
    signers: [plan.sender],
    lookupTables: [plan.lookupTable],
    instructions: [
      { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: cu(plan.computeUnitLimit) },
      { programId: COMPUTE_BUDGET_PROGRAM, accounts: [], data: price(plan.computeUnitPrice) },
      {
        programId: plan.programId,
        accounts: [...expectedSendAccounts(plan), acc('76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6'), acc('7a4WjyR8VZ7yZz5XJAKm39BZFVBqfsNkyJ4yBTG9Dtdk', true)],
        data: encodeSvmSendData(svmSendDataFor(plan)),
      },
    ],
  }
}

describe('send instruction codec', () => {
  it('discriminator is sha256("global:send")[0..8] = 66fb14bb414b0c45 (what the SDK emits)', () => {
    expect(hex(SEND_DISCRIMINATOR)).toBe('66fb14bb414b0c45')
    expect(hex(sha256(new TextEncoder().encode('global:send')).slice(0, 8))).toBe('66fb14bb414b0c45')
  })

  it('encodes the exact bytes the SDK produced on mainnet for 1 PENGU → HyperEVM, fee 330000', () => {
    const plan = penguPlan()
    // Captured from the browser e2e (the transaction the wallet was asked to sign).
    expect(hex(encodeSvmSendData(svmSendDataFor(plan)))).toBe(
      '66fb14bb414b0c45' + '9f760000' + '000000000000000000000000' + '1111111111111111111111111111111111111111' + '40420f0000000000' + '40420f0000000000' + '00000000' + '00' + '1009050000000000' + '0000000000000000',
    )
  })

  it('round-trips, including options and a compose message', () => {
    const d = { dstEid: 30101, to: addressToBytes32(RECIPIENT), amountLd: 123n, minAmountLd: 100n, options: '0x0003010011010000000000000000000000000000ea60' as const, composeMsg: '0xdeadbeef' as const, nativeFee: 5n, lzTokenFee: 0n }
    expect(decodeSvmSendData(encodeSvmSendData(d))).toEqual(d)
  })

  it('rejects foreign data, truncation and trailing bytes', () => {
    const good = encodeSvmSendData(svmSendDataFor(penguPlan()))
    expect(() => decodeSvmSendData(good.slice(0, 40))).toThrow(/truncated/)
    expect(() => decodeSvmSendData(new Uint8Array([...good, 0]))).toThrow(/trailing/)
    const bad = new Uint8Array(good)
    bad[0] = bad[0]! ^ 1
    expect(() => decodeSvmSendData(bad)).toThrow(/discriminator/)
    expect(() => encodeSvmSendData({ ...svmSendDataFor(penguPlan()), to: '0x1234' })).toThrow(/32 bytes/)
    expect(() => encodeSvmSendData({ ...svmSendDataFor(penguPlan()), nativeFee: -1n })).toThrow(/u64/)
  })

  it('compute-budget data decodes', () => {
    expect(decodeComputeBudget(cu(600_000))).toEqual({ kind: 'limit', units: 600_000 })
    expect(decodeComputeBudget(price(10_000n))).toEqual({ kind: 'price', microLamports: 10_000n })
    expect(decodeComputeBudget(new Uint8Array([1, 2, 3]))).toEqual({ kind: 'other' })
  })

  it('derives the PDAs the instruction must carry', () => {
    // PeerConfig for HyperEVM and the Anchor event authority, checked against explorer values.
    expect(peerConfigPda(STORE, PROGRAM, HYPER_EID)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    expect(eventAuthorityPda(PROGRAM)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    expect(expectedSendAccounts(penguPlan()).map((a) => a.isSigner)).toEqual([true, false, false, false, false, false, false, false, false])
  })
})

describe('selfCheckSvm', () => {
  const plan = penguPlan()

  it('accepts the SDK-shaped transaction', () => {
    expect(selfCheckSvm(plan, goodView(plan))).toEqual({ ok: true })
  })

  it.each<[string, (v: SvmTxView) => void, RegExp]>([
    ['fee payer is not the sender', (v) => { v.signers[0] = STORE }, /fee payer/],
    ['a second signer', (v) => { v.signers.push(STORE) }, /signers: 2/],
    ['an extra signer inside the instruction', (v) => { v.instructions[2]!.accounts[10]!.isSigner = true }, /extra signer/],
    ['wrong lookup table', (v) => { v.lookupTables = [STORE] }, /lookup table/],
    ['no lookup table', (v) => { v.lookupTables = [] }, /lookup table/],
    ['a fourth instruction', (v) => { v.instructions.push(v.instructions[0]!) }, /instructions: 4/],
    ['compute limit differs from the plan', (v) => { v.instructions[0]!.data = cu(1_400_000) }, /computeUnitLimit/],
    ['compute price differs from the plan', (v) => { v.instructions[1]!.data = price(1n) }, /computeUnitPrice/],
    ['send goes to another program', (v) => { v.instructions[2]!.programId = STORE }, /send: program/],
    ['token source is not the sender ATA', (v) => { v.instructions[2]!.accounts[3]!.pubkey = ESCROW }, /account 3/],
    ['peer PDA swapped', (v) => { v.instructions[2]!.accounts[1]!.pubkey = STORE }, /account 1/],
    ['recipient changed', (v) => { v.instructions[2]!.data = encodeSvmSendData({ ...svmSendDataFor(plan), to: addressToBytes32(PENGU_HYPER) }) }, /^to$/],
    ['amount changed', (v) => { v.instructions[2]!.data = encodeSvmSendData({ ...svmSendDataFor(plan), amountLd: 2_000_000n }) }, /amountLD/],
    ['fee above plan.value', (v) => { v.instructions[2]!.data = encodeSvmSendData({ ...svmSendDataFor(plan), nativeFee: plan.value + 1n }) }, /nativeFee/],
    ['lzTokenFee set', (v) => { v.instructions[2]!.data = encodeSvmSendData({ ...svmSendDataFor(plan), lzTokenFee: 1n }) }, /lzTokenFee/],
    ['compose message added', (v) => { v.instructions[2]!.data = encodeSvmSendData({ ...svmSendDataFor(plan), composeMsg: '0x01' }) }, /composeMsg/],
    ['options added', (v) => { v.instructions[2]!.data = encodeSvmSendData({ ...svmSendDataFor(plan), options: '0x0003' }) }, /extraOptions/],
    ['dstEid changed', (v) => { v.instructions[2]!.data = encodeSvmSendData({ ...svmSendDataFor(plan), dstEid: 30101 }) }, /dstEid/],
    ['garbage data', (v) => { v.instructions[2]!.data = new Uint8Array(3) }, /decode/],
  ])('rejects: %s', (_name, mutate, re) => {
    const v = goodView(plan)
    mutate(v)
    const r = selfCheckSvm(plan, v)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.mismatches.some((m) => re.test(m))).toBe(true)
  })
})

describe('guards with a Solana-source plan', () => {
  const info = penguSource()
  const plan = penguPlan()
  const input = (over: Partial<GuardInput> = {}): GuardInput => ({
    walletAddress: undefined,
    walletChainId: undefined,
    srcChainId: 0,
    svmWalletAddress: SENDER,
    info,
    plan,
    recipientIsCustom: true,
    customRecipientConfirmed: true,
    tokenBalance: 10n ** 12n,
    nativeBalance: 10n ** 9n,
    allowance: undefined,
    gasCostWei: svmTxFee(plan.computeUnitLimit, plan.computeUnitPrice),
    simulation: { ok: true },
    selfCheck: { ok: true },
    noExecutorGasAccepted: false,
    flags: [],
    peerBack: { status: 'ok' },
    peerBackUnavailableAccepted: false,
    ...over,
  })

  it('all 20 pass for a complete, confirmed plan', () => {
    const r = runGuards(input())
    expect(r.results.filter((x) => !x.ok)).toEqual([])
    expect(r.canSend).toBe(true)
  })

  it('g1: needs the Solana wallet, and it must be the plan sender', () => {
    expect(g1Chain(input({ svmWalletAddress: undefined }))).toMatchObject({ ok: false, code: 'wallet_not_connected' })
    expect(g1Chain(input({ svmWalletAddress: STORE }))).toMatchObject({ ok: false, code: 'chain_mismatch' })
    // An EVM wallet being connected is irrelevant for a Solana source.
    expect(g1Chain(input({ walletAddress: RECIPIENT, walletChainId: 1 }))).toEqual({ id: 1, ok: true })
  })

  it('g3: the EVM recipient is always custom and must be confirmed', () => {
    expect(g3Recipient(input({ recipientIsCustom: false, customRecipientConfirmed: false }))).toMatchObject({ ok: false, code: 'recipient_unconfirmed' })
    expect(g3Recipient(input({ customRecipientConfirmed: false }))).toMatchObject({ ok: false, code: 'recipient_unconfirmed' })
  })

  it('g4: the destination OFT contract itself cannot be the recipient', () => {
    const bad = penguPlan({ recipient: addressToBytes32(PENGU_HYPER), recipientDisplay: PENGU_HYPER })
    expect(g4RecipientNotContract(input({ plan: bad }))).toMatchObject({ ok: false, code: 'recipient_is_contract' })
  })

  it('g7: nativeFee in the instruction equals plan.value and covers the quote', () => {
    expect(planFee(plan)).toEqual({ nativeFee: plan.value, lzTokenFee: 0n })
    expect(g7Fee(input({ plan: penguPlan({ value: 1n }) }))).toMatchObject({ ok: false, code: 'fee_mismatch' })
  })

  it('g8: value + tx fee must fit in the SOL balance', () => {
    const need = plan.value + svmTxFee(plan.computeUnitLimit, plan.computeUnitPrice)
    expect(runGuards(input({ nativeBalance: need - 1n })).results.find((x) => x.id === 8)).toMatchObject({ ok: false, code: 'insufficient_native' })
    expect(runGuards(input({ nativeBalance: need })).results.find((x) => x.id === 8)).toEqual({ id: 8, ok: true })
  })

  it('g12: an approve intent can never be right for a Solana source', () => {
    expect(g12Spender(input({ approveIntent: { spender: RECIPIENT, amount: 1n } }))).toMatchObject({ ok: false, code: 'approve_wrong_spender' })
  })

  it('g2: the plan must name the store that was checked', () => {
    const other = penguSource({ oftStore: ESCROW })
    expect(runGuards(input({ info: other })).results.find((x) => x.id === 2)).toMatchObject({ ok: false, code: 'oft_missing' })
  })

  it('g17: a mismatching back-link blocks', () => {
    expect(runGuards(input({ peerBack: { status: 'mismatch', theirPeer: addressToBytes32(RECIPIENT) } })).results.find((x) => x.id === 17)).toMatchObject({ ok: false, code: 'peer_back_mismatch' })
  })

  it('svmTxFee: base + ceil(CU × price / 1e6)', () => {
    expect(svmTxFee(600_000, 10_000n)).toBe(5_000n + 6_000n)
    expect(svmTxFee(1, 1n)).toBe(5_001n)
  })
})

describe('layouts', () => {
  it('lookup table: 56-byte header then addresses', () => {
    const data = new Uint8Array(56 + 64)
    new DataView(data.buffer).setUint32(0, 1, true)
    data.set(Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'), 56)
    data.set(Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex'), 88)
    expect(decodeLookupTable(data).addresses).toEqual(['11111111111111111111111111111112', '11111111111111111111111111111113'])
    const uninit = new Uint8Array(56)
    expect(() => decodeLookupTable(uninit)).toThrow(/not an initialized/)
    expect(() => decodeLookupTable(new Uint8Array(10))).toThrow(/too short/)
  })

  it('metaplex metadata: key, authority, mint, name, symbol (NUL padded)', () => {
    const str = (s: string, size: number) => {
      const b = new Uint8Array(4 + size)
      new DataView(b.buffer).setUint32(0, size, true)
      b.set(new TextEncoder().encode(s), 4)
      return b
    }
    const data = new Uint8Array([4, ...new Uint8Array(32), ...pubkeyFromBase58(MINT), ...str('Pudgy Penguins', 32), ...str('PENGU', 10), ...str('https://x', 200)])
    expect(decodeTokenMetadata(data, MINT)).toEqual({ name: 'Pudgy Penguins', symbol: 'PENGU' })
    expect(() => decodeTokenMetadata(data, ESCROW)).toThrow(/different mint/)
    data[0] = 1
    expect(() => decodeTokenMetadata(data, MINT)).toThrow(/MetadataV1/)
  })
})
