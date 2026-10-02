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
import { encodeFunctionData, encodePacked, keccak256, parseAbi, type Address, type Hex } from 'viem'
import { erc20Abi, oftAbi } from '../../core/abi'
import { byEid, evmByKey, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { sameAddress } from '../../core/encoding'
import { sanitizeText } from '../../core/text'
import type { EvmSendPlan } from '../../core/plan'
import type { OftInfo } from '../../core/types'
import { lockedBps, type AdapterStanding } from './adapters'
import { dvnInfo, judgeDvns } from './dvns'
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

  const srcDvns = [...send.value.requiredDVNs, ...send.value.optionalDVNs]
  const verdict = judgeDvns(c.srcChain, srcDvns)
  if (verdict.dead.length > 0) {
    const names = verdict.dead.map((d) => `${d.entry.name} (${d.address})`).join(', ')
    return { state: { status: 'fail', reason: `deprecated DVN on the send side: ${names}` }, extra: { deprecatedVerifier: true } }
  }

  // The receive side, read on the destination's own chain from the registry's endpoint.
  const recvLib = await attempt(
    c.dstClient.readContract({ address: dstEndpoint, abi: v2Abi, functionName: 'getReceiveLibrary', args: [c.dstOft, c.plan.srcEid] }),
    undefined,
    'receive library',
  )
  if (!recvLib.ok) {
    return { state: { status: 'unchecked', reason: recvLib.reason }, extra: { unknownDvnSet: verdict.unknown.length > 0 } }
  }
  const recv = await attempt(
    c.dstClient.readContract({ address: recvLib.value[0], abi: v2Abi, functionName: 'getUlnConfig', args: [c.dstOft, c.plan.srcEid] }),
    undefined,
    'receive ULN config',
  )
  if (!recv.ok) {
    return { state: { status: 'unchecked', reason: recv.reason }, extra: { unknownDvnSet: verdict.unknown.length > 0 } }
  }

  const dstVerdict = judgeDvns(c.dstChain, [...recv.value.requiredDVNs, ...recv.value.optionalDVNs])
  if (dstVerdict.dead.length > 0) {
    const names = dstVerdict.dead.map((d) => `${d.entry.name} (${d.address})`).join(', ')
    return { state: { status: 'fail', reason: `deprecated DVN on the receive side: ${names}` }, extra: { deprecatedVerifier: true } }
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
 * Do the two sides ask for the same verification?
 *
 * **Not by address.** A DVN is an operator, and the same operator has a different contract on every
 * chain — so the send side's `requiredDVNs` and the receive side's are different addresses even when
 * the route is configured perfectly. Comparing them directly reports every healthy V2 route as
 * broken, which is how this was found: three required DVNs and twenty confirmations on both sides,
 * called a mismatch.
 *
 * So the comparison is over LayerZero's own ids for those addresses, and when even one address on
 * either side is not in the committed list there is no way to line the two up — that is `unknown`,
 * never a mismatch. Counts and confirmations are compared regardless, because those are plain
 * numbers and mean the same thing on both chains.
 */
export function compareUlnShape(a: Uln, b: Uln, srcChain: ChainKey, dstChain: ChainKey): ShapeComparison {
  if (a.confirmations !== b.confirmations) {
    return { same: false, why: `the send side waits for ${a.confirmations} confirmations, the receive side for ${b.confirmations}` }
  }
  if (a.requiredDVNs.length !== b.requiredDVNs.length) {
    return { same: false, why: `the send side requires ${a.requiredDVNs.length} DVN(s), the receive side ${b.requiredDVNs.length}` }
  }
  if (a.optionalDVNThreshold !== b.optionalDVNThreshold || a.optionalDVNs.length !== b.optionalDVNs.length) {
    return {
      same: false,
      why: `the optional DVN threshold differs: ${a.optionalDVNThreshold} of ${a.optionalDVNs.length} on the send side, ${b.optionalDVNThreshold} of ${b.optionalDVNs.length} on the receive side`,
    }
  }
  const ids = (chain: ChainKey, xs: readonly Address[]): string[] | undefined => {
    const out: string[] = []
    for (const x of xs) {
      const e = dvnInfo(chain, x)
      if (!e || !e.id) return undefined
      out.push(e.id)
    }
    return out.sort()
  }
  const aReq = ids(srcChain, a.requiredDVNs)
  const bReq = ids(dstChain, b.requiredDVNs)
  const aOpt = ids(srcChain, a.optionalDVNs)
  const bOpt = ids(dstChain, b.optionalDVNs)
  if (!aReq || !bReq || !aOpt || !bOpt) {
    return { same: 'unknown', why: 'a DVN on one side is not in LayerZero’s published list, so the two sides cannot be lined up by operator' }
  }
  if (aReq.join(',') !== bReq.join(',')) {
    return { same: false, why: `the send side requires ${aReq.join(', ')}, the receive side ${bReq.join(', ')}` }
  }
  if (aOpt.join(',') !== bOpt.join(',')) {
    return { same: false, why: `the optional DVNs differ: ${aOpt.join(', ') || 'none'} against ${bOpt.join(', ') || 'none'}` }
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
  const held = await attempt(
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
  const age = await daysSinceBlock(c.dstClient, scan.value.blockNumber)
  if (!age.ok) return { state: { status: 'unchecked', reason: age.reason }, extra: { history: { kind: 'unknown', reason: age.reason } } }
  return {
    state: { status: 'pass', note: `last delivered ${age.value < 1 ? 'today' : `${Math.floor(age.value)} day(s) ago`}` },
    extra: { history: { kind: 'delivered', days: age.value } },
  }
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
  if (c.info.kind !== 'OFTAdapter' || !c.info.approvalRequired) return null

  const [held, supply] = await Promise.all([
    attempt(c.srcClient.readContract({ address: c.info.token, abi: erc20Abi, functionName: 'balanceOf', args: [c.info.oft] }), undefined, 'adapter balance'),
    attempt(c.srcClient.readContract({ address: c.info.token, abi: supplyAbi, functionName: 'totalSupply' }), undefined, 'token supply'),
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

  return { lockedBps: held.ok && supply.ok ? lockedBps(held.value, supply.value) : undefined, outboundNonce }
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
  return {
    checks,
    adapter,
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
