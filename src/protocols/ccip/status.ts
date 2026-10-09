/**
 * Status tab: what became of a CCIP message, read from the two chains and nothing else.
 *
 * The source transaction's logs name the message (messageId, sequence number, destination selector —
 * each on-ramp generation says a different subset, see abi.ts). The destination then answers from
 * its own state: the router from OUR table lists its off-ramps per source chain, the off-ramp names
 * the on-ramp it serves, and only the off-ramp that names the on-ramp which emitted this message is
 * asked for `getExecutionState`. That last step is what makes the answer about THIS message: during
 * a lane upgrade a destination router lists two off-ramps for the same source, and their sequence
 * numbers are different counters.
 *
 * The on-ramp itself is anchored from the destination side (the off-ramp's config), not from the
 * source router — a message sent before a lane upgrade was emitted by an on-ramp the source router
 * no longer names, and it is still a real message on a real lane. The source router is asked only
 * for what the 1.5 event does not carry: which destination the on-ramp serves.
 *
 * No writes. A FAILURE state is CCIP's own "manual execution" case, which the CCIP Explorer offers
 * once the lane's waiting period has passed; this tab links there and does not build that call.
 */
import { decodeEventLog, getAddress, pad, type Address, type Hex } from 'viem'
import { byKey, isEvm, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { attempt } from '../lz-risk/probe'
import {
  CCIP_TOPICS,
  ccipEventsAbi,
  ccipExecutionState,
  ccipOffRamp15Abi,
  ccipOffRamp16Abi,
  ccipOffRamp20Abi,
  ccipRamp2EventsAbi,
  ccipRouterRampsAbi,
  typeAndVersionAbi,
  type CcipExecutionState,
} from './abi'
import { CCIP_CHAINS, ccipConfig, chainOfCcipSelector } from './chains'

export type LogLike = { address: string; topics: readonly string[]; data: string }

export type CcipGeneration = '1.5' | '1.6' | '2.0'

/** One CCIP message found in a transaction. */
export type FoundCcipSend = {
  srcChain: ChainKey
  version: CcipGeneration
  /** The on-ramp that emitted the event. */
  onRamp: Address
  messageId: Hex
  /** The lane's counter — what 1.5 and 1.6 off-ramps key their state by. 2.0 keys by messageId. */
  sequenceNumber: bigint | undefined
  srcSelector: bigint
  /** From the event for 1.6 / 2.0; for 1.5 only after `resolveCcipDestination`. */
  destSelector: bigint | undefined
  dstChain: ChainKey | undefined
  sender: Address | undefined
}

/**
 * Every CCIP message in one transaction's logs. Pure: the destination of a 1.5 message is not in
 * its event and is resolved separately. Nothing here is trusted yet — the emitter is whatever
 * emitted the topic, and `diagnoseCcip` is where the destination's own config has to name it.
 */
export function findCcipSends(logs: readonly LogLike[], srcChain: ChainKey): FoundCcipSend[] {
  const out: FoundCcipSend[] = []
  const cfg = ccipConfig(srcChain)
  if (!cfg || !isEvm(byKey(srcChain))) return out
  const srcSelector = cfg.selector

  for (const log of logs) {
    const t0 = (log.topics[0] ?? '').toLowerCase()
    let onRamp: Address
    try {
      onRamp = getAddress(log.address)
    } catch {
      continue
    }
    const raw = { data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }

    if (t0 === CCIP_TOPICS.CCIPMessageSent.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: ccipEventsAbi, eventName: 'CCIPMessageSent', ...raw })
        const dest = d.args.destChainSelector
        out.push({
          srcChain,
          version: '1.6',
          onRamp,
          messageId: d.args.message.header.messageId,
          sequenceNumber: d.args.message.header.sequenceNumber,
          srcSelector,
          destSelector: dest,
          dstChain: chainOfCcipSelector(dest),
          sender: getAddress(d.args.message.sender),
        })
      } catch {
        /* not a 1.6 event we can read */
      }
      continue
    }
    if (t0 === CCIP_TOPICS.CCIPMessageSentRamp2.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: ccipRamp2EventsAbi, eventName: 'CCIPMessageSent', ...raw })
        const dest = d.args.destChainSelector
        out.push({
          srcChain,
          version: '2.0',
          onRamp,
          messageId: d.args.messageId,
          sequenceNumber: undefined,
          srcSelector,
          destSelector: dest,
          dstChain: chainOfCcipSelector(dest),
          sender: getAddress(d.args.sender),
        })
      } catch {
        /* not a 2.0 event we can read */
      }
      continue
    }
    if (t0 === CCIP_TOPICS.CCIPSendRequested.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: ccipEventsAbi, eventName: 'CCIPSendRequested', ...raw })
        out.push({
          srcChain,
          version: '1.5',
          onRamp,
          messageId: d.args.message.messageId,
          sequenceNumber: d.args.message.sequenceNumber,
          srcSelector,
          destSelector: undefined,
          dstChain: undefined,
          sender: getAddress(d.args.message.sender),
        })
      } catch {
        /* not a 1.5 event we can read */
      }
    }
  }
  return out
}

