/**
 * Status tab, NTT side.
 *
 * The transceiver message is assembled here byte by byte from the contracts' own wire format
 * (TransceiverStructs.encodeTransceiverMessage / encodeNttManagerMessage / the NativeTokenTransfer
 * layout), and the digest the destination manager stores it under is recomputed the way
 * `_nttManagerMessageDigest` does. Two rules get the most attention: only the committed core bridge's
 * log counts, and "executed" is not "paid out" until the inbound queue has been read.
 */
import { describe, expect, it } from 'vitest'
import { encodePacked, getAddress, keccak256, pad, toHex, type Abi, type Address, type Hex } from 'viem'
import type { ReadClient } from '@/core/client'
import { foreignEventsAbi } from '@/core/analysis/foreign'
import { nttTransferSentDigestAbi, NTT_PREFIX, WH_TRANSCEIVER_PAYLOAD_PREFIX } from '@/protocols/wormhole-ntt/abi'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'
import { diagnoseNtt, findNttTransfers, lookupNttStatus, nttDigest, parseNttManagerMessage, parseTransceiverMessage } from '@/protocols/wormhole-ntt/status'
import { makeLog } from './logs'

const ETH_CORE = getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge)
const SRC_MANAGER = getAddress('0x7926d63feb9b950908b297cc995b6853bca21847')
const DST_MANAGER = getAddress('0xbc51f76178a56811fdfe95d3897e6ac2b11dbb62')
const TRANSCEIVER = getAddress('0x6c55f346c20ca2b0c62e30790907f0a41c978ccc')
const TOKEN = getAddress('0x88909d489678dd17aa6d9609f89b0419bf78fd9a')
const WALLET = getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9')
const ETH_WH = 2
const BSC_WH = 4

/** bytes32 as the parser returns it: lower-case, the checksum being a property of addresses, not bytes. */
const b32 = (a: Address): Hex => pad(a, { size: 32 }).toLowerCase() as Hex
const u = (v: bigint | number, bytes: number): Hex => toHex(BigInt(v), { size: bytes })
const cat = (...parts: Hex[]): Hex => `0x${parts.map((p) => p.slice(2)).join('')}`

/** NativeTokenTransfer: NTT_PREFIX ++ decimals(1) ++ amount(8) ++ sourceToken(32) ++ to(32) ++ toChain(2) [++ len(2) ++ extra]. */
function nativeTokenTransfer(p: { amount: bigint; decimals: number; toChain: number; extra?: Hex }): Hex {
  const base = cat(NTT_PREFIX, u(p.decimals, 1), u(p.amount, 8), b32(TOKEN), b32(WALLET), u(p.toChain, 2))
  return p.extra ? cat(base, u(p.extra.length / 2 - 1, 2), p.extra) : base
}

/** NttManagerMessage: id(32) ++ sender(32) ++ len(2) ++ payload. */
function managerMessage(seq: bigint, payload: Hex): Hex {
  return cat(u(seq, 32), b32(WALLET), u(payload.length / 2 - 1, 2), payload)
}

/** TransceiverMessage: prefix ++ srcManager(32) ++ dstManager(32) ++ len(2) ++ managerMessage ++ len(2) ++ transceiverPayload. */
function transceiverMessage(managerMsg: Hex, p: { src?: Address; dst?: Address; prefix?: Hex } = {}): Hex {
  return cat(p.prefix ?? WH_TRANSCEIVER_PAYLOAD_PREFIX, b32(p.src ?? SRC_MANAGER), b32(p.dst ?? DST_MANAGER), u(managerMsg.length / 2 - 1, 2), managerMsg, u(0, 2))
}

function published(payload: Hex, p: { from?: Address; sender?: Address; sequence?: bigint } = {}) {
  return makeLog(p.from ?? ETH_CORE, foreignEventsAbi as Abi, 'LogMessagePublished', {
    sender: p.sender ?? TRANSCEIVER,
    sequence: p.sequence ?? 3479n,
    nonce: 0,
    payload,
    consistencyLevel: 202,
  })
}

const announced = (digest: Hex) => makeLog(SRC_MANAGER, nttTransferSentDigestAbi as Abi, 'TransferSent', { digest })

const PAYLOAD = nativeTokenTransfer({ amount: 123_456_789n, decimals: 8, toChain: BSC_WH })
const MANAGER_MSG = managerMessage(17n, PAYLOAD)
const WIRE = transceiverMessage(MANAGER_MSG)
const DIGEST = keccak256(encodePacked(['uint16', 'bytes'], [ETH_WH, MANAGER_MSG]))

