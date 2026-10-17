/**
 * §4 for LayerZero V2: the same eight checks, asked of the V2 stack.
 *
 * What differs from v1 is worth naming, because it is where the two protocols disagree about what
 * can go wrong:
 *
 *   - **There is no stored payload.** EndpointV2 does not park an undeliverable message the way
 *     Endpoint V1 does, so check 2 is the nonce pair alone: `outboundNonce` on the source against
 *     `inboundNonce` on the destination, for this exact (sender, eid, receiver) triple.
 *   - **Verification is a DVN set, not an oracle and a relayer.** Check 3 reads the ULN config on
 *     both sides and compares them, and judges the DVNs against LayerZero's own published list
 *     (dvns.ts). A deprecated DVN — the dead DVN above all — blocks; an unusual but healthy set is
 *     not even a warning, which §4 says in as many words.
 *   - **The credit is simulated through the OApp's `lzReceive`**, called `from` the destination
 *     endpoint, because OAppReceiver requires `msg.sender == endpoint` and then requires
 *     `_origin.sender` to be the peer. The message is the 40 bytes OFTMsgCodec.encode produces:
 *     `abi.encodePacked(sendTo, amountSD)`.
 */
import { decodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseAbi, toEventSelector, type Address, type Hex } from 'viem'
import { erc20Abi, oftAbi } from '../../core/abi'
import { byEid, evmByKey, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { sameAddress, ZERO_ADDRESS } from '../../core/encoding'
import { sanitizeText } from '../../core/text'
import type { EvmSendPlan } from '../../core/plan'
import type { OftInfo } from '../../core/types'
import { lockedBps, type AdapterStanding } from './adapters'
import { DEAD_DVN_ID, dvnInfo, judgeDvns } from './dvns'
import { attempt, daysSinceBlock, isTransportFailure, pickEvent, scanNewest, windowDays } from './probe'
import { allUnchecked, INFLIGHT_GRACE_MINUTES, type CheckId, type CheckState, type RiskInput } from './risk'
import { THIN_GAS_RATIO } from './v1'

/** EndpointV2's channel and library manager, plus the OApp receive entry point. */
/** `totalSupply` is not in core/abi.ts's erc20Abi, and this is the only place that needs it. */
const supplyAbi = parseAbi(['function totalSupply() view returns (uint256)'])

const v2Abi = parseAbi([
  'struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }',
  'struct UlnConfig { uint64 confirmations; uint8 requiredDVNCount; uint8 optionalDVNCount; uint8 optionalDVNThreshold; address[] requiredDVNs; address[] optionalDVNs; }',
  'function inboundNonce(address _receiver, uint32 _srcEid, bytes32 _sender) view returns (uint64)',
  'function outboundNonce(address _sender, uint32 _dstEid, bytes32 _receiver) view returns (uint64)',
  'function getSendLibrary(address _sender, uint32 _eid) view returns (address lib)',
  'function getReceiveLibrary(address _receiver, uint32 _eid) view returns (address lib, bool isDefault)',
  'function getUlnConfig(address _oapp, uint32 _remoteEid) view returns (UlnConfig)',
  'function lzReceive(Origin _origin, bytes32 _guid, bytes _message, address _executor, bytes _extraData) payable',
  'function paused() view returns (bool)',
  // ILayerZeroEndpointV2.quote: what the ENDPOINT charges for this exact packet. OFTCore._quote
  // returns this number unchanged; an OFT whose quoteSend asks for more keeps the difference.
  'struct MessagingParams { uint32 dstEid; bytes32 receiver; bytes message; bytes options; bool payInLzToken; }',
  'struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }',
  'function quote(MessagingParams _params, address _sender) view returns (MessagingFee)',
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  'event PeerSet(uint32 eid, bytes32 peer)',
])

export type V2RiskContext = {
  info: OftInfo
  plan: EvmSendPlan
  srcChain: ChainKey
  dstChain: ChainKey
  srcClient: ReadClient
  dstClient: ReadClient
  /** The destination-side OFT, from the peer. */
  dstOft: Address
}

type Outcome = { state: CheckState; extra?: Partial<RiskInput> }

/**
 * The destination's EndpointV2, from the committed registry — never from `dstOft.endpoint()`.
 *
 * CLAUDE.md rule 3: the destination contract is reached through the source's `peers()`, so
 * everything it says, its endpoint included, is the examined party's own claim. Asking a fake
 * endpoint for `inboundNonce`, reading the receive library from it and simulating the credit
 * "from" it would let one deployer write both halves of every check. The registry address is the
 * one thing here the deployer cannot write, so the nonce, the libraries and the simulated
 * `msg.sender` all come from it, and a destination wired to anything else fails on its own terms.
 */
function registryEndpoint(c: V2RiskContext): Address {
  return evmByKey(c.dstChain).endpointV2
}

/**
 * OAppOptionsType3.combineOptions, read here rather than imported (this module must not depend on
 * the encoder whose output it judges): the enforced blob alone when nothing extra was given, the
 * extra blob alone when nothing is enforced, otherwise enforced ++ extra minus its 2-byte type.
 */
export function combineOptionsV2(enforced: Hex, extra: Hex): Hex {
  const e = enforced.slice(2)
  const x = extra.slice(2)
  if (e.length === 0) return extra
  if (x.length === 0) return enforced
  if (!x.startsWith('0003')) return extra
  return `0x${e}${x.slice(4)}` as Hex
}

/** OFTMsgCodec.encode with no compose payload: sendTo ++ amountSD, 40 bytes. */
export function v2Message(plan: EvmSendPlan, conversionRate: bigint): Hex {
  const amountSD = plan.quote.amountReceivedLD / conversionRate
  return encodePacked(['bytes32', 'uint64'], [plan.recipient, amountSD])
}

/** 1. Peers name each other. */
async function checkPeers(c: V2RiskContext): Promise<Outcome> {
  const route = c.info.routes.find((r) => r.eid === c.plan.dstEid)
  if (!route) return { state: { status: 'fail', reason: 'the source contract has no peer for this destination' } }
  const back = await attempt(
    c.dstClient.readContract({ address: c.dstOft, abi: oftAbi, functionName: 'peers', args: [c.plan.srcEid] }),
    undefined,
    'destination peer',
  )
  if (!back.ok) return { state: { status: 'unchecked', reason: back.reason } }
  const ours = `0x${'0'.repeat(24)}${c.info.oft.slice(2).toLowerCase()}`
  if (back.value.toLowerCase() !== ours) {
    return { state: { status: 'fail', reason: `the destination names ${back.value} as its peer for this chain, not this contract` } }
  }
  // A destination wired to some other endpoint can never be delivered to by LayerZero's: the real
  // endpoint's lzReceive call would fail OAppReceiver's `msg.sender == endpoint`.
  const dstEndpoint = await attempt(c.dstClient.readContract({ address: c.dstOft, abi: oftAbi, functionName: 'endpoint' }), undefined, 'destination endpoint')
  if (dstEndpoint.ok && !sameAddress(dstEndpoint.value, registryEndpoint(c))) {
    return {
      state: { status: 'fail', reason: `the destination contract is wired to ${dstEndpoint.value}, not to LayerZero's endpoint on ${c.dstChain} (${registryEndpoint(c)})` },
    }
  }
  // The fee. OFTCore returns the endpoint's quote unchanged, so a quoteSend above it is money the
  // contract keeps: a pair of real-looking OFTs whose only purpose is the "fee" passes every other
  // check here. The endpoint is the committed one, asked on the source chain for this exact packet.
  const options = combineOptionsV2(c.info.enforced[c.plan.dstEid] ?? '0x', c.plan.extraOptions)
  const endpointFee = await attempt(
    c.srcClient.readContract({
      address: c.info.endpoint,
      abi: v2Abi,
      functionName: 'quote',
      args: [{ dstEid: c.plan.dstEid, receiver: route.peer, message: v2Message(c.plan, c.info.conversionRate), options, payInLzToken: false }, c.info.oft],
    }),
    undefined,
    'endpoint quote',
  )
  if (!endpointFee.ok) return { state: { status: 'pass', note: `peers match; the fee could not be checked against the endpoint (${endpointFee.reason})` } }
  if (c.plan.quote.nativeFee > endpointFee.value.nativeFee) {
    return {
      state: {
        status: 'fail',
        reason: `the contract charges ${c.plan.quote.nativeFee} wei for a message the endpoint prices at ${endpointFee.value.nativeFee} — the difference stays with the contract`,
      },
    }
  }
  return { state: { status: 'pass', note: 'peers match; the fee is the endpoint’s own quote' } }
}

/** 2. The nonces are level, or the gap is young enough to be traffic rather than a stoppage. */
async function checkPath(c: V2RiskContext): Promise<Outcome> {
  const dstEndpoint = registryEndpoint(c)
  const peerBytes32 = `0x${'0'.repeat(24)}${c.info.oft.slice(2).toLowerCase()}` as Hex
  const dstBytes32 = `0x${'0'.repeat(24)}${c.dstOft.slice(2).toLowerCase()}` as Hex

  const [outbound, inbound] = await Promise.all([
    attempt(
      c.srcClient.readContract({ address: c.info.endpoint, abi: v2Abi, functionName: 'outboundNonce', args: [c.info.oft, c.plan.dstEid, dstBytes32] }),
      undefined,
      'outbound nonce',
    ),
    attempt(
      c.dstClient.readContract({ address: dstEndpoint, abi: v2Abi, functionName: 'inboundNonce', args: [c.dstOft, c.plan.srcEid, peerBytes32] }),
      undefined,
      'inbound nonce',
    ),
  ])
  if (!outbound.ok) return { state: { status: 'unchecked', reason: outbound.reason } }
  if (!inbound.ok) return { state: { status: 'unchecked', reason: inbound.reason } }
  const gap = outbound.value > inbound.value ? outbound.value - inbound.value : 0n
  if (gap === 0n) return { state: { status: 'pass' } }

  const newest = await scanNewest(c.srcClient, { address: c.info.oft, event: pickEvent(v2Abi, 'OFTSent') })
  if (newest.status !== 'found') {
    return {
      state: {
        status: 'unchecked',
        reason: `${gap} message(s) in flight, and how long they have been could not be established${newest.status === 'unavailable' ? `: ${newest.reason}` : ''}`,
      },
    }
  }
  const age = await daysSinceBlock(c.srcClient, newest.value.blockNumber)
  if (!age.ok) return { state: { status: 'unchecked', reason: `${gap} message(s) in flight; ${age.reason}` } }
  const minutes = age.value * 24 * 60
  // A delay, not a blocked path — see the v1 note. EndpointV2 parks nothing, so there is nothing
  // here that could be a `fail`: either the nonces are level, or messages are queued ahead of ours.
  return minutes > INFLIGHT_GRACE_MINUTES
    ? {
        state: { status: 'pass', note: `${gap} packet(s) undelivered, the oldest sent ${Math.floor(minutes)} minutes ago` },
        extra: { delayed: { packets: Number(gap), oldestMinutes: minutes } },
      }
    : { state: { status: 'pass', note: `${gap} message(s) in flight, the newest sent ${Math.floor(minutes)} minutes ago` } }
}

/** 3. The ULN configs agree, and the DVNs are ones LayerZero has not deprecated. */
async function checkConfig(c: V2RiskContext): Promise<Outcome> {
  const dstEndpoint = registryEndpoint(c)
  const sendLib = await attempt(
    c.srcClient.readContract({ address: c.info.endpoint, abi: v2Abi, functionName: 'getSendLibrary', args: [c.info.oft, c.plan.dstEid] }),
    undefined,
    'send library',
  )
  if (!sendLib.ok) return { state: { status: 'unchecked', reason: sendLib.reason } }
  const send = await attempt(
    c.srcClient.readContract({ address: sendLib.value, abi: v2Abi, functionName: 'getUlnConfig', args: [c.info.oft, c.plan.dstEid] }),
    undefined,
    'send ULN config',
  )
  if (!send.ok) return { state: { status: 'unchecked', reason: send.reason } }

  const verdict = judgeDvns(c.srcChain, [...send.value.requiredDVNs, ...send.value.optionalDVNs])
  const sendDeprecated = (): Outcome => ({
    state: { status: 'fail', reason: `deprecated DVN on the send side: ${verdict.dead.map((d) => `${d.entry.name} (${d.address})`).join(', ')}` },
    extra: { deprecatedVerifier: true, deadVerifier: verdict.dead.some((d) => d.entry.id === DEAD_DVN_ID) },
  })

  // The receive side, read on the destination's own chain from the registry's endpoint — also when
  // the send side already failed: a dead DVN on the receive side is red whatever the history says,
  // and it can only be seen by reading it.
  const recvLib = await attempt(
    c.dstClient.readContract({ address: dstEndpoint, abi: v2Abi, functionName: 'getReceiveLibrary', args: [c.dstOft, c.plan.srcEid] }),
    undefined,
    'receive library',
  )
  const recv = recvLib.ok
    ? await attempt(
        c.dstClient.readContract({ address: recvLib.value[0], abi: v2Abi, functionName: 'getUlnConfig', args: [c.dstOft, c.plan.srcEid] }),
        undefined,
        'receive ULN config',
      )
    : recvLib
  if (!recv.ok) {
    // Unread receive side: a send-side deprecated DVN is still a fact, but without the receive side
    // nothing may vouch for the route, so it is never treated as contradicted by deliveries.
    if (verdict.dead.length > 0) {
      const o = sendDeprecated()
      return { ...o, extra: { ...o.extra, deadVerifier: true } }
    }
    return { state: { status: 'unchecked', reason: recv.reason }, extra: { unknownDvnSet: verdict.unknown.length > 0 } }
  }

  const dstVerdict = judgeDvns(c.dstChain, [...recv.value.requiredDVNs, ...recv.value.optionalDVNs])
  const deadAnywhere = [...verdict.dead, ...dstVerdict.dead].some((d) => d.entry.id === DEAD_DVN_ID)
  if (verdict.dead.length > 0) {
    const o = sendDeprecated()
    return { ...o, extra: { ...o.extra, deadVerifier: deadAnywhere } }
  }
  if (dstVerdict.dead.length > 0) {
    const names = dstVerdict.dead.map((d) => `${d.entry.name} (${d.address})`).join(', ')
    return { state: { status: 'fail', reason: `deprecated DVN on the receive side: ${names}` }, extra: { deprecatedVerifier: true, deadVerifier: deadAnywhere } }
  }

  // A send set and a receive set that do not match mean a message signed by the senders' DVNs is
  // not the message the receiver will accept. §4 treats that as a block — but only when the two
  // can actually be compared, which is by operator and not by address.
  const shape = compareUlnShape(send.value, recv.value, c.srcChain, c.dstChain)
  if (shape.same === false) {
    return { state: { status: 'fail', reason: shape.why }, extra: { configMismatch: true } }
  }
  if (shape.same === 'unknown') {
    return { state: { status: 'pass', note: shape.why }, extra: { unknownDvnSet: true } }
  }
  const unknown = verdict.unknown.length > 0 || dstVerdict.unknown.length > 0
  const names = [...new Set([...verdict.healthy, ...dstVerdict.healthy].map((d) => d.entry.name))]
  return {
    state: names.length ? { status: 'pass', note: `verified by ${names.join(', ')}` } : { status: 'pass' },
    extra: { unknownDvnSet: unknown },
  }
}

type Uln = { confirmations: bigint; requiredDVNs: readonly Address[]; optionalDVNs: readonly Address[]; optionalDVNThreshold: number }

export type ShapeComparison = { same: true } | { same: false; why: string } | { same: 'unknown'; why: string }

/**
 * Will a message sent under the source's send config be accepted under the destination's receive
 * config? (`same` is kept as the field name; it means "compatible".)
 *
 * This is the check ReceiveUln302 itself makes, not a demand that the two configs look alike:
 *
 *   • Who verifies is decided by the SEND config: every required AND every optional DVN in it is
 *     assigned the packet (SendUln302 assigns jobs to both lists). The send-side optional threshold
 *     plays no part in delivery.
 *   • The RECEIVE config decides what is enough: every receive-required DVN must have verified, and
 *     at least `optionalDVNThreshold` of the receive-optional DVNs must have, each after
 *     `confirmations` blocks — which the DVNs wait out as the SEND config told them to.
 *
 * So the route works when every receive-required operator is among the send side's verifiers,
 * enough receive-optional operators are among them, and the send side waits at least as many
 * blocks as the receive side asks for. The shapes may differ freely — BEM's BNB Chain → X Layer
 * route requires {Nethermind, LayerZero Labs} + 1 of {Horizen, Canary} on send and {LayerZero Labs}
 * + 2 of {Canary, Nethermind, Horizen} on receive, and delivers every message (2026-10-17); the
 * old "same counts, same sets" rule called it broken.
 *
 * **By operator, not by address**: the same operator has a different contract on every chain, so
 * addresses are mapped to LayerZero's own DVN ids through the committed table (dvns.json, generated
 * from LayerZero's metadata). An address on either side that the table does not know means the two
 * cannot be lined up — `unknown`, never a mismatch.
 */
export function compareUlnShape(a: Uln, b: Uln, srcChain: ChainKey, dstChain: ChainKey): ShapeComparison {
  const ids = (chain: ChainKey, xs: readonly Address[]): string[] | undefined => {
    const out: string[] = []
    for (const x of xs) {
      const e = dvnInfo(chain, x)
      if (!e || !e.id) return undefined
      out.push(e.id)
    }
    return out
  }
  const sendReq = ids(srcChain, a.requiredDVNs)
  const sendOpt = ids(srcChain, a.optionalDVNs)
  const recvReq = ids(dstChain, b.requiredDVNs)
  const recvOpt = ids(dstChain, b.optionalDVNs)

  // Plain numbers mean the same thing on both chains: compared even when a DVN is unknown.
  if (a.confirmations < b.confirmations) {
    return { same: false, why: `the send side waits for ${a.confirmations} confirmations, but the receive side requires ${b.confirmations}` }
  }
  if (!sendReq || !sendOpt || !recvReq || !recvOpt) {
    return { same: 'unknown', why: 'a DVN on one side is not in LayerZero’s published list, so the two sides cannot be matched by operator' }
  }
  // ReceiveUln302 counts verifications per DVN ADDRESS. If one operator appears under two different
  // addresses on the receive side, a single send-side DVN of that operator cannot satisfy both, and
  // which one it is cannot be told from ids — so that is "cannot compare", never "compatible".
  const recvAll = [...b.requiredDVNs, ...b.optionalDVNs].map((x) => x.toLowerCase())
  const recvIds = [...recvReq, ...recvOpt]
  const seenId = new Map<string, string>()
  for (const [i, id] of recvIds.entries()) {
    const prior = seenId.get(id)
    if (prior !== undefined && prior !== recvAll[i]) {
      return { same: 'unknown', why: `the receive side lists two different ${id} DVN contracts, so it cannot be matched to the send side by operator` }
    }
    seenId.set(id, recvAll[i]!)
  }
  const verifiers = new Set([...sendReq, ...sendOpt])
  const missing = recvReq.filter((id) => !verifiers.has(id))
  if (missing.length > 0) {
    return { same: false, why: `the receive side requires ${missing.join(', ')}, which the send side never asks to verify` }
  }
  const available = new Set(recvOpt.filter((id) => verifiers.has(id))).size
  if (available < b.optionalDVNThreshold) {
    return {
      same: false,
      why: `the receive side needs ${b.optionalDVNThreshold} of its optional DVNs (${recvOpt.join(', ')}), and the send side asks only ${available} of them to verify`,
    }
  }
  return { same: true }
}

/** 4. Execute the credit on the destination OApp, called from its endpoint. */
async function checkDeliverySim(c: V2RiskContext): Promise<Outcome> {
  const dstEndpoint = registryEndpoint(c)
  const peerBytes32 = `0x${'0'.repeat(24)}${c.info.oft.slice(2).toLowerCase()}` as Hex
  const nonce = await attempt(
    c.dstClient.readContract({ address: dstEndpoint, abi: v2Abi, functionName: 'inboundNonce', args: [c.dstOft, c.plan.srcEid, peerBytes32] }),
    undefined,
    'inbound nonce',
  )
  const next = nonce.ok ? nonce.value + 1n : 1n
  const origin = { srcEid: c.plan.srcEid, sender: peerBytes32, nonce: next }
  // A guid the endpoint would have produced is not knowable here; it is not read by the OFT's
  // credit path, only echoed in its event, so a deterministic placeholder keeps the call honest
  // about what it is exercising.
  const guid = keccak256(encodePacked(['uint32', 'bytes32', 'uint64'], [c.plan.srcEid, peerBytes32, next]))
  const data = encodeFunctionData({
    abi: v2Abi,
    functionName: 'lzReceive',
    args: [origin, guid, v2Message(c.plan, c.info.conversionRate), c.dstOft, '0x'],
  })
  const call = { account: dstEndpoint, to: c.dstOft, data } as const
  const sim = await attempt(c.dstClient.call(call), undefined, 'destination credit')
  if (!sim.ok) {
    return isTransportFailure(sim.reason)
      ? { state: { status: 'unchecked', reason: sim.reason } }
      : { state: { status: 'fail', reason: `the destination would not credit this transfer: ${sim.reason}` } }
  }
  const gas = await attempt(c.dstClient.estimateGas(call), undefined, 'destination gas')
  if (!gas.ok) return { state: { status: 'pass', note: 'the destination credit succeeds; its gas could not be measured' } }
  const enforced = c.info.enforced[c.plan.dstEid] ?? '0x'
  const bought = receiveGasOf(enforced) + receiveGasOf(c.plan.extraOptions)
  const thin = bought > 0n && Number(bought) < Number(gas.value) * THIN_GAS_RATIO
  return { state: { status: 'pass', note: `the destination credit succeeds, costing ${gas.value} gas` }, extra: { thinGas: thin } }
}

/**
 * The lzReceive gas an options blob buys, read here rather than imported.
 *
 * §4's own rule: this file must not depend on the encoder whose output it is judging. Type 3
 * executor option 1 is `gas` as a uint128, optionally followed by a value.
 */
function receiveGasOf(options: Hex): bigint {
  const h = options.slice(2).toLowerCase()
  if (!h.startsWith('0003')) return 0n
  let i = 4
  let total = 0n
  while (i + 8 <= h.length) {
    const size = Number.parseInt(h.slice(i + 2, i + 6), 16)
    const optionType = Number.parseInt(h.slice(i + 6, i + 8), 16)
    const workerId = Number.parseInt(h.slice(i, i + 2), 16)
    const dataEnd = i + 6 + size * 2
    if (!Number.isFinite(size) || dataEnd > h.length) break
    if (workerId === 1 && optionType === 1) {
      const data = h.slice(i + 8, dataEnd)
      if (data.length >= 32) total += BigInt(`0x${data.slice(0, 32)}`)
    }
    i = dataEnd
  }
  return total
}

/** 5. An adapter on the destination can only release what it holds. */
async function checkAdapterLiquidity(c: V2RiskContext): Promise<Outcome> {
  const token = await attempt(c.dstClient.readContract({ address: c.dstOft, abi: oftAbi, functionName: 'token' }), undefined, 'destination token')
  if (!token.ok) return { state: { status: 'unchecked', reason: token.reason } }
  if (sameAddress(token.value, c.dstOft)) {
    return { state: { status: 'skipped', reason: 'the destination mints its own token, so it holds no reserve' } }
  }
  // token() == 0: a NativeOFTAdapter on the destination, which releases the chain's own coin — its
  // reserve is its coin balance, not an ERC-20's (core/types.ts).
  const held = sameAddress(token.value, ZERO_ADDRESS)
    ? await attempt(c.dstClient.getBalance({ address: c.dstOft }), undefined, 'adapter balance')
    : await attempt(
        c.dstClient.readContract({ address: token.value, abi: erc20Abi, functionName: 'balanceOf', args: [c.dstOft] }),
        undefined,
        'adapter balance',
      )
  if (!held.ok) return { state: { status: 'unchecked', reason: held.reason } }
  if (held.value < c.plan.quote.amountReceivedLD) {
    return {
      state: { status: 'fail', reason: `the destination adapter holds ${held.value}, less than the ${c.plan.quote.amountReceivedLD} that would arrive` },
    }
  }
  return { state: { status: 'pass', note: `the destination adapter holds ${held.value}` } }
}

/** 6. Neither side is paused. */
async function checkLimits(c: V2RiskContext): Promise<Outcome> {
  const [src, dst] = await Promise.all([
    attempt(c.srcClient.readContract({ address: c.info.oft, abi: v2Abi, functionName: 'paused' }), undefined, 'source pause'),
    attempt(c.dstClient.readContract({ address: c.dstOft, abi: v2Abi, functionName: 'paused' }), undefined, 'destination pause'),
  ])
  if (src.ok && src.value) return { state: { status: 'fail', reason: 'the source contract is paused' } }
  if (dst.ok && dst.value) return { state: { status: 'fail', reason: 'the destination contract is paused' } }
  // See the v1 note: a revert means there is no pause, an unreachable provider means this hard
  // check was never made — on EITHER side. One side reverting and the other timing out is still
  // an unmade check, not a pass.
  const transport = [src, dst].filter((a) => !a.ok).map((a) => a.reason).filter(isTransportFailure)
  if (transport.length > 0) return { state: { status: 'unchecked', reason: transport[0]! } }
  if (!src.ok && !dst.ok) return { state: { status: 'skipped', reason: 'neither side has a pause or a rate limit to read' } }
  return { state: { status: 'pass' } }
}

/** 7. Has anything ever arrived on this route? */
async function checkHistory(c: V2RiskContext): Promise<Outcome> {
  // OFTReceived is the destination contract's own event, and emitting one costs nothing. The
  // endpoint's inboundNonce for this exact (receiver, srcEid, sender) is the fact: zero there
  // means nothing has ever been delivered on this route, whatever the contract's logs say.
  const peerBytes32 = `0x${'0'.repeat(24)}${c.info.oft.slice(2).toLowerCase()}` as Hex
  const [scan, nonce] = await Promise.all([
    scanNewest(c.dstClient, { address: c.dstOft, event: pickEvent(v2Abi, 'OFTReceived') }),
    attempt(
      c.dstClient.readContract({ address: registryEndpoint(c), abi: v2Abi, functionName: 'inboundNonce', args: [c.dstOft, c.plan.srcEid, peerBytes32] }),
      undefined,
      'inbound nonce',
    ),
  ])
  if (scan.status === 'found' && nonce.ok && nonce.value === 0n) {
    return {
      state: { status: 'fail', reason: 'the destination contract logs deliveries the endpoint never made — nothing has been delivered on this route' },
      extra: { history: { kind: 'never' } },
    }
  }
  if (scan.status === 'found' && !nonce.ok) {
    // The log is the contract's word; the endpoint's nonce is what confirms it, and it was not read.
    const reason = `deliveries are logged, but the endpoint's inbound nonce could not be read (${nonce.reason})`
    return { state: { status: 'unchecked', reason }, extra: { history: { kind: 'unknown', reason } } }
  }
  if (scan.status === 'unavailable') {
    if (nonce.ok && nonce.value > 0n) {
      return { state: { status: 'pass', note: `the endpoint has delivered ${nonce.value} message(s) on this route; when, could not be read` }, extra: { history: { kind: 'unknown', reason: scan.reason } } }
    }
    return { state: { status: 'unchecked', reason: scan.reason }, extra: { history: { kind: 'unknown', reason: scan.reason } } }
  }
  if (scan.status === 'none') {
    if (nonce.ok && nonce.value > 0n) {
      const days = await windowDays(c.dstClient, scan.window)
      return {
        state: { status: 'pass', note: `the endpoint has delivered ${nonce.value} message(s) on this route, none in the window searched` },
        extra: { history: days.ok ? { kind: 'none_in_window', days: days.value } : { kind: 'unknown', reason: days.reason } },
      }
    }
    const days = await windowDays(c.dstClient, scan.window)
    if (!days.ok) {
      return {
        state: { status: 'unchecked', reason: `nothing found in ${scan.window.blocks} blocks, and the window's length could not be measured` },
        extra: { history: { kind: 'unknown', reason: days.reason } },
      }
    }
    const window = `${scan.window.blocks} blocks (${days.value < 1 ? 'under a day' : `${Math.floor(days.value)} days`})`
    return {
      state: { status: 'pass', note: `nothing delivered in the last ${window}` },
      extra: { history: { kind: 'none_in_window', days: days.value } },
    }
  }
  // The newest OFTReceived is the contract's own word, and its date is what "recent" rests on. It
  // counts only when the same transaction carries the REGISTRY endpoint's PacketDelivered for
  // exactly this (srcEid, sender) → receiver: an event the contract under test cannot write.
  const confirmed = await endpointConfirms(c, (scan.value.log as { transactionHash?: Hex }).transactionHash)
  if (!confirmed.ok) {
    const reason = `the newest delivery the contract logs is not confirmed by the endpoint (${confirmed.reason})`
    return { state: { status: 'unchecked', reason }, extra: { history: { kind: 'unknown', reason } } }
  }
  const age = await daysSinceBlock(c.dstClient, scan.value.blockNumber)
  if (!age.ok) return { state: { status: 'unchecked', reason: age.reason }, extra: { history: { kind: 'unknown', reason: age.reason } } }
  return {
    state: { status: 'pass', note: `last delivered ${age.value < 1 ? 'today' : `${Math.floor(age.value)} day(s) ago`}` },
    extra: { history: { kind: 'delivered', days: age.value } },
  }
}

/**
 * EndpointV2's PacketDelivered (ILayerZeroEndpointV2: `event PacketDelivered(Origin origin, address
 * receiver)`, Origin = (uint32 srcEid, bytes32 sender, uint64 nonce)) — checked on a live BEM
 * delivery on X Layer (tx 0x9d1e47…8e8b, nonce 1496) before it was written here.
 */
const PACKET_DELIVERED = parseAbi(['event PacketDelivered((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver)'])
const PACKET_DELIVERED_TOPIC = toEventSelector(PACKET_DELIVERED[0])

async function endpointConfirms(c: V2RiskContext, txHash: Hex | undefined): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!txHash) return { ok: false, reason: 'no transaction hash on the log' }
  const receipt = await attempt(c.dstClient.getTransactionReceipt({ hash: txHash }), undefined, 'delivery receipt')
  if (!receipt.ok) return { ok: false, reason: receipt.reason }
  const endpoint = registryEndpoint(c).toLowerCase()
  const sender = `0x${'0'.repeat(24)}${c.info.oft.slice(2).toLowerCase()}`
  for (const log of receipt.value.logs) {
    if (log.address.toLowerCase() !== endpoint || log.topics[0] !== PACKET_DELIVERED_TOPIC) continue
    try {
      const [origin, receiver] = decodeAbiParameters(PACKET_DELIVERED[0].inputs, log.data)
      if (origin.srcEid === c.plan.srcEid && origin.sender.toLowerCase() === sender && sameAddress(receiver, c.dstOft)) return { ok: true }
    } catch {
      /* not this event's shape: keep looking */
    }
  }
  return { ok: false, reason: 'no PacketDelivered from the registry endpoint for this route in that transaction' }
}

