/**
 * §Task 1.3–1.9 + §Task 2: read a transaction's LOGS and say which bridges are in it.
 *
 * Logs, not top-level calldata: a bridge reached through a router, an aggregator, a Safe or a
 * smart wallet still emits the protocol's own events, while `tx.to` is something else entirely.
 * Everything here is pure — one receipt in, findings out — so it is fully testable offline.
 */
import { decodeEventLog, encodeEventTopics, getAddress, parseAbi, type Address, type Hex } from 'viem'
import type { ChainKey } from '../chains'
import { decodePacket, PacketError, type LzPacket } from '../lz/packet'
import { LZ_TOPICS, lzEventsAbi } from '../lz/events'
import { CCIP_TOPICS, ccipEventsAbi } from '../../protocols/ccip/abi'
import { chainOfCcipSelector } from '../../protocols/ccip/chains'
import { NTT_TOPIC_COUNT, NTT_TOPICS, nttTransferSentV1Abi, nttTransferSentV2Abi } from '../../protocols/wormhole-ntt/abi'
import { chainOfWormholeId, isCoreBridge, isTokenBridge } from '../../protocols/wormhole-ntt/chains'
import { FOREIGN_TOPICS, foreignEventsAbi, nativeBridgeAt } from './foreign'
import type { ForeignProtocolId } from './result'

/** ERC-20 events, from EIP-20 itself. Used only to describe a transaction, never to bridge. */
const erc20EventsAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
])
const ERC20_TOPICS = Object.freeze({
  Transfer: encodeEventTopics({ abi: erc20EventsAbi, eventName: 'Transfer' })[0],
  Approval: encodeEventTopics({ abi: erc20EventsAbi, eventName: 'Approval' })[0],
})

export type LogLike = { address: string; topics: readonly string[]; data: string }

export type TxLike = {
  hash?: string
  from?: string
  /** null for a contract creation. */
  to?: string | null
  /** Top-level calldata, when the provider gave it. */
  input?: string
  logs: readonly LogLike[]
}

export type Finding =
  | { kind: 'lz_oft_sent'; emitter: Address; guid: Hex; dstEid: number; fromAddress: Address; amountSentLD: bigint; amountReceivedLD: bigint }
  | { kind: 'lz_oft_received'; emitter: Address; guid: Hex; srcEid: number; toAddress: Address; amountReceivedLD: bigint }
  | { kind: 'lz_packet_sent'; emitter: Address; packet: LzPacket }
  | { kind: 'lz_packet_delivered'; emitter: Address; srcEid: number; sender: Hex; nonce: bigint; receiver: Address }
  | { kind: 'ntt_transfer'; emitter: Address; recipientChain?: number; destChain?: ChainKey; amount?: bigint; digest?: Hex }
  | { kind: 'ccip_sent'; emitter: Address; version: '1.5' | '1.6'; messageId: Hex; destChainSelector?: bigint; destChain?: ChainKey; tokens: { token: string; amount: bigint }[] }
  | { kind: 'foreign'; protocol: ForeignProtocolId; emitter: Address; label?: string; vars: Record<string, string> }
  | { kind: 'erc20'; what: 'approve' | 'transfer'; emitter: Address }

/** A safe decode: a log whose data does not match its topic is skipped, never thrown over. */
function tryDecode<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

const addr = (s: string): Address => getAddress(s)

/**
 * Everything recognisable in one transaction, in log order. `chain` is where the transaction was
 * found — it decides which canonical addresses (Portal, native bridges) apply.
 */
