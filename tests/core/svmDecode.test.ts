/** Solana sample-transaction decode: which fields are copied, which are not, quorum. */
import { describe, expect, it } from 'vitest'
import { addressToBytes32 } from '@/core/encoding'
import { encodeBase58 } from '@/core/svm/base58'
import { decodeSvmTx, isSolanaSignature, prefillFromTransaction } from '@/core/svm/decode'
import { encodeSvmSendData, eventAuthorityPda, peerConfigPda, type SvmSendData } from '@/core/svm/plan'
import { PROGRAM } from '@/core/svm/pubkey'
import { SvmRpc, type SvmCompiledIx, type SvmTransaction } from '@/core/svm/rpc'
import { ESCROW, HYPER_EID, MINT, PROGRAM as OFT_PROGRAM, SENDER, STORE } from './svmFixtures'

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const RECIPIENT = '0x1ebeb39ead138a5a1aa9a2bce759cfa0b5f14bf4'
const ATA = '4DspWggarDzgWrzRdzyaTZENuS9Xprbp9ybtDgUPjSjf'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'

const sendData = (over: Partial<SvmSendData> = {}): SvmSendData => ({
  dstEid: HYPER_EID,
  to: addressToBytes32(RECIPIENT),
  amountLd: 2_980_863_708_000n,
  minAmountLd: 2_951_055_070_920n,
  options: '0x0003',
  composeMsg: null,
  nativeFee: 231_700n,
  lzTokenFee: 0n,
  ...over,
})

/**
 * A v0 transaction shaped like the real PENGU send BzCcx7…: 10 static keys, the endpoint's CPI
 * accounts loaded from the lookup table, one compute-budget instruction before `send`.
 */
function tx(o: { data?: SvmSendData; err?: unknown; inner?: boolean; extraSend?: boolean; program?: string; accounts?: number[] } = {}): SvmTransaction {
  const program = o.program ?? OFT_PROGRAM
  const accountKeys = [SENDER, peerConfigPda(STORE, OFT_PROGRAM, HYPER_EID), STORE, ATA, ESCROW, MINT, PROGRAM.token, eventAuthorityPda(OFT_PROGRAM), program, COMPUTE_BUDGET]
  const loaded = { writable: ['7a4WjyR8VZ7yZz5XJAKm39BZFVBqfsNkyJ4yBTG9Dtdk'], readonly: ['76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6'] }
  const send: SvmCompiledIx = { programIdIndex: 8, accounts: o.accounts ?? [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11], data: encodeBase58(encodeSvmSendData(o.data ?? sendData())) }
  const cu: SvmCompiledIx = { programIdIndex: 9, accounts: [], data: encodeBase58(new Uint8Array([2, 0xc0, 0x27, 0x09, 0])) }
  const top = o.inner ? [cu] : o.extraSend ? [cu, send, send] : [cu, send]
  return {
    slot: 1,
    blockTime: 1,
    transaction: { signatures: [SIG], message: { accountKeys, instructions: top } },
    meta: { err: o.err ?? null, loadedAddresses: loaded, innerInstructions: o.inner ? [{ index: 0, instructions: [send] }] : [] },
  }
}

const rpcFor = (byUrl: Record<string, SvmTransaction | null | 'boom'>) =>
  new SvmRpc(Object.keys(byUrl), async (url, init) => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string }
    expect(req.method).toBe('getTransaction')
    const v = byUrl[url]
    if (v === 'boom') return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result: v }) } as unknown as Response
  })

describe('isSolanaSignature', () => {
  it('accepts 86–88 base58 chars only', () => {
    expect(isSolanaSignature(SIG)).toBe(true)
    expect(isSolanaSignature('0x' + 'ab'.repeat(32))).toBe(false)
    expect(isSolanaSignature(SIG.slice(0, 60))).toBe(false)
    expect(isSolanaSignature('0OIl' + SIG.slice(4))).toBe(false)
  })
})

