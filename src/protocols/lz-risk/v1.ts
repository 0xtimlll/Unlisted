/**
 * §4 for LayerZero v1: the eight checks, run against the two chains in parallel.
 *
 * Each one answers with a `CheckState` and nothing else — it never decides a verdict, and it never
 * reports an RPC problem as a fact about the route. The fold lives in risk.ts, and it is the only
 * thing that turns these into a colour.
 *
 * The two that carry the most weight are worth reading closely:
 *
 *   **delivery_sim** executes the credit on the destination, with the payload the destination will
 *   actually receive, built from the contract's own codec: `abi.encode(uint16 PT_SEND, bytes to,
 *   uint256 amount)` for the `bytes` standard (OFTCore._sendAck decodes exactly that), and
 *   `abi.encodePacked(uint8 PT_SEND, bytes32 to, uint64 amountSD)` for the bytes32 ones
 *   (OFTCoreV2._decodeSendPayload requires that 41-byte shape). The call is made `from` the
 *   destination OFT itself, because NonblockingLzApp.nonblockingLzReceive requires
 *   `_msgSender() == address(this)`.
 *
 *   **path** asks two different questions that both mean "a transfer sent now would not arrive":
 *   a payload already stuck in front of it, and an outbound/inbound nonce gap that is not moving.
 *   A gap whose age cannot be established is `unchecked`, not `pass` — a gap of unknown age is
 *   exactly the case where guessing would be worst.
 */
import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, type Address, type Hex } from 'viem'
import { erc20Abi } from '../../core/abi'
import type { ReadClient } from '../../core/client'
import { sameAddress } from '../../core/encoding'
import { endpointV1Abi, isUnverifiedStandard, lzAppAbi, oftV1Abi, PT_SEND, type V1Wire } from '../lz-v1/abi'
import { lzV1 } from '../lz-v1/chains'
import type { OftV1Info } from '../lz-v1/detect'
import type { V1SendPlan } from '../lz-v1/plan'
import { dvnInfo } from './dvns'
import { attempt, daysSinceBlock, isTransportFailure, pickEvent, scanNewest, windowDays } from './probe'
import { allUnchecked, type CheckId, type CheckState, type RiskInput } from './risk'

/** An in-flight gap older than this is treated as messages not arriving, not messages travelling. */
export const STALE_INFLIGHT_MINUTES = 30
/** Below this multiple of the destination estimate, the gas bought is called thin. */
export const THIN_GAS_RATIO = 1.2

/** NonblockingLzApp + Pausable + the receive event, all read-only here. */
const v1DstAbi = parseAbi([
  'function nonblockingLzReceive(uint16 _srcChainId, bytes _srcAddress, uint64 _nonce, bytes _payload)',
  'function paused() view returns (bool)',
  'event ReceiveFromChain(uint16 indexed _srcChainId, address indexed _to, uint256 _amount)',
])

/** LzApp's configuration events — what "something changed on this route" looks like. */
const v1ChangeAbi = parseAbi([
  'event SetTrustedRemote(uint16 _remoteChainId, bytes _path)',
  'event SetTrustedRemoteAddress(uint16 _remoteChainId, bytes _remoteAddress)',
  'event SetMinDstGas(uint16 _dstChainId, uint16 _type, uint256 _minDstGas)',
])

/** ILayerZeroUltraLightNodeV2.ApplicationConfiguration, for the oracle/relayer comparison. */
const ulnConfigAbi = parseAbi([
  'struct ApplicationConfiguration { uint16 inboundProofLibraryVersion; uint64 inboundBlockConfirmations; address relayer; uint16 outboundProofType; uint64 outboundBlockConfirmations; address oracle; }',
  'function getAppConfig(uint16 _remoteChainId, address _userApplicationAddress) view returns (ApplicationConfiguration)',
  'function defaultAppConfig(uint16 _chainId) view returns (uint16 inboundProofLibraryVersion, uint64 inboundBlockConfirmations, address relayer, uint16 outboundProofType, uint64 outboundBlockConfirmations, address oracle)',
])

