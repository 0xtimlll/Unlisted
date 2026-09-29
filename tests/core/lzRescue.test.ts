/**
 * §5: Status / Rescue.
 *
 * The centre of this file is one rule: **a payload is only ever submitted after the destination's own
 * record of its hash has been matched.** So the tests that matter most are the refusals — a payload
 * whose hash does not match what the contract is holding, a message paid for with a native drop, a
 * state that has already been cleared by somebody else. Each of those must produce no call at all,
 * and none of them may be reachable by any argument the screen can pass.
 *
 * The packets are built with viem's own encoder from the events' real signatures, so what is decoded
 * here is the shape a chain actually emits.
 */
import { describe, expect, it } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem'
import type { ReadClient } from '@/core/client'
import { lzV1 } from '@/protocols/lz-v1/chains'
import { encodeAdapterParamsType1 } from '@/protocols/lz-v1/adapterParams'
import { findMessages, diagnose, messageNeedsNativeDrop, ZERO_HASH, type LogLike } from '@/protocols/lz-rescue/diagnose'
import { planRescue, simulateRescue, EXPLAIN_ONLY } from '@/protocols/lz-rescue/actions'
import { RESCUE_WRITES } from '@/protocols/lz-rescue/abi'
import { RescueRefused, submitRescue } from '@/protocols/lz-rescue/send'

const SRC_OFT = getAddress('0x1111111111111111111111111111111111111111')
const DST_OFT = getAddress('0x2222222222222222222222222222222222222222')
const WALLET = getAddress('0x3333333333333333333333333333333333333333')
const ULN = getAddress('0x4d73ADb72bC3dd368966edD0f0b2148401A178E2')
const ENDPOINT_V2 = getAddress('0x1a44076050125825900e736c501f859c50fE728c')

const ETH_V1 = 101
const ARB_V1 = 110
const ARB_EID = 30110
const ETH_EID = 30101

/** The app-level payload a v1 OFTV2 sends: PT_SEND ++ bytes32 ++ amountSD. */
const V1_PAYLOAD: Hex = `0x00${'0'.repeat(24)}${WALLET.slice(2).toLowerCase()}${(1_000_000n).toString(16).padStart(16, '0')}`

/** UltraLightNodeV2.send: abi.encodePacked(nonce, localChainId, ua, dstChainId, dstAddress, payload). */
function v1Packet(p: { nonce: bigint; srcV1: number; src: Address; dstV1: number; dst: Address; payload: Hex }): Hex {
  const hex = (v: bigint, bytes: number) => v.toString(16).padStart(bytes * 2, '0')
  return `0x${hex(p.nonce, 8)}${hex(BigInt(p.srcV1), 2)}${p.src.slice(2).toLowerCase()}${hex(BigInt(p.dstV1), 2)}${p.dst.slice(2).toLowerCase()}${p.payload.slice(2)}`
}

const ulnAbi = parseAbi(['event Packet(bytes payload)', 'event RelayerParams(bytes adapterParams, uint16 outboundProofType)'])
const v2Abi = parseAbi(['event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)'])

function packetLog(payload: Hex): LogLike {
  return {
    address: ULN,
    topics: encodeEventTopics({ abi: ulnAbi, eventName: 'Packet' }) as string[],
    data: encodeAbiParameters([{ type: 'bytes' }], [payload]),
  }
}

function relayerParamsLog(adapterParams: Hex): LogLike {
  return {
    address: ULN,
    topics: encodeEventTopics({ abi: ulnAbi, eventName: 'RelayerParams' }) as string[],
    data: encodeAbiParameters([{ type: 'bytes' }, { type: 'uint16' }], [adapterParams, 2]),
  }
}

