/**
 * §5: the four things this app may do about a stuck message, and everything that has to be true
 * first.
 *
 * The rule that shapes this file: **a payload is only ever submitted after the destination's own
 * record of its hash has been read and matched.** The bytes come from an event on the source chain;
 * the hash they are compared against comes from the destination contract — `storedPayload.payloadHash`,
 * `failedMessages[…]`, `inboundPayloadHash(…)`, or the ULN's `verifiable`. If the two disagree, or if
 * either could not be read, there is no action. LayerZero Scan is not consulted anywhere in this
 * module; an API cannot be allowed to choose the bytes a user signs.
 *
 * Four more constraints, all enforced here rather than trusted to the screen:
 *
 *   - `value` is always 0. None of these four calls needs native coin from the caller, and a rescue
 *     that could carry value would be a rescue that could be turned into a payment.
 *   - A message paid for with a **native drop** is refused. This app submits 0, so the drop would
 *     not happen and the recipient would be short exactly what the sender paid for. §5 says explain,
 *     do not execute.
 *   - Addresses come from the committed config (Endpoint V1) or are read from the message itself
 *     (the receiving OApp, and the endpoint and receive library it names). Nothing is typed in.
 *   - Every action is `eth_call`ed before it is offered. A revert means no button and the reason on
 *     screen, never a button that will fail in the wallet.
 */
import { encodeFunctionData, keccak256, type Address, type Hex } from 'viem'
import type { ReadClient } from '../../core/client'
import { decodeRevert, revertDataFromError, type DecodedRevert } from '../../core/sim/revert'
import { attempt, isTransportFailure } from '../lz-risk/probe'
import { lzV1 } from '../lz-v1/chains'
import { endpointV1RescueAbi, endpointV2RescueAbi, lzAppRescueAbi, receiveUlnRescueAbi } from './abi'
import { receiveLibraryOf, ZERO_HASH, type Diagnosis } from './diagnose'

/** Origin, as EndpointV2 takes it. */
export type RescueOrigin = { srcEid: number; sender: Hex; nonce: bigint }

type RescueCallBase = {
  to: Address
  /**
   * The encoded call, for the screen to print and for a reviewer to hash. It is NOT what gets
   * submitted: send.ts hands the wallet `abi + functionName + args` so wagmi re-encodes what was
   * verified here. Raw calldata is never submitted anywhere in this app — `sendTransaction` is on
   * the build's forbidden list precisely because it would be arbitrary calldata.
   */
  data: Hex
  /** Always 0n. Asserted again at the submit boundary. */
  value: 0n
  /** What the user is told this does. */
  what: string
  /** The hash that was matched, and where each side of it came from. */
  evidence: { payloadHash: Hex; readFrom: string }
}

/**
 * A call this module is prepared to submit, discriminated by which of the four it is so each one's
 * argument tuple is checked against the ABI that will encode it.
 */
export type RescueCall =
  | (RescueCallBase & { write: 'retryPayload'; args: readonly [number, Hex, Hex] })
  | (RescueCallBase & { write: 'retryMessage'; args: readonly [number, Hex, bigint, Hex] })
  | (RescueCallBase & { write: 'commitVerification'; args: readonly [Hex, Hex] })
  | (RescueCallBase & { write: 'lzReceive'; args: readonly [RescueOrigin, Address, Hex, Hex, Hex] })

export type RescuePlan =
  | { kind: 'action'; call: RescueCall }
  /** Nothing to do, and why — delivered, in flight, or a state with no whitelisted action. */
  | { kind: 'nothing'; reason: string }
  /** There is an action for this state, but it must not be offered. */
  | { kind: 'refused'; reason: string }

/**
 * The call for this diagnosis, or the reason there is none.
 *
 * Re-reads the destination rather than trusting the diagnosis it was handed: a verdict can be a few
 * seconds old, and the payload hash is the one thing that must be current at the moment of building.
 */