/**
 * The payload the destination will receive, built from the source contract's own encoder.
 *
 * Not a guess and not a copy of someone else's transfer: the same two branches OFTCore._send and
 * OFTCoreV2._send take, with this plan's recipient and this plan's amount.
 */
export function v1Payload(plan: V1SendPlan, conversionRate: bigint): Hex {
  if (plan.standard.wire === 'bytes') {
    // OFTCore._send: abi.encode(PT_SEND, _toAddress, amount) — PT_SEND is uint16 there.
    return encodeAbiParameters(
      [{ type: 'uint16' }, { type: 'bytes' }, { type: 'uint256' }],
      [PT_SEND, plan.toWire, plan.amounts.delivered],
    )
  }
  // OFTCoreV2._encodeSendPayload: abi.encodePacked(PT_SEND, _toAddress, _ld2sd(amount)).
  const amountSD = plan.amounts.delivered / conversionRate
  return encodePacked(['uint8', 'bytes32', 'uint64'], [PT_SEND, plan.toWire, amountSD])
}

export type V1RiskContext = {
  info: OftV1Info
  plan: V1SendPlan
  srcClient: ReadClient
  dstClient: ReadClient
}

type Outcome = { state: CheckState; extra?: Partial<RiskInput> }

/** 1. Both sides name each other. */
async function checkPeers(c: V1RiskContext): Promise<Outcome> {
  const route = c.info.routes.find((r) => r.key === c.plan.dst.key)
  if (!route) return { state: { status: 'fail', reason: 'the source contract has no trusted remote for this destination' } }
  const remote = route.remoteAddress
  if (!remote) return { state: { status: 'fail', reason: `the trusted remote is not an EVM path: ${route.trustedRemote.slice(0, 22)}…` } }
  const back = await attempt(
    c.dstClient.readContract({ address: remote, abi: lzAppAbi, functionName: 'trustedRemoteLookup', args: [c.info.srcV1ChainId] }),
    undefined,
    'destination trusted remote',
  )
  if (!back.ok) return { state: { status: 'unchecked', reason: back.reason } }
  const path = back.value
  if (!path || path === '0x') return { state: { status: 'fail', reason: 'the destination contract trusts no remote for this chain' } }
  const theirRemote = `0x${path.slice(2, 42)}`
  if (!sameAddress(theirRemote, c.info.oft)) {
    return { state: { status: 'fail', reason: `the destination trusts ${theirRemote} for this chain, not this contract` } }
  }
  return { state: { status: 'pass' } }
}