/**
 * The destination of a 1.5 message: the chain whose on-ramp, as the SOURCE router names it, is the
 * contract that emitted the event. One batched read per served chain. An on-ramp the router no
 * longer names (a lane upgraded since) stays unresolved, and the diagnosis says so.
 */
export async function resolveCcipDestination(found: FoundCcipSend, srcClient: ReadClient): Promise<FoundCcipSend> {
  if (found.destSelector !== undefined) return found
  const router = ccipConfig(found.srcChain)?.router
  if (!router) return found
  const candidates = (Object.entries(CCIP_CHAINS) as [ChainKey, { selector: bigint } | undefined][]).filter(
    ([key, c]) => c && key !== found.srcChain,
  )
  const answers = await Promise.all(
    candidates.map(([, c]) =>
      attempt(
        srcClient.readContract({ address: getAddress(router), abi: ccipRouterRampsAbi, functionName: 'getOnRamp', args: [c!.selector] }),
        undefined,
        'getOnRamp',
      ),
    ),
  )
  for (let i = 0; i < candidates.length; i++) {
    const a = answers[i]!
    if (a.ok && a.value.toLowerCase() === found.onRamp.toLowerCase()) {
      const [key, c] = candidates[i]!
      return { ...found, destSelector: c!.selector, dstChain: key }
    }
  }
  return found
}

/** What the destination off-ramp says. */
export type CcipMessageState =
  | { kind: 'delivered'; offRamp: Address; offRampVersion: string }
  /** UNTOUCHED: not yet committed and executed on the destination. */
  | { kind: 'in_flight'; offRamp: Address; offRampVersion: string }
  /** IN_PROGRESS: execution has started and not finished — normally a state nobody sees. */
  | { kind: 'executing'; offRamp: Address; offRampVersion: string }
  /** FAILURE: execution reverted; CCIP's manual-execution path applies. */
  | { kind: 'failed'; offRamp: Address; offRampVersion: string }
  | { kind: 'unknown'; reason: string }

export type CcipDiagnosis = {
  send: FoundCcipSend
  state: CcipMessageState
}

const ZERO_HASH = `0x${'0'.repeat(64)}`

/** `abi.encode(address)` as a 32-byte word, or the bare 20 bytes — both are "this on-ramp". */
function namesOnRamp(encoded: Hex, onRamp: Address): boolean {
  const e = encoded.toLowerCase()
  return e === pad(onRamp, { size: 32 }).toLowerCase() || e === onRamp.toLowerCase()
}

function fromExecutionState(raw: CcipExecutionState | undefined, offRamp: Address, offRampVersion: string): CcipMessageState {
  switch (raw) {
    case 'SUCCESS':
      return { kind: 'delivered', offRamp, offRampVersion }
    case 'UNTOUCHED':
      return { kind: 'in_flight', offRamp, offRampVersion }
    case 'IN_PROGRESS':
      return { kind: 'executing', offRamp, offRampVersion }
    case 'FAILURE':
      return { kind: 'failed', offRamp, offRampVersion }
    default:
      return { kind: 'unknown', reason: `the off-ramp answered an execution state this app does not know (${String(raw)})` }
  }
}

/**
 * One off-ramp's answer about one message, or `undefined` when this off-ramp does not serve the
 * message's lane (wrong generation, or it names a different on-ramp) — then the next one is asked.
 */
