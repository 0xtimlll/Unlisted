/**
 * A recipient is a 32-byte wire value plus the VM it belongs to. The VM tag is what makes
 * the worst mistake impossible: an EVM address can never become a Solana recipient, because
 * the only way to obtain `{ vm: 'svm' }` is svmRecipient(), which accepts base58 only and
 * refuses anything that looks like hex. buildSendPlan() then refuses a recipient whose vm is
 * not the destination chain's vm. No UI default can bypass this — there is no constructor for it.
 */
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { addressToBytes32 } from './encoding'
import { decodeBase58, isBase58 } from './svm/base58'

export type EvmRecipient = { vm: 'evm'; to: Hex; display: Address }
export type SvmRecipient = { vm: 'svm'; to: Hex; display: string }
export type Recipient = EvmRecipient | SvmRecipient

export type RecipientErrorCode = 'empty' | 'not_an_address' | 'looks_like_evm' | 'not_base58' | 'bad_length'

export class RecipientError extends Error {
  constructor(
    public readonly code: RecipientErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'RecipientError'
  }
}

/** 20-byte EVM address → bytes32 (left-padded) + checksummed display. */
export function evmRecipient(address: string): EvmRecipient {
  const s = address.trim()
  if (s === '') throw new RecipientError('empty')
  if (!isAddress(s, { strict: false })) throw new RecipientError('not_an_address')
  return { vm: 'evm', to: addressToBytes32(s), display: getAddress(s) }
}

/**
 * base58 Solana pubkey → bytes32. Rejects hex outright, even when it would happen to be valid
 * base58 (a `0x…` string never is, since `0` is not in the alphabet — but we do not rely on that).
 */
export function svmRecipient(base58: string): SvmRecipient {
  const s = base58.trim()
  if (s === '') throw new RecipientError('empty')
  if (/^0x/i.test(s) || /^[0-9a-fA-F]{40}$/.test(s) || /^[0-9a-fA-F]{64}$/.test(s)) throw new RecipientError('looks_like_evm')
  if (!isBase58(s)) throw new RecipientError('not_base58')
  const bytes = decodeBase58(s)
  if (bytes.length !== 32) throw new RecipientError('bad_length', `${bytes.length} bytes`)
  const to = `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
  return { vm: 'svm', to, display: s }
}

/** Non-throwing variant for form validation. */
export function tryRecipient(vm: 'evm' | 'svm', input: string): { ok: true; recipient: Recipient } | { ok: false; code: RecipientErrorCode } {
  try {
    return { ok: true, recipient: vm === 'evm' ? evmRecipient(input) : svmRecipient(input) }
  } catch (e) {
    return { ok: false, code: e instanceof RecipientError ? e.code : 'not_an_address' }
  }
}
