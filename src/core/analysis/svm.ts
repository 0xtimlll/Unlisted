/**
 * §Task 1.6: a Solana signature, in the same shape as everything else.
 *
 * The decoding itself is not repeated here — core/svm/decode.ts already turns a signature into a
 * prefill, cross-checked across RPC providers, and that is what this reads. All this adds is the
 * translation into the one result type the UI renders for every protocol, so a Solana transfer gets
 * the same verdict card, the same action and the same raw-details block as an EVM one.
 *
 * Pure: a prefill in, a verdict out. No RPC.
 */
import { byEid, byKey, type ChainKey } from '../chains'
import type { SvmTxPrefill } from '../svm/decode'
import { result, type AnalysisResult } from './result'

export const SOLANA: ChainKey = 'solana'

export type AnalyzeSvmOptions = {
  /** The signature that was looked up, for the details block. */
  signature?: string
  /** The chain the user had selected; a difference becomes the "switch network" action. */
  selected?: ChainKey
  /**
   * The OFT Store in the sample is owned by a different program than the one that executed the
   * send. The existing probe treats that as disqualifying, and so does the verdict.
   */
  programMismatch?: boolean
}

/** One Solana OFT send, as a verdict. */
export function analyzeSvmPrefill(prefill: SvmTxPrefill, opts: AnalyzeSvmOptions = {}): AnalysisResult {
  const dst = byEid(prefill.dstEid)
  const fields: Record<string, string> = {
    programId: prefill.programId,
    oftStore: prefill.oftStore,
    dstEid: String(prefill.dstEid),
    amountLD: prefill.observed.amountLD.toString(),
    minAmountLD: prefill.observed.minAmountLD.toString(),
    nativeFee: prefill.observed.nativeFee.toString(),
    from: prefill.observed.from,
    to: prefill.observed.to,
  }
  if (prefill.observed.failed) fields['sampleFailed'] = 'true'
  if (prefill.observed.hadComposeMsg) fields['hadComposeMsg'] = 'true'

  const details = {
    chain: SOLANA,
    ...(opts.signature ? { txHash: opts.signature } : {}),
    fields,
  }
  const vars = {
    address: prefill.oftStore,
    chain: byKey(SOLANA).name,
    destination: dst?.name ?? String(prefill.dstEid),
  }

  // The store must be owned by the program that ran the send; anything else is not this OFT.
  if (opts.programMismatch) {
    return result('cannot_bridge', 'lz_oapp_not_oft', { protocol: 'lz-oft', vars, details })
  }

  const switchAction = opts.selected && opts.selected !== SOLANA ? ({ kind: 'switch_chain', chain: SOLANA } as const) : undefined
  return result('can_bridge', 'lz_oft_send', {
    protocol: 'lz-oft',
    vars,
    details,
    target: {
      chain: SOLANA,
      address: prefill.oftStore,
      kind: 'oft-store',
      ...(dst ? { dstChain: dst.key } : {}),
    },
    ...(switchAction ? { action: switchAction } : { action: { kind: 'use_address', chain: SOLANA, address: prefill.oftStore } }),
  })
}