async function askOffRamp(client: ReadClient, offRamp: Address, send: FoundCcipSend): Promise<CcipMessageState | undefined> {
  const tv = await attempt(client.readContract({ address: offRamp, abi: typeAndVersionAbi, functionName: 'typeAndVersion' }), undefined, 'typeAndVersion')
  if (!tv.ok) return { kind: 'unknown', reason: `${offRamp}: ${tv.reason}` }
  const version = tv.value.slice(0, 40)

  if (send.version === '1.5') {
    if (!version.startsWith('EVM2EVMOffRamp')) return undefined
    const cfg = await attempt(client.readContract({ address: offRamp, abi: ccipOffRamp15Abi, functionName: 'getStaticConfig' }), undefined, 'getStaticConfig')
    if (!cfg.ok) return { kind: 'unknown', reason: `${offRamp}: ${cfg.reason}` }
    if (cfg.value.onRamp.toLowerCase() !== send.onRamp.toLowerCase()) return undefined
    if (send.sequenceNumber === undefined) return { kind: 'unknown', reason: 'the event carried no sequence number' }
    const st = await attempt(
      client.readContract({ address: offRamp, abi: ccipOffRamp15Abi, functionName: 'getExecutionState', args: [send.sequenceNumber] }),
      undefined,
      'getExecutionState',
    )
    if (!st.ok) return { kind: 'unknown', reason: `${offRamp}: ${st.reason}` }
    return fromExecutionState(ccipExecutionState(st.value), offRamp, version)
  }

  if (send.version === '1.6') {
    if (!/^OffRamp 1\./.test(version)) return undefined
    const cfg = await attempt(
      client.readContract({ address: offRamp, abi: ccipOffRamp16Abi, functionName: 'getSourceChainConfig', args: [send.srcSelector] }),
      undefined,
      'getSourceChainConfig',
    )
    if (!cfg.ok) return { kind: 'unknown', reason: `${offRamp}: ${cfg.reason}` }
    if (!namesOnRamp(cfg.value.onRamp, send.onRamp)) return undefined
    if (send.sequenceNumber === undefined) return { kind: 'unknown', reason: 'the event carried no sequence number' }
    const st = await attempt(
      client.readContract({ address: offRamp, abi: ccipOffRamp16Abi, functionName: 'getExecutionState', args: [send.srcSelector, send.sequenceNumber] }),
      undefined,
      'getExecutionState',
    )
    if (!st.ok) return { kind: 'unknown', reason: `${offRamp}: ${st.reason}` }
    return fromExecutionState(ccipExecutionState(st.value), offRamp, version)
  }

  // 2.0
  if (!/^OffRamp 2\./.test(version)) return undefined
  const cfg = await attempt(
    client.readContract({ address: offRamp, abi: ccipOffRamp20Abi, functionName: 'getSourceChainConfig', args: [send.srcSelector] }),
    undefined,
    'getSourceChainConfig',
  )
  if (!cfg.ok) return { kind: 'unknown', reason: `${offRamp}: ${cfg.reason}` }
  if (!cfg.value.onRamps.some((r) => namesOnRamp(r, send.onRamp))) return undefined
  if (send.messageId.toLowerCase() === ZERO_HASH) return { kind: 'unknown', reason: 'the event carried no message id' }
  const st = await attempt(
    client.readContract({ address: offRamp, abi: ccipOffRamp20Abi, functionName: 'getExecutionState', args: [send.messageId] }),
    undefined,
    'getExecutionState',
  )
  if (!st.ok) return { kind: 'unknown', reason: `${offRamp}: ${st.reason}` }
  return fromExecutionState(ccipExecutionState(st.value), offRamp, version)
}

/**
 * Reads the destination's own state for one message. The router from our table lists the off-ramps;
 * the one that names the emitting on-ramp answers. Every read may fail into `unknown` with its reason.
 */
export async function diagnoseCcip(send: FoundCcipSend, dstClient: ReadClient | undefined): Promise<CcipDiagnosis> {
  const dst = send.dstChain ? byKey(send.dstChain) : undefined
  const dstCfg = send.dstChain ? ccipConfig(send.dstChain) : undefined
  if (!dst || !isEvm(dst) || !dstCfg || !dstClient) {
    return {
      send,
      state: {
        kind: 'unknown',
        reason:
          send.destSelector === undefined
            ? 'the destination could not be established: the event names none, and the source router no longer names this on-ramp'
            : 'the destination is not a chain this app serves over CCIP',
      },
    }
  }

  const ramps = await attempt(
    dstClient.readContract({ address: getAddress(dstCfg.router), abi: ccipRouterRampsAbi, functionName: 'getOffRamps' }),
    undefined,
    'getOffRamps',
  )
  if (!ramps.ok) return { send, state: { kind: 'unknown', reason: ramps.reason } }
  const forSource = ramps.value.filter((r) => r.sourceChainSelector === send.srcSelector).map((r) => getAddress(r.offRamp))
  if (forSource.length === 0) {
    return { send, state: { kind: 'unknown', reason: `the ${dst.name} router lists no off-ramp for ${byKey(send.srcChain).name}` } }
  }

  const failures: string[] = []
  for (const offRamp of forSource) {
    const answer = await askOffRamp(dstClient, offRamp, send)
    if (!answer) continue
    if (answer.kind === 'unknown') {
      failures.push(answer.reason)
      continue
    }
    return { send, state: answer }
  }
  return {
    send,
    state: {
      kind: 'unknown',
      reason: failures.length
        ? failures.join('; ')
        : `none of the ${forSource.length} off-ramp(s) the ${dst.name} router lists for ${byKey(send.srcChain).name} names the on-ramp that emitted this message`,
    },
  }
}

export type CcipStatusLookup = {
  reports: CcipDiagnosis[]
  /** Messages whose destination this app does not serve, kept so the tab can say so. */
  unserved: FoundCcipSend[]
}

/** The tab's whole CCIP work: find, resolve the 1.5 destinations, then ask each destination. */
export async function lookupCcipStatus(
  logs: readonly LogLike[],
  srcChain: ChainKey,
  srcClient: ReadClient | undefined,
  dstClientFor: (chain: ChainKey) => ReadClient | undefined,
): Promise<CcipStatusLookup> {
  const found = findCcipSends(logs, srcChain)
  const reports: CcipDiagnosis[] = []
  const unserved: FoundCcipSend[] = []
  for (let send of found) {
    if (send.destSelector === undefined && srcClient) send = await resolveCcipDestination(send, srcClient)
    const client = send.dstChain ? dstClientFor(send.dstChain) : undefined
    if (!client && send.destSelector !== undefined) {
      unserved.push(send)
      continue
    }
    // A message with no destination at all is reported, not hidden: the diagnosis says why.
    reports.push(await diagnoseCcip(send, client))
  }
  return { reports, unserved }
}
