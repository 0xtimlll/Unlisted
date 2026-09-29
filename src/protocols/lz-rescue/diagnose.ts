/**
 * §5: what happened to this message, read from the chains and nothing else.
 *
 * Input is a transaction hash and the chain it is on. Everything after that comes from the source
 * transaction's own logs and the destination's own state — LayerZero Scan is never consulted here,
 * because a rescue submits a payload and a payload that came from an API is a payload someone else
 * chose. The v1 packet is taken from `UltraLightNodeV2.Packet`, the V2 packet from
 * `EndpointV2.PacketSent`, and in both cases the bytes are what the source chain recorded.
 *
 * The diagnosis never decides that an action is safe. It reports a state; actions.ts is what checks
 * the payload against the destination's own hash and builds a call, and it refuses on its own terms.
 */
import { getAddress, keccak256, type Address, type Hex } from 'viem'
import { byEid, byKey, isEvm, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { decodePacket, PacketError, type LzPacket } from '../../core/lz/packet'
import { LZ_TOPICS } from '../../core/lz/events'
import { hasDangerousOptions } from '../../core/options'
import { lzV1, byV1ChainId } from '../lz-v1/chains'
import { judgeAdapterParams } from '../lz-v1/adapterParams'
import { endpointV1RescueAbi, endpointV2RescueAbi, lzAppRescueAbi, receiveUlnRescueAbi, ulnRescueAbi } from './abi'
import { attempt, type Attempt } from '../lz-risk/probe'
import { decodeEventLog, encodeEventTopics } from 'viem'

/** One LayerZero message found in a transaction, with the bytes needed to act on it. */
export type FoundMessage =
  | {
      version: 'v1'
      srcChain: ChainKey
      dstChain: ChainKey | undefined
      srcV1ChainId: number
      dstV1ChainId: number
      /** The sending OApp on the source. */
      srcOApp: Address
      /** The receiving OApp on the destination — read from the packet, never from a list. */
      dstOApp: Address
      nonce: bigint
      /** `abi.encodePacked(srcOApp, dstOApp)` — the key the destination endpoint stores under. */
      path: Hex
      /** The app-level payload, exactly as the destination will receive it. */
      payload: Hex
      /** The relayer params the source paid for, when the transaction published them. */
      adapterParams: Hex | undefined
    }
  | {
      version: 'v2'
      srcChain: ChainKey
      dstChain: ChainKey | undefined
      packet: LzPacket
      /** The receiving OApp, when the packet's receiver is EVM-shaped. */
      dstOApp: Address | undefined
      /** bytes[0:81] of the encoded packet. */
      header: Hex
      /** `guid ++ message` — what the endpoint hashes. */
      payload: Hex
      payloadHash: Hex
      /** The executor options the source paid for. */
      options: Hex
    }

const PACKET_V1_TOPIC = encodeEventTopics({ abi: ulnRescueAbi, eventName: 'Packet' })[0]
const RELAYER_PARAMS_TOPIC = encodeEventTopics({ abi: ulnRescueAbi, eventName: 'RelayerParams' })[0]

export type LogLike = { address: string; topics: readonly string[]; data: string }

/** v1 packet layout, from UltraLightNodeV2.send: nonce(8) srcChainId(2) ua(20) dstChainId(2) dst(20) payload. */
const V1_MIN_BYTES = 8 + 2 + 20 + 2 + 20

function decodeV1Packet(payload: Hex): Omit<Extract<FoundMessage, { version: 'v1' }>, 'srcChain' | 'dstChain' | 'adapterParams'> | undefined {
  const h = payload.slice(2).toLowerCase()
  if (h.length < V1_MIN_BYTES * 2) return undefined
  const at = (from: number, to: number) => h.slice(from * 2, to * 2)
  let srcOApp: Address
  let dstOApp: Address
  try {
    srcOApp = getAddress(`0x${at(10, 30)}`)
    dstOApp = getAddress(`0x${at(32, 52)}`)
  } catch {
    return undefined
  }
  return {
    version: 'v1',
    srcV1ChainId: Number(BigInt(`0x${at(8, 10)}`)),
    dstV1ChainId: Number(BigInt(`0x${at(30, 32)}`)),
    srcOApp,
    dstOApp,
    nonce: BigInt(`0x${at(0, 8)}`),
    path: `0x${at(10, 30)}${at(32, 52)}` as Hex,
    payload: `0x${h.slice(V1_MIN_BYTES * 2)}` as Hex,
  }
}

/**
 * Every LayerZero message in one transaction's logs.
 *
 * Both versions are looked for, because the tab takes a hash without being told which protocol it
 * belongs to — and a transaction can legitimately contain more than one message.
 */
export function findMessages(logs: readonly LogLike[], srcChain: ChainKey): FoundMessage[] {
  const out: FoundMessage[] = []
  // The adapter params belong to the v1 packet emitted alongside them in the same transaction.
  let adapterParams: Hex | undefined
  for (const log of logs) {
    const t0 = (log.topics[0] ?? '').toLowerCase()
    if (t0 === RELAYER_PARAMS_TOPIC.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: ulnRescueAbi, eventName: 'RelayerParams', data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
        adapterParams = d.args.adapterParams
      } catch {
        /* an unreadable params blob is simply not reported */
      }
    }
  }
  for (const log of logs) {
    const t0 = (log.topics[0] ?? '').toLowerCase()

    if (t0 === PACKET_V1_TOPIC.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: ulnRescueAbi, eventName: 'Packet', data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
        const p = decodeV1Packet(d.args.payload)
        if (p) {
          const dst = byV1ChainId(p.dstV1ChainId)
          out.push({ ...p, srcChain, dstChain: dst?.key, ...(adapterParams ? { adapterParams } : { adapterParams: undefined }) })
        }
      } catch {
        /* not a packet we can read */
      }
      continue
    }

    if (t0 === LZ_TOPICS.PacketSent.toLowerCase()) {
      try {
        const d = decodeEventLog({
          abi: endpointV2RescueAbi,
          eventName: 'PacketSent',
          data: log.data as Hex,
          topics: log.topics as [Hex, ...Hex[]],
        })
        const packet = decodePacket(d.args.encodedPayload)
        const encoded = d.args.encodedPayload.slice(2)
        const header = `0x${encoded.slice(0, 81 * 2)}` as Hex
        const payload = `0x${encoded.slice(81 * 2)}` as Hex
        const receiverHex = packet.receiver.slice(2)
        const dstOApp = receiverHex.slice(0, 24) === '0'.repeat(24) ? getAddress(`0x${receiverHex.slice(24)}`) : undefined
        out.push({
          version: 'v2',
          srcChain,
          dstChain: byEid(packet.dstEid)?.key,
          packet,
          dstOApp,
          header,
          payload,
          payloadHash: keccak256(payload),
          options: d.args.options,
        })
      } catch (e) {
        if (!(e instanceof PacketError)) throw e
      }
    }
  }
  return out
}