export async function planRescue(d: Diagnosis, dstClient: ReadClient): Promise<RescuePlan> {
  if (d.needsNativeDrop) {
    return {
      kind: 'refused',
      reason:
        'this message was paid for with a native drop on the destination. Executing it from here would deliver the tokens but not the native coin, because this app submits with no value of its own. Only an executor that carries that value can finish it properly.',
    }
  }

  const m = d.message
  switch (d.state.kind) {
    case 'delivered':
      return { kind: 'nothing', reason: `already delivered — ${d.state.note}` }
    case 'in_flight':
      return { kind: 'nothing', reason: `still on its way — ${d.state.note}` }
    case 'unknown':
      return { kind: 'nothing', reason: `the destination’s state could not be read: ${d.state.reason}` }

    case 'stored_payload': {
      if (m.version !== 'v1') return { kind: 'nothing', reason: 'a stored payload is a v1 state' }
      const v1 = m.dstChain ? lzV1(m.dstChain) : undefined
      if (!v1) return { kind: 'refused', reason: 'no Endpoint V1 is committed for the destination chain' }
      // Read again, now, and compare with the bytes from the source transaction.
      const stored = await attempt(
        dstClient.readContract({ address: v1.endpoint, abi: endpointV1RescueAbi, functionName: 'storedPayload', args: [m.srcV1ChainId, m.path] }),
        undefined,
        'storedPayload',
      )
      if (!stored.ok) return { kind: 'refused', reason: `the destination endpoint could not be read: ${stored.reason}` }
      const onChain = stored.value[2]
      if (onChain === ZERO_HASH) return { kind: 'nothing', reason: 'the endpoint no longer holds a payload for this path — someone has already cleared it' }
      const ours = keccak256(m.payload)
      if (ours !== onChain) {
        return {
          kind: 'refused',
          reason: `the payload from the source transaction hashes to ${ours}, but the destination endpoint is holding ${onChain}. Refusing: these are not the same message.`,
        }
      }
      return {
        kind: 'action',
        call: {
          write: 'retryPayload',
          to: v1.endpoint,
          args: [m.srcV1ChainId, m.path, m.payload] as const,
          data: encodeFunctionData({ abi: endpointV1RescueAbi, functionName: 'retryPayload', args: [m.srcV1ChainId, m.path, m.payload] }),
          value: 0n,
          what: 'ask the destination endpoint to deliver the payload it parked',
          evidence: { payloadHash: ours, readFrom: `Endpoint.storedPayload(${m.srcV1ChainId}, path) on ${m.dstChain}` },
        },
      }
    }

    case 'failed_message': {
      if (m.version !== 'v1') return { kind: 'nothing', reason: 'a failed message is a v1 state' }
      const failed = await attempt(
        dstClient.readContract({ address: m.dstOApp, abi: lzAppRescueAbi, functionName: 'failedMessages', args: [m.srcV1ChainId, m.path, m.nonce] }),
        undefined,
        'failedMessages',
      )
      if (!failed.ok) return { kind: 'refused', reason: `the destination contract could not be read: ${failed.reason}` }
      if (failed.value === ZERO_HASH) return { kind: 'nothing', reason: 'the contract no longer has a failed message for this nonce — it has already been retried' }
      const ours = keccak256(m.payload)
      if (ours !== failed.value) {
        return {
          kind: 'refused',
          reason: `the payload from the source transaction hashes to ${ours}, but the contract recorded ${failed.value}. Refusing: these are not the same message.`,
        }
      }
      return {
        kind: 'action',
        call: {
          write: 'retryMessage',
          // The receiving contract, read out of the packet itself — not from any list.
          to: m.dstOApp,
          args: [m.srcV1ChainId, m.path, m.nonce, m.payload] as const,
          data: encodeFunctionData({
            abi: lzAppRescueAbi,
            functionName: 'retryMessage',
            args: [m.srcV1ChainId, m.path, m.nonce, m.payload],
          }),
          value: 0n,
          what: 'ask the receiving contract to run the message it stored as failed',
          evidence: { payloadHash: ours, readFrom: `failedMessages(${m.srcV1ChainId}, path, ${m.nonce}) on ${m.dstOApp}` },
        },
      }
    }

    case 'verified_not_committed': {
      if (m.version !== 'v2') return { kind: 'nothing', reason: 'committing verification is a V2 step' }
      if (!d.dstEndpoint || !m.dstOApp) return { kind: 'refused', reason: 'the destination endpoint is not known' }
      const lib = await receiveLibraryOf(dstClient, d.dstEndpoint, m.dstOApp, m.packet.srcEid)
      if (!lib.ok) return { kind: 'refused', reason: `the receive library could not be read: ${lib.reason}` }
      const config = await attempt(
        dstClient.readContract({ address: lib.value, abi: receiveUlnRescueAbi, functionName: 'getUlnConfig', args: [m.dstOApp, m.packet.srcEid] }),
        undefined,
        'ULN config',
      )
      if (!config.ok) return { kind: 'refused', reason: `the ULN config could not be read: ${config.reason}` }
      // The library's own answer about its own thresholds, for this exact header and payload.
      const ok = await attempt(
        dstClient.readContract({
          address: lib.value,
          abi: receiveUlnRescueAbi,
          functionName: 'verifiable',
          args: [config.value, keccak256(m.header), m.payloadHash],
        }),
        undefined,
        'verifiable',
      )
      if (!ok.ok) return { kind: 'refused', reason: `the library could not be asked whether this is committable: ${ok.reason}` }
      if (!ok.value) return { kind: 'nothing', reason: 'the DVNs have not signed enough for this to be committed yet' }
      return {
        kind: 'action',
        call: {
          write: 'commitVerification',
          to: lib.value,
          args: [m.header, m.payloadHash] as const,
          data: encodeFunctionData({ abi: receiveUlnRescueAbi, functionName: 'commitVerification', args: [m.header, m.payloadHash] }),
          value: 0n,
          what: 'hand the DVNs’ signatures to the endpoint so the message becomes executable',
          evidence: { payloadHash: m.payloadHash, readFrom: `ReceiveUln.verifiable(config, keccak256(header), payloadHash) on ${m.dstChain}` },
        },
      }
    }

    case 'committed_not_executed': {
      if (m.version !== 'v2') return { kind: 'nothing', reason: 'executing a committed message is a V2 step' }
      if (!d.dstEndpoint || !m.dstOApp) return { kind: 'refused', reason: 'the destination endpoint is not known' }
      const origin = { srcEid: m.packet.srcEid, sender: m.packet.sender, nonce: m.packet.nonce } as const
      const held = await attempt(
        dstClient.readContract({
          address: d.dstEndpoint,
          abi: endpointV2RescueAbi,
          functionName: 'inboundPayloadHash',
          args: [m.dstOApp, origin.srcEid, origin.sender, origin.nonce],
        }),
        undefined,
        'inboundPayloadHash',
      )
      if (!held.ok) return { kind: 'refused', reason: `the destination endpoint could not be read: ${held.reason}` }
      if (held.value === ZERO_HASH) return { kind: 'nothing', reason: 'the endpoint holds no payload for this nonce any more — it has been executed or cleared' }
      if (held.value !== m.payloadHash) {
        return {
          kind: 'refused',
          reason: `the packet from the source transaction hashes to ${m.payloadHash}, but the endpoint is holding ${held.value}. Refusing: these are not the same message.`,
        }
      }
      return {
        kind: 'action',
        call: {
          write: 'lzReceive',
          to: d.dstEndpoint,
          // extraData is empty: it is the executor's own field, and this app is not an executor.
          args: [origin, m.dstOApp, m.packet.guid, m.packet.message, '0x'] as const,
          data: encodeFunctionData({
            abi: endpointV2RescueAbi,
            functionName: 'lzReceive',
            args: [origin, m.dstOApp, m.packet.guid, m.packet.message, '0x'],
          }),
          value: 0n,
          what: 'run the message the endpoint has already verified',
          evidence: {
            payloadHash: m.payloadHash,
            readFrom: `EndpointV2.inboundPayloadHash(${m.dstOApp}, ${origin.srcEid}, sender, ${origin.nonce}) on ${m.dstChain}`,
          },
        },
      }
    }
  }
}

