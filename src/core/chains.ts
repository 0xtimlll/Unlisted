/**
 * Chain registry (§4), built from the generated src/core/networks.ts and nothing else. `eid`
 * values live ONLY there and are never editable from the UI.
 * No imports beyond networks.ts on purpose: scripts/gen-headers.mjs loads this file with plain Node.
 */
import { NETWORKS, NETWORKS_GENERATED, type NetworkSpec } from './networks.ts'

/** Every key networks.ts has. The union is derived, so a protocol table cannot name a chain that is not served. */
export type ChainKey = keyof typeof NETWORKS

/** `NETWORKS` as the generated literal; this widens it to the declared shape once, for everything below. */
const SPECS: Readonly<Record<ChainKey, NetworkSpec>> = NETWORKS

export const NETWORKS_DATE: string = NETWORKS_GENERATED

/**
 * One RPC endpoint and the operator behind it. `provider` is the operator's domain, so it matches
 * what providerOfUrl() derives for a user-supplied RPC and the two vocabularies cannot drift.
 */
export type RpcEndpoint = { url: string; provider: string }

type ChainCommon = {
  key: ChainKey
  name: string
  /**
   * LayerZero V2 endpoint id. 0 on a chain LayerZero does not serve (Wormhole- or CCIP-only):
   * no route can name eid 0, byEid(0) answers nothing, and the OFT tabs list only lzChains().
   */
  eid: number
  nativeSymbol: string
  nativeDecimals: number
  /**
   * Public RPCs, tried in order. A user-supplied RPC (settings) goes first.
   *
   * Each one names the OPERATOR that answers it, because a cross-check counts operators, not
   * URLs. Two hostnames belonging to one company are one opinion: if that company is wrong — or
   * compromised, or simply serving a stale fork — both answers are wrong together, and reporting
   * them as "cross-checked" would be a lie told by arithmetic. core/quorum.ts enforces this.
   */
  rpcs: readonly RpcEndpoint[]
  /** Derived from `rpcs`, same order. Everything that only needs the URLs reads this. */
  rpcUrls: readonly string[]
  /** Prefix; append the tx hash. */
  explorerTxUrl: string
  /** Prefix; append the address. */
  explorerAddrUrl: string
  /** Rough number of source confirmations before LZ DVNs verify — for the "usually ~N min" hint only. */
  srcConfirmationsHint: number
  /**
   * Seconds per block, for the same ETA hint and nothing else. Omitted means the 12s the hint has
   * always assumed. It exists because that assumption is off by two orders of magnitude on a chain
   * that produces a block every 100ms: 20 confirmations there is two seconds, not four minutes.
   */
  blockTimeSec?: number
  /**
   * §6.21 A deliberately generous ceiling on the LayerZero fee, in this chain's smallest native
   * unit (wei / lamports). Nothing about a quote is verifiable off-chain: `quoteSend` is whatever
   * the OFT — or whatever RPC answered for it — chose to return, and `msg.value` follows it, so
   * without a ceiling the only bound on the fee is the wallet's whole balance.
   *
   * It is set an order of magnitude above what these routes actually cost, so an ordinary send
   * never meets it and a gas spike does not either. Crossing it does not refuse the send; it asks
   * the user to confirm the number they are about to pay (guard 21).
   */
  feeCeiling: bigint
  /** DefiLlama's TVL on the day networks.ts was generated, in USD. Orders the network picker; decides nothing else. */
  tvlUsd: number
}

export type EvmChainDef = ChainCommon & {
  vm: 'evm'
  chainId: number
  /**
   * LayerZero EndpointV2 on this chain.
   *
   * An OFT answers `endpoint()`, but that is the OFT's own claim — and every §4 risk check then
   * reads `outboundNonce` and `getSendLibrary` from whatever address it named, so a fake OFT that
   * names a fake endpoint gets to answer the questions about itself. probeOft() compares the two
   * and refuses a mismatch, the way lz-v1/detect.ts has always done with Endpoint V1.
   *
   * Every address here was read back on chain by scripts/update-networks.ts: `eid()` on each one
   * returns this chain's `eid`. On a chain LayerZero does not serve it is the zero address, which
   * no OFT's `endpoint()` can equal — so the probe refuses every contract there, as it should.
   */
  endpointV2: `0x${string}`
  /** Fee rounding step (wei). `value` is rounded UP to a multiple of this so the wallet shows a clean number. */
  feeStepWei: bigint
}

export type SvmChainDef = ChainCommon & {
  vm: 'svm'
  /** Fee rounding step in lamports (same role as feeStepWei). */
  feeStepLamports: bigint
}

/** Discriminated by `vm`. Everything that needs a chainId or wei must narrow with isEvm() first. */
export type ChainDef = EvmChainDef | SvmChainDef

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/** The operator a hostname belongs to: its registrable domain, near enough for this purpose. */
export function providerOfHost(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean)
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.')
}

/**
 * The operator behind a URL. A registry URL answers with its declared provider; anything else
 * (a user's own RPC) falls back to the host's registrable domain.
 */
export function providerOfUrl(url: string): string {
  const declared = PROVIDER_OF_URL.get(url)
  if (declared) return declared
  try {
    return providerOfHost(new URL(url).hostname)
  } catch {
    return url
  }
}