/** 8. Was the peer changed recently? */
async function checkRecentChanges(c: V2RiskContext): Promise<Outcome> {
  const scan = await scanNewest(c.srcClient, { address: c.info.oft, event: pickEvent(v2Abi, 'PeerSet') })
  if (scan.status === 'unavailable') return { state: { status: 'unchecked', reason: scan.reason } }
  if (scan.status === 'none') {
    // The rule is "changed within 7 days"; a window that reaches back less than that cannot say
    // it was not, and a provider that serves 2 000 blocks is a few hours on most chains.
    const days = await windowDays(c.srcClient, scan.window)
    if (!days.ok) return { state: { status: 'unchecked', reason: `no change found, but the window's length could not be measured: ${days.reason}` } }
    if (days.value < 7) return { state: { status: 'unchecked', reason: `the window searched covers only ${Math.max(1, Math.floor(days.value * 24))} hour(s), less than the 7 days this check is about` } }
    return { state: { status: 'pass', note: `no peer change in the last ${Math.floor(days.value)} days` } }
  }
  const age = await daysSinceBlock(c.srcClient, scan.value.blockNumber)
  if (!age.ok) return { state: { status: 'unchecked', reason: age.reason } }
  return age.value <= 7
    ? { state: { status: 'fail', reason: `the peer was changed ${Math.floor(age.value)} day(s) ago` }, extra: { recentChange: true } }
    : { state: { status: 'pass', note: `peer last changed ${Math.floor(age.value)} day(s) ago` } }
}