/** Answers each read by function name; a thrown value is a failed read. Unlisted reads fail. */
type Answers = Record<string, unknown>
function fakeClient(answers: Answers): ReadClient {
  return {
    readContract: async (p: { functionName: string; args?: unknown[] }) => {
      if (!(p.functionName in answers)) throw new Error(`no answer for ${p.functionName}`)
      const v = answers[p.functionName]
      if (v instanceof Error) throw v
      return typeof v === 'function' ? (v as (args: unknown[] | undefined) => unknown)(p.args) : v
    },
  } as unknown as ReadClient
}

const healthy = (over: Answers = {}): Answers => ({
  isMessageExecuted: false,
  messageAttestations: 0,
  getThreshold: 1,
  getInboundQueuedTransfer: { amount: 0n, txTimestamp: 0n, recipient: `0x${'0'.repeat(40)}` },
  rateLimitDuration: 86_400n,
  getPeer: { peerAddress: b32(SRC_MANAGER), tokenDecimals: 8 },
  ...over,
})

describe('the wire format is read the way the contracts write it', () => {
  it('parses the transceiver message and the manager message inside it', () => {
    const tm = parseTransceiverMessage(WIRE)
    expect(tm).toMatchObject({ srcManagerRaw: b32(SRC_MANAGER), dstManagerRaw: b32(DST_MANAGER), nttManagerPayload: MANAGER_MSG, transceiverPayload: '0x' })
    const mm = parseNttManagerMessage(MANAGER_MSG)
    expect(mm?.id).toBe(u(17n, 32))
    expect(mm?.transfer).toEqual({ amount: 123_456_789n, decimals: 8, sourceToken: b32(TOKEN), to: b32(WALLET), toChain: BSC_WH })
  })

  it('accepts the optional additional payload a v2 manager may append', () => {
    const withExtra = managerMessage(1n, nativeTokenTransfer({ amount: 5n, decimals: 6, toChain: BSC_WH, extra: '0xdeadbeef' }))
    expect(parseNttManagerMessage(withExtra)?.transfer?.toChain).toBe(BSC_WH)
  })

  it('refuses a wrong prefix, a short buffer and trailing bytes', () => {
    expect(parseTransceiverMessage(transceiverMessage(MANAGER_MSG, { prefix: '0x9c23bd3b' }))).toBeUndefined()
    expect(parseTransceiverMessage(WIRE.slice(0, -8) as Hex)).toBeUndefined()
    expect(parseTransceiverMessage(`${WIRE}00` as Hex)).toBeUndefined()
    expect(parseNttManagerMessage(managerMessage(1n, cat('0x11223344', u(0, 1))))?.transfer).toBeUndefined()
  })

  it('computes the digest exactly as _nttManagerMessageDigest does', () => {
    expect(nttDigest(ETH_WH, MANAGER_MSG)).toBe(DIGEST)
    // The chain id is a uint16 in the packed encoding, not a word.
    expect(nttDigest(ETH_WH, MANAGER_MSG)).toBe(keccak256(`0x0002${MANAGER_MSG.slice(2)}`))
  })
})

describe('finding NTT transfers in a transaction', () => {
  it('reads the transfer from the committed core bridge’s log', () => {
    const found = findNttTransfers([published(WIRE)], 'ethereum')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      srcChain: 'ethereum',
      dstChain: 'bsc',
      srcWormholeChainId: ETH_WH,
      dstWormholeChainId: BSC_WH,
      transceiver: TRANSCEIVER,
      sequence: 3479n,
      srcManager: SRC_MANAGER,
      dstManager: DST_MANAGER,
      digest: DIGEST,
      digestConfirmed: undefined,
    })
  })

  it('ignores the same log from any other address', () => {
    expect(findNttTransfers([published(WIRE, { from: SRC_MANAGER })], 'ethereum')).toHaveLength(0)
  })

  it('ignores a core-bridge message that is not a transceiver message (Portal, a plain app)', () => {
    expect(findNttTransfers([published(cat('0x01', b32(WALLET)))], 'ethereum')).toHaveLength(0)
  })

  it('checks the digest against the one the source manager announced, when it announced one', () => {
    expect(findNttTransfers([announced(DIGEST), published(WIRE)], 'ethereum')[0]?.digestConfirmed).toBe(true)
    expect(findNttTransfers([announced(`0x${'ff'.repeat(32)}`), published(WIRE)], 'ethereum')[0]?.digestConfirmed).toBe(false)
  })

  it('a destination Wormhole does not serve is kept, with no chain', () => {
    const wire = transceiverMessage(managerMessage(1n, nativeTokenTransfer({ amount: 1n, decimals: 6, toChain: 65000 })))
    expect(findNttTransfers([published(wire)], 'ethereum')[0]).toMatchObject({ dstChain: undefined, dstWormholeChainId: 65000 })
  })

  it('a manager that is not an EVM address is kept raw', () => {
    const solanaLike = `0x${'ab'.repeat(32)}` as Hex
    const wire = cat(WH_TRANSCEIVER_PAYLOAD_PREFIX, b32(SRC_MANAGER), solanaLike, u(MANAGER_MSG.length / 2 - 1, 2), MANAGER_MSG, u(0, 2))
    expect(findNttTransfers([published(wire)], 'ethereum')[0]).toMatchObject({ dstManager: undefined, dstManagerRaw: solanaLike })
  })

  it('finds nothing on a chain Wormhole does not serve', () => {
    expect(findNttTransfers([published(WIRE)], 'scroll')).toHaveLength(0)
  })
})

