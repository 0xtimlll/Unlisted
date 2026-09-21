/**
 * §6 Solana as the SOURCE: the counterpart of core/probe.ts. Input: an OFT Store address (base58).
 * Everything else is read from the chain, exactly as on EVM — no hardcoded mints or programs:
 *
 *   store.owner            → this token's OFT program (the instruction's program id)
 *   store data             → mint, escrow, type, ld2sd rate, paused, default fee
 *   mint.owner             → Token / Token-2022 (drives the sender's ATA)
 *   PeerConfig per eid     → routes (peer bytes32 = the EVM OFT) + enforced send options
 *   Metaplex metadata      → name / symbol (display only; absent → the mint's short form)
 *
 * With two or more RPC URLs the store, mint and every PeerConfig are read from each and must agree
 * byte for byte (core/quorum.ts discipline); with one URL the caller flags `svm_single_provider`.
 */
import type { Hex } from 'viem'
import { ALL_EIDS, byKey } from '../chains'
import { decodeMint, decodeOftStore, decodePeerConfig, decodeTokenAccount, decodeTokenMetadata, LayoutError, type OftStore } from './layouts'
import { SvmDiscoverError } from './errors'
import type { TokenProgram } from './discover'
import { findMetadata, PROGRAM, pubkeyFromBase58, pubkeyToBase58, pubkeyToHex } from './pubkey'
import { peerConfigPda } from './plan'
import type { SvmRpc, SvmAccount } from './rpc'

const TOKEN_PROGRAMS: Record<string, TokenProgram> = { [PROGRAM.token]: 'token', [PROGRAM.token2022]: 'token2022' }

/** What the UI knows about a Solana-side OFT chosen as the source. Field names mirror OftInfo. */
export type SvmSourceInfo = {
  vm: 'svm'
  oftStore: string
  /** The same key as bytes32 — what an EVM peer's `peers(30168)` must equal (guard 17). */
  oftStoreBytes32: Hex
  programId: string
  kind: 'OFT' | 'OFTAdapter'
  tokenMint: string
  tokenEscrow: string
  tokenProgram: TokenProgram
  endpointProgram: string
  symbol: string
  name: string
  decimals: number
  sharedDecimals: number
  /** ld2sdRate: amounts must be multiples of it (same role as OftInfo.conversionRate). */
  conversionRate: bigint
  /** Solana OFTs pull tokens through the program directly; there is no separate approval step. */
  approvalRequired: false
  paused: boolean
  defaultFeeBps: number
  tvlLd: bigint
  /** Destinations with a PeerConfig, across the registry. `peer` = remote OFT as bytes32. */
  routes: { eid: number; peer: Hex }[]
  /** PeerConfig.enforcedSend per destination eid. */
  enforced: Record<number, Hex>
}

export type SvmProbeResult = { info: SvmSourceInfo; crossChecked: boolean }

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
}

function log10(n: bigint): number | undefined {
  let k = 0
  let v = n
  while (v > 1n) {
    if (v % 10n !== 0n) return undefined
    v /= 10n
    k++
  }
  return k
}

function sameAccount(a: SvmAccount | null, b: SvmAccount | null): boolean {
  if (!a || !b) return a === b
  if (a.owner !== b.owner || a.data.length !== b.data.length) return false
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false
  return true
}

/** One provider's view: the store plus everything derived from it, in a fixed order. */
async function readAll(rpc: SvmRpc, oftStore: string, eids: readonly number[]): Promise<{ store: SvmAccount; decoded: OftStore; programId: string; rest: (SvmAccount | null)[] }> {
  const store = await rpc.getAccountInfo(oftStore)
  if (!store) throw new SvmDiscoverError('store_missing', `no account at ${oftStore}`)
  let decoded: OftStore
  try {
    decoded = decodeOftStore(store.data)
  } catch (e) {
    throw new SvmDiscoverError('not_oft_store', e instanceof LayoutError ? e.message : String(e))
  }
  const programId = store.owner
  const mint = pubkeyFromBase58(decoded.tokenMint)
  const keys = [decoded.tokenMint, decoded.tokenEscrow, pubkeyToBase58(findMetadata(mint)), ...eids.map((eid) => peerConfigPda(oftStore, programId, eid))]
  const rest = await rpc.getMultipleAccounts(keys)
  return { store, decoded, programId, rest }
}

