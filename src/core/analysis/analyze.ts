/**
 * §Task 1.3 + §Task 3: turn the findings of one transaction into the verdicts the UI shows.
 *
 * One result per bridge found, in log order, so a transaction carrying two bridges produces two
 * results and the user picks. Pure: no RPC, no React. A verdict here is a statement about what the
 * transaction contains — never a permission to sign anything.
 */
import { byEid, byKey, type ChainKey } from '../chains'
import { IMPLEMENTED, type ProtocolId } from '../protocols'
import { detectFindings, logEmitters, topSelector, type Finding, type TxLike } from './detect'
import { FOREIGN_LINK } from './foreign'
import { isForeignProtocol, result, type AnalysisDetails, type AnalysisResult } from './result'

export type AnalyzeOptions = {
  /** The chain the transaction was actually found on. */
  chain: ChainKey
  /** The chain the user had selected. A difference becomes the "switch network" action. */
  selected?: ChainKey
  /**
   * The protocol tab this was pasted into. Every tab reads the same transaction the same way —
   * what changes is what can be done about it, because a form belongs to one protocol. Defaults
   * to the OFT tab, which is the only one that used to analyse anything.
   */
  tab?: ProtocolId
}

/** Details shared by every result for this transaction. */
function baseDetails(tx: TxLike, chain: ChainKey, emitter?: string): AnalysisDetails {
  const to = tx.to ?? undefined
  const d: AnalysisDetails = { chain, logEmitters: logEmitters(tx) }
  if (tx.hash) d.txHash = tx.hash
  if (to) d.to = to
  if (emitter && to && to.toLowerCase() !== emitter.toLowerCase()) d.indirect = true
  const sel = topSelector(tx)
  if (sel) d.selector = sel
  return d
}

/**
 * Transport layers are not bridges of their own. A LayerZero packet carries the OFT send, and a
 * Wormhole core message carries the NTT transfer, in the same transaction — reporting both would
 * make every transfer look like two bridges and put the transport first.
 */
function dropRedundantPackets(findings: Finding[]): Finding[] {
  const oftGuids = new Set(findings.filter((f) => f.kind === 'lz_oft_sent').map((f) => f.guid.toLowerCase()))
  const receivedGuids = new Set(findings.filter((f) => f.kind === 'lz_oft_received').map((f) => f.guid.toLowerCase()))
  const hasNtt = findings.some((f) => f.kind === 'ntt_transfer')
  return findings.filter((f) => {
    if (f.kind === 'lz_packet_sent') return !oftGuids.has(f.packet.guid.toLowerCase())
    if (f.kind === 'lz_packet_delivered') return receivedGuids.size === 0
    // NTT publishes through the core bridge; Portal stays, because that IS the bridge.
    if (f.kind === 'foreign' && f.protocol === 'wormhole-other') return !hasNtt
    return true
  })
}

/**
 * The same verdict, re-answered for the tab it was pasted into.
 *
 * `fromFinding` describes a transaction as its own protocol's tab would read it — that is the
 * honest reading, and it is the one the tab that owns the protocol needs. But a form belongs to
 * one protocol: an OFT send cannot be rebuilt from the CCIP tab any more than a CCIP transfer can
 * be rebuilt from the OFT tab. So when the protocol is not this tab's, the one useful thing left
 * is to say which tab it is and carry the target over — the verdict itself is not touched, because
 * where a transaction was pasted says nothing about what it contains.
 */
export function forTab(r: AnalysisResult, tab: ProtocolId): AnalysisResult {
  const p = r.protocol
  // Nothing recognised, or a protocol we never bridge (it already links to its own app), or the
  // tab that owns it — all answered where they are.
  if (!p || isForeignProtocol(p) || p === tab) return r
  if (!IMPLEMENTED.has(p)) {
    return { ...r, verdict: 'cannot_bridge', code: 'protocol_not_implemented', action: { kind: 'open_tab', protocol: p } }
  }
  return { ...r, code: 'switch_protocol', action: { kind: 'open_tab', protocol: p } }
}

