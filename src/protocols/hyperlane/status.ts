/**
 * Status tab: what became of a Hyperlane message, read from the two chains and nothing else.
 *
 * The source transaction's logs carry the whole message: the registry Mailbox emits
 * `Dispatch(sender, destination, recipient, message)` with the raw bytes, and `DispatchId(id)`
 * right after it. The id is keccak256 of those bytes (libs/Message.sol) and is computed here from
 * the log, then compared with the DispatchId the Mailbox announced — the way the NTT reader
 * recomputes a digest rather than trusting one. Only a `Dispatch` from the Mailbox in OUR table
 * counts: the same topic from any other contract is somebody's event, not a Hyperlane message.
 *
 * The destination then answers from its own state: the Mailbox from our table says whether the id
 * is `delivered`, and the router the message is addressed to is asked two things it can only get
 * wrong — whether it names the registry Mailbox for its chain (Router.handle accepts its own
 * mailbox and nothing else) and whether it names the dispatching router back for the origin
 * domain ("Enrolled router does not match sender"). Either mismatch means the message cannot be
 * delivered as sent; both are reported next to the state, not as the state.
 *
 * No writes. A Hyperlane message that has not been delivered is waiting on its relayer and on the
 * destination's ISM; this tab links the explorer, where the message can be re-processed by anyone
 * once the validators have signed it, and does not build that call.
 */
import { decodeEventLog, getAddress, isAddressEqual, type Address, type Hex } from 'viem'
import { byKey, isEvm, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { attempt } from '../lz-risk/probe'
import {
  bytes32ToEvmAddress,
  HYPERLANE_TOPICS,
  MAILBOX_VERSION,
  mailboxAbi,
  mailboxEventsAbi,
  parseHyperlaneMessage,
  parseTokenMessage,
  warpRouteAbi,
  warpRouteEventsAbi,
  type HyperlaneMessage,
} from './abi'
import { chainOfHyperlaneDomain, hyperlaneConfig, isHyperlaneMailbox } from './chains'

export type LogLike = { address: string; topics: readonly string[]; data: string }

/** One Hyperlane message found in a transaction. */
export type FoundHyperlaneDispatch = {
  srcChain: ChainKey
  /** The registry Mailbox that emitted it. */
  mailbox: Address
  /** The contract that dispatched: for a warp transfer, the route's router. */
  sender: Address
  message: HyperlaneMessage
  /** keccak256(message) — what the destination Mailbox is asked about. */
  messageId: Hex
  /**
   * Whether the `DispatchId` the Mailbox emitted right after names the same id. Undefined when
   * no DispatchId followed (a log set that was trimmed, or a build without the event).
   */
  idConfirmed: boolean | undefined
  dstChain: ChainKey | undefined
  /** The router the message is addressed to, when EVM-shaped. */
  recipientRouter: Address | undefined
  /** The body read as a warp TokenMessage: who gets how much, in the far token's wire units. */
  transfer: { recipient: Address | undefined; amount: bigint } | undefined
  /** The router's own `SentTransferRemote` for this destination, when it is in the same logs. */
  sentAmount: bigint | undefined
}

/**
 * Every Hyperlane message in one transaction's logs. Pure: nothing here is trusted beyond the
 * Mailbox address, which comes from our table; `diagnoseHyperlane` is where the destination's own
 * state has to answer for the rest.
 */
export function findHyperlaneDispatches(logs: readonly LogLike[], srcChain: ChainKey): FoundHyperlaneDispatch[] {
  const out: FoundHyperlaneDispatch[] = []
  const cfg = hyperlaneConfig(srcChain)
  if (!cfg || !isEvm(byKey(srcChain))) return out

  // The router's own event, keyed by destination, so an amount can be matched to a dispatch.
  const sent: { emitter: Address; destination: number; amount: bigint }[] = []
  for (const log of logs) {
    const t0 = (log.topics[0] ?? '').toLowerCase()
    if (t0 !== HYPERLANE_TOPICS.SentTransferRemote.toLowerCase()) continue
    try {
      const d = decodeEventLog({ abi: warpRouteEventsAbi, eventName: 'SentTransferRemote', data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
      sent.push({ emitter: getAddress(log.address), destination: d.args.destination, amount: d.args.amount })
    } catch {
      /* not a SentTransferRemote we can read */
    }
  }

  let last: FoundHyperlaneDispatch | undefined
  for (const log of logs) {
    const t0 = (log.topics[0] ?? '').toLowerCase()
    if (!isHyperlaneMailbox(srcChain, log.address)) continue
    const raw = { data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }

    if (t0 === HYPERLANE_TOPICS.Dispatch.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: mailboxEventsAbi, eventName: 'Dispatch', ...raw })
        const message = parseHyperlaneMessage(d.args.message)
        const sender = getAddress(d.args.sender)
        const body = parseTokenMessage(message.body)
        const match = sent.find((s) => isAddressEqual(s.emitter, sender) && s.destination === message.destination)
        last = {
          srcChain,
          mailbox: getAddress(log.address),
          sender,
          message,
          messageId: message.id,
          idConfirmed: undefined,
          dstChain: chainOfHyperlaneDomain(message.destination),
          recipientRouter: bytes32ToEvmAddress(message.recipient),
          transfer: body ? { recipient: bytes32ToEvmAddress(body.recipient), amount: body.amount } : undefined,
          sentAmount: match?.amount,
        }
        out.push(last)
      } catch {
        /* not a Dispatch we can read */
      }
      continue
    }
    if (t0 === HYPERLANE_TOPICS.DispatchId.toLowerCase() && last && last.idConfirmed === undefined) {
      const id = log.topics[1]
      last.idConfirmed = !!id && id.toLowerCase() === last.messageId.toLowerCase()
    }
  }
  return out
}