export type RescueSimulation =
  | { status: 'ok'; gas: bigint | undefined }
  | { status: 'reverted'; revert: DecodedRevert; raw: string }
  | { status: 'unavailable'; reason: string }

/**
 * Runs the exact call before it is offered.
 *
 * `from` is the connected wallet, because that is who will send it — none of the four is restricted
 * to a particular caller, but simulating as somebody else would not be simulating this transaction.
 */
export async function simulateRescue(dstClient: ReadClient, call: RescueCall, from: Address): Promise<RescueSimulation> {
  const req = { account: from, to: call.to, data: call.data, value: call.value } as const
  try {
    await dstClient.call(req)
  } catch (e) {
    const data = revertDataFromError(e)
    const raw = e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)
    if (data === undefined && isTransportFailure(raw)) return { status: 'unavailable', reason: raw }
    return { status: 'reverted', revert: decodeRevert(data), raw }
  }
  const gas = await attempt(dstClient.estimateGas(req), undefined, 'gas')
  return { status: 'ok', gas: gas.ok ? gas.value : undefined }
}

/**
 * §5's two explain-only states.
 *
 * Neither is an action this app will ever offer. `forceResumeReceive` destroys the parked payload
 * rather than delivering it, and only the receiving contract's owner can call it at all; a dead DVN
 * cannot be worked around from outside the project either. So both are sentences, and the sentence
 * says who can act and what it would cost.
 */
export const EXPLAIN_ONLY = {
  forceResumeReceive:
    'The path can be unblocked with forceResumeReceive, but only the receiving contract’s owner can call it, and it DESTROYS the parked payload instead of delivering it — the tokens in that message are not recovered, the queue behind it simply starts moving again. This app will not offer it.',
  deadDvn:
    'This route is configured with a DVN that LayerZero has deprecated, so the attestation this message needs can never be produced. Nothing can be retried from here: the project that owns the contract has to reconfigure the route.',
} as const
