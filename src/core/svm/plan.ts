/**
 * Solana-source send plan (§6): the exact `send` instruction the wallet will sign, as data, plus
 * our own codec for it. The instruction itself is produced by the LayerZero SDK (svm/send.ts);
 * everything here is independent of the SDK so that the self-check (guard 14) decodes what the
 * SDK built with code the SDK never touched — the Solana counterpart of decoding our calldata.
 */
import type { Hex } from 'viem'
import { sha256 } from '@noble/hashes/sha2'
import type { AmountBreakdown, SendQuote } from '../plan'
import type { SelfCheckResult } from '../guards'
import { findProgramAddress, PROGRAM, pubkeyFromBase58, pubkeyFromHex, pubkeyToBase58, pubkeyToHex, u32be, utf8 } from './pubkey'
import type { TokenProgram } from './discover'

/**
 * LayerZero's mainnet address lookup table. A `send` references ~50 accounts; without the table the
 * transaction does not fit in 1232 bytes (verified: building without it throws). Infrastructure,
 * like the endpoint program id — not a token address.
 */
export const LZ_MAINNET_LOOKUP_TABLE = 'AokBxha6VMLLgf97B5VYHEtqztamWmYERBmmFvjuTzJB'

export { BASE_FEE_LAMPORTS, MAX_COMPUTE_UNITS, PRIORITY_FEE_MAX, PRIORITY_FEE_MIN } from './fees'

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

export type SvmSendPlan = {
  vm: 'svm'
  /** base58 OFT Store — the "contract" on Solana. */
  oftStore: string
  /** base58 OFT program that owns the store; the instruction's program id. */
  programId: string
  tokenMint: string
  tokenEscrow: string
  tokenProgram: TokenProgram
  /** base58 PeerConfig PDA for dstEid (writable account #1 of the instruction). */
  peerConfig: string
  /** The destination OFT as bytes32 (PeerConfig.peerAddress) — the EVM contract that will receive. */
  dstPeer: Hex
  srcEid: number
  dstEid: number
  /** Connected wallet (base58): signer, fee payer and token source owner. */
  sender: string
  /** The sender's associated token account for tokenMint (base58). */
  senderAta: string
  /** SendParam.to: bytes32, an EVM address left-padded. */
  recipient: Hex
  recipientDisplay: string
  recipientVm: 'evm'
  amounts: AmountBreakdown
  slippageBps: number
  feeBufferBps: number
  extraOptions: Hex
  quote: SendQuote
  /**
   * `native_fee` in the instruction: the MAXIMUM the program may take (the ULN transfers exactly the
   * quoted worker+treasury fees and requires native_fee >= that). Quoted fee plus buffer.
   */
  value: bigint
  computeUnitLimit: number
  /** micro-lamports per compute unit. */
  computeUnitPrice: bigint
  /** base58 address lookup table the transaction must use. */
  lookupTable: string
}

/** Anchor: sha256("global:send")[0..8]. */
export const SEND_DISCRIMINATOR: Uint8Array = sha256(utf8('global:send')).slice(0, 8)

export type SvmSendData = {
  dstEid: number
  to: Hex
  amountLd: bigint
  minAmountLd: bigint
  options: Hex
  composeMsg: Hex | null
  nativeFee: bigint
  lzTokenFee: bigint
}