/** What the destination Mailbox says. */
export type HyperlaneMessageState =
  | { kind: 'delivered'; processedAtBlock: bigint | undefined }
  | { kind: 'in_flight' }
  | { kind: 'unknown'; reason: string }

/** What the far router says about itself — each a reason a message cannot be delivered as sent. */
export type FarRouterCheck = {
  /** It names the registry Mailbox for its chain. */
  mailboxOk: boolean | undefined
  /** It names the dispatching router as its peer for the origin domain. */
  pointsBack: boolean | undefined
}

export type HyperlaneDiagnosis = {
  dispatch: FoundHyperlaneDispatch
  state: HyperlaneMessageState
  farRouter: FarRouterCheck | undefined
}

/**
 * Reads the destination's own state for one message. The Mailbox from our table answers for the
 * id; the far router answers for itself. Every read may fail into `unknown` with its reason.
 */
export async function diagnoseHyperlane(dispatch: FoundHyperlaneDispatch, dstClient: ReadClient | undefined): Promise<HyperlaneDiagnosis> {
  const dst = dispatch.dstChain ? byKey(dispatch.dstChain) : undefined
  const dstCfg = dispatch.dstChain ? hyperlaneConfig(dispatch.dstChain) : undefined
  if (!dst || !isEvm(dst) || !dstCfg || !dstClient) {
    return { dispatch, state: { kind: 'unknown', reason: 'the destination is not a chain this app serves over Hyperlane' }, farRouter: undefined }
  }
  if (dispatch.message.version !== MAILBOX_VERSION) {
    return { dispatch, state: { kind: 'unknown', reason: `the message carries version ${dispatch.message.version}; this app reads version ${MAILBOX_VERSION}` }, farRouter: undefined }
  }

  const mailbox = getAddress(dstCfg.mailbox)
  const [delivered, processedAt, farMailbox, farPeer] = await Promise.all([
    attempt(dstClient.readContract({ address: mailbox, abi: mailboxAbi, functionName: 'delivered', args: [dispatch.messageId] }), undefined, 'delivered'),
    attempt(dstClient.readContract({ address: mailbox, abi: mailboxAbi, functionName: 'processedAt', args: [dispatch.messageId] }), undefined, 'processedAt'),
    dispatch.recipientRouter
      ? attempt(dstClient.readContract({ address: dispatch.recipientRouter, abi: warpRouteAbi, functionName: 'mailbox' }), undefined, 'mailbox')
      : Promise.resolve(undefined),
    dispatch.recipientRouter
      ? attempt(dstClient.readContract({ address: dispatch.recipientRouter, abi: warpRouteAbi, functionName: 'routers', args: [dispatch.message.origin] }), undefined, 'routers')
      : Promise.resolve(undefined),
  ])

  const farRouter: FarRouterCheck | undefined = dispatch.recipientRouter
    ? {
        mailboxOk: farMailbox?.ok ? isAddressEqual(farMailbox.value, mailbox) : undefined,
        pointsBack: farPeer?.ok ? (() => { const a = bytes32ToEvmAddress(farPeer.value); return !!a && isAddressEqual(a, dispatch.sender) })() : undefined,
      }
    : undefined

  if (!delivered.ok) return { dispatch, state: { kind: 'unknown', reason: delivered.reason }, farRouter }
  if (delivered.value) {
    // uint48 on the wire, which viem hands back as a number.
    return { dispatch, state: { kind: 'delivered', processedAtBlock: processedAt.ok && processedAt.value > 0 ? BigInt(processedAt.value) : undefined }, farRouter }
  }
  return { dispatch, state: { kind: 'in_flight' }, farRouter }
}

export type HyperlaneStatusLookup = {
  reports: HyperlaneDiagnosis[]
  /** Messages whose destination this app does not serve, kept so the tab can say so. */
  unserved: FoundHyperlaneDispatch[]
}

/** The tab's whole Hyperlane work: find, then ask each destination. */
export async function lookupHyperlaneStatus(
  logs: readonly LogLike[],
  srcChain: ChainKey,
  dstClientFor: (chain: ChainKey) => ReadClient | undefined,
): Promise<HyperlaneStatusLookup> {
  const found = findHyperlaneDispatches(logs, srcChain)
  const reports: HyperlaneDiagnosis[] = []
  const unserved: FoundHyperlaneDispatch[] = []
  for (const dispatch of found) {
    const client = dispatch.dstChain ? dstClientFor(dispatch.dstChain) : undefined
    if (!client) {
      unserved.push(dispatch)
      continue
    }
    reports.push(await diagnoseHyperlane(dispatch, client))
  }
  return { reports, unserved }
}