/** 2. Nothing stuck in front of this transfer, and the nonces are not diverging. */
async function checkPath(c: V1RiskContext): Promise<Outcome> {
  const route = c.info.routes.find((r) => r.key === c.plan.dst.key)
  const remote = route?.remoteAddress
  const dstV1 = lzV1(c.plan.dst.key)
  if (!remote || !dstV1) return { state: { status: 'unchecked', reason: 'the destination side of the route is not known yet' } }

  const pathOnDst = await attempt(
    c.dstClient.readContract({ address: remote, abi: lzAppAbi, functionName: 'trustedRemoteLookup', args: [c.info.srcV1ChainId] }),
    undefined,
    'destination path',
  )
  if (!pathOnDst.ok) return { state: { status: 'unchecked', reason: pathOnDst.reason } }
  if (!pathOnDst.value || pathOnDst.value === '0x') {
    return { state: { status: 'fail', reason: 'the destination has no path for this chain, so nothing can be delivered' } }
  }
  const srcAddress = pathOnDst.value

  const [stuck, inbound, outbound] = await Promise.all([
    attempt(
      c.dstClient.readContract({ address: dstV1.endpoint, abi: endpointV1Abi, functionName: 'hasStoredPayload', args: [c.info.srcV1ChainId, srcAddress] }),
      undefined,
      'hasStoredPayload',
    ),
    attempt(
      c.dstClient.readContract({ address: dstV1.endpoint, abi: endpointV1Abi, functionName: 'getInboundNonce', args: [c.info.srcV1ChainId, srcAddress] }),
      undefined,
      'inbound nonce',
    ),
    attempt(
      c.srcClient.readContract({ address: c.info.endpoint, abi: endpointV1Abi, functionName: 'getOutboundNonce', args: [c.plan.dst.v1ChainId, c.info.oft] }),
      undefined,
      'outbound nonce',
    ),
  ])

  if (stuck.ok && stuck.value) {
    return { state: { status: 'fail', reason: 'the destination endpoint is holding a stuck packet for this path; anything sent now waits behind it' } }
  }
  if (!stuck.ok) return { state: { status: 'unchecked', reason: stuck.reason } }
  if (!inbound.ok || !outbound.ok) {
    return { state: { status: 'unchecked', reason: (!inbound.ok ? inbound.reason : '') || (!outbound.ok ? outbound.reason : '') } }
  }
  const gap = outbound.value > inbound.value ? outbound.value - inbound.value : 0n
  if (gap === 0n) return { state: { status: 'pass' } }

  // A gap alone says nothing: it is either traffic in flight or traffic that stopped arriving. The
  // newest outbound message's age is what separates the two, and if that cannot be established the
  // check has not been made.
  const newest = await scanNewest(c.srcClient, {
    address: c.info.oft,
    event: v1SendEvent(c.info.standard.wire),
  })
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
  if (minutes > STALE_INFLIGHT_MINUTES) {
    // Not a failure of the path: the endpoint is holding nothing, so the route itself works. What it
    // means is that v1 delivers in nonce order and these are ahead of us, so a transfer sent now
    // waits for them. A delay caps the amount; it does not refuse the send. Only a stored payload
    // above does that.
    return {
      state: { status: 'pass', note: `${gap} packet(s) undelivered, the oldest sent ${Math.floor(minutes)} minutes ago` },
      extra: { delayed: { packets: Number(gap), oldestMinutes: minutes } },
    }
  }
  return { state: { status: 'pass', note: `${gap} message(s) in flight, the newest sent ${Math.floor(minutes)} minutes ago` } }
}

/** The send event of each standard, used to date the newest outbound message. */
function v1SendEvent(wire: V1Wire) {
  const abi =
    wire === 'bytes'
      ? parseAbi(['event SendToChain(uint16 indexed _dstChainId, address indexed _from, bytes _toAddress, uint256 _amount)'])
      : parseAbi(['event SendToChain(uint16 indexed dstChainId, address indexed from, bytes32 indexed toAddress, uint256 amount)'])
  return abi[0]
}

/**
 * 3. Who verifies this route, and is that a party LayerZero stands behind?
 *
 * The question is NOT whether the app kept the defaults. Plenty of live OFTs set their own oracle —
 * JOE's is Chainlink — and there is nothing to say about that. There are exactly two answers worth
 * a word, and both are read from LayerZero's own material:
 *
 *   **deprecated** — the party is in the committed list with LayerZero's `deprecated` flag set.
 *   Messages on this route are attested by something its own publisher says not to rely on. Blocks.
 *
 *   **unpublished** — the party is in neither of the two places LayerZero names its infrastructure:
 *   the committed metadata table, and the UltraLightNode's own `defaultAppConfig` for this
 *   destination. Both are LayerZero's, one off-chain and one on-chain; a party that is either is
 *   published. This alone is not a cap — the fold lets the route's delivery history answer for it.
 *
 * Counting the on-chain default matters: every live relayer read during development was the ULN's
 * own default and none of them is in the DVN feed, so judging against the table alone reported
 * LayerZero's own relayer as unknown on every route.
 */
