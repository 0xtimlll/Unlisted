/** Input parsing, the cross-chain lookup, verdict assembly and revert decoding. All offline. */
import { describe, expect, it } from 'vitest'
import { encodeErrorResult, getAddress, pad, type Abi, type Address, type Hex } from 'viem'
import { analyzeTx, needsChoice } from '@/core/analysis/analyze'
import type { TxLike } from '@/core/analysis/detect'
import { foreignEventsAbi } from '@/core/analysis/foreign'
import { parseAnalysisInput } from '@/core/analysis/input'
import { classifyRpcError, searchTx } from '@/core/analysis/search'
import { analyzeSvmPrefill } from '@/core/analysis/svm'
import { lzEventsAbi } from '@/core/lz/events'
import { encodePacket } from '@/core/lz/packet'
import { knownErrorsAbi } from '@/core/sim/errors'
import { decodeRevert, formatRevert, revertDataFromError } from '@/core/sim/revert'
import { nttTransferSentV1Abi } from '@/protocols/wormhole-ntt/abi'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'
import { makeLog } from './logs'

const OFT = getAddress('0xfa44c2634ff17cbe26dc3007d36bd61c79068c14')
const ENDPOINT = getAddress('0x1a44076050125825900e736c501f859c50fe728c')
const WALLET = getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9')
const ROUTER = getAddress('0x1111111111111111111111111111111111111111')
const GUID: Hex = `0x${'11'.repeat(32)}`
const HASH = `0x${'ab'.repeat(32)}`
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'

describe('input classification', () => {
  it('recognises each shape', () => {
    expect(parseAnalysisInput(HASH)).toEqual({ ok: true, input: { kind: 'evm_tx', hash: HASH, mayBeGuid: true } })
    expect(parseAnalysisInput(`  ${OFT}  `)).toEqual({ ok: true, input: { kind: 'evm_address', address: OFT } })
    expect(parseAnalysisInput(SIG)).toEqual({ ok: true, input: { kind: 'svm_tx', signature: SIG } })
    expect(parseAnalysisInput('qMNo1RFo11J9ZLGuq7dVmWAssuCZaNsSamk8g2q4UZA')).toMatchObject({ ok: true, input: { kind: 'svm_address' } })
  })

  it('accepts a checksummed address and normalises it', () => {
    const r = parseAnalysisInput(OFT.toLowerCase())
    expect(r).toEqual({ ok: true, input: { kind: 'evm_address', address: OFT } })
  })

  it('separates a truncated hash from something unrecognisable', () => {
    expect(parseAnalysisInput('')).toEqual({ ok: false, code: 'empty' })
    expect(parseAnalysisInput('0xabc')).toEqual({ ok: false, code: 'evm_tx_length' })
    expect(parseAnalysisInput(HASH.slice(0, 40))).toEqual({ ok: false, code: 'evm_tx_length' })
    expect(parseAnalysisInput('hello world')).toEqual({ ok: false, code: 'unrecognised' })
  })

  it('reads LayerZero Scan links, and only those', () => {
    expect(parseAnalysisInput(`https://layerzeroscan.com/tx/${HASH}`)).toEqual({ ok: true, input: { kind: 'evm_tx', hash: HASH, mayBeGuid: false } })
    expect(parseAnalysisInput(`https://layerzeroscan.com/tx/${SIG}`)).toEqual({ ok: true, input: { kind: 'svm_tx', signature: SIG } })
    // A bare identifier page is the message GUID, not a transaction.
    expect(parseAnalysisInput(`https://layerzeroscan.com/${GUID}`)).toEqual({ ok: true, input: { kind: 'lz_guid', guid: GUID } })
    expect(parseAnalysisInput('https://evil.example/tx/0x1')).toEqual({ ok: false, code: 'not_our_scan_link' })
  })
})

