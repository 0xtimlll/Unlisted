/**
 * Status tab: what became of an NTT transfer, read from the two chains and nothing else.
 *
 * The source transaction's own logs name the message. The Wormhole core bridge — the address from
 * OUR table, never the one a contract claims — logs `LogMessagePublished`, and its payload is the
 * transceiver message the WormholeTransceiver built (TransceiverStructs.encodeTransceiverMessage):
 *
 *   prefix(4) ++ sourceNttManager(32) ++ recipientNttManager(32)
 *   ++ len(2) ++ nttManagerPayload ++ len(2) ++ transceiverPayload
 *
 * The destination manager knows the message by one number only:
 *
 *   digest = keccak256(abi.encodePacked(uint16 sourceChainId, nttManagerPayload))
 *
 * (TransceiverStructs._nttManagerMessageDigest; ManagerBase._recordTransceiverAttestation passes the
 * VAA's emitter chain as sourceChainId). `sourceChainId` here is the Wormhole id of the source chain
 * from our own table, and the bytes are what the chain recorded — so the digest is computed from a
 * number we committed and bytes nobody can edit after the fact. A manager new enough to emit
 * `TransferSent(bytes32 digest)` is checked against it; a v1 manager emits none, and then the
 * computation stands alone.
 *
 * State is then read from the manager the message is addressed to: `isMessageExecuted`, the
 * attestation count against `getThreshold`, and the inbound rate-limit queue (NttManager._handleTransfer
 * marks the digest executed BEFORE it decides whether to queue, so "executed" alone does not mean
 * "paid out"). None of this is a decision about trust — the tab reports, it approves nothing — and
 * none of it is a write. NTT's own `completeInboundQueuedTransfer(digest)` is named so the user knows
 * what releases a queued transfer; it is not offered here.
 */
