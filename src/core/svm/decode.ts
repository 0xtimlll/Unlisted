/**
 * §5.4 for Solana (stage 5): turn someone else's OFT `send` transaction (a base58 signature) into a
 * form prefill, exactly like core/decodeTx.ts does for EVM. Only the OFT Store, the destination eid
 * and a sanitized extraOptions are copied; recipient, fee payer and fee are never copied.
 *
 * The transaction is read from every RPC URL independently and the decoded prefills must agree.
 */
import type { Hex } from 'viem'
import { byEid } from '../chains'
import { DecodeTxError } from '../decodeTx'
import { sanitizeOptions, type OptionItem } from '../options'
import { decodeBase58 } from './base58'
import { isSolanaSignature } from './ids'
import { decodeSvmSendData, SEND_DISCRIMINATOR, type SvmSendData } from './plan'
import type { SvmCompiledIx, SvmRpc, SvmTransaction } from './rpc'

export type SvmTxPrefill = {
  /** accounts[2] of the send instruction — must still pass probeSvmOft(). */
  oftStore: string
  /** The program that executed `send`; probeSvmOft() must find the store owned by it. */
  programId: string
  dstEid: number
  /** Sanitized for the destination VM: only a receive-gas hint survives, or '0x'. */
  extraOptions: Hex
  droppedOptions: OptionItem[]
  optionsMalformed: boolean
  /** For display only ("this tx sent X"). Never used to build our plan. */
  observed: {
    from: string
    to: Hex
    amountLD: bigint
    minAmountLD: bigint
    nativeFee: bigint
    hadComposeMsg: boolean
    /** The sample transaction failed on-chain; its parameters are still a valid hint. */
    failed: boolean
  }
}

export type SvmDecodeResult = SvmTxPrefill & { crossChecked: boolean }

export { isSolanaSignature } from './ids'

function isSend(data: Uint8Array): boolean {
  if (data.length < 8) return false
  for (let i = 0; i < 8; i++) if (data[i] !== SEND_DISCRIMINATOR[i]) return false
  return true
}

/** Pure: the prefill from one provider's view of the transaction. */
export function prefillFromTransaction(tx: SvmTransaction): SvmTxPrefill {
  const m = tx.transaction.message
  const loaded = tx.meta?.loadedAddresses
  const keys = [...m.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])]
  const key = (i: number) => {
    const k = keys[i]
    if (k === undefined) throw new DecodeTxError('not_send', `account index ${i} out of range`)
    return k
  }

  // Top-level instructions first; a send reached through another program's CPI counts too.
  const candidates: { ix: SvmCompiledIx; data: Uint8Array }[] = []
  const consider = (ix: SvmCompiledIx) => {
    let data: Uint8Array
    try {
      data = decodeBase58(ix.data)
    } catch {
      return
    }
    if (isSend(data)) candidates.push({ ix, data })
  }
  m.instructions.forEach(consider)
  if (candidates.length === 0) for (const inner of tx.meta?.innerInstructions ?? []) inner.instructions.forEach(consider)
  if (candidates.length === 0) throw new DecodeTxError('not_send', 'no OFT send instruction')
  if (candidates.length > 1) throw new DecodeTxError('not_send', `${candidates.length} send instructions in one transaction`)
  const { ix, data } = candidates[0]!

  let d: SvmSendData
  try {
    d = decodeSvmSendData(data)
  } catch (e) {
    throw new DecodeTxError('not_send', e instanceof Error ? e.message : String(e))
  }
  // Fixed account layout of `send`: signer, peer, oftStore, tokenSource, escrow, mint, tokenProgram, eventAuthority, program.
  if (ix.accounts.length < 9) throw new DecodeTxError('not_send', `send with ${ix.accounts.length} accounts`)
  const programId = key(ix.programIdIndex)
  if (key(ix.accounts[8]!) !== programId) throw new DecodeTxError('not_send', 'program account does not match the executing program')

  const opts = sanitizeOptions(d.options, byEid(d.dstEid)?.vm ?? 'evm')
  return {
    oftStore: key(ix.accounts[2]!),
    programId,
    dstEid: d.dstEid,
    extraOptions: opts.options,
    droppedOptions: opts.dropped,
    optionsMalformed: opts.malformed,
    observed: {
      from: key(ix.accounts[0]!),
      to: d.to,
      amountLD: d.amountLd,
      minAmountLD: d.minAmountLd,
      nativeFee: d.nativeFee,
      hadComposeMsg: d.composeMsg !== null,
      failed: tx.meta?.err !== null && tx.meta?.err !== undefined,
    },
  }
}

function samePrefill(a: SvmTxPrefill, b: SvmTxPrefill): boolean {
  return (
    a.oftStore === b.oftStore && a.programId === b.programId && a.dstEid === b.dstEid &&
    a.extraOptions.toLowerCase() === b.extraOptions.toLowerCase() &&
    a.observed.from === b.observed.from && a.observed.amountLD === b.observed.amountLD && a.observed.to.toLowerCase() === b.observed.to.toLowerCase()
  )
}

export async function decodeSvmTx(rpc: SvmRpc, signature: string): Promise<SvmDecodeResult> {
  const sig = signature.trim()
  if (!isSolanaSignature(sig)) throw new DecodeTxError('invalid_hash')

  const one = async (url: string): Promise<SvmTxPrefill> => {
    let tx: SvmTransaction | null
    try {
      tx = await rpc.single(url).getTransaction(sig)
    } catch {
      throw new DecodeTxError('tx_not_found')
    }
    if (!tx) throw new DecodeTxError('tx_not_found')
    return prefillFromTransaction(tx)
  }
  const views = await Promise.allSettled(rpc.urls.map(one))
  const first = views.find((v) => v.status === 'fulfilled')
  if (!first || first.status !== 'fulfilled') {
    const e = (views[0] as PromiseRejectedResult | undefined)?.reason
    throw e instanceof Error ? e : new DecodeTxError('tx_not_found', String(e))
  }
  let crossChecked = false
  for (const v of views) {
    if (v === first) continue
    if (v.status === 'fulfilled') {
      if (!samePrefill(v.value, first.value)) throw new DecodeTxError('rpc_mismatch', 'RPC providers disagree about this transaction')
      crossChecked = true
    } else if (v.reason instanceof DecodeTxError && v.reason.code === 'not_send') {
      throw new DecodeTxError('rpc_mismatch', 'another RPC returned a different transaction')
    }
  }
  return { ...first.value, crossChecked }
}