/** Runs all eight checks in parallel and returns the input the fold takes. */
/**
 * §Adapter The source adapter's standing, or undefined when the source is a plain OFT.
 *
 * Both numbers come from contracts the adapter's deployer does not write: the balance and supply
 * are read from the REAL token, and the nonces from the EndpointV2 that probeOft has just confirmed
 * is LayerZero's. A read that fails stays `undefined`, which adapters.adapterSignsOk() treats as a
 * failure rather than a pass.
 */
async function adapterStanding(c: V2RiskContext): Promise<AdapterStanding | null> {
  // Only an adapter that takes an ALLOWANCE. `approvalRequired === false` means it never calls
  // transferFrom, so no allowance is ever granted to it (guard 11 forbids one) and the
  // impersonation this rule is about has nothing to spend. It also holds no reserve by design, so
  // measuring its locked share would refuse a working bridge for a number that cannot apply:
  // USDT0 on HyperEVM locks 0% of supply across 23k deliveries, and is not an approve risk at all.
  //
  // A NativeOFTAdapter is the exception to that exemption: it answers false too, but it takes the
  // amount out of msg.value, so an impersonator has exactly the funds the person sends. Its
  // reserve is its coin balance, and a coin has no supply to take a share of (adapters.ts).
  const native = c.info.kind === 'NativeOFTAdapter'
  if (!native && (c.info.kind !== 'OFTAdapter' || !c.info.approvalRequired)) return null

  const [held, supply] = await Promise.all([
    native
      ? attempt(c.srcClient.getBalance({ address: c.info.oft }), undefined, 'adapter balance')
      : attempt(c.srcClient.readContract({ address: c.info.token, abi: erc20Abi, functionName: 'balanceOf', args: [c.info.oft] }), undefined, 'adapter balance'),
    native ? Promise.resolve(undefined) : attempt(c.srcClient.readContract({ address: c.info.token, abi: supplyAbi, functionName: 'totalSupply' }), undefined, 'token supply'),
  ])

  // Summed over every peer this adapter has, not just the selected route: a legitimate adapter can
  // have a brand-new route with no history while being heavily used elsewhere.
  const nonces = await Promise.all(
    c.info.routes.map((r) =>
      attempt(
        c.srcClient.readContract({ address: c.info.endpoint, abi: v2Abi, functionName: 'outboundNonce', args: [c.info.oft, r.eid, r.peer] }),
        undefined,
        'outbound nonce',
      ),
    ),
  )
  // One unreadable route makes the sum unknown rather than smaller — a partial sum could fail the
  // floor for a reason that has nothing to do with the adapter.
  const outboundNonce = nonces.every((n) => n.ok) ? nonces.reduce((t, n) => t + BigInt(n.ok ? n.value : 0n), 0n) : undefined

  if (native) return { lockedBps: undefined, outboundNonce, native: true, held: held.ok ? held.value : undefined }
  return { lockedBps: held.ok && supply?.ok ? lockedBps(held.value, supply.value) : undefined, outboundNonce }
}

