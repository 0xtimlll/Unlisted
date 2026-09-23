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
import { result, type AnalysisDetails, type AnalysisResult } from './result'

export type AnalyzeOptions = {
  /** The chain the transaction was actually found on. */
  chain: ChainKey
  /** The chain the user had selected. A difference becomes the "switch network" action. */
  selected?: ChainKey
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

/** The result for a protocol we have a tab for: open it, or say its bridge is not built yet. */
function protocolResult(
  protocol: ProtocolId,
  chain: ChainKey,
  details: AnalysisDetails,
  vars: Record<string, string>,
  target?: AnalysisResult['target'],
): AnalysisResult {
  const implemented = IMPLEMENTED.has(protocol)
  return result(implemented ? 'can_bridge' : 'cannot_bridge', implemented ? 'switch_protocol' : 'protocol_not_implemented', {
    protocol,
    vars,
    details,
    action: { kind: 'open_tab', protocol },
    ...(target ? { target } : {}),
  })
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
      return protocolResult('wormhole-ntt', chain, details, { address: f.emitter, chain: chainName, destination: f.destChain ? byKey(f.destChain).name : '' }, {
        chain,
        address: f.emitter,
        kind: 'ntt-manager',
        ...(f.destChain ? { dstChain: f.destChain } : {}),
      })
    }
    case 'ccip_sent': {
      details.fields = {
        messageId: f.messageId,
        version: f.version,
        ...(f.destChainSelector !== undefined ? { destChainSelector: f.destChainSelector.toString() } : {}),
        ...(f.tokens.length ? { tokens: f.tokens.map((t) => `${t.token}:${t.amount}`).join(' ') } : {}),
      }
      const token = f.tokens[0]?.token
      return protocolResult('ccip', chain, details, { address: f.emitter, chain: chainName, destination: f.destChain ? byKey(f.destChain).name : '' }, {
        chain,
        address: f.emitter,
        kind: 'ccip-token',
        ...(token ? { token } : {}),
        ...(f.destChain ? { dstChain: f.destChain } : {}),
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
  return findings.map((f) => fromFinding(f, tx, opts))
}

/** True when the user has to choose which bridge in the transaction they mean. */
export function needsChoice(results: readonly AnalysisResult[]): boolean {
  return results.length > 1
}