/** What the destination says about a message. Each one names what could be done about it. */
export type MessageState =
  | { kind: 'delivered'; note: string }
  /** Sent, verified by nobody yet. Nothing to do but wait. */
  | { kind: 'in_flight'; note: string }
  /** v2: the DVNs have signed but nobody has committed it to the endpoint. */
  | { kind: 'verified_not_committed' }
  /** v2: the endpoint holds the payload hash and will execute it. */
  | { kind: 'committed_not_executed' }
  /** v1: the endpoint parked the payload because delivery reverted. */
  | { kind: 'stored_payload'; payloadHash: Hex; storedFor: Address }
  /** v1: the app caught the failure and stored it under its own key. */
  | { kind: 'failed_message'; payloadHash: Hex }
  /** Read but not understood, or the reads could not be made. */
  | { kind: 'unknown'; reason: string }

export type Diagnosis = {
  message: FoundMessage
  state: MessageState
  /**
   * The message was paid for with a native drop on the destination. §5 refuses to execute such a
   * message: this app submits with `msg.value` 0, so the drop would not happen and the recipient
   * would be short exactly the native coin the sender paid for.
   */
  needsNativeDrop: boolean
  /** The destination chain's committed endpoint, when the destination is one this app serves. */
  dstEndpoint: Address | undefined
}