export async function assessV2Route(c: V2RiskContext): Promise<RiskInput> {
  const runners: [CheckId, Promise<Outcome>][] = [
    ['peers', checkPeers(c)],
    ['path', checkPath(c)],
    ['config', checkConfig(c)],
    ['delivery_sim', checkDeliverySim(c)],
    ['adapter_liquidity', checkAdapterLiquidity(c)],
    ['limits', checkLimits(c)],
    ['history', checkHistory(c)],
    ['recent_changes', checkRecentChanges(c)],
  ]
  const settled = await Promise.all(
    runners.map(async ([id, p]): Promise<[CheckId, Outcome]> => {
      try {
        return [id, await p]
      } catch (e) {
        return [id, { state: { status: 'unchecked', reason: sanitizeText(e instanceof Error ? e.message : String(e), 160) } }]
      }
    }),
  )
  const checks = allUnchecked('not run')
  let extra: Partial<RiskInput> = {}
  for (const [id, outcome] of settled) {
    checks[id] = outcome.state
    if (outcome.extra) extra = { ...extra, ...outcome.extra }
  }
  const adapter = await adapterStanding(c)
  const merged = { history: { kind: 'unknown', reason: '' } as RiskInput['history'], delayed: undefined as RiskInput['delayed'], ...extra }
  return {
    checks,
    adapter,
    recentDeliveries: deliveringNow(checks, merged.history, merged.delayed),
    unverifiedStandard: false,
    deprecatedVerifier: false,
    unknownInfra: false,
    configMismatch: false,
    unknownDvnSet: false,
    history: { kind: 'unknown', reason: 'the history check did not report' },
    recentChange: false,
    delayed: undefined,
    thinGas: false,
    nearLimit: false,
      // Placeholder; assessRoute() overrides it. `false` is the safe default: an uncorroborated
      // route, so forgetting to pass it fails closed.
    linkCrossChecked: false,
    ...extra,
  }
}