async function checkConfig(c: V1RiskContext): Promise<Outcome> {
  const src = lzV1(c.info.chain)
  if (!src?.uln) return { state: { status: 'skipped', reason: 'this chain has no UltraLightNodeV2 to read a config from' } }
  const [app, dflt] = await Promise.all([
    attempt(
      c.srcClient.readContract({ address: src.uln, abi: ulnConfigAbi, functionName: 'getAppConfig', args: [c.plan.dst.v1ChainId, c.info.oft] }),
      undefined,
      'app config',
    ),
    attempt(
      c.srcClient.readContract({ address: src.uln, abi: ulnConfigAbi, functionName: 'defaultAppConfig', args: [c.plan.dst.v1ChainId] }),
      undefined,
      'default config',
    ),
  ])
  if (!app.ok) return { state: { status: 'unchecked', reason: app.reason } }
  if (!dflt.ok) return { state: { status: 'unchecked', reason: dflt.reason } }
  const [, , defaultRelayer, , , defaultOracle] = dflt.value

  const parties: { role: 'relayer' | 'oracle'; address: Address; isDefault: boolean }[] = [
    { role: 'relayer', address: app.value.relayer, isDefault: sameAddress(app.value.relayer, defaultRelayer) },
    { role: 'oracle', address: app.value.oracle, isDefault: sameAddress(app.value.oracle, defaultOracle) },
  ]

  const deprecated: string[] = []
  const unpublished: string[] = []
  const published: string[] = []
  for (const party of parties) {
    const entry = dvnInfo(c.info.chain, party.address)
    if (entry?.deprecated) {
      deprecated.push(`${party.role} ${entry.name} (${party.address})`)
    } else if (entry) {
      published.push(`${party.role} ${entry.name}`)
    } else if (party.isDefault) {
      published.push(`${party.role} LayerZero's default`)
    } else {
      unpublished.push(`${party.role} ${party.address}`)
    }
  }

  if (deprecated.length > 0) {
    return { state: { status: 'fail', reason: `LayerZero has deprecated this route's ${deprecated.join(', ')}` }, extra: { deprecatedVerifier: true } }
  }
  if (unpublished.length > 0) {
    return { state: { status: 'pass', note: `not published by LayerZero: ${unpublished.join(', ')}` }, extra: { unknownInfra: true } }
  }
  return { state: { status: 'pass', note: `verified by ${published.join(', ')}` } }
}

/** 4. Execute the credit on the destination, with the payload the destination will really get. */
async function checkDeliverySim(c: V1RiskContext): Promise<Outcome> {
  const route = c.info.routes.find((r) => r.key === c.plan.dst.key)
  const remote = route?.remoteAddress
  const dstV1 = lzV1(c.plan.dst.key)
  if (!remote || !dstV1) return { state: { status: 'unchecked', reason: 'the destination contract is not known yet' } }

  const pathOnDst = await attempt(
    c.dstClient.readContract({ address: remote, abi: lzAppAbi, functionName: 'trustedRemoteLookup', args: [c.info.srcV1ChainId] }),
    undefined,
    'destination path',
  )
  if (!pathOnDst.ok) return { state: { status: 'unchecked', reason: pathOnDst.reason } }
  if (!pathOnDst.value || pathOnDst.value === '0x') return { state: { status: 'fail', reason: 'the destination has no path for this chain' } }

  const nonce = await attempt(
    c.dstClient.readContract({ address: dstV1.endpoint, abi: endpointV1Abi, functionName: 'getInboundNonce', args: [c.info.srcV1ChainId, pathOnDst.value] }),
    undefined,
    'inbound nonce',
  )
  const next = nonce.ok ? nonce.value + 1n : 1n
  const data = encodeFunctionData({
    abi: v1DstAbi,
    functionName: 'nonblockingLzReceive',
    args: [c.info.srcV1ChainId, pathOnDst.value, next, v1Payload(c.plan, c.info.conversionRate)],
  })
  // `from` is the destination contract itself: NonblockingLzApp requires _msgSender() == address(this).
  const call = { account: remote, to: remote, data } as const
  const sim = await attempt(c.dstClient.call(call), undefined, 'destination credit')
  if (!sim.ok) {
    // A revert here is a real answer about the route, but an RPC that never replied is not. The
    // reason text carries whichever it was, and a reverting call names the contract's own message.
    return isTransportFailure(sim.reason)
      ? { state: { status: 'unchecked', reason: sim.reason } }
      : { state: { status: 'fail', reason: `the destination would not credit this transfer: ${sim.reason}` } }
  }
  const gas = await attempt(c.dstClient.estimateGas(call), undefined, 'destination gas')
  if (!gas.ok) return { state: { status: 'pass', note: 'the destination credit succeeds; its gas could not be measured' } }
  const bought = adapterGasOf(c.plan.adapterParams)
  const thin = bought > 0n && Number(bought) < Number(gas.value) * THIN_GAS_RATIO
  return {
    state: { status: 'pass', note: `the destination credit succeeds, costing ${gas.value} gas` },
    extra: { thinGas: thin, dstGasEstimate: gas.value } as Partial<RiskInput> & { dstGasEstimate?: bigint },
  }
}