export async function probeSvmOft(rpc: SvmRpc, oftStoreInput: string, eids: readonly number[] = ALL_EIDS.filter((e) => e !== byKey('solana').eid)): Promise<SvmProbeResult> {
  let oftStore: string
  try {
    oftStore = pubkeyToBase58(pubkeyFromBase58(oftStoreInput.trim()))
  } catch {
    throw new SvmDiscoverError('bad_peer', 'not a base58 public key')
  }

  // Every URL is asked independently; the first answer is used, the others must match it.
  const views = await Promise.allSettled(rpc.urls.map((u) => readAll(rpc.single(u), oftStore, eids)))
  const first = views.find((v) => v.status === 'fulfilled')
  if (!first || first.status !== 'fulfilled') {
    const e = (views[0] as PromiseRejectedResult | undefined)?.reason
    throw e instanceof Error ? e : new SvmDiscoverError('store_missing', String(e))
  }
  let crossChecked = false
  for (const v of views) {
    if (v === first) continue
    if (v.status === 'fulfilled') {
      const same = sameAccount(v.value.store, first.value.store) && v.value.rest.length === first.value.rest.length && v.value.rest.every((a, i) => sameAccount(a, first.value.rest[i]!))
      if (!same) throw new SvmDiscoverError('rpc_mismatch', 'RPC providers disagree about this OFT Store')
      crossChecked = true
    } else if (v.reason instanceof SvmDiscoverError && (v.reason.code === 'store_missing' || v.reason.code === 'not_oft_store')) {
      throw new SvmDiscoverError('rpc_mismatch', `another RPC: ${v.reason.code}`)
    }
  }

  const { decoded, programId, rest } = first.value
  const [mint, escrow, metadata, ...peers] = rest
  if (!mint) throw new SvmDiscoverError('mint_missing', decoded.tokenMint)
  const tokenProgram = TOKEN_PROGRAMS[mint.owner]
  if (!tokenProgram) throw new SvmDiscoverError('unknown_token_program', mint.owner)
  const { decimals } = decodeMint(mint.data)
  if (escrow) {
    try {
      const esc = decodeTokenAccount(escrow.data)
      if (esc.mint !== decoded.tokenMint) throw new SvmDiscoverError('escrow_mismatch', `${esc.mint} != ${decoded.tokenMint}`)
    } catch (e) {
      if (e instanceof SvmDiscoverError) throw e
      throw new SvmDiscoverError('escrow_mismatch', String(e))
    }
  }

  let symbol = shortMint(decoded.tokenMint)
  let name = ''
  if (metadata && metadata.owner === PROGRAM.metadata) {
    try {
      const md = decodeTokenMetadata(metadata.data, decoded.tokenMint)
      if (md.symbol) symbol = md.symbol
      name = md.name
    } catch {
      /* unreadable metadata is not an error — the mint is still the mint */
    }
  }

  const routes: SvmSourceInfo['routes'] = []
  const enforced: Record<number, Hex> = {}
  eids.forEach((eid, i) => {
    const acc = peers[i]
    if (!acc || acc.owner !== programId) return
    try {
      const pc = decodePeerConfig(acc.data)
      if (/^0x0{64}$/.test(pc.peerAddress)) return
      routes.push({ eid, peer: pc.peerAddress })
      enforced[eid] = pc.enforcedSend
    } catch {
      /* a foreign account at the PDA address: not a route */
    }
  })

  const rateExp = log10(decoded.ld2sdRate)
  return {
    info: {
      vm: 'svm',
      oftStore,
      oftStoreBytes32: pubkeyToHex(pubkeyFromBase58(oftStore)),
      programId,
      kind: decoded.oftType === 'adapter' ? 'OFTAdapter' : 'OFT',
      tokenMint: decoded.tokenMint,
      tokenEscrow: decoded.tokenEscrow,
      tokenProgram,
      endpointProgram: decoded.endpointProgram,
      symbol,
      name,
      decimals,
      sharedDecimals: rateExp === undefined ? decimals : decimals - rateExp,
      conversionRate: decoded.ld2sdRate,
      approvalRequired: false,
      paused: decoded.paused,
      defaultFeeBps: decoded.defaultFeeBps,
      tvlLd: decoded.tvlLd,
      routes,
      enforced,
    },
    crossChecked,
  }
}