function toChainDef(key: ChainKey, s: NetworkSpec): ChainDef {
  const common: ChainCommon = {
    key,
    name: s.name,
    eid: s.lz?.eid ?? 0,
    nativeSymbol: s.nativeSymbol,
    nativeDecimals: s.nativeDecimals,
    rpcs: s.rpcs.map((r) => ({ url: r.url, provider: r.provider })),
    rpcUrls: s.rpcs.map((r) => r.url),
    explorerTxUrl: s.explorerTxUrl,
    explorerAddrUrl: s.explorerAddrUrl,
    srcConfirmationsHint: s.srcConfirmationsHint,
    ...(s.blockTimeSec !== null ? { blockTimeSec: s.blockTimeSec } : {}),
    feeCeiling: BigInt(s.feeCeiling),
    tvlUsd: s.tvlUsd,
  }
  if (s.vm === 'svm') return { ...common, vm: 'svm', feeStepLamports: BigInt(s.feeStep) }
  if (s.chainId === null) throw new Error(`networks.ts: ${key} is evm without a chainId`)
  return {
    ...common,
    vm: 'evm',
    chainId: s.chainId,
    endpointV2: (s.lz?.endpointV2 ?? ZERO_ADDRESS) as `0x${string}`,
    feeStepWei: BigInt(s.feeStep),
  }
}

/**
 * The registry, most popular first: DefiLlama TVL descending, then by name. That is the default
 * order of the network picker and the order a cross-chain search asks chains in.
 */
export const CHAINS: readonly ChainDef[] = (Object.keys(SPECS) as ChainKey[])
  .map((key) => toChainDef(key, SPECS[key]))
  .sort((a, b) => b.tvlUsd - a.tvlUsd || a.name.localeCompare(b.name))

const PROVIDER_OF_URL = new Map<string, string>()
for (const c of CHAINS) for (const r of c.rpcs) PROVIDER_OF_URL.set(r.url, r.provider)

const BY_KEY = new Map<ChainKey, ChainDef>(CHAINS.map((c) => [c.key, c]))
const BY_EID = new Map<number, ChainDef>(CHAINS.filter((c) => c.eid > 0).map((c) => [c.eid, c]))
const BY_CHAIN_ID = new Map<number, EvmChainDef>(CHAINS.filter(isEvm).map((c) => [c.chainId, c]))

/** Every LayerZero V2 eid served, in registry order. Chains without LayerZero have none. */
export const ALL_EIDS: readonly number[] = CHAINS.filter((c) => c.eid > 0).map((c) => c.eid)

export function isEvm(c: ChainDef): c is EvmChainDef {
  return c.vm === 'evm'
}

export function isSvm(c: ChainDef): c is SvmChainDef {
  return c.vm === 'svm'
}

export function evmChains(): readonly EvmChainDef[] {
  return CHAINS.filter(isEvm)
}

/** True when LayerZero V2 serves this chain — the OFT tabs, the adapter search and Rescue work on these only. */
export function hasLz(c: ChainDef): boolean {
  return c.eid > 0
}

/** The chains LayerZero V2 serves (EVM and Solana), in registry order. */
export function lzChains(): readonly ChainDef[] {
  return CHAINS.filter(hasLz)
}

/** The EVM chains LayerZero V2 serves. */
export function lzEvmChains(): readonly EvmChainDef[] {
  return evmChains().filter(hasLz)
}

/** For code that only works on EVM (wagmi, viem, wei math). Throws instead of casting. */
export function requireEvm(c: ChainDef): EvmChainDef {
  if (!isEvm(c)) throw new Error(`${c.name} is not an EVM chain`)
  return c
}

export function byEid(eid: number): ChainDef | undefined {
  return BY_EID.get(eid)
}

/** EVM chain ids only — an svm chain has no chainId, so it can never match. */
export function byChainId(chainId: number): EvmChainDef | undefined {
  return BY_CHAIN_ID.get(chainId)
}

export function byKey(key: ChainKey): ChainDef {
  const c = BY_KEY.get(key)
  if (!c) throw new Error(`unknown chain key: ${key}`)
  return c
}

/** True for a string that names a chain in the registry; the type guard storage and links need. */
export function isChainKey(s: unknown): s is ChainKey {
  return typeof s === 'string' && BY_KEY.has(s as ChainKey)
}

/** byKey + requireEvm, for EVM-only call sites. */
export function evmByKey(key: ChainKey): EvmChainDef {
  return requireEvm(byKey(key))
}

/** Every public RPC origin in the registry, sorted. The wallet is handed these for `wallet_addEthereumChain`; the page itself reads through /rpc. */
export function allRpcHosts(): string[] {
  const hosts = new Set<string>()
  for (const c of CHAINS) for (const u of c.rpcUrls) hosts.add(new URL(u).origin)
  return [...hosts].sort()
}

/**
 * §6.21 True when a transaction's `value` exceeds this chain's fee ceiling.
 *
 * The ceiling is deliberately generous (an order of magnitude above what these routes cost), and
 * crossing it never refuses a send — it asks the user to read the number. Every protocol needs the
 * same bound for the same reason: a quote is whatever the contract, or whatever RPC answered for
 * it, chose to return, so without a ceiling the only limit on a fee is the wallet's whole balance.
 */
export function aboveFeeCeiling(key: ChainKey, value: bigint): boolean {
  return value > byKey(key).feeCeiling
}