/**
 * Is this route delivering right now, by the registry endpoints' own records? The destination
 * endpoint's inbound nonce for this exact (receiver, srcEid, sender) is above zero (check 7); the
 * newest delivery is at most RECENT_DELIVERY_DAYS old — its date is the block of a transaction in
 * which the registry endpoint itself emitted PacketDelivered for this route (endpointConfirms), so
 * the contract under test cannot backdate or invent it; and the path is level — every packet sent
 * has been verified and executed (check 2), so nothing is stuck behind today's receive config.
 */
const RECENT_DELIVERY_DAYS = 7
export function deliveringNow(checks: Record<CheckId, CheckState>, history: RiskInput['history'], delayed: RiskInput['delayed']): boolean {
  return history.kind === 'delivered' && history.days <= RECENT_DELIVERY_DAYS && checks.path.status === 'pass' && delayed === undefined
}

/** The destination-side OFT of a V2 route, from the peer bytes32. */
export function dstOftOf(info: OftInfo, dstEid: number): Address | undefined {
  const peer = info.routes.find((r) => r.eid === dstEid)?.peer
  if (!peer) return undefined
  const hex = peer.slice(2)
  if (hex.slice(0, 24) !== '0'.repeat(24)) return undefined
  return `0x${hex.slice(24)}` as Address
}

/** The destination chain of a V2 eid, when the registry serves it. */
export function dstChainOf(dstEid: number): ChainKey | undefined {
  return byEid(dstEid)?.key
}