/** True when this message's paid-for options include a native drop on the destination. */
export function messageNeedsNativeDrop(m: FoundMessage): boolean {
  if (m.version === 'v2') {
    const dstVm = m.dstChain ? byKey(m.dstChain).vm : 'evm'
    return hasDangerousOptions(m.options, dstVm)
  }
  if (!m.adapterParams) return false
  const v = judgeAdapterParams(m.adapterParams)
  return v.kind === 'refused' && v.reason === 'native_drop'
}

/**
 * Reads the destination's own state for one message.
 *
 * Every read is allowed to fail into `unknown` with its reason: §5's actions all hash a payload
 * against a value read here, so a state nobody could read produces no button rather than a guess.
 */
export async function diagnose(m: FoundMessage, dstClient: ReadClient): Promise<Diagnosis> {
  const needsNativeDrop = messageNeedsNativeDrop(m)
  const dst = m.dstChain ? byKey(m.dstChain) : undefined
  if (!dst || !isEvm(dst)) {
    return { message: m, state: { kind: 'unknown', reason: 'the destination is not an EVM chain this app serves' }, needsNativeDrop, dstEndpoint: undefined }
  }

  if (m.version === 'v1') {
    const v1 = lzV1(m.dstChain!)
    if (!v1) {
      return { message: m, state: { kind: 'unknown', reason: 'no Endpoint V1 is known for the destination' }, needsNativeDrop, dstEndpoint: undefined }
    }
    const [stored, failed, inbound] = await Promise.all([
      attempt(
        dstClient.readContract({ address: v1.endpoint, abi: endpointV1RescueAbi, functionName: 'storedPayload', args: [m.srcV1ChainId, m.path] }),
        undefined,
        'storedPayload',
      ),
      attempt(
        dstClient.readContract({ address: m.dstOApp, abi: lzAppRescueAbi, functionName: 'failedMessages', args: [m.srcV1ChainId, m.path, m.nonce] }),
        undefined,
        'failedMessages',
      ),
      attempt(
        dstClient.readContract({ address: v1.endpoint, abi: endpointV1RescueAbi, functionName: 'getInboundNonce', args: [m.srcV1ChainId, m.path] }),
        undefined,
        'inbound nonce',
      ),
    ])

    // Order matters: a stored payload blocks the whole path, so it is the first thing to say.
    if (stored.ok && stored.value[2] !== ZERO_HASH) {
      return {
        message: m,
        state: { kind: 'stored_payload', payloadHash: stored.value[2], storedFor: getAddress(stored.value[1]) },
        needsNativeDrop,
        dstEndpoint: v1.endpoint,
      }
    }
    if (failed.ok && failed.value !== ZERO_HASH) {
      return { message: m, state: { kind: 'failed_message', payloadHash: failed.value }, needsNativeDrop, dstEndpoint: v1.endpoint }
    }
    if (inbound.ok) {
      return inbound.value >= m.nonce
        ? {
            message: m,
            state: { kind: 'delivered', note: `the destination has taken nonce ${inbound.value}, at or past this message's ${m.nonce}` },
            needsNativeDrop,
            dstEndpoint: v1.endpoint,
          }
        : {
            message: m,
            state: { kind: 'in_flight', note: `the destination is at nonce ${inbound.value}, this message is ${m.nonce}` },
            needsNativeDrop,
            dstEndpoint: v1.endpoint,
          }
    }
    const reason = [stored, failed, inbound].find((x) => !x.ok)
    return {
      message: m,
      state: { kind: 'unknown', reason: reason && !reason.ok ? reason.reason : 'the destination did not answer' },
      needsNativeDrop,
      dstEndpoint: v1.endpoint,
    }
  }

  // ---- V2 ------------------------------------------------------------------
  if (!m.dstOApp) {
    return { message: m, state: { kind: 'unknown', reason: 'the packet’s receiver is not an EVM address' }, needsNativeDrop, dstEndpoint: undefined }
  }
  const endpointRead = await attempt(
    dstClient.readContract({ address: m.dstOApp, abi: oappEndpointAbi, functionName: 'endpoint' }),
    undefined,
    'destination endpoint',
  )
  if (!endpointRead.ok) {
    return { message: m, state: { kind: 'unknown', reason: endpointRead.reason }, needsNativeDrop, dstEndpoint: undefined }
  }
  const dstEndpoint = getAddress(endpointRead.value)
  const origin = { srcEid: m.packet.srcEid, sender: m.packet.sender, nonce: m.packet.nonce } as const

  const [held, lazy, verifiable] = await Promise.all([
    attempt(
      dstClient.readContract({
        address: dstEndpoint,
        abi: endpointV2RescueAbi,
        functionName: 'inboundPayloadHash',
        args: [m.dstOApp, origin.srcEid, origin.sender, origin.nonce],
      }),
      undefined,
      'inboundPayloadHash',
    ),
    attempt(
      dstClient.readContract({
        address: dstEndpoint,
        abi: endpointV2RescueAbi,
        functionName: 'lazyInboundNonce',
        args: [m.dstOApp, origin.srcEid, origin.sender],
      }),
      undefined,
      'lazyInboundNonce',
    ),
    ulnVerifiable(dstClient, dstEndpoint, m),
  ])

  if (held.ok && held.value !== ZERO_HASH) {
    return { message: m, state: { kind: 'committed_not_executed' }, needsNativeDrop, dstEndpoint }
  }
  if (verifiable.ok && verifiable.value) {
    return { message: m, state: { kind: 'verified_not_committed' }, needsNativeDrop, dstEndpoint }
  }
  if (lazy.ok && lazy.value >= m.packet.nonce) {
    return {
      message: m,
      state: { kind: 'delivered', note: `the destination has executed up to nonce ${lazy.value}` },
      needsNativeDrop,
      dstEndpoint,
    }
  }
  if (held.ok && lazy.ok) {
    return {
      message: m,
      state: { kind: 'in_flight', note: 'the destination holds no payload for this nonce and the DVNs have not finished' },
      needsNativeDrop,
      dstEndpoint,
    }
  }
  const failedRead = [held, lazy].find((x) => !x.ok)
  return {
    message: m,
    state: { kind: 'unknown', reason: failedRead && !failedRead.ok ? failedRead.reason : 'the destination did not answer' },
    needsNativeDrop,
    dstEndpoint,
  }
}