export function detectFindings(tx: TxLike, chain: ChainKey): Finding[] {
  const out: Finding[] = []
  let sawErc20Approve = false
  let sawErc20Transfer = false

  for (const log of tx.logs) {
    const t0 = (log.topics[0] ?? '').toLowerCase()
    const emitter = tryDecode(() => addr(log.address))
    if (!emitter) continue
    const args = { abi: lzEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }

    // ---- LayerZero ----------------------------------------------------------
    if (t0 === LZ_TOPICS.OFTSent.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ ...args, eventName: 'OFTSent' }))
      if (d) {
        out.push({
          kind: 'lz_oft_sent',
          emitter,
          guid: d.args.guid,
          dstEid: d.args.dstEid,
          fromAddress: d.args.fromAddress,
          amountSentLD: d.args.amountSentLD,
          amountReceivedLD: d.args.amountReceivedLD,
        })
        continue
      }
    }
    if (t0 === LZ_TOPICS.OFTReceived.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ ...args, eventName: 'OFTReceived' }))
      if (d) {
        out.push({ kind: 'lz_oft_received', emitter, guid: d.args.guid, srcEid: d.args.srcEid, toAddress: d.args.toAddress, amountReceivedLD: d.args.amountReceivedLD })
        continue
      }
    }
    if (t0 === LZ_TOPICS.PacketSent.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ ...args, eventName: 'PacketSent' }))
      const packet = d && tryDecode(() => decodePacket(d.args.encodedPayload))
      if (packet) {
        out.push({ kind: 'lz_packet_sent', emitter, packet })
        continue
      }
      if (d && !packet) {
        // A LayerZero packet we cannot parse is still a LayerZero packet — say so with no details.
        out.push({ kind: 'foreign', protocol: 'wormhole-other', emitter, vars: { reason: 'unparsable LayerZero packet' } })
        continue
      }
    }
    if (t0 === LZ_TOPICS.PacketDelivered.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ ...args, eventName: 'PacketDelivered' }))
      if (d) {
        out.push({ kind: 'lz_packet_delivered', emitter, srcEid: d.args.origin.srcEid, sender: d.args.origin.sender, nonce: d.args.origin.nonce, receiver: d.args.receiver })
        continue
      }
    }

    // ---- Wormhole NTT -------------------------------------------------------
    if (t0 === NTT_TOPICS.TransferSentDetailed.toLowerCase()) {
      // v1 puts everything in data, v2 indexes the first two: same topic0, different topic count.
      const abi = log.topics.length === NTT_TOPIC_COUNT.v2 ? nttTransferSentV2Abi : nttTransferSentV1Abi
      const d = tryDecode(() =>
        decodeEventLog({ abi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: 'TransferSent' }),
      )
      const a = d?.args as { amount?: bigint; recipientChain?: number } | undefined
      if (a && a.recipientChain !== undefined) {
        const destChain = chainOfWormholeId(a.recipientChain)
        out.push({
          kind: 'ntt_transfer',
          emitter,
          recipientChain: a.recipientChain,
          ...(destChain ? { destChain } : {}),
          ...(a.amount !== undefined ? { amount: a.amount } : {}),
        })
        continue
      }
    }
    if (t0 === NTT_TOPICS.TransferSentDigest.toLowerCase()) {
      const digest = log.topics[1]
      out.push({ kind: 'ntt_transfer', emitter, ...(digest ? { digest: digest as Hex } : {}) })
      continue
    }

    // ---- Chainlink CCIP -----------------------------------------------------
    if (t0 === CCIP_TOPICS.CCIPMessageSent.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ abi: ccipEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: 'CCIPMessageSent' }))
      if (d) {
        const selector = d.args.destChainSelector
        const destChain = chainOfCcipSelector(selector)
        out.push({
          kind: 'ccip_sent',
          emitter,
          version: '1.6',
          messageId: d.args.message.header.messageId,
          destChainSelector: selector,
          ...(destChain ? { destChain } : {}),
          tokens: d.args.message.tokenAmounts.map((t) => ({ token: t.sourcePoolAddress, amount: t.amount })),
        })
        continue
      }
    }
    if (t0 === CCIP_TOPICS.CCIPSendRequested.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ abi: ccipEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: 'CCIPSendRequested' }))
      if (d) {
        // v1.5 carries no destination selector; the on-ramp that emitted it is what fixes it.
        out.push({
          kind: 'ccip_sent',
          emitter,
          version: '1.5',
          messageId: d.args.message.messageId,
          tokens: d.args.message.tokenAmounts.map((t) => ({ token: t.token, amount: t.amount })),
        })
        continue
      }
    }

    // ---- Protocols we do not bridge -----------------------------------------
    if (t0 === FOREIGN_TOPICS.LogMessagePublished.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ abi: foreignEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: 'LogMessagePublished' }))
      const publisher = d?.args.sender
      // Same core bridge for everything Wormhole: only the publisher separates Portal from NTT.
      if (publisher && isTokenBridge(chain, publisher)) {
        out.push({ kind: 'foreign', protocol: 'wormhole-portal', emitter, vars: { publisher } })
      } else if (isCoreBridge(chain, emitter)) {
        out.push({ kind: 'foreign', protocol: 'wormhole-other', emitter, vars: { publisher: publisher ?? '' } })
      }
      continue
    }
    if (t0 === FOREIGN_TOPICS.InterchainTransfer.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ abi: foreignEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: 'InterchainTransfer' }))
      out.push({ kind: 'foreign', protocol: 'axelar-its', emitter, vars: { destination: d?.args.destinationChain ?? '' } })
      continue
    }
    if (t0 === FOREIGN_TOPICS.ContractCall.toLowerCase() || t0 === FOREIGN_TOPICS.ContractCallWithToken.toLowerCase()) {
      const name = t0 === FOREIGN_TOPICS.ContractCall.toLowerCase() ? 'ContractCall' : 'ContractCallWithToken'
      const d = tryDecode(() => decodeEventLog({ abi: foreignEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: name }))
      out.push({ kind: 'foreign', protocol: 'axelar', emitter, vars: { destination: d?.args.destinationChain ?? '' } })
      continue
    }
    if (t0 === FOREIGN_TOPICS.DepositForBurn.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ abi: foreignEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: 'DepositForBurn' }))
      out.push({ kind: 'foreign', protocol: 'cctp', emitter, vars: { domain: String(d?.args.destinationDomain ?? '') } })
      continue
    }
    if (t0 === FOREIGN_TOPICS.Dispatch.toLowerCase()) {
      const d = tryDecode(() => decodeEventLog({ abi: foreignEventsAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], eventName: 'Dispatch' }))
      out.push({ kind: 'foreign', protocol: 'hyperlane', emitter, vars: { destination: String(d?.args.destination ?? '') } })
      continue
    }

    // ---- The network's own bridge, by its documented address -----------------
    const native = nativeBridgeAt(chain, emitter)
    if (native) {
      out.push({ kind: 'foreign', protocol: 'native-bridge', emitter, label: native, vars: { bridge: native } })
      continue
    }

    if (t0 === ERC20_TOPICS.Approval.toLowerCase()) sawErc20Approve = true
    else if (t0 === ERC20_TOPICS.Transfer.toLowerCase()) sawErc20Transfer = true
  }

  // Plain token activity is only worth reporting when there is no bridge to talk about.
  if (out.length === 0) {
    if (sawErc20Approve) out.push({ kind: 'erc20', what: 'approve', emitter: addr(tx.to ?? `0x${'0'.repeat(40)}`) })
    else if (sawErc20Transfer) out.push({ kind: 'erc20', what: 'transfer', emitter: addr(tx.to ?? `0x${'0'.repeat(40)}`) })
  }
  return out
}

/** Every contract that emitted a log, deduplicated, in order — the raw material for "unknown". */
export function logEmitters(tx: TxLike): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of tx.logs) {
    const a = tryDecode(() => addr(l.address))
    if (a && !seen.has(a)) {
      seen.add(a)
      out.push(a)
    }
  }
  return out
}

/** The 4-byte selector of the top-level call, when there is calldata. */
export function topSelector(tx: TxLike): string | undefined {
  return tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : undefined
}

export { PacketError }
