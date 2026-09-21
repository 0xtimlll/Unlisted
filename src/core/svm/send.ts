/**
 * §6 Solana → EVM: the only module that talks to the LayerZero Solana SDK (umi). Loaded on demand
 * when Solana is the source. It does exactly four things:
 *
 *   quote     oft.quoteOft + oft.quote          → limits, receipt, nativeFee (lamports)
 *   assemble  oft.send + compute budget + ALT   → the unsigned transaction, plus a plain view of it
 *   simulate  the assembled transaction         → compute units / failure reason (guard 13)
 *   submit    builder.send(umi)                 → THE one place a Solana transaction leaves the app
 *
 * The wallet only ever sees `signTransaction`; no key material exists here in any form. The
 * assembled transaction is decoded back with SDK-free code (svm/plan.ts) before it is signed.
 */
import { oft } from '@layerzerolabs/oft-v2-solana-sdk'
import { createNoopSigner, publicKey, signerIdentity, transactionBuilder, type AddressLookupTableInput, type Transaction, type Umi } from '@metaplex-foundation/umi'
import { base64 } from '@metaplex-foundation/umi/serializers'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { setComputeUnitLimit, setComputeUnitPrice } from '@metaplex-foundation/mpl-toolbox'
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters'
import type { PublicKey as Web3PublicKey, Transaction as Web3Transaction, VersionedTransaction as Web3VersionedTransaction } from '@solana/web3.js'
import type { Hex } from 'viem'
import { byEid, byKey } from '../chains'
import { computeAmounts, computeValue, DEFAULT_FEE_BUFFER_BPS, DEFAULT_SLIPPAGE_BPS, EMPTY_BYTES, MAX_SLIPPAGE_BPS_PLAN, PlanError, type SendQuote } from '../plan'
import type { Recipient } from '../recipient'
import { encodeBase58 } from './base58'
import { decodeLookupTable } from './layouts'
import { MAX_COMPUTE_UNITS, PRIORITY_FEE_MAX, PRIORITY_FEE_MIN, svmTxFee } from './fees'
import { hexToBytes, LZ_MAINNET_LOOKUP_TABLE, peerConfigPda, selfCheckSvm, tokenProgramId, type SvmSendPlan, type SvmTxView } from './plan'
import { PROGRAM } from './pubkey'
import { ataFor } from './recipient'
import { SvmRpc, type SvmSimulation } from './rpc'
import type { SvmSourceInfo } from './source'

/** The slice of a wallet adapter we hand to umi: a public key and ONE signing method. */
export type SvmSigner = {
  publicKey: Web3PublicKey
  signTransaction: <T extends Web3Transaction | Web3VersionedTransaction>(tx: T) => Promise<T>
}

export type SvmSendContext = {
  /** The SDK's rpc (single endpoint: the user's RPC if set, else the registry's first). */
  umi: Umi
  endpoint: string
  /** Our own client, with fallback URLs, for reads and simulation. */
  rpc: SvmRpc
  lookupTable: AddressLookupTableInput
}

export async function createSvmSendContext(urls: readonly string[]): Promise<SvmSendContext> {
  const endpoint = urls[0]
  if (!endpoint) throw new Error('no Solana RPC url')
  const rpc = new SvmRpc(urls)
  const alt = await rpc.getAccountInfo(LZ_MAINNET_LOOKUP_TABLE)
  if (!alt || alt.owner !== PROGRAM.lookupTable) throw new PlanError('quote_failed', 'LayerZero lookup table not found')
  const { addresses } = decodeLookupTable(alt.data)
  return {
    umi: createUmi(endpoint),
    endpoint,
    rpc,
    lookupTable: { publicKey: publicKey(LZ_MAINNET_LOOKUP_TABLE), addresses: addresses.map((a) => publicKey(a)) },
  }
}

export type BuildSvmSendPlanInput = {
  info: SvmSourceInfo
  dstEid: number
  amountInput: string
  /** Connected Solana wallet, base58. */
  sender: string
  /** Built by evmRecipient(); its vm must equal the destination chain's vm. */
  recipient: Recipient
  slippageBps?: number
  feeBufferBps?: number
  extraOptions?: Hex
}