describe('finding the transaction', () => {
  const tx: TxLike = { logs: [] }
  const fetcherThatHas = (where: string) => async (chain: string) => (chain === where ? tx : null)

  it('tries the selected chain first and stops there', async () => {
    const seen: string[] = []
    const r = await searchTx(HASH, {
      selected: 'base',
      chains: ['ethereum', 'base', 'arbitrum'],
      fetch: async (c) => {
        seen.push(c)
        return c === 'base' ? tx : null
      },
    })
    expect(r.status).toBe('found')
    expect(seen).toEqual(['base'])
  })

  it('falls back to every other chain and says where it was', async () => {
    const r = await searchTx(HASH, { selected: 'base', chains: ['ethereum', 'base', 'arbitrum'], fetch: fetcherThatHas('arbitrum') })
    expect(r).toMatchObject({ status: 'found', chain: 'arbitrum' })
  })

  it('a broken RPC is never reported as "no such transaction"', async () => {
    const r = await searchTx(HASH, {
      selected: 'base',
      chains: ['base', 'ethereum'],
      fetch: async (c) => {
        if (c === 'base') throw new Error('HTTP 429 rate limit exceeded')
        return null
      },
    })
    expect(r.status).toBe('not_found')
    expect(r.failed).toEqual([{ chain: 'base', reason: 'rate_limited' }])
  })

  it('classifies RPC failures apart from each other', () => {
    expect(classifyRpcError(new Error('request timed out'))).toBe('timeout')
    expect(classifyRpcError(new Error('429 Too Many Requests'))).toBe('rate_limited')
    expect(classifyRpcError(new Error('socket hang up'))).toBe('unavailable')
  })

  it('the answer does not depend on which provider answers first', async () => {
    const slowFirst = async (c: string) => {
      if (c === 'ethereum') await new Promise((r) => setTimeout(r, 20))
      return c === 'ethereum' || c === 'arbitrum' ? tx : null
    }
    const r = await searchTx(HASH, { chains: ['ethereum', 'arbitrum'], fetch: slowFirst })
    expect(r).toMatchObject({ status: 'found', chain: 'ethereum' })
  })
})

describe('verdicts', () => {
  const oftSent = (at: Address = OFT) =>
    makeLog(at, lzEventsAbi as Abi, 'OFTSent', { guid: GUID, dstEid: 30101, fromAddress: WALLET, amountSentLD: 10n, amountReceivedLD: 9n })

  it('an OFT send can be bridged, and names the contract and destination', () => {
    const [r] = analyzeTx({ hash: HASH, to: OFT, logs: [oftSent()] }, { chain: 'hyperevm', selected: 'hyperevm' })
    expect(r).toMatchObject({ verdict: 'can_bridge', protocol: 'lz-oft', code: 'lz_oft_send' })
    expect(r?.target).toEqual({ chain: 'hyperevm', address: OFT, kind: 'oft', dstChain: 'ethereum' })
    expect(r?.details.indirect).toBeUndefined()
  })

  it('a transaction on another chain asks to switch, not to give up', () => {
    const [r] = analyzeTx({ hash: HASH, to: OFT, logs: [oftSent()] }, { chain: 'hyperevm', selected: 'base' })
    expect(r?.verdict).toBe('can_bridge')
    expect(r?.action).toEqual({ kind: 'switch_chain', chain: 'hyperevm' })
  })

  it('a bridge through a router is marked as indirect and still resolved', () => {
    const [r] = analyzeTx({ hash: HASH, to: ROUTER, logs: [oftSent()] }, { chain: 'hyperevm' })
    expect(r?.details.indirect).toBe(true)
    expect(r?.details.to).toBe(ROUTER)
    expect(r?.target?.address).toBe(OFT)
  })

  it('a packet without OFTSent stays unknown until the address is probed', () => {
    const packetSent = makeLog(ENDPOINT, lzEventsAbi as Abi, 'PacketSent', {
      encodedPayload: encodePacket({
        version: 1, nonce: 1n, srcEid: 30367, sender: pad(OFT.toLowerCase() as Address, { size: 32 }),
        dstEid: 30101, receiver: pad(ROUTER, { size: 32 }), guid: GUID, message: '0x',
      }),
      options: '0x',
      sendLibrary: ENDPOINT,
    })
    const [r] = analyzeTx({ logs: [packetSent] }, { chain: 'hyperevm' })
    expect(r).toMatchObject({ verdict: 'unknown', code: 'lz_packet_no_oft', protocol: 'lz-oft' })
    expect(r?.target).toMatchObject({ kind: 'lz-oapp', address: OFT.toLowerCase() })
  })

  it('the packet is not reported twice when the OFT send is already there', () => {
    const packetSent = makeLog(ENDPOINT, lzEventsAbi as Abi, 'PacketSent', {
      encodedPayload: encodePacket({
        version: 1, nonce: 1n, srcEid: 30367, sender: pad(OFT.toLowerCase() as Address, { size: 32 }),
        dstEid: 30101, receiver: pad(ROUTER, { size: 32 }), guid: GUID, message: '0x',
      }),
      options: '0x',
      sendLibrary: ENDPOINT,
    })
    const rs = analyzeTx({ logs: [oftSent(), packetSent] }, { chain: 'hyperevm' })
    expect(rs).toHaveLength(1)
    expect(needsChoice(rs)).toBe(false)
  })

  it('two bridges in one transaction become two results to choose from', () => {
    const rs = analyzeTx({ logs: [oftSent(), oftSent(ROUTER)] }, { chain: 'hyperevm' })
    expect(rs).toHaveLength(2)
    expect(needsChoice(rs)).toBe(true)
  })

  it('a protocol we have built hands over to its tab', () => {
    const sent = makeLog(ROUTER, nttTransferSentV1Abi as Abi, 'TransferSent', {
      recipient: pad(WALLET, { size: 32 }), refundAddress: pad(WALLET, { size: 32 }), amount: 7n, fee: 0n, recipientChain: 30, msgSequence: 1n,
    })
    const [r] = analyzeTx({ logs: [sent] }, { chain: 'ethereum' })
    expect(r).toMatchObject({ verdict: 'can_bridge', code: 'switch_protocol', protocol: 'wormhole-ntt' })
    expect(r?.action).toEqual({ kind: 'open_tab', protocol: 'wormhole-ntt' })
    expect(r?.target).toMatchObject({ kind: 'ntt-manager', dstChain: 'base' })
  })

  it('a protocol we will never bridge points at its own app', () => {
    const published = makeLog(getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge), foreignEventsAbi as Abi, 'LogMessagePublished', {
      sender: getAddress(WORMHOLE_CHAINS.ethereum!.tokenBridge!), sequence: 1n, nonce: 0, payload: '0x00', consistencyLevel: 1,
    })
    const [r] = analyzeTx({ logs: [published] }, { chain: 'ethereum' })
    expect(r).toMatchObject({ verdict: 'cannot_bridge', code: 'foreign_protocol', protocol: 'wormhole-portal' })
    expect(r?.action).toEqual({ kind: 'open_url', url: 'https://portalbridge.com/' })
  })

  it('nothing recognised is "unknown" with the raw material, never "cannot bridge"', () => {
    const [r] = analyzeTx({ hash: HASH, to: ROUTER, input: '0x12345678aabb', logs: [{ address: ROUTER, topics: [`0x${'99'.repeat(32)}`], data: '0x' }] }, { chain: 'ethereum' })
    expect(r?.verdict).toBe('unknown')
    expect(r?.code).toBe('unknown')
    expect(r?.details).toMatchObject({ to: ROUTER, selector: '0x12345678', logEmitters: [ROUTER] })
  })
})