/** The gas a type-1 adapter param buys, read here so this file owes nothing to the send path. */
function adapterGasOf(params: Hex): bigint {
  const h = params.slice(2)
  if (h.length !== 68 || !h.startsWith('0001')) return 0n
  return BigInt(`0x${h.slice(4)}`)
}

/** 5. An adapter on the destination can only release what it holds. */
async function checkAdapterLiquidity(c: V1RiskContext): Promise<Outcome> {
  const route = c.info.routes.find((r) => r.key === c.plan.dst.key)
  const remote = route?.remoteAddress
  if (!remote) return { state: { status: 'unchecked', reason: 'the destination contract is not known yet' } }
  const token = await attempt(c.dstClient.readContract({ address: remote, abi: oftV1Abi, functionName: 'token' }), undefined, 'destination token')
  if (!token.ok) return { state: { status: 'unchecked', reason: token.reason } }
  if (sameAddress(token.value, remote)) {
    return { state: { status: 'skipped', reason: 'the destination mints its own token, so it holds no reserve' } }
  }
  const held = await attempt(
    c.dstClient.readContract({ address: token.value, abi: erc20Abi, functionName: 'balanceOf', args: [remote] }),
    undefined,
    'adapter balance',
  )
  if (!held.ok) return { state: { status: 'unchecked', reason: held.reason } }
  // The destination credits what arrives, which is this plan's delivered amount.
  if (held.value < c.plan.amounts.delivered) {
    return { state: { status: 'fail', reason: `the destination adapter holds ${held.value}, less than the ${c.plan.amounts.delivered} that would arrive` } }
  }
  return { state: { status: 'pass', note: `the destination adapter holds ${held.value}` } }
}

/** 6. Neither side is paused. Rate limits are not part of the v1 OFT standard. */
async function checkLimits(c: V1RiskContext): Promise<Outcome> {
  const route = c.info.routes.find((r) => r.key === c.plan.dst.key)
  const remote = route?.remoteAddress
  const [srcPaused, dstPaused] = await Promise.all([
    attempt(c.srcClient.readContract({ address: c.info.oft, abi: v1DstAbi, functionName: 'paused' }), undefined, 'source pause'),
    remote
      ? attempt(c.dstClient.readContract({ address: remote, abi: v1DstAbi, functionName: 'paused' }), undefined, 'destination pause')
      : Promise.resolve({ ok: false, reason: 'the destination contract is not known yet' } as const),
  ])
  if (srcPaused.ok && srcPaused.value) return { state: { status: 'fail', reason: 'the source contract is paused' } }
  if (dstPaused.ok && dstPaused.value) return { state: { status: 'fail', reason: 'the destination contract is paused' } }
  if (!srcPaused.ok && !dstPaused.ok) {
    // Both reads failed, and why decides everything. A contract that reverts has no `paused()`, so
    // there is nothing to check and `skipped` is honest. A provider that never answered leaves this
    // hard check unmade, and calling that `skipped` would let the verdict reach OK on a route whose
    // pause state nobody established.
    const transport = [srcPaused.reason, dstPaused.reason].filter(isTransportFailure)
    return transport.length > 0
      ? { state: { status: 'unchecked', reason: transport[0]! } }
      : { state: { status: 'skipped', reason: 'neither side has a pause or a rate limit to read' } }
  }
  return { state: { status: 'pass' } }
}