/** p75 of recent fees paid for these accounts, clamped. */
function pickPriorityFee(fees: bigint[]): bigint {
  const sorted = fees.filter((f) => f > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const p75 = sorted[Math.floor(sorted.length * 0.75)] ?? 0n
  return p75 < PRIORITY_FEE_MIN ? PRIORITY_FEE_MIN : p75 > PRIORITY_FEE_MAX ? PRIORITY_FEE_MAX : p75
}

/** Tx fee in lamports for the plan's compute budget. */
export function svmTxFeeLamports(plan: SvmSendPlan): bigint {
  return svmTxFee(plan.computeUnitLimit, plan.computeUnitPrice)
}

/**
 * §5.3 for a Solana source: pure amount math + quoteOft + quote + fee buffer, then one dry run to
 * size the compute budget. Same rules as buildSendPlan(): the recipient type must match the
 * destination VM before any RPC call is made.
 */
export async function buildSvmSendPlan(ctx: SvmSendContext, p: BuildSvmSendPlanInput): Promise<SvmSendPlan> {
  const slippageBps = p.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const feeBufferBps = p.feeBufferBps ?? DEFAULT_FEE_BUFFER_BPS
  const extraOptions = p.extraOptions ?? EMPTY_BYTES
  const src = byKey('solana')

  const route = p.info.routes.find((r) => r.eid === p.dstEid)
  if (!route) throw new PlanError('no_route', `no peer for eid ${p.dstEid}`)
  const dst = byEid(p.dstEid)
  if (!dst) throw new PlanError('no_route', `eid ${p.dstEid} is not in the registry`)
  if (p.recipient.vm !== dst.vm) throw new PlanError('recipient_vm_mismatch', `${p.recipient.vm} recipient for a ${dst.vm} destination`)
  if (slippageBps > MAX_SLIPPAGE_BPS_PLAN) throw new PlanError('slippage_too_high', `${slippageBps} bps > ${MAX_SLIPPAGE_BPS_PLAN}`)
  if (src.vm !== 'svm') throw new Error('unreachable: solana is svm')

  const amounts = computeAmounts(p.amountInput, p.info.decimals, p.info.conversionRate, slippageBps)
  if (amounts.amountLD <= 0n) throw new PlanError('amount_zero')

  const to = hexToBytes(p.recipient.to)
  const peerAddr = hexToBytes(route.peer)
  const mint = publicKey(p.info.tokenMint)
  const escrow = publicKey(p.info.tokenEscrow)
  const program = publicKey(p.info.programId)
  const payer = publicKey(p.sender)
  const params = { dstEid: p.dstEid, to, amountLd: amounts.amountLD, minAmountLd: amounts.minAmountLD, options: hexToBytes(extraOptions) }
  const peerConfig = peerConfigPda(p.info.oftStore, p.info.programId, p.dstEid)

  let quoteOft, fee, fees
  try {
    ;[quoteOft, fee, fees] = await Promise.all([
      oft.quoteOft(ctx.umi.rpc, { payer, tokenMint: mint, tokenEscrow: escrow }, params, program),
      oft.quote(ctx.umi.rpc, { payer, tokenMint: mint, tokenEscrow: escrow, peerAddr }, params, { oft: program }, undefined, ctx.lookupTable.publicKey),
      ctx.rpc.getRecentPrioritizationFees([p.info.oftStore, p.info.tokenEscrow, peerConfig]).catch(() => [] as bigint[]),
    ])
  } catch (e) {
    throw new PlanError('quote_failed', e instanceof Error ? e.message : String(e))
  }
  if (fee.lzTokenFee !== 0n) throw new PlanError('quote_failed', 'lzTokenFee != 0')

  const quote: SendQuote = {
    amountSentLD: quoteOft.oftReceipt.amountSentLd,
    amountReceivedLD: quoteOft.oftReceipt.amountReceivedLd,
    limitMinLD: quoteOft.oftLimits.minAmountLd,
    limitMaxLD: quoteOft.oftLimits.maxAmountLd,
    feeDetails: quoteOft.oftFeeDetails.map((d) => ({ amountLD: d.feeAmountLd, description: d.description.slice(0, 64) })),
    nativeFee: fee.nativeFee,
  }

  const plan: SvmSendPlan = {
    vm: 'svm',
    oftStore: p.info.oftStore,
    programId: p.info.programId,
    tokenMint: p.info.tokenMint,
    tokenEscrow: p.info.tokenEscrow,
    tokenProgram: p.info.tokenProgram,
    peerConfig,
    dstPeer: route.peer,
    srcEid: src.eid,
    dstEid: p.dstEid,
    sender: p.sender,
    senderAta: ataFor(p.sender, p.info.tokenMint, p.info.tokenProgram),
    recipient: p.recipient.to,
    recipientDisplay: p.recipient.display,
    recipientVm: 'evm',
    amounts,
    slippageBps,
    feeBufferBps,
    extraOptions,
    quote,
    value: computeValue(fee.nativeFee, feeBufferBps, src.feeStepLamports),
    computeUnitLimit: MAX_COMPUTE_UNITS,
    computeUnitPrice: pickPriorityFee(fees),
    lookupTable: LZ_MAINNET_LOOKUP_TABLE,
  }

  // Size the compute budget from a dry run; a failing dry run keeps the cap (guard 13 will say why).
  try {
    const { tx } = await assembleSvmTransaction(ctx, plan)
    const sim = await simulateSvm(ctx, tx)
    if (sim.err === null && sim.unitsConsumed > 0) {
      const padded = Math.ceil((sim.unitsConsumed * 1.2) / 10_000) * 10_000
      plan.computeUnitLimit = Math.min(MAX_COMPUTE_UNITS, Math.max(padded, 50_000))
    }
  } catch {
    /* keep MAX_COMPUTE_UNITS */
  }
  return plan
}

/** A fresh umi for one build: the SDK's rpc plus the identity that will (or will not) sign. */
function umiFor(ctx: SvmSendContext, plan: SvmSendPlan, signer?: SvmSigner): Umi {
  const umi = createUmi(ctx.endpoint)
  return signer ? umi.use(walletAdapterIdentity(signer)) : umi.use(signerIdentity(createNoopSigner(publicKey(plan.sender))))
}

/**
 * The transaction for a plan: [setComputeUnitLimit, setComputeUnitPrice, oft.send] with the
 * mandatory lookup table and a fresh blockhash. Unsigned. `view` is the same transaction resolved
 * back to keys for selfCheckSvm().
 */
export async function assembleSvmTransaction(ctx: SvmSendContext, plan: SvmSendPlan, signer?: SvmSigner) {
  const umi = umiFor(ctx, plan, signer)
  const ix = await oft.send(
    umi.rpc,
    { payer: umi.identity, tokenMint: publicKey(plan.tokenMint), tokenEscrow: publicKey(plan.tokenEscrow), tokenSource: publicKey(plan.senderAta), peerAddr: hexToBytes(plan.dstPeer) },
    { dstEid: plan.dstEid, to: hexToBytes(plan.recipient), amountLd: plan.amounts.amountLD, minAmountLd: plan.amounts.minAmountLD, options: hexToBytes(plan.extraOptions), nativeFee: plan.value },
    { oft: publicKey(plan.programId), token: publicKey(tokenProgramId(plan.tokenProgram)) },
  )
  let builder = transactionBuilder()
    .add(setComputeUnitLimit(umi, { units: plan.computeUnitLimit }))
    .add(setComputeUnitPrice(umi, { microLamports: plan.computeUnitPrice }))
    .add(ix)
    .setAddressLookupTables([ctx.lookupTable])
  builder = await builder.setLatestBlockhash(umi, { commitment: 'confirmed' })
  const tx = builder.build(umi)
  return { umi, builder, tx, view: viewOf(tx, [ctx.lookupTable]) }
}

/** Resolve a compiled v0 message back to keys + flags (static accounts, then ALT writable, then ALT readonly). */
export function viewOf(tx: Transaction, tables: AddressLookupTableInput[]): SvmTxView {
  const m = tx.message
  const staticKeys = m.accounts.map(String)
  const loadedWritable: string[] = []
  const loadedReadonly: string[] = []
  for (const l of m.addressLookupTables) {
    const t = tables.find((x) => x.publicKey === l.publicKey)
    if (!t) throw new Error(`transaction uses an unknown lookup table ${l.publicKey}`)
    for (const i of l.writableIndexes) loadedWritable.push(String(t.addresses[i] ?? '?'))
    for (const i of l.readonlyIndexes) loadedReadonly.push(String(t.addresses[i] ?? '?'))
  }
  const all = [...staticKeys, ...loadedWritable, ...loadedReadonly]
  const h = m.header
  const flags = (i: number) => {
    if (i < staticKeys.length) {
      const isSigner = i < h.numRequiredSignatures
      const isWritable = isSigner ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < staticKeys.length - h.numReadonlyUnsignedAccounts
      return { isSigner, isWritable }
    }
    return { isSigner: false, isWritable: i < staticKeys.length + loadedWritable.length }
  }
  return {
    signers: staticKeys.slice(0, h.numRequiredSignatures),
    lookupTables: m.addressLookupTables.map((l) => String(l.publicKey)),
    instructions: m.instructions.map((ix) => ({
      programId: all[ix.programIndex] ?? '?',
      accounts: ix.accountIndexes.map((i) => ({ pubkey: all[i] ?? '?', ...flags(i) })),
      data: ix.data,
    })),
  }
}

export async function simulateSvm(ctx: SvmSendContext, tx: Transaction): Promise<SvmSimulation> {
  const bytes = ctx.umi.transactions.serialize(tx)
  return ctx.rpc.simulateTransaction(base64.deserialize(bytes)[0])
}

/**
 * Sign with the wallet and submit. The transaction is rebuilt from the plan, decoded and compared
 * with it (guard 14) immediately before signing; the builder's `send` is the single submit path in
 * this codebase (scripts/check-whitelist.mjs counts it).
 */
export async function submitSvm(ctx: SvmSendContext, plan: SvmSendPlan, signer: SvmSigner): Promise<string> {
  if (signer.publicKey.toBase58() !== plan.sender) throw new Error('wallet is not the plan sender')
  const { umi, builder, view } = await assembleSvmTransaction(ctx, plan, signer)
  const sc = selfCheckSvm(plan, view)
  if (!sc.ok) throw new Error(`self-check: ${sc.mismatches.join(', ')}`)
  const sig = await builder.send(umi, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 })
  // umi returns raw signature bytes; explorers and LayerZero Scan use base58.
  return encodeBase58(sig)
}