describe('prefillFromTransaction', () => {
  it('copies store, program, dstEid and sanitized options; reports the rest as observed only', () => {
    const p = prefillFromTransaction(tx())
    expect(p).toMatchObject({ oftStore: STORE, programId: OFT_PROGRAM, dstEid: HYPER_EID, extraOptions: '0x', droppedOptions: [], optionsMalformed: false })
    expect(p.observed).toEqual({ from: SENDER, to: addressToBytes32(RECIPIENT), amountLD: 2_980_863_708_000n, minAmountLD: 2_951_055_070_920n, nativeFee: 231_700n, hadComposeMsg: false, failed: false })
    // Nothing that identifies the sample's recipient or payer leaks into the prefill itself.
    expect(Object.keys(p)).toEqual(['oftStore', 'programId', 'dstEid', 'extraOptions', 'droppedOptions', 'optionsMalformed', 'observed'])
  })

  it('keeps a receive-gas hint for an EVM destination and drops nativeDrop / compose', () => {
    // lzReceive(60000) + nativeDrop(1 wei → 0x11…11)
    // executor option 2 = nativeDrop: u128 amount + bytes32 receiver (49 bytes with the type byte)
    const options = ('0x0003' + '010011010000000000000000000000000000ea60' + '01003102' + '00000000000000000000000000000001' + '0000000000000000000000001111111111111111111111111111111111111111') as `0x${string}`
    const p = prefillFromTransaction(tx({ data: sendData({ options }) }))
    expect(p.extraOptions).toBe('0x0003010011010000000000000000000000000000ea60')
    expect(p.droppedOptions.map((d) => d.kind)).toEqual(['nativeDrop'])
    expect(p.optionsMalformed).toBe(false)
  })

  it('malformed options are ignored and flagged', () => {
    const p = prefillFromTransaction(tx({ data: sendData({ options: '0x00030100ff' }) }))
    expect(p.extraOptions).toBe('0x')
    expect(p.optionsMalformed).toBe(true)
  })

  it('a failed sample is still a hint, but flagged', () => {
    expect(prefillFromTransaction(tx({ err: { InstructionError: [1, { Custom: 1 }] } })).observed.failed).toBe(true)
  })

  it('finds a send reached through a CPI (inner instruction)', () => {
    expect(prefillFromTransaction(tx({ inner: true })).oftStore).toBe(STORE)
  })

  it('a compose message is observed', () => {
    expect(prefillFromTransaction(tx({ data: sendData({ composeMsg: '0x01' }) })).observed.hadComposeMsg).toBe(true)
  })

  it('refuses: no send, two sends, too few accounts, program account mismatch, bad index', () => {
    const noSend = tx()
    noSend.transaction.message.instructions = noSend.transaction.message.instructions.slice(0, 1)
    expect(() => prefillFromTransaction(noSend)).toThrow(/no OFT send/)
    expect(() => prefillFromTransaction(tx({ extraSend: true }))).toThrow(/2 send instructions/)
    expect(() => prefillFromTransaction(tx({ accounts: [0, 1, 2] }))).toThrow(/3 accounts/)
    expect(() => prefillFromTransaction(tx({ accounts: [0, 1, 2, 3, 4, 5, 6, 7, 9] }))).toThrow(/program account/)
    expect(() => prefillFromTransaction(tx({ accounts: [0, 1, 99, 3, 4, 5, 6, 7, 8] }))).toThrow(/out of range/)
  })
})

describe('decodeSvmTx', () => {
  it('validates the signature before any RPC call', async () => {
    const rpc = new SvmRpc(['https://a'], async () => {
      throw new Error('must not be called')
    })
    await expect(decodeSvmTx(rpc, '0x' + 'ab'.repeat(32))).rejects.toMatchObject({ code: 'invalid_hash' })
  })

  it('tx_not_found when every provider has nothing', async () => {
    await expect(decodeSvmTx(rpcFor({ 'https://a': null, 'https://b': null }), SIG)).rejects.toMatchObject({ code: 'tx_not_found' })
    await expect(decodeSvmTx(rpcFor({ 'https://a': 'boom' }), SIG)).rejects.toMatchObject({ code: 'tx_not_found' })
  })

  it('two agreeing providers → crossChecked; a second provider down → not cross-checked; disagreement → rpc_mismatch', async () => {
    expect((await decodeSvmTx(rpcFor({ 'https://a': tx(), 'https://b': tx() }), SIG)).crossChecked).toBe(true)
    expect((await decodeSvmTx(rpcFor({ 'https://a': tx(), 'https://b': 'boom' }), SIG)).crossChecked).toBe(false)
    expect((await decodeSvmTx(rpcFor({ 'https://a': tx(), 'https://b': null }), SIG)).crossChecked).toBe(false)
    await expect(decodeSvmTx(rpcFor({ 'https://a': tx(), 'https://b': tx({ data: sendData({ dstEid: 30101 }) }) }), SIG)).rejects.toMatchObject({ code: 'rpc_mismatch' })
    const other = tx()
    other.transaction.message.instructions = other.transaction.message.instructions.slice(0, 1)
    await expect(decodeSvmTx(rpcFor({ 'https://a': tx(), 'https://b': other }), SIG)).rejects.toMatchObject({ code: 'rpc_mismatch' })
  })
})