/** 7. Has anything ever arrived on this route? */
async function checkHistory(c: V1RiskContext): Promise<Outcome> {
  const route = c.info.routes.find((r) => r.key === c.plan.dst.key)
  const remote = route?.remoteAddress
  if (!remote) return { state: { status: 'unchecked', reason: 'the destination contract is not known yet' } }
  const scan = await scanNewest(c.dstClient, {
    address: remote,
    event: pickEvent(v1DstAbi, 'ReceiveFromChain'),
    args: { _srcChainId: c.info.srcV1ChainId },
  })
  if (scan.status === 'unavailable') {
    return { state: { status: 'unchecked', reason: scan.reason }, extra: { history: { kind: 'unknown', reason: scan.reason } } }
  }
  if (scan.status === 'none') {
    // How far back the window really reached, from the chain's own timestamps. Without this the
    // answer would rest on an assumed block time, which is wrong by an order of magnitude on an L2.
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

/** 8. Was the route reconfigured recently? */
async function checkRecentChanges(c: V1RiskContext): Promise<Outcome> {
  const scans = await Promise.all(
    (['SetTrustedRemote', 'SetTrustedRemoteAddress', 'SetMinDstGas'] as const).map((name) =>
      scanNewest(c.srcClient, { address: c.info.oft, event: pickEvent(v1ChangeAbi, name) }),
    ),
  )
  const found = scans.filter((s) => s.status === 'found') as Extract<(typeof scans)[number], { status: 'found' }>[]
  if (found.length === 0) {
    const unavailable = scans.find((s) => s.status === 'unavailable')
    return unavailable && unavailable.status === 'unavailable'
      ? { state: { status: 'unchecked', reason: unavailable.reason } }
      : { state: { status: 'pass', note: 'no configuration change in the window searched' } }
  }
  const newest = found.reduce((a, b) => (b.value.blockNumber > a.value.blockNumber ? b : a))
  const age = await daysSinceBlock(c.srcClient, newest.value.blockNumber)
  if (!age.ok) return { state: { status: 'unchecked', reason: age.reason } }
  return age.value <= 7
    ? { state: { status: 'fail', reason: `the route was reconfigured ${Math.floor(age.value)} day(s) ago` }, extra: { recentChange: true } }
    : { state: { status: 'pass', note: `last reconfigured ${Math.floor(age.value)} day(s) ago` } }
}

export type V1Assessment = { input: RiskInput; dstGasEstimate: bigint | undefined }

/**
 * Runs all eight checks in parallel and returns the input the fold takes.
 *
 * Parallel because §4 asks for the whole panel in 1–3 seconds, and independent because one check
 * failing must not stop another from answering.
 */
export async function assessV1Route(c: V1RiskContext): Promise<V1Assessment> {
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
        // A check must not be able to take the panel down with it.
        return [id, { state: { status: 'unchecked', reason: e instanceof Error ? e.message.slice(0, 160) : String(e) } }]
      }
    }),
  )

  const checks = allUnchecked('not run')
  let extra: Partial<RiskInput> = {}
  let dstGasEstimate: bigint | undefined
  for (const [id, outcome] of settled) {
    checks[id] = outcome.state
    if (outcome.extra) {
      const { dstGasEstimate: gas, ...rest } = outcome.extra as Partial<RiskInput> & { dstGasEstimate?: bigint }
      if (gas !== undefined) dstGasEstimate = gas
      extra = { ...extra, ...rest }
    }
  }

  return {
    input: {
      checks,
      unverifiedStandard: isUnverifiedStandard(c.info.standard),
      deprecatedVerifier: false,
      unknownInfra: false,
      configMismatch: false,
      unknownDvnSet: false,
      history: { kind: 'unknown', reason: 'the history check did not report' },
      recentChange: false,
      delayed: undefined,
      thinGas: false,
      nearLimit: false,
      testVerified: false,
      ...extra,
    },
    dstGasEstimate,
  }
}
