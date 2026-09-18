/**
 * §5.4: turn someone else's `send` transaction into a form prefill.
 * We copy ONLY the contract, dstEid and extraOptions. Recipient, refund address
 * and fee are never copied — they are always recomputed for the connected wallet.
 */
import { getAddress, type Address, type Hash, type Hex } from 'viem'
import type { ReadClient } from './client'
import { decodeSendCalldata } from './plan'

export type DecodeTxErrorCode = 'invalid_hash' | 'tx_not_found' | 'not_send' | 'no_to'

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
  extraOptions: Hex
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

  return {
    oft: getAddress(tx.to),
    dstEid: decoded.sendParam.dstEid,
    extraOptions: decoded.sendParam.extraOptions,
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