/** PacketV1Codec: version ++ nonce ++ srcEid ++ sender ++ dstEid ++ receiver ++ guid ++ message. */
function v2Encoded(p: { nonce: bigint; srcEid: number; sender: Address; dstEid: number; receiver: Address; guid: Hex; message: Hex }): Hex {
  const hex = (v: bigint, bytes: number) => v.toString(16).padStart(bytes * 2, '0')
  const b32 = (a: Address) => `${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
  return `0x01${hex(p.nonce, 8)}${hex(BigInt(p.srcEid), 4)}${b32(p.sender)}${hex(BigInt(p.dstEid), 4)}${b32(p.receiver)}${p.guid.slice(2)}${p.message.slice(2)}`
}

function packetSentLog(encoded: Hex, options: Hex): LogLike {
  return {
    address: ENDPOINT_V2,
    topics: encodeEventTopics({ abi: v2Abi, eventName: 'PacketSent' }) as string[],
    data: encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }, { type: 'address' }], [encoded, options, ULN]),
  }
}

const GUID: Hex = `0x${'ab'.repeat(32)}`
const V2_MESSAGE: Hex = `0x${'0'.repeat(24)}${WALLET.slice(2).toLowerCase()}${(500_000n).toString(16).padStart(16, '0')}`

/** A client that answers exactly the reads named, and rejects everything else. */
function stub(answers: Record<string, unknown>): ReadClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName in answers) {
        const v = answers[functionName]
        if (v instanceof Error) throw v
        return v
      }
      throw new Error(`unexpected read: ${functionName}`)
    },
    call: async () => ({ data: '0x' }),
    estimateGas: async () => 120_000n,
  } as unknown as ReadClient
}

describe('finding the messages in a transaction', () => {
  it('reads a v1 packet out of the UltraLightNode’s own event', () => {
    const encoded = v1Packet({ nonce: 42n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
    const [m] = findMessages([packetLog(encoded)], 'ethereum')
    expect(m).toBeDefined()
    if (m?.version !== 'v1') throw new Error('expected a v1 message')
    expect(m.nonce).toBe(42n)
    expect(m.srcV1ChainId).toBe(ETH_V1)
    expect(m.dstV1ChainId).toBe(ARB_V1)
    expect(m.srcOApp).toBe(SRC_OFT)
    expect(m.dstOApp).toBe(DST_OFT)
    expect(m.dstChain).toBe('arbitrum')
    expect(m.payload).toBe(V1_PAYLOAD.toLowerCase())
    // The endpoint keys a stored payload by the packed path, which is what a retry must pass.
    expect(m.path).toBe(`0x${SRC_OFT.slice(2).toLowerCase()}${DST_OFT.slice(2).toLowerCase()}`)
  })

  it('carries the relayer params published alongside a v1 packet', () => {
    const encoded = v1Packet({ nonce: 1n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
    const params = encodeAdapterParamsType1(200_000n)
    const [m] = findMessages([relayerParamsLog(params), packetLog(encoded)], 'ethereum')
    if (m?.version !== 'v1') throw new Error('expected a v1 message')
    expect(m.adapterParams).toBe(params)
    expect(messageNeedsNativeDrop(m)).toBe(false)
  })

  it('reads a V2 packet and splits it into the header and the payload the endpoint hashes', () => {
    const encoded = v2Encoded({ nonce: 7n, srcEid: ETH_EID, sender: SRC_OFT, dstEid: ARB_EID, receiver: DST_OFT, guid: GUID, message: V2_MESSAGE })
    const [m] = findMessages([packetSentLog(encoded, '0x')], 'ethereum')
    if (m?.version !== 'v2') throw new Error('expected a v2 message')
    expect(m.packet.nonce).toBe(7n)
    expect(m.dstOApp).toBe(DST_OFT)
    expect(m.dstChain).toBe('arbitrum')
    // The header is the first 81 bytes and the payload is guid ++ message, which is what
    // commitVerification and inboundPayloadHash are both about.
    expect((m.header.length - 2) / 2).toBe(81)
    expect(m.payload).toBe(`${GUID}${V2_MESSAGE.slice(2)}`.toLowerCase())
    expect(m.payloadHash).toBe(keccak256(m.payload))
  })

  it('finds both versions in one transaction and ignores everything else', () => {
    const v1 = v1Packet({ nonce: 1n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
    const v2 = v2Encoded({ nonce: 2n, srcEid: ETH_EID, sender: SRC_OFT, dstEid: ARB_EID, receiver: DST_OFT, guid: GUID, message: V2_MESSAGE })
    const noise: LogLike = { address: SRC_OFT, topics: [`0x${'11'.repeat(32)}`], data: '0x' }
    const found = findMessages([noise, packetLog(v1), packetSentLog(v2, '0x'), noise], 'ethereum')
    expect(found.map((m) => m.version)).toEqual(['v1', 'v2'])
  })

  it('does not invent a message out of a truncated packet', () => {
    expect(findMessages([packetLog('0xdeadbeef')], 'ethereum')).toEqual([])
  })
})

describe('a native drop is explained, never executed', () => {
  it('recognises a v1 txType 2 and refuses to act', async () => {
    const encoded = v1Packet({ nonce: 1n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
    // uint16(2) ++ gas ++ amount ++ 20-byte address, RelayerV2's own shape.
    const drop: Hex = `0x0002${(200_000n).toString(16).padStart(64, '0')}${(10n ** 18n).toString(16).padStart(64, '0')}${WALLET.slice(2)}`
    const [m] = findMessages([relayerParamsLog(drop), packetLog(encoded)], 'ethereum')
    if (!m) throw new Error('expected a message')
    expect(messageNeedsNativeDrop(m)).toBe(true)
    const d = await diagnose(m, stub({ storedPayload: [0n, DST_OFT, keccak256(V1_PAYLOAD)], failedMessages: ZERO_HASH, getInboundNonce: 0n }))
    expect(d.needsNativeDrop).toBe(true)
    const plan = await planRescue(d, stub({}))
    expect(plan.kind).toBe('refused')
    expect(plan.kind === 'refused' && plan.reason).toMatch(/native drop/)
  })
})

describe('v1: a parked payload', () => {
  const encoded = v1Packet({ nonce: 9n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
  const message = () => {
    const [m] = findMessages([packetLog(encoded)], 'ethereum')
    if (m?.version !== 'v1') throw new Error('expected a v1 message')
    return m
  }

  it('offers retryPayload when the endpoint’s hash matches the bytes from the source', async () => {
    const m = message()
    const hash = keccak256(m.payload)
    const client = stub({ storedPayload: [0n, DST_OFT, hash], failedMessages: ZERO_HASH, getInboundNonce: 8n })
    const d = await diagnose(m, client)
    expect(d.state.kind).toBe('stored_payload')
    const plan = await planRescue(d, client)
    expect(plan.kind).toBe('action')
    if (plan.kind !== 'action') return
    expect(plan.call.write).toBe('retryPayload')
    // The endpoint from the committed table, never from the message or the user.
    expect(plan.call.to).toBe(lzV1('arbitrum')!.endpoint)
    expect(plan.call.value).toBe(0n)
    expect(plan.call.evidence.payloadHash).toBe(hash)
    expect(plan.call.args).toEqual([ETH_V1, m.path, m.payload])
  })

  it('REFUSES when the endpoint is holding a different hash', async () => {
    const m = message()
    const someoneElses = keccak256('0xdeadbeef')
    const client = stub({ storedPayload: [0n, DST_OFT, someoneElses], failedMessages: ZERO_HASH, getInboundNonce: 8n })
    const d = await diagnose(m, client)
    const plan = await planRescue(d, client)
    expect(plan.kind).toBe('refused')
    expect(plan.kind === 'refused' && plan.reason).toMatch(/not the same message/)
  })

  it('says there is nothing to do once somebody else has cleared it', async () => {
    const m = message()
    const client = stub({ storedPayload: [0n, DST_OFT, keccak256(m.payload)], failedMessages: ZERO_HASH, getInboundNonce: 8n })
    const d = await diagnose(m, client)
    // Cleared between the diagnosis and the click: the second read is the one that decides.
    const plan = await planRescue(d, stub({ storedPayload: [0n, DST_OFT, ZERO_HASH] }))
    expect(plan.kind).toBe('nothing')
    expect(plan.kind === 'nothing' && plan.reason).toMatch(/already cleared/)
  })

  it('reports a delivered message rather than offering anything', async () => {
    const m = message()
    const client = stub({ storedPayload: [0n, DST_OFT, ZERO_HASH], failedMessages: ZERO_HASH, getInboundNonce: 9n })
    const d = await diagnose(m, client)
    expect(d.state.kind).toBe('delivered')
    expect((await planRescue(d, client)).kind).toBe('nothing')
  })

  it('reports a message still on its way', async () => {
    const m = message()
    const client = stub({ storedPayload: [0n, DST_OFT, ZERO_HASH], failedMessages: ZERO_HASH, getInboundNonce: 3n })
    const d = await diagnose(m, client)
    expect(d.state.kind).toBe('in_flight')
    expect((await planRescue(d, client)).kind).toBe('nothing')
  })

  it('never claims a state when the destination could not be read', async () => {
    const m = message()
    const down = new Error('HTTP request failed')
    const d = await diagnose(m, stub({ storedPayload: down, failedMessages: down, getInboundNonce: down }))
    expect(d.state.kind).toBe('unknown')
    expect((await planRescue(d, stub({}))).kind).toBe('nothing')
  })
})

describe('v1: a failed message', () => {
  it('offers retryMessage on the receiving contract, read out of the packet', async () => {
    const encoded = v1Packet({ nonce: 5n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
    const [m] = findMessages([packetLog(encoded)], 'ethereum')
    if (m?.version !== 'v1') throw new Error('expected a v1 message')
    const hash = keccak256(m.payload)
    const client = stub({ storedPayload: [0n, DST_OFT, ZERO_HASH], failedMessages: hash, getInboundNonce: 5n })
    const d = await diagnose(m, client)
    expect(d.state.kind).toBe('failed_message')
    const plan = await planRescue(d, client)
    if (plan.kind !== 'action') throw new Error('expected an action')
    expect(plan.call.write).toBe('retryMessage')
    expect(plan.call.to).toBe(DST_OFT)
    expect(plan.call.value).toBe(0n)
    expect(plan.call.args).toEqual([ETH_V1, m.path, 5n, m.payload])
  })

  it('REFUSES a payload the contract did not record', async () => {
    const encoded = v1Packet({ nonce: 5n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
    const [m] = findMessages([packetLog(encoded)], 'ethereum')
    if (!m) throw new Error('expected a message')
    const client = stub({ storedPayload: [0n, DST_OFT, ZERO_HASH], failedMessages: keccak256('0xbeef'), getInboundNonce: 5n })
    const d = await diagnose(m, client)
    const plan = await planRescue(d, client)
    expect(plan.kind).toBe('refused')
    expect(plan.kind === 'refused' && plan.reason).toMatch(/not the same message/)
  })
})

describe('V2: committed but not executed', () => {
  const encoded = v2Encoded({ nonce: 3n, srcEid: ETH_EID, sender: SRC_OFT, dstEid: ARB_EID, receiver: DST_OFT, guid: GUID, message: V2_MESSAGE })
  const message = () => {
    const [m] = findMessages([packetSentLog(encoded, '0x')], 'ethereum')
    if (m?.version !== 'v2') throw new Error('expected a v2 message')
    return m
  }

  it('offers lzReceive on the endpoint the receiver itself names', async () => {
    const m = message()
    const client = stub({ endpoint: ENDPOINT_V2, inboundPayloadHash: m.payloadHash, lazyInboundNonce: 2n, getReceiveLibrary: [SRC_OFT, true], getUlnConfig: {}, verifiable: false })
    const d = await diagnose(m, client)
    expect(d.state.kind).toBe('committed_not_executed')
    expect(d.dstEndpoint).toBe(ENDPOINT_V2)
    const plan = await planRescue(d, client)
    if (plan.kind !== 'action') throw new Error('expected an action')
    expect(plan.call.write).toBe('lzReceive')
    expect(plan.call.to).toBe(ENDPOINT_V2)
    expect(plan.call.value).toBe(0n)
    expect(plan.call.args[1]).toBe(DST_OFT)
    expect(plan.call.args[2]).toBe(GUID.toLowerCase())
    // extraData is empty: this app is not an executor and has nothing to put there.
    expect(plan.call.args[4]).toBe('0x')
  })

  it('REFUSES when the endpoint holds a different payload hash', async () => {
    const m = message()
    const client = stub({
      endpoint: ENDPOINT_V2,
      inboundPayloadHash: keccak256('0xfeed'),
      lazyInboundNonce: 2n,
      getReceiveLibrary: [SRC_OFT, true],
      getUlnConfig: {},
      verifiable: false,
    })
    const d = await diagnose(m, client)
    const plan = await planRescue(d, client)
    expect(plan.kind).toBe('refused')
    expect(plan.kind === 'refused' && plan.reason).toMatch(/not the same message/)
  })

  it('offers commitVerification when the library says the DVNs have signed', async () => {
    const m = message()
    const client = stub({
      endpoint: ENDPOINT_V2,
      inboundPayloadHash: ZERO_HASH,
      lazyInboundNonce: 2n,
      getReceiveLibrary: [SRC_OFT, true],
      getUlnConfig: { confirmations: 20n, requiredDVNs: [], optionalDVNs: [], optionalDVNThreshold: 0 },
      verifiable: true,
    })
    const d = await diagnose(m, client)
    expect(d.state.kind).toBe('verified_not_committed')
    const plan = await planRescue(d, client)
    if (plan.kind !== 'action') throw new Error('expected an action')
    expect(plan.call.write).toBe('commitVerification')
    expect(plan.call.to).toBe(SRC_OFT) // the receive library the endpoint named
    expect(plan.call.args).toEqual([m.header, m.payloadHash])
  })

  it('offers nothing while the DVNs have not finished', async () => {
    const m = message()
    const client = stub({
      endpoint: ENDPOINT_V2,
      inboundPayloadHash: ZERO_HASH,
      lazyInboundNonce: 2n,
      getReceiveLibrary: [SRC_OFT, true],
      getUlnConfig: {},
      verifiable: false,
    })
    const d = await diagnose(m, client)
    expect(d.state.kind).toBe('in_flight')
    expect((await planRescue(d, client)).kind).toBe('nothing')
  })
})

describe('the submit boundary', () => {
  async function anAction() {
    const encoded = v1Packet({ nonce: 9n, srcV1: ETH_V1, src: SRC_OFT, dstV1: ARB_V1, dst: DST_OFT, payload: V1_PAYLOAD })
    const [m] = findMessages([packetLog(encoded)], 'ethereum')
    if (!m) throw new Error('expected a message')
    const client = stub({ storedPayload: [0n, DST_OFT, keccak256(m.payload)], failedMessages: ZERO_HASH, getInboundNonce: 8n })
    const d = await diagnose(m, client)
    const plan = await planRescue(d, client)
    if (plan.kind !== 'action') throw new Error('expected an action')
    return plan.call
  }

  const writer = (onCall?: (a: { functionName: string; value?: bigint }) => void) => ({
    writeContractAsync: (async (a: { functionName: string; value?: bigint }) => {
      onCall?.(a)
      return '0xabc'
    }) as never,
  })

  it('hands the wallet the function the plan named, with no value', async () => {
    const call = await anAction()
    let seen: { functionName: string; value?: bigint } | undefined
    const hash = await submitRescue(writer((a) => (seen = a)), call, { chainId: 42161, from: WALLET, client: stub({}) })
    expect(hash).toBe('0xabc')
    expect(seen?.functionName).toBe('retryPayload')
    // retryPayload is non-payable, so no value field is sent at all.
    expect(seen?.value).toBeUndefined()
  })

  it('refuses without asking the wallet when the call reverts now', async () => {
    const call = await anAction()
    let asked = false
    const reverting = {
      call: async () => {
        throw new Error('execution reverted: LayerZero: no stored payload')
      },
      estimateGas: async () => 0n,
      readContract: async () => 0n,
    } as unknown as ReadClient
    await expect(
      submitRescue(writer(() => (asked = true)), call, { chainId: 42161, from: WALLET, client: reverting }),
    ).rejects.toThrow(RescueRefused)
    expect(asked).toBe(false)
  })

  it('refuses without asking the wallet when the destination cannot be reached', async () => {
    const call = await anAction()
    let asked = false
    const down = {
      call: async () => {
        throw new Error('HTTP request failed')
      },
      estimateGas: async () => 0n,
      readContract: async () => 0n,
    } as unknown as ReadClient
    await expect(
      submitRescue(writer(() => (asked = true)), call, { chainId: 42161, from: WALLET, client: down }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(asked).toBe(false)
  })

  it('refuses a call that somehow carries value', async () => {
    const call = await anAction()
    await expect(
      submitRescue(writer(), { ...call, value: 1n } as never, { chainId: 42161, from: WALLET, client: stub({}) }),
    ).rejects.toMatchObject({ code: 'value_not_zero' })
  })

  it('simulates as the wallet that will send it', async () => {
    const call = await anAction()
    let account: unknown
    const client = {
      call: async (req: { account?: unknown }) => {
        account = req.account
        return { data: '0x' }
      },
      estimateGas: async () => 99_000n,
    } as unknown as ReadClient
    const sim = await simulateRescue(client, call, WALLET)
    expect(account).toBe(WALLET)
    expect(sim).toEqual({ status: 'ok', gas: 99_000n })
  })
})

describe('the two things this tab only explains', () => {
  it('says who can call forceResumeReceive and what it costs', () => {
    expect(EXPLAIN_ONLY.forceResumeReceive).toMatch(/owner/)
    expect(EXPLAIN_ONLY.forceResumeReceive).toMatch(/DESTROYS/)
  })

  it('says a dead DVN cannot be worked around from here', () => {
    expect(EXPLAIN_ONLY.deadDvn).toMatch(/deprecated/)
  })

  it('names exactly the four actions §5 allows', () => {
    expect([...RESCUE_WRITES].sort()).toEqual(['commitVerification', 'lzReceive', 'retryMessage', 'retryPayload'])
  })
})