describe('what the destination manager says', () => {
  const found = () => findNttTransfers([published(WIRE)], 'ethereum')[0]!

  it('executed with an empty queue is delivered', async () => {
    const d = await diagnoseNtt(found(), fakeClient(healthy({ isMessageExecuted: true })))
    expect(d.state).toEqual({ kind: 'delivered' })
    expect(d.peerOk).toBe(true)
  })

  it('executed with a queued entry is held by the rate limit, with the release time', async () => {
    const d = await diagnoseNtt(
      found(),
      fakeClient(healthy({ isMessageExecuted: true, getInboundQueuedTransfer: { amount: 1n, txTimestamp: 1_700_000_000n, recipient: WALLET } })),
    )
    expect(d.state).toEqual({ kind: 'queued', recipient: WALLET, queuedAt: 1_700_000_000, releaseAt: 1_700_086_400 })
  })

  it('the release time is left out when the duration could not be read', async () => {
    const d = await diagnoseNtt(
      found(),
      fakeClient(healthy({ isMessageExecuted: true, getInboundQueuedTransfer: { amount: 1n, txTimestamp: 1_700_000_000n, recipient: WALLET }, rateLimitDuration: new Error('down') })),
    )
    expect(d.state).toMatchObject({ kind: 'queued', releaseAt: undefined })
  })

  it('attested to the threshold but not executed', async () => {
    const d = await diagnoseNtt(found(), fakeClient(healthy({ messageAttestations: 2, getThreshold: 2 })))
    expect(d.state).toEqual({ kind: 'attested_not_executed', attestations: 2, threshold: 2 })
  })

  it('below the threshold is in flight, with the count', async () => {
    const d = await diagnoseNtt(found(), fakeClient(healthy({ messageAttestations: 1, getThreshold: 2 })))
    expect(d.state).toEqual({ kind: 'in_flight', attestations: 1, threshold: 2 })
  })

  it('a destination that does not name the source manager as its peer is flagged', async () => {
    const d = await diagnoseNtt(found(), fakeClient(healthy({ getPeer: { peerAddress: b32(WALLET), tokenDecimals: 8 } })))
    expect(d.peerOk).toBe(false)
    const unread = await diagnoseNtt(found(), fakeClient(healthy({ getPeer: new Error('down') })))
    expect(unread.peerOk).toBeUndefined()
  })

  it('an unreadable executed flag is unknown, with the reason — never a guess', async () => {
    const d = await diagnoseNtt(found(), fakeClient(healthy({ isMessageExecuted: new Error('rpc timeout') })))
    expect(d.state).toMatchObject({ kind: 'unknown' })
    expect((d.state as { reason: string }).reason).toContain('rpc timeout')
  })

  it('a destination this app does not serve, or a non-EVM manager, is unknown', async () => {
    const far = findNttTransfers([published(transceiverMessage(managerMessage(1n, nativeTokenTransfer({ amount: 1n, decimals: 6, toChain: 65000 }))))], 'ethereum')[0]!
    expect((await diagnoseNtt(far, fakeClient(healthy()))).state.kind).toBe('unknown')
  })

  it('lookupNttStatus separates served from unserved destinations', async () => {
    const far = transceiverMessage(managerMessage(1n, nativeTokenTransfer({ amount: 1n, decimals: 6, toChain: 65000 })))
    const r = await lookupNttStatus([published(WIRE), published(far)], 'ethereum', (c) => (c === 'bsc' ? fakeClient(healthy({ isMessageExecuted: true })) : undefined))
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]?.state.kind).toBe('delivered')
    expect(r.unserved).toHaveLength(1)
  })
})