describe('a Solana signature, in the same shape as everything else', () => {
  const prefill = {
    oftStore: 'qMNo1RFo11J9ZLGuq7dVmWAssuCZaNsSamk8g2q4UZA',
    programId: 'EfRMrTJWU2CYm52kHmRYozQNdF8RH5aTi3xyeSuLAX2Y',
    dstEid: 30367,
    extraOptions: '0x' as const,
    droppedOptions: [],
    optionsMalformed: false,
    observed: {
      from: '2hCc738iscpDVahFvwjNwUq1WZQ7xRTeitebgWtkkp1h',
      to: pad(WALLET, { size: 32 }),
      amountLD: 1_000000n,
      minAmountLD: 990000n,
      nativeFee: 231_700n,
      hadComposeMsg: false,
      failed: false,
    },
  }

  it('produces the same verdict shape as an EVM send', () => {
    const r = analyzeSvmPrefill(prefill, { signature: SIG, selected: 'solana' })
    expect(r).toMatchObject({ verdict: 'can_bridge', code: 'lz_oft_send', protocol: 'lz-oft' })
    expect(r.target).toEqual({ chain: 'solana', address: prefill.oftStore, kind: 'oft-store', dstChain: 'hyperevm' })
    expect(r.details).toMatchObject({ chain: 'solana', txHash: SIG })
    expect(r.details.fields).toMatchObject({ programId: prefill.programId, dstEid: '30367', amountLD: '1000000' })
  })

  it('offers to switch the network when Solana is not the one selected', () => {
    expect(analyzeSvmPrefill(prefill, { selected: 'base' }).action).toEqual({ kind: 'switch_chain', chain: 'solana' })
    expect(analyzeSvmPrefill(prefill, { selected: 'solana' }).action).toEqual({ kind: 'use_address', chain: 'solana', address: prefill.oftStore })
  })

  it('refuses when the store is owned by another program', () => {
    const r = analyzeSvmPrefill(prefill, { programMismatch: true })
    expect(r).toMatchObject({ verdict: 'cannot_bridge', code: 'lz_oapp_not_oft' })
    expect(r.target).toBeUndefined()
  })

  it('records a destination outside our registry without inventing a name', () => {
    const r = analyzeSvmPrefill({ ...prefill, dstEid: 30324 }, {})
    expect(r.vars['destination']).toBe('30324')
    expect(r.target?.dstChain).toBeUndefined()
  })

  it('keeps a failed sample visible in the raw details', () => {
    const r = analyzeSvmPrefill({ ...prefill, observed: { ...prefill.observed, failed: true } }, {})
    expect(r.details.fields?.['sampleFailed']).toBe('true')
  })
})

