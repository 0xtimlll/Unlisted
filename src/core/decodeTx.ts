/**
 * §5.4: turn someone else's `send` transaction into a form prefill.
 * We copy ONLY the contract, dstEid and a sanitized extraOptions (receive gas only —
 * see options.ts for why). Recipient, refund address and fee are never copied — they are
 * always recomputed for the connected wallet.
 */
import { getAddress, type Address, type Hash, type Hex } from 'viem'
import type { ReadClient } from './client'
import { byEid } from './chains'
import { sanitizeOptions, type OptionItem } from './options'
import { decodeSendCalldata } from './plan'

export type DecodeTxErrorCode = 'invalid_hash' | 'tx_not_found' | 'not_send' | 'no_to' | 'rpc_mismatch'

export class DecodeTxError extends Error {
  constructor(
    public readonly code: DecodeTxErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'DecodeTxError'
  }
}

export type TxPrefill = {
  /** tx.to — the OFT contract. Must still pass probeOft(). */
  oft: Address
  dstEid: number
  /** Sanitized: only an lzReceive gas hint survives, or '0x'. */
  extraOptions: Hex
  /** Options present in the sample that were NOT copied (nativeDrop, compose, …). */
  droppedOptions: OptionItem[]
  /** The sample's options could not even be decoded; nothing was copied. */
  optionsMalformed: boolean
  /** For display only ("this tx sent X"). Never used to build our plan. */
  observed: {
    from: Address
    amountLD: bigint
    minAmountLD: bigint
    nativeFee: bigint
    value: bigint
    hadComposeMsg: boolean
    hadOftCmd: boolean
  }
}

export function isTxHash(s: string): s is Hash {
  return /^0x[0-9a-fA-F]{64}$/.test(s)
}

export async function decodeTx(client: ReadClient, txHash: string): Promise<TxPrefill> {
  if (!isTxHash(txHash)) throw new DecodeTxError('invalid_hash')
  let tx
  try {
    tx = await client.getTransaction({ hash: txHash })
  } catch {
    throw new DecodeTxError('tx_not_found')
  }
  if (!tx) throw new DecodeTxError('tx_not_found')
  if (!tx.to) throw new DecodeTxError('no_to', 'contract creation tx')

  let decoded
  try {
    decoded = decodeSendCalldata(tx.input)
  } catch (e) {
    throw new DecodeTxError('not_send', e instanceof Error ? e.message : String(e))
  }

  const opts = sanitizeOptions(decoded.sendParam.extraOptions, byEid(decoded.sendParam.dstEid)?.vm ?? 'evm')
  return {
    oft: getAddress(tx.to),
    dstEid: decoded.sendParam.dstEid,
    extraOptions: opts.options,
    droppedOptions: opts.dropped,
    optionsMalformed: opts.malformed,
    observed: {
      from: getAddress(tx.from),
      amountLD: decoded.sendParam.amountLD,
      minAmountLD: decoded.sendParam.minAmountLD,
      nativeFee: decoded.fee.nativeFee,
      value: tx.value,
      hadComposeMsg: decoded.sendParam.composeMsg !== '0x',
      hadOftCmd: decoded.sendParam.oftCmd !== '0x',
    },
  }
}
