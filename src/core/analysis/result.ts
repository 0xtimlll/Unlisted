/**
 * §Task 3: one shape for every answer the analysis can give, whichever protocol produced it.
 *
 * Text is NOT stored here. A result carries a stable `code` plus `vars`, and the dictionary turns
 * them into a title, a reason and an action — the same discipline as core/guards.ts, so the whole
 * analysis layer stays pure and testable without React.
 */
import type { ChainKey } from '../chains'
import type { ProtocolId } from '../protocols'

export type Verdict = 'can_bridge' | 'cannot_bridge' | 'unknown'

/** Protocols we recognise in order to say "not here, go there". We never bridge these. */
export const FOREIGN_PROTOCOL_IDS = [
  'wormhole-portal',
  'wormhole-other',
  'axelar',
  'axelar-its',
  'cctp',
  'hyperlane',
  'native-bridge',
] as const
export type ForeignProtocolId = (typeof FOREIGN_PROTOCOL_IDS)[number]

export type AnyProtocolId = ProtocolId | ForeignProtocolId

export function isForeignProtocol(id: AnyProtocolId): id is ForeignProtocolId {
  return (FOREIGN_PROTOCOL_IDS as readonly string[]).includes(id)
}

/** Every outcome the analysis can reach. One code = one sentence in the dictionary. */
export type AnalysisCode =
  // --- LayerZero OFT ---------------------------------------------------------
  | 'lz_oft_send' // an OFT send: we know the contract and the destination
  | 'lz_oft_receive' // the receiving side of a transfer: the OFT on THIS chain
  | 'lz_packet_no_oft' // a LayerZero packet whose OApp still has to be probed
  | 'lz_oapp_not_oft' // a LayerZero app, but not an OFT — bridge on the project's own site
  // --- another protocol we support -------------------------------------------
  | 'switch_protocol' // recognised and implemented: open that tab
  | 'protocol_not_implemented' // recognised, its bridge is not built yet
  // --- protocols we will never bridge ----------------------------------------
  | 'foreign_protocol'
  // --- ordinary transactions --------------------------------------------------
  | 'plain_approve'
  | 'plain_transfer'
  // --- input / lookup ----------------------------------------------------------
  | 'invalid_input'
  | 'tx_not_found'
  | 'unknown' // nothing recognised; details carry the raw material

/*
 * "found on another chain" and "more than one bridge here" are not codes: the first is the
 * `switch_chain` action on an otherwise normal result, the second is simply more than one result.
 * A failed lookup is reported through SearchResult.failed, never as a verdict.
 */

/** What the user can do about it. The UI renders exactly one button from this. */
export type AnalysisAction =
  | { kind: 'switch_chain'; chain: ChainKey }
  | { kind: 'open_tab'; protocol: ProtocolId }
  | { kind: 'use_address'; chain: ChainKey; address: string }
  | { kind: 'open_url'; url: string }
  | { kind: 'choose'; count: number }

/** The contract the user should act on, once we know it. */
export type AnalysisTarget = {
  chain: ChainKey
  /** EVM address (EIP-55) or a Solana base58 key. */
  address: string
  kind: 'oft' | 'oft-store' | 'lz-oapp' | 'ntt-manager' | 'ccip-token'
  /** The ERC-20 / mint being moved, when it differs from `address`. */
  token?: string
  /** Destination the sample used, as that protocol numbers its chains. */
  dstChain?: ChainKey
}

/** Raw material, always shown behind a disclosure so a wrong verdict can still be debugged. */
export type AnalysisDetails = {
  chain?: ChainKey
  txHash?: string
  /** tx.to — when it is not the protocol contract, the bridge went through a router or a wallet. */
  to?: string
  /** True when `to` is not the contract that emitted the bridge event. */
  indirect?: boolean
  /** First 4 bytes of the top-level calldata. */
  selector?: string
  /** Every contract that emitted a log, deduplicated, in order. */
  logEmitters?: string[]
  /** Protocol-specific identifiers worth showing verbatim (guid, messageId, nonce…). */
  fields?: Record<string, string>
}

export type AnalysisResult = {
  verdict: Verdict
  /** null when nothing was recognised. */
  protocol: AnyProtocolId | null
  code: AnalysisCode
  /** Values for the dictionary's `{placeholders}`. Always strings — never rendered as HTML. */
  vars: Record<string, string>
  action?: AnalysisAction
  target?: AnalysisTarget
  details: AnalysisDetails
}

/** Small constructor so every call site produces the same shape. */
export function result(
  verdict: Verdict,
  code: AnalysisCode,
  rest: Partial<Omit<AnalysisResult, 'verdict' | 'code'>> = {},
): AnalysisResult {
  return {
    verdict,
    code,
    protocol: rest.protocol ?? null,
    vars: rest.vars ?? {},
    details: rest.details ?? {},
    ...(rest.action ? { action: rest.action } : {}),
    ...(rest.target ? { target: rest.target } : {}),
  }
}