describe('an unrecognised bridge never becomes a wrong verdict', () => {
  it('a native bridge we have no address for reads as "could not tell", not as a protocol', () => {
    // Base's L1StandardBridge on Ethereum is a documented TODO in core/analysis/foreign.ts.
    // Until it is confirmed, a transaction through it must fall through to unknown.
    const [r] = analyzeTx(
      { hash: HASH, to: ROUTER, input: '0x3dbb202b', logs: [{ address: ROUTER, topics: [`0x${'77'.repeat(32)}`], data: '0x' }] },
      { chain: 'ethereum' },
    )
    expect(r).toMatchObject({ verdict: 'unknown', code: 'unknown', protocol: null })
    expect(r?.details.logEmitters).toEqual([ROUTER])
  })
})

describe('revert decoding', () => {
  const enc = (errorName: string, args: readonly unknown[]): Hex =>
    encodeErrorResult({ abi: knownErrorsAbi as Abi, errorName, args: args as never })

  it('names LayerZero errors and what they mean', () => {
    expect(decodeRevert(enc('NoPeer', [30101]))).toMatchObject({ kind: 'error', name: 'NoPeer', meaning: 'no_peer' })
    expect(decodeRevert(enc('SlippageExceeded', [100n, 101n]))).toMatchObject({ name: 'SlippageExceeded', meaning: 'slippage' })
    expect(decodeRevert(enc('NotEnoughNative', [1n]))).toMatchObject({ meaning: 'fee_too_low' })
    expect(decodeRevert(enc('LZ_ULN_AtLeastOneDVN', []))).toMatchObject({ meaning: 'config_missing' })
  })

  it('names the token errors that block a send', () => {
    expect(decodeRevert(enc('ERC20InsufficientAllowance', [OFT, 0n, 5n]))).toMatchObject({ meaning: 'needs_approve' })
    expect(decodeRevert(enc('ERC20InsufficientBalance', [WALLET, 1n, 5n]))).toMatchObject({ meaning: 'insufficient_balance' })
    expect(decodeRevert(enc('EnforcedPause', []))).toMatchObject({ meaning: 'paused' })
  })

  it('handles the standard Error(string) and Panic(uint256)', () => {
    const errStr = encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'm' }] }] as const, errorName: 'Error', args: ['ERC20: transfer amount exceeds balance'] })
    expect(decodeRevert(errStr)).toMatchObject({ kind: 'string', message: 'ERC20: transfer amount exceeds balance' })
    const panic = encodeErrorResult({ abi: [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'c' }] }] as const, errorName: 'Panic', args: [0x11n] })
    expect(decodeRevert(panic)).toMatchObject({ kind: 'panic', code: 0x11n })
  })

  it('an unknown selector is shown raw, with a link the user may open', () => {
    const r = decodeRevert('0xdeadbeef')
    expect(r).toMatchObject({ kind: 'unknown', selector: '0xdeadbeef' })
    if (r.kind !== 'unknown') throw new Error('unreachable')
    expect(r.lookupUrl).toBe('https://openchain.xyz/signatures?query=0xdeadbeef')
  })

  it('an empty revert is not mistaken for a decodable one', () => {
    expect(decodeRevert('0x')).toMatchObject({ kind: 'empty' })
    expect(decodeRevert(undefined)).toMatchObject({ kind: 'empty' })
  })

  it('decodes a contract’s own error when its ABI is known', () => {
    const tokenAbi = [{ type: 'error', name: 'TransferBlocked', inputs: [{ type: 'address', name: 'who' }] }] as const satisfies Abi
    const data = encodeErrorResult({ abi: tokenAbi, errorName: 'TransferBlocked', args: [WALLET] })
    expect(decodeRevert(data)).toMatchObject({ kind: 'unknown' })
    expect(decodeRevert(data, tokenAbi as Abi)).toMatchObject({ kind: 'error', name: 'TransferBlocked' })
  })

  it('digs the payload out of a nested client error', () => {
    const data = enc('NoPeer', [30101])
    expect(revertDataFromError({ cause: { cause: { data } } })).toBe(data)
    expect(revertDataFromError({ cause: { data: { data } } })).toBe(data)
    expect(revertDataFromError(new Error('nope'))).toBeUndefined()
    const loop: { cause?: unknown } = {}
    loop.cause = loop
    expect(revertDataFromError(loop)).toBeUndefined()
  })

  it('formats one line for the details block', () => {
    expect(formatRevert(decodeRevert(enc('SlippageExceeded', [100n, 101n])))).toBe('SlippageExceeded(100, 101)')
    expect(formatRevert(decodeRevert('0x'))).toBe('reverted without data')
  })
})