class Writer {
  private parts: Uint8Array[] = []
  bytes(b: Uint8Array) {
    this.parts.push(b)
  }
  u8(n: number) {
    this.bytes(Uint8Array.of(n))
  }
  u32(n: number) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, n, true)
    this.bytes(b)
  }
  u64(n: bigint) {
    if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${n}`)
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, n, true)
    this.bytes(b)
  }
  vec(b: Uint8Array) {
    this.u32(b.length)
    this.bytes(b)
  }
  out(): Uint8Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0)
    const out = new Uint8Array(n)
    let o = 0
    for (const p of this.parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }
}

export function hexToBytes(h: Hex): Uint8Array {
  const clean = h.slice(2)
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`bad hex: ${h}`)
  return Uint8Array.from(clean.match(/../g) ?? [], (x) => parseInt(x, 16))
}

export function bytesToHex(b: Uint8Array): Hex {
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/** Borsh layout of the OFT `send` instruction (programs/oft/src/instructions/send.rs). */
export function encodeSvmSendData(d: SvmSendData): Uint8Array {
  const w = new Writer()
  w.bytes(SEND_DISCRIMINATOR)
  w.u32(d.dstEid)
  const to = hexToBytes(d.to)
  if (to.length !== 32) throw new Error('to must be 32 bytes')
  w.bytes(to)
  w.u64(d.amountLd)
  w.u64(d.minAmountLd)
  w.vec(hexToBytes(d.options))
  if (d.composeMsg === null) w.u8(0)
  else {
    w.u8(1)
    w.vec(hexToBytes(d.composeMsg))
  }
  w.u64(d.nativeFee)
  w.u64(d.lzTokenFee)
  return w.out()
}

export function decodeSvmSendData(data: Uint8Array): SvmSendData {
  let o = 0
  const need = (n: number) => {
    if (o + n > data.length) throw new Error(`send data truncated at ${o}+${n}`)
  }
  const bytes = (n: number) => {
    need(n)
    const b = data.subarray(o, o + n)
    o += n
    return b
  }
  const dv = () => new DataView(data.buffer, data.byteOffset, data.byteLength)
  const u32 = () => {
    need(4)
    const v = dv().getUint32(o, true)
    o += 4
    return v
  }
  const u64 = () => {
    need(8)
    const v = dv().getBigUint64(o, true)
    o += 8
    return v
  }
  const disc = bytes(8)
  for (let i = 0; i < 8; i++) if (disc[i] !== SEND_DISCRIMINATOR[i]) throw new Error('not an OFT send instruction (discriminator)')
  const dstEid = u32()
  const to = bytesToHex(bytes(32))
  const amountLd = u64()
  const minAmountLd = u64()
  const options = bytesToHex(bytes(u32()))
  const tag = bytes(1)[0]
  let composeMsg: Hex | null = null
  if (tag === 1) composeMsg = bytesToHex(bytes(u32()))
  else if (tag !== 0) throw new Error(`bad option tag ${tag}`)
  const nativeFee = u64()
  const lzTokenFee = u64()
  if (o !== data.length) throw new Error(`trailing bytes in send data (${data.length - o})`)
  return { dstEid, to, amountLd, minAmountLd, options, composeMsg, nativeFee, lzTokenFee }
}

/** The instruction data this plan must produce. */
export function svmSendDataFor(plan: SvmSendPlan): SvmSendData {
  return {
    dstEid: plan.dstEid,
    to: plan.recipient,
    amountLd: plan.amounts.amountLD,
    minAmountLd: plan.amounts.minAmountLD,
    options: plan.extraOptions,
    composeMsg: null,
    nativeFee: plan.value,
    lzTokenFee: 0n,
  }
}

export function peerConfigPda(oftStore: string, programId: string, remoteEid: number): string {
  return pubkeyToBase58(findProgramAddress([utf8('Peer'), pubkeyFromBase58(oftStore), u32be(remoteEid)], pubkeyFromBase58(programId)).address)
}

export function eventAuthorityPda(programId: string): string {
  return pubkeyToBase58(findProgramAddress([utf8('__event_authority')], pubkeyFromBase58(programId)).address)
}

export function tokenProgramId(p: TokenProgram): string {
  return p === 'token' ? PROGRAM.token : PROGRAM.token2022
}

/** Compute-budget instruction data: `2 ‖ u32 units` and `3 ‖ u64 microLamports`. */
export function decodeComputeBudget(data: Uint8Array): { kind: 'limit'; units: number } | { kind: 'price'; microLamports: bigint } | { kind: 'other' } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length === 5 && data[0] === 2) return { kind: 'limit', units: dv.getUint32(1, true) }
  if (data.length === 9 && data[0] === 3) return { kind: 'price', microLamports: dv.getBigUint64(1, true) }
  return { kind: 'other' }
}

/** A compiled transaction message resolved back to keys: what the wallet is asked to sign. */
export type SvmTxView = {
  /** base58, in message order; index 0 is the fee payer. */
  signers: string[]
  instructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array }[]
  lookupTables: string[]
}

/** The account list `send` must carry, in order (programs/oft/src/instructions/send.rs). */
export function expectedSendAccounts(plan: SvmSendPlan): { pubkey: string; isSigner: boolean; isWritable: boolean }[] {
  return [
    { pubkey: plan.sender, isSigner: true, isWritable: true },
    { pubkey: plan.peerConfig, isSigner: false, isWritable: true },
    { pubkey: plan.oftStore, isSigner: false, isWritable: true },
    { pubkey: plan.senderAta, isSigner: false, isWritable: true },
    { pubkey: plan.tokenEscrow, isSigner: false, isWritable: true },
    { pubkey: plan.tokenMint, isSigner: false, isWritable: true },
    { pubkey: tokenProgramId(plan.tokenProgram), isSigner: false, isWritable: false },
    { pubkey: eventAuthorityPda(plan.programId), isSigner: false, isWritable: false },
    { pubkey: plan.programId, isSigner: false, isWritable: false },
  ]
}

/**
 * §6.14 for Solana: the transaction about to be signed must be exactly
 *   [setComputeUnitLimit, setComputeUnitPrice, oft.send]
 * with our wallet as the only signer, the nine fixed accounts of `send` matching the plan, no other
 * signer anywhere (the endpoint's CPI accounts are read/write but never sign), and the instruction
 * data decoding back to the plan field by field.
 */
export function selfCheckSvm(plan: SvmSendPlan, tx: SvmTxView): SelfCheckResult {
  const m: string[] = []
  if (tx.signers.length !== 1) m.push(`signers: ${tx.signers.length}`)
  if (tx.signers[0] !== plan.sender) m.push('fee payer != sender')
  if (tx.lookupTables.length !== 1 || tx.lookupTables[0] !== plan.lookupTable) m.push('lookup table')
  if (tx.instructions.length !== 3) {
    m.push(`instructions: ${tx.instructions.length}`)
    return { ok: false, mismatches: m }
  }
  const [cuLimit, cuPrice, send] = tx.instructions as [SvmTxView['instructions'][number], SvmTxView['instructions'][number], SvmTxView['instructions'][number]]
  for (const [ix, name] of [[cuLimit, 'limit'], [cuPrice, 'price']] as const) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM) m.push(`${name}: program`)
    if (ix.accounts.length !== 0) m.push(`${name}: accounts`)
  }
  const lim = decodeComputeBudget(cuLimit.data)
  if (lim.kind !== 'limit' || lim.units !== plan.computeUnitLimit) m.push('computeUnitLimit')
  const pr = decodeComputeBudget(cuPrice.data)
  if (pr.kind !== 'price' || pr.microLamports !== plan.computeUnitPrice) m.push('computeUnitPrice')

  if (send.programId !== plan.programId) m.push('send: program')
  const expected = expectedSendAccounts(plan)
  if (send.accounts.length < expected.length) m.push('send: too few accounts')
  expected.forEach((e, i) => {
    const a = send.accounts[i]
    if (!a || a.pubkey !== e.pubkey) m.push(`send: account ${i}`)
    else if (a.isSigner !== e.isSigner || a.isWritable !== e.isWritable) m.push(`send: account ${i} flags`)
  })
  send.accounts.forEach((a, i) => {
    if (a.isSigner && a.pubkey !== plan.sender) m.push(`send: extra signer at ${i}`)
  })
  for (const ix of tx.instructions) for (const a of ix.accounts) if (a.isSigner && a.pubkey !== plan.sender) m.push('extra signer')

  let d: SvmSendData
  try {
    d = decodeSvmSendData(send.data)
  } catch (e) {
    m.push(`decode: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, mismatches: m }
  }
  const want = svmSendDataFor(plan)
  if (d.dstEid !== want.dstEid) m.push('dstEid')
  if (d.to.toLowerCase() !== want.to.toLowerCase()) m.push('to')
  if (d.amountLd !== want.amountLd) m.push('amountLD')
  if (d.minAmountLd !== want.minAmountLd) m.push('minAmountLD')
  if (d.options.toLowerCase() !== want.options.toLowerCase()) m.push('extraOptions')
  if (d.composeMsg !== null) m.push('composeMsg')
  if (d.nativeFee !== want.nativeFee) m.push('fee.nativeFee')
  if (d.nativeFee !== plan.value) m.push('fee.nativeFee != value')
  if (d.lzTokenFee !== 0n) m.push('fee.lzTokenFee')
  if (/^0x0{64}$/.test(d.to)) m.push('to is zero')
  return m.length === 0 ? { ok: true } : { ok: false, mismatches: m }
}

/** bytes32 → base58 pubkey; used to name the OFT Store from an EVM `peers()` value. */
export function bytes32ToPubkey(b: Hex): string {
  return pubkeyToBase58(pubkeyFromHex(b))
}

export function pubkeyToBytes32(base58: string): Hex {
  return pubkeyToHex(pubkeyFromBase58(base58))
}