import { decodeEventLog, encodePacked, getAddress, keccak256, type Address, type Hex } from 'viem'
import { byKey, isEvm, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { FOREIGN_TOPICS, foreignEventsAbi } from '../../core/analysis/foreign'
import { attempt, type Attempt } from '../lz-risk/probe'
import { NTT_PREFIX, NTT_TOPICS, nttManagerAbi, nttStatusAbi, WH_TRANSCEIVER_PAYLOAD_PREFIX } from './abi'
import { chainOfWormholeId, isCoreBridge, wormholeChainId } from './chains'

export type LogLike = { address: string; topics: readonly string[]; data: string }

/** The NativeTokenTransfer inside the manager message (TransceiverStructs.parseNativeTokenTransfer). */
export type NttWireTransfer = {
  /** Trimmed amount: a u64 in `decimals` decimals. */
  amount: bigint
  decimals: number
  sourceToken: Hex
  to: Hex
  toChain: number
}

/** One NTT transfer found in a transaction, with everything needed to ask the destination about it. */
export type FoundNttTransfer = {
  srcChain: ChainKey
  dstChain: ChainKey | undefined
  srcWormholeChainId: number
  dstWormholeChainId: number
  /** The transceiver that published the Wormhole message (`LogMessagePublished.sender`). */
  transceiver: Address
  /** The Wormhole sequence the core bridge assigned. */
  sequence: bigint
  /** bytes32 as published; the EVM address when the upper 12 bytes are zero. */
  srcManagerRaw: Hex
  srcManager: Address | undefined
  dstManagerRaw: Hex
  dstManager: Address | undefined
  /** The NttManagerMessage bytes, exactly as the destination will hash them. */
  nttManagerPayload: Hex
  /** NttManagerMessage.id — the manager's own sequence, as bytes32. */
  id: Hex
  transfer: NttWireTransfer | undefined
  digest: Hex
  /**
   * true/false when the source manager emitted `TransferSent(bytes32 digest)` and it does / does not
   * name this digest; undefined when it emitted none (v1 managers), so nothing could be compared.
   */
  digestConfirmed: boolean | undefined
}

const ZERO12 = '0'.repeat(24)
const b32ToAddress = (b: Hex): Address | undefined => {
  const h = b.slice(2).toLowerCase()
  if (h.length !== 64 || h.slice(0, 24) !== ZERO12) return undefined
  try {
    return getAddress(`0x${h.slice(24)}`)
  } catch {
    return undefined
  }
}

/** A cursor over hex bytes; every read is bounds-checked and a short buffer throws. */
class Reader {
  private at = 0
  constructor(private readonly hex: string) {}
  take(bytes: number): string {
    const end = this.at + bytes * 2
    if (end > this.hex.length) throw new Error('short')
    const out = this.hex.slice(this.at, end)
    this.at = end
    return out
  }
  u(bytes: number): bigint {
    return BigInt(`0x${this.take(bytes)}`)
  }
  get remaining(): number {
    return (this.hex.length - this.at) / 2
  }
  get done(): boolean {
    return this.at === this.hex.length
  }
}

/** TransceiverStructs.parseTransceiverMessage, for the Wormhole transceiver's prefix. */
export function parseTransceiverMessage(payload: Hex): { srcManagerRaw: Hex; dstManagerRaw: Hex; nttManagerPayload: Hex; transceiverPayload: Hex } | undefined {
  try {
    const r = new Reader(payload.slice(2).toLowerCase())
    if (`0x${r.take(4)}` !== WH_TRANSCEIVER_PAYLOAD_PREFIX) return undefined
    const srcManagerRaw = `0x${r.take(32)}` as Hex
    const dstManagerRaw = `0x${r.take(32)}` as Hex
    const nttManagerPayload = `0x${r.take(Number(r.u(2)))}` as Hex
    const transceiverPayload = `0x${r.take(Number(r.u(2)))}` as Hex
    if (!r.done) return undefined
    return { srcManagerRaw, dstManagerRaw, nttManagerPayload, transceiverPayload }
  } catch {
    return undefined
  }
}

/** TransceiverStructs.parseNttManagerMessage + parseNativeTokenTransfer. */
export function parseNttManagerMessage(encoded: Hex): { id: Hex; sender: Hex; transfer: NttWireTransfer | undefined } | undefined {
  try {
    const r = new Reader(encoded.slice(2).toLowerCase())
    const id = `0x${r.take(32)}` as Hex
    const sender = `0x${r.take(32)}` as Hex
    const payload = r.take(Number(r.u(2)))
    if (!r.done) return undefined
    return { id, sender, transfer: parseNativeTokenTransfer(`0x${payload}`) }
  } catch {
    return undefined
  }
}

function parseNativeTokenTransfer(payload: Hex): NttWireTransfer | undefined {
  try {
    const r = new Reader(payload.slice(2).toLowerCase())
    if (`0x${r.take(4)}` !== NTT_PREFIX) return undefined
    // decimals before amount: "parsed in reverse order compared to how they are declared" (the contract's own note).
    const decimals = Number(r.u(1))
    const amount = r.u(8)
    const sourceToken = `0x${r.take(32)}` as Hex
    const to = `0x${r.take(32)}` as Hex
    const toChain = Number(r.u(2))
    // An additional payload is optional, length-prefixed when present.
    if (r.remaining >= 2) r.take(Number(r.u(2)))
    if (!r.done) return undefined
    return { amount, decimals, sourceToken, to, toChain }
  } catch {
    return undefined
  }
}

/** The number the destination manager stores the message under. */
export function nttDigest(srcWormholeChainId: number, nttManagerPayload: Hex): Hex {
  return keccak256(encodePacked(['uint16', 'bytes'], [srcWormholeChainId, nttManagerPayload]))
}

/**
 * Every NTT transfer in one transaction's logs.
 *
 * Only the committed core bridge's logs count: any contract can emit `LogMessagePublished` with a
 * payload of its choosing, and only the real core bridge's log is a message the guardians will sign.
 * A core-bridge log whose payload is not a Wormhole-transceiver message (Portal, a plain Wormhole
 * app) is simply not an NTT transfer.
 */
export function findNttTransfers(logs: readonly LogLike[], srcChain: ChainKey): FoundNttTransfer[] {
  const out: FoundNttTransfer[] = []
  const srcWh = wormholeChainId(srcChain)
  if (srcWh === undefined || !isEvm(byKey(srcChain))) return out

  // Digests the source manager itself announced (v2+ managers emit TransferSent(bytes32 digest)).
  const announced = new Set<string>()
  for (const log of logs) {
    if ((log.topics[0] ?? '').toLowerCase() === NTT_TOPICS.TransferSentDigest.toLowerCase() && log.topics[1]) {
      announced.add(log.topics[1].toLowerCase())
    }
  }

  for (const log of logs) {
    if ((log.topics[0] ?? '').toLowerCase() !== FOREIGN_TOPICS.LogMessagePublished.toLowerCase()) continue
    if (!isCoreBridge(srcChain, log.address)) continue
    let decoded
    try {
      decoded = decodeEventLog({ abi: foreignEventsAbi, eventName: 'LogMessagePublished', data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
    } catch {
      continue
    }
    const tm = parseTransceiverMessage(decoded.args.payload)
    if (!tm) continue
    const mm = parseNttManagerMessage(tm.nttManagerPayload)
    if (!mm) continue
    const digest = nttDigest(srcWh, tm.nttManagerPayload)
    const dstWh = mm.transfer?.toChain
    if (dstWh === undefined) continue
    const dstChain = chainOfWormholeId(dstWh)
    out.push({
      srcChain,
      dstChain,
      srcWormholeChainId: srcWh,
      dstWormholeChainId: dstWh,
      transceiver: getAddress(decoded.args.sender),
      sequence: decoded.args.sequence,
      srcManagerRaw: tm.srcManagerRaw,
      srcManager: b32ToAddress(tm.srcManagerRaw),
      dstManagerRaw: tm.dstManagerRaw,
      dstManager: b32ToAddress(tm.dstManagerRaw),
      nttManagerPayload: tm.nttManagerPayload,
      id: mm.id,
      transfer: mm.transfer,
      digest,
      digestConfirmed: announced.size === 0 ? undefined : announced.has(digest.toLowerCase()),
    })
  }
  return out
}

/** What the destination manager says. Each state names what, if anything, finishes it. */
export type NttMessageState =
  /** Executed and paid out (TransferRedeemed). */
  | { kind: 'delivered' }
  /** Executed, but the inbound rate limit queued the amount; released by completeInboundQueuedTransfer. */
  | { kind: 'queued'; recipient: Address; queuedAt: number; releaseAt: number | undefined }
  /** Enough transceivers have attested, nobody has executed — a transient state, or a paused manager. */
  | { kind: 'attested_not_executed'; attestations: number; threshold: number }
  /** Not yet attested to the threshold: the VAA is still on its way, or nobody has relayed it. */
  | { kind: 'in_flight'; attestations: number | undefined; threshold: number | undefined }
  | { kind: 'unknown'; reason: string }

export type NttDiagnosis = {
  transfer: FoundNttTransfer
  state: NttMessageState
  /**
   * Whether the destination manager names the source manager as its peer for the source chain —
   * NttManager.executeMsg refuses a message from any other. undefined when the read failed.
   */
  peerOk: boolean | undefined
}

const reasonOf = (reads: Attempt<unknown>[], fallback: string): string => {
  const failed = reads.find((r) => !r.ok)
  return failed && !failed.ok ? failed.reason : fallback
}

/**
 * Reads the destination's own state for one transfer. Every read may fail into `unknown` with its
 * reason — a state nobody could read is reported as such, never guessed.
 */
export async function diagnoseNtt(t: FoundNttTransfer, dstClient: ReadClient): Promise<NttDiagnosis> {
  const dst = t.dstChain ? byKey(t.dstChain) : undefined
  if (!dst || !isEvm(dst)) {
    return { transfer: t, state: { kind: 'unknown', reason: 'the destination is not an EVM chain this app serves' }, peerOk: undefined }
  }
  if (!t.dstManager) {
    return { transfer: t, state: { kind: 'unknown', reason: 'the message is addressed to a manager that is not an EVM address' }, peerOk: undefined }
  }
  const manager = t.dstManager
  const status = { address: manager, abi: nttStatusAbi } as const

  const [executed, attestations, threshold, queued, duration, peer] = await Promise.all([
    attempt(dstClient.readContract({ ...status, functionName: 'isMessageExecuted', args: [t.digest] }), undefined, 'isMessageExecuted'),
    attempt(dstClient.readContract({ ...status, functionName: 'messageAttestations', args: [t.digest] }), undefined, 'messageAttestations'),
    attempt(dstClient.readContract({ address: manager, abi: nttManagerAbi, functionName: 'getThreshold' }), undefined, 'getThreshold'),
    attempt(dstClient.readContract({ ...status, functionName: 'getInboundQueuedTransfer', args: [t.digest] }), undefined, 'getInboundQueuedTransfer'),
    attempt(dstClient.readContract({ ...status, functionName: 'rateLimitDuration' }), undefined, 'rateLimitDuration'),
    attempt(dstClient.readContract({ address: manager, abi: nttManagerAbi, functionName: 'getPeer', args: [t.srcWormholeChainId] }), undefined, 'getPeer'),
  ])

  const peerOk = peer.ok ? peer.value.peerAddress.toLowerCase() === t.srcManagerRaw.toLowerCase() : undefined

  if (!executed.ok) {
    return { transfer: t, state: { kind: 'unknown', reason: executed.reason }, peerOk }
  }

  if (executed.value) {
    // Executed means the digest was consumed; the queue says whether the tokens actually moved.
    if (queued.ok && queued.value.txTimestamp !== 0n) {
      const queuedAt = Number(queued.value.txTimestamp)
      return {
        transfer: t,
        state: {
          kind: 'queued',
          recipient: getAddress(queued.value.recipient),
          queuedAt,
          releaseAt: duration.ok ? queuedAt + Number(duration.value) : undefined,
        },
        peerOk,
      }
    }
    return { transfer: t, state: { kind: 'delivered' }, peerOk }
  }

  const count = attestations.ok ? Number(attestations.value) : undefined
  const need = threshold.ok ? Number(threshold.value) : undefined
  if (count !== undefined && need !== undefined && need > 0 && count >= need) {
    return { transfer: t, state: { kind: 'attested_not_executed', attestations: count, threshold: need }, peerOk }
  }
  if (count !== undefined || need !== undefined) {
    return { transfer: t, state: { kind: 'in_flight', attestations: count, threshold: need }, peerOk }
  }
  return { transfer: t, state: { kind: 'unknown', reason: reasonOf([attestations, threshold], 'the destination did not answer') }, peerOk }
}

export type NttStatusLookup = {
  reports: NttDiagnosis[]
  /** Transfers whose destination this app does not serve, kept so the tab can say so. */
  unserved: FoundNttTransfer[]
}

/** The tab's whole NTT work: find, then ask each destination. `dstClientFor` honours the user's RPC. */
export async function lookupNttStatus(
  logs: readonly LogLike[],
  srcChain: ChainKey,
  dstClientFor: (chain: ChainKey) => ReadClient | undefined,
): Promise<NttStatusLookup> {
  const found = findNttTransfers(logs, srcChain)
  const reports: NttDiagnosis[] = []
  const unserved: FoundNttTransfer[] = []
  for (const t of found) {
    const client = t.dstChain ? dstClientFor(t.dstChain) : undefined
    if (!client) {
      unserved.push(t)
      continue
    }
    reports.push(await diagnoseNtt(t, client))
  }
  return { reports, unserved }
}