function fromFinding(f: Finding, tx: TxLike, opts: AnalyzeOptions): AnalysisResult {
  const { chain, selected } = opts
  const emitter = 'emitter' in f ? f.emitter : undefined
  const details = baseDetails(tx, chain, emitter)
  /** Display name, never the registry key: these values are read by people. */
  const chainName = byKey(chain).name
  /** When the transaction lives on another chain, switching is the first thing to do. */
  const switchAction = selected && selected !== chain ? ({ kind: 'switch_chain', chain } as const) : undefined

  switch (f.kind) {
    case 'lz_oft_sent': {
      const dst = byEid(f.dstEid)
      details.fields = { guid: f.guid, dstEid: String(f.dstEid), amountSentLD: f.amountSentLD.toString(), amountReceivedLD: f.amountReceivedLD.toString() }
      return result('can_bridge', 'lz_oft_send', {
        protocol: 'lz-oft',
        vars: { address: f.emitter, chain: chainName, destination: dst?.name ?? String(f.dstEid) },
        details,
        target: { chain, address: f.emitter, kind: 'oft', ...(dst ? { dstChain: dst.key } : {}) },
        ...(switchAction ? { action: switchAction } : {}),
      })
    }
    case 'lz_oft_received': {
      const src = byEid(f.srcEid)
      details.fields = { guid: f.guid, srcEid: String(f.srcEid), amountReceivedLD: f.amountReceivedLD.toString() }
      return result('can_bridge', 'lz_oft_receive', {
        protocol: 'lz-oft',
        vars: { address: f.emitter, chain: chainName, source: src?.name ?? String(f.srcEid) },
        details,
        target: { chain, address: f.emitter, kind: 'oft' },
        action: switchAction ?? { kind: 'use_address', chain, address: f.emitter },
      })
    }
    case 'lz_packet_sent': {
      // The packet names the OApp but not what kind it is: probing the address decides.
      const dst = byEid(f.packet.dstEid)
      const senderHex = f.packet.sender
      const evmSender = /^0x0{24}[0-9a-f]{40}$/i.test(senderHex) ? (`0x${senderHex.slice(26)}` as string) : undefined
      details.fields = { guid: f.packet.guid, srcEid: String(f.packet.srcEid), dstEid: String(f.packet.dstEid), sender: senderHex, nonce: f.packet.nonce.toString() }
      return result('unknown', 'lz_packet_no_oft', {
        protocol: 'lz-oft',
        vars: { address: evmSender ?? senderHex, chain: chainName, destination: dst?.name ?? String(f.packet.dstEid) },
        details,
        ...(evmSender ? { target: { chain, address: evmSender, kind: 'lz-oapp' as const, ...(dst ? { dstChain: dst.key } : {}) } } : {}),
        ...(switchAction ? { action: switchAction } : evmSender ? { action: { kind: 'use_address', chain, address: evmSender } } : {}),
      })
    }
    case 'lz_packet_delivered': {
      const src = byEid(f.srcEid)
      details.fields = { srcEid: String(f.srcEid), sender: f.sender, nonce: f.nonce.toString() }
      return result('unknown', 'lz_packet_no_oft', {
        protocol: 'lz-oft',
        vars: { address: f.receiver, chain: chainName, destination: src?.name ?? String(f.srcEid) },
        details,
        target: { chain, address: f.receiver, kind: 'lz-oapp' },
        action: switchAction ?? { kind: 'use_address', chain, address: f.receiver },
      })
    }
    case 'ntt_transfer': {
      details.fields = {
        manager: f.emitter,
        ...(f.recipientChain !== undefined ? { recipientChain: String(f.recipientChain) } : {}),
        ...(f.amount !== undefined ? { amount: f.amount.toString() } : {}),
        ...(f.digest ? { digest: f.digest } : {}),
      }
      return result('can_bridge', 'ntt_transfer', {
        protocol: 'wormhole-ntt',
        vars: { address: f.emitter, chain: chainName, destination: f.destChain ? byKey(f.destChain).name : '' },
        details,
        target: { chain, address: f.emitter, kind: 'ntt-manager', ...(f.destChain ? { dstChain: f.destChain } : {}) },
        action: switchAction ?? { kind: 'use_address', chain, address: f.emitter },
      })
    }
    case 'ccip_sent': {
      details.fields = {
        messageId: f.messageId,
        version: f.version,
        ...(f.destChainSelector !== undefined ? { destChainSelector: f.destChainSelector.toString() } : {}),
        ...(f.transfers.length ? { [f.transfers[0]!.is === 'token' ? 'tokens' : 'pools']: f.transfers.map((t) => `${t.address}:${t.amount}`).join(' ') } : {}),
      }
      // Only a real token may be carried into the CCIP tab's form — its field is an ERC-20, and a
      // pool address pasted there finds no pool at all. The newer on-ramps name no token, so the
      // tab opens on the right chain with an empty field rather than a wrong one.
      const first = f.transfers[0]
      const token = first?.is === 'token' ? first.address : undefined
      return result('can_bridge', 'ccip_send', {
        protocol: 'ccip',
        vars: {
          address: token ?? f.emitter,
          chain: chainName,
          // The selector when we do not serve that chain, so the sentence never trails off — v1.5
          // alone carries neither, because its event names no destination at all.
          destination: f.destChain ? byKey(f.destChain).name : f.destChainSelector !== undefined ? String(f.destChainSelector) : '',
        },
        details,
        target: { chain, address: f.emitter, kind: 'ccip-token', ...(token ? { token } : {}), ...(f.destChain ? { dstChain: f.destChain } : {}) },
        // The CCIP form starts from the TOKEN; the emitter is the onRamp, which it never takes.
        ...(switchAction ? { action: switchAction } : token ? { action: { kind: 'use_address' as const, chain, address: token } } : {}),
      })
    }
    case 'foreign': {
      const url = FOREIGN_LINK[f.protocol]
      details.fields = { emitter: f.emitter, ...f.vars }
      return result('cannot_bridge', 'foreign_protocol', {
        protocol: f.protocol,
        vars: { ...f.vars, address: f.emitter, chain: chainName, ...(f.label ? { bridge: f.label } : {}) },
        details,
        ...(url ? { action: { kind: 'open_url', url } } : {}),
      })
    }
    case 'erc20':
      return result('cannot_bridge', f.what === 'approve' ? 'plain_approve' : 'plain_transfer', { vars: { chain: chainName }, details })
  }
}

/**
 * Every bridge in one transaction, as verdicts. Never empty: when nothing is recognised the single
 * result is `unknown` and carries the raw material (to, selector, log emitters).
 */
export function analyzeTx(tx: TxLike, opts: AnalyzeOptions): AnalysisResult[] {
  const findings = dropRedundantPackets(detectFindings(tx, opts.chain))
  if (findings.length === 0) {
    return [result('unknown', 'unknown', { vars: { chain: byKey(opts.chain).name }, details: baseDetails(tx, opts.chain) })]
  }
  const tab = opts.tab ?? 'lz-oft'
  return findings.map((f) => forTab(fromFinding(f, tx, opts), tab))
}

/** True when the user has to choose which bridge in the transaction they mean. */
export function needsChoice(results: readonly AnalysisResult[]): boolean {
  return results.length > 1
}