export const ZERO_HASH: Hex = `0x${'0'.repeat(64)}`

/** IOAppCore's endpoint getter — the one address a V2 rescue reads from the receiver itself. */
const oappEndpointAbi = [
  { type: 'function', name: 'endpoint', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

/**
 * Have the DVNs signed this packet without anyone committing it?
 *
 * Asked of the receive library the destination endpoint names for this route, with that library's
 * own ULN config — not with a config from anywhere else, because `verifiable` is only meaningful
 * against the thresholds that will actually be enforced.
 */
async function ulnVerifiable(dstClient: ReadClient, dstEndpoint: Address, m: Extract<FoundMessage, { version: 'v2' }>): Promise<Attempt<boolean>> {
  if (!m.dstOApp) return { ok: false, reason: 'the receiver is not an EVM address' }
  const lib = await attempt(
    dstClient.readContract({
      address: dstEndpoint,
      abi: endpointV2RescueAbi,
      functionName: 'getReceiveLibrary',
      args: [m.dstOApp, m.packet.srcEid],
    }),
    undefined,
    'receive library',
  )
  if (!lib.ok) return lib
  const config = await attempt(
    dstClient.readContract({ address: lib.value[0], abi: receiveUlnRescueAbi, functionName: 'getUlnConfig', args: [m.dstOApp, m.packet.srcEid] }),
    undefined,
    'ULN config',
  )
  if (!config.ok) return config
  return attempt(
    dstClient.readContract({
      address: lib.value[0],
      abi: receiveUlnRescueAbi,
      functionName: 'verifiable',
      args: [config.value, keccak256(m.header), m.payloadHash],
    }),
    undefined,
    'verifiable',
  )
}

/** The receive library for a V2 message, for the action that needs to call it. */
export async function receiveLibraryOf(dstClient: ReadClient, dstEndpoint: Address, dstOApp: Address, srcEid: number): Promise<Attempt<Address>> {
  const lib = await attempt(
    dstClient.readContract({ address: dstEndpoint, abi: endpointV2RescueAbi, functionName: 'getReceiveLibrary', args: [dstOApp, srcEid] }),
    undefined,
    'receive library',
  )
  return lib.ok ? { ok: true, value: getAddress(lib.value[0]) } : lib
}
