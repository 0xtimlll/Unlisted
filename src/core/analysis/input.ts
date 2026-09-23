/**
 * §Task 1.1: what did the user paste? One search box accepts a transaction on either VM, a
 * contract address, a LayerZero GUID or a LayerZero Scan link. Nothing here touches the network.
 */
import { getAddress, isAddress, type Address, type Hash, type Hex } from 'viem'
import { isSolanaSignature, looksLikePubkey } from '../svm/ids'
import { LZ_SCAN_UI } from '../track'

export type AnalysisInput =
  /** 0x + 64 hex. A transaction hash — and, when typed bare, possibly a LayerZero GUID. */
  | { kind: 'evm_tx'; hash: Hash; mayBeGuid: boolean }
  | { kind: 'svm_tx'; signature: string }
  | { kind: 'evm_address'; address: Address }
  | { kind: 'svm_address'; address: string }
  | { kind: 'lz_guid'; guid: Hex }

export type InputErrorCode = 'empty' | 'unrecognised' | 'evm_tx_length' | 'not_our_scan_link'

export type InputParse = { ok: true; input: AnalysisInput } | { ok: false; code: InputErrorCode }

const BYTES32 = /^0x[0-9a-fA-F]{64}$/
/** A 0x string of the wrong length is almost always a truncated or over-pasted hash — say so. */
const HEXISH = /^0x[0-9a-fA-F]+$/

const LZ_SCAN_HOSTS = new Set(['layerzeroscan.com', 'www.layerzeroscan.com', new URL(LZ_SCAN_UI).hostname])

/**
 * Classifies one line of user input. `lz_guid` is only produced by an explicit LayerZero Scan
 * link — a bare bytes32 stays a transaction hash with `mayBeGuid`, because looking it up as a
 * transaction first costs nothing and is what the user usually meant.
 */
export function parseAnalysisInput(raw: string): InputParse {
  const s = raw.trim()
  if (s === '') return { ok: false, code: 'empty' }

  if (/^https?:\/\//i.test(s)) return fromUrl(s)

  if (isAddress(s, { strict: false })) return { ok: true, input: { kind: 'evm_address', address: getAddress(s) } }
  if (BYTES32.test(s)) return { ok: true, input: { kind: 'evm_tx', hash: s.toLowerCase() as Hash, mayBeGuid: true } }
  if (HEXISH.test(s)) return { ok: false, code: 'evm_tx_length' }
  if (isSolanaSignature(s)) return { ok: true, input: { kind: 'svm_tx', signature: s } }
  if (looksLikePubkey(s)) return { ok: true, input: { kind: 'svm_address', address: s } }
  return { ok: false, code: 'unrecognised' }
}

/**
 * A LayerZero Scan link. Only that host is accepted: pasting any other URL would otherwise look
 * like it was understood. The identifier is the last non-empty path segment (…/tx/<hash>,
 * …/tx/<signature>, or a bare GUID page).
 */
function fromUrl(s: string): InputParse {
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, code: 'unrecognised' }
  }
  if (!LZ_SCAN_HOSTS.has(u.hostname.toLowerCase())) return { ok: false, code: 'not_our_scan_link' }

  const parts = u.pathname.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  const viaTxPath = parts.length >= 2 && parts[parts.length - 2] === 'tx'

  if (BYTES32.test(last)) {
    const hex = last.toLowerCase() as Hex
    // /tx/<bytes32> is a source transaction; a bare bytes32 page is the message GUID.
    return viaTxPath ? { ok: true, input: { kind: 'evm_tx', hash: hex as Hash, mayBeGuid: false } } : { ok: true, input: { kind: 'lz_guid', guid: hex } }
  }
  if (isSolanaSignature(last)) return { ok: true, input: { kind: 'svm_tx', signature: last } }
  return { ok: false, code: 'unrecognised' }
}

/** Is this input a transaction we can look up on a chain? */
export function isTxInput(i: AnalysisInput): i is Extract<AnalysisInput, { kind: 'evm_tx' | 'svm_tx' }> {
  return i.kind === 'evm_tx' || i.kind === 'svm_tx'
}
