/**
 * Chain registry (§4). `eid` values live ONLY here and are never editable from the UI.
 * No imports on purpose: scripts/gen-headers.mjs loads this file with plain Node.
 */

export type ChainKey =
  | 'ethereum'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'bsc'
  | 'polygon'
  | 'avalanche'
  | 'hyperevm'
  | 'linea'
  | 'scroll'
  | 'robinhood'
  | 'solana'

/**
 * One RPC endpoint and the operator behind it. `provider` is the operator's domain, so it matches
 * what providerOfUrl() derives for a user-supplied RPC and the two vocabularies cannot drift.
 */
export type RpcEndpoint = { url: string; provider: string }

type ChainCommon = {
  key: ChainKey
  name: string
  /** LayerZero V2 endpoint id. */
  eid: number
  nativeSymbol: string
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
}

export type EvmChainDef = ChainCommon & {
  vm: 'evm'
  chainId: number
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

/**
 * An optional build-time RPC, from a NEXT_PUBLIC_ variable. Robinhood Chain's public endpoint is
 * the only one its operator publishes and it is rate-limited, so a deployment can put its own node
 * in front of it without editing this file:
 *
 *   NEXT_PUBLIC_RPC_ROBINHOOD=https://my-node.example
 *
 * Next inlines this literal `process.env['NEXT_PUBLIC_...']` access at build time, and
 * scripts/gen-headers.mjs reads the same variable with plain Node — so whatever is set here also
 * lands in the CSP's connect-src and in validateRpcUrl's allow-list, and can never become a host
 * the browser silently blocks. A value that is not an https URL is dropped rather than shipped:
 * one broken entry here would take the whole chain's reads down.
 */
function envRpc(value: string | undefined): readonly RpcEndpoint[] {
  if (!value) return []
  try {
    const u = new URL(value.trim())
    // Its operator is whatever host was configured — never one of the registry's, so it always
    // counts as an independent opinion against them.
    return u.protocol === 'https:' ? [{ url: u.toString(), provider: providerOfHost(u.hostname) }] : []
  } catch {
    return []
  }
}

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
  for (const c of CHAINS) for (const r of c.rpcs) if (r.url === url) return r.provider
  try {
    return providerOfHost(new URL(url).hostname)
  } catch {
    return url
  }
}

/** The registry as written: every field except `rpcUrls`, which is derived from `rpcs` below. */
type ChainSpec = (Omit<EvmChainDef, 'rpcUrls'> | Omit<SvmChainDef, 'rpcUrls'>) & { rpcs: readonly RpcEndpoint[] }

const CHAIN_SPECS: readonly ChainSpec[] = [
  {
    vm: 'evm',
    key: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    eid: 30101,
    nativeSymbol: 'ETH',
    rpcs: [{ url: 'https://ethereum-rpc.publicnode.com', provider: 'publicnode.com' }, { url: 'https://eth.drpc.org', provider: 'drpc.org' }],
    explorerTxUrl: 'https://etherscan.io/tx/',
    explorerAddrUrl: 'https://etherscan.io/address/',
    feeStepWei: 10n ** 14n, // 0.0001 ETH
    srcConfirmationsHint: 32,
    feeCeiling: 10n ** 17n, // 0.1 ETH
  },
  {
    vm: 'evm',
    key: 'arbitrum',
    name: 'Arbitrum',
    chainId: 42161,
    eid: 30110,
    nativeSymbol: 'ETH',
    rpcs: [{ url: 'https://arb1.arbitrum.io/rpc', provider: 'arbitrum.io' }, { url: 'https://arbitrum-one-rpc.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://arbiscan.io/tx/',
    explorerAddrUrl: 'https://arbiscan.io/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
    feeCeiling: 2n * 10n ** 16n, // 0.02 ETH
  },
  {
    vm: 'evm',
    key: 'optimism',
    name: 'Optimism',
    chainId: 10,
    eid: 30111,
    nativeSymbol: 'ETH',
    rpcs: [{ url: 'https://mainnet.optimism.io', provider: 'optimism.io' }, { url: 'https://optimism-rpc.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://optimistic.etherscan.io/tx/',
    explorerAddrUrl: 'https://optimistic.etherscan.io/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
    feeCeiling: 2n * 10n ** 16n, // 0.02 ETH
  },
  {
    vm: 'evm',
    key: 'base',
    name: 'Base',
    chainId: 8453,
    eid: 30184,
    nativeSymbol: 'ETH',
    rpcs: [{ url: 'https://mainnet.base.org', provider: 'base.org' }, { url: 'https://base-rpc.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://basescan.org/tx/',
    explorerAddrUrl: 'https://basescan.org/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 10,
    feeCeiling: 2n * 10n ** 16n, // 0.02 ETH
  },
  {
    vm: 'evm',
    key: 'bsc',
    name: 'BNB Chain',
    chainId: 56,
    eid: 30102,
    nativeSymbol: 'BNB',
    rpcs: [{ url: 'https://bsc-dataseed.bnbchain.org', provider: 'bnbchain.org' }, { url: 'https://bsc-rpc.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://bscscan.com/tx/',
    explorerAddrUrl: 'https://bscscan.com/address/',
    feeStepWei: 10n ** 15n, // 0.001 BNB
    srcConfirmationsHint: 20,
    feeCeiling: 2n * 10n ** 17n, // 0.2 BNB
  },
  {
    vm: 'evm',
    key: 'polygon',
    name: 'Polygon',
    chainId: 137,
    eid: 30109,
    nativeSymbol: 'POL',
    rpcs: [{ url: 'https://polygon-bor-rpc.publicnode.com', provider: 'publicnode.com' }, { url: 'https://polygon.drpc.org', provider: 'drpc.org' }],
    explorerTxUrl: 'https://polygonscan.com/tx/',
    explorerAddrUrl: 'https://polygonscan.com/address/',
    feeStepWei: 10n ** 16n, // 0.01 POL
    srcConfirmationsHint: 512,
    feeCeiling: 2n * 10n ** 20n, // 200 POL
  },
  {
    vm: 'evm',
    key: 'avalanche',
    name: 'Avalanche',
    chainId: 43114,
    eid: 30106,
    nativeSymbol: 'AVAX',
    rpcs: [{ url: 'https://api.avax.network/ext/bc/C/rpc', provider: 'avax.network' }, { url: 'https://avalanche-c-chain-rpc.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://snowtrace.io/tx/',
    explorerAddrUrl: 'https://snowtrace.io/address/',
    feeStepWei: 10n ** 15n,
    srcConfirmationsHint: 12,
    feeCeiling: 5n * 10n ** 18n, // 5 AVAX
  },
  {
    vm: 'evm',
    key: 'hyperevm',
    name: 'HyperEVM',
    chainId: 999,
    eid: 30367,
    nativeSymbol: 'HYPE',
    rpcs: [{ url: 'https://rpc.hyperliquid.xyz/evm', provider: 'hyperliquid.xyz' }, { url: 'https://rpc.hypurrscan.io', provider: 'hypurrscan.io' }, { url: 'https://hyperliquid-json-rpc.stakely.io', provider: 'stakely.io' }],
    explorerTxUrl: 'https://hyperevmscan.io/tx/',
    explorerAddrUrl: 'https://hyperevmscan.io/address/',
    feeStepWei: 10n ** 16n, // 0.01 HYPE
    srcConfirmationsHint: 20,
    feeCeiling: 5n * 10n ** 18n, // 5 HYPE
  },
  {
    vm: 'evm',
    key: 'linea',
    name: 'Linea',
    chainId: 59144,
    eid: 30183,
    nativeSymbol: 'ETH',
    rpcs: [{ url: 'https://rpc.linea.build', provider: 'linea.build' }, { url: 'https://linea-rpc.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://lineascan.build/tx/',
    explorerAddrUrl: 'https://lineascan.build/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
    feeCeiling: 2n * 10n ** 16n, // 0.02 ETH
  },
  {
    vm: 'evm',
    key: 'scroll',
    name: 'Scroll',
    chainId: 534352,
    eid: 30214,
    nativeSymbol: 'ETH',
    rpcs: [{ url: 'https://rpc.scroll.io', provider: 'scroll.io' }, { url: 'https://scroll-rpc.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://scrollscan.com/tx/',
    explorerAddrUrl: 'https://scrollscan.com/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
    feeCeiling: 2n * 10n ** 16n, // 0.02 ETH
  },
  {
    vm: 'evm',
    key: 'robinhood',
    // "Robinhood Chain" in its own documentation; the pill shows the short form.
    name: 'Robinhood',
    chainId: 4663,
    eid: 30416,
    nativeSymbol: 'ETH',
    // The operator publishes one RPC and rate-limits it; drpc serves the chain as a second opinion,
    // which the quorum checks need (one provider must never be the only one asked about a spender).
    rpcs: [...envRpc(process.env['NEXT_PUBLIC_RPC_ROBINHOOD']), { url: 'https://rpc.mainnet.chain.robinhood.com', provider: 'robinhood.com' }, { url: 'https://robinhood.drpc.org', provider: 'drpc.org' }],
    explorerTxUrl: 'https://robinhoodchain.blockscout.com/tx/',
    explorerAddrUrl: 'https://robinhoodchain.blockscout.com/address/',
    feeStepWei: 10n ** 13n,
    // Read from the chain, not assumed: the ULN send config for live routes off this chain asks for
    // 20 confirmations, and a block is ~0.101s, so the wait is seconds rather than minutes.
    srcConfirmationsHint: 20,
    blockTimeSec: 0.1,
    feeCeiling: 2n * 10n ** 16n, // 0.02 ETH
  },
  {
    vm: 'svm',
    key: 'solana',
    name: 'Solana',
    eid: 30168,
    nativeSymbol: 'SOL',
    // Public Solana RPCs that accept browser origins without a key are rare: api.mainnet-beta
    // rejects requests carrying an Origin header, drpc/ankr/helius need keys. Both entries below
    // are publicnode, i.e. one provider — the UI recommends a personal RPC for Solana.
    rpcs: [{ url: 'https://solana-rpc.publicnode.com', provider: 'publicnode.com' }, { url: 'https://solana.publicnode.com', provider: 'publicnode.com' }],
    explorerTxUrl: 'https://solscan.io/tx/',
    explorerAddrUrl: 'https://solscan.io/account/',
    feeStepLamports: 10_000n,
    srcConfirmationsHint: 1,
    feeCeiling: 10n ** 9n, // 1 SOL
  },
]

/**
 * `rpcUrls` is filled in from `rpcs` here and nowhere else, so the two can never disagree: there is
 * exactly one place a URL is written down, and it is the one that also names its operator.
 */
export const CHAINS: readonly ChainDef[] = CHAIN_SPECS.map((c) => ({ ...c, rpcUrls: c.rpcs.map((r) => r.url) }) as ChainDef)

export const ALL_EIDS: readonly number[] = CHAINS.map((c) => c.eid)

export function isEvm(c: ChainDef): c is EvmChainDef {
  return c.vm === 'evm'
}

export function isSvm(c: ChainDef): c is SvmChainDef {
  return c.vm === 'svm'
}

export function evmChains(): readonly EvmChainDef[] {
  return CHAINS.filter(isEvm)
}

/** For code that only works on EVM (wagmi, viem, wei math). Throws instead of casting. */
export function requireEvm(c: ChainDef): EvmChainDef {
  if (!isEvm(c)) throw new Error(`${c.name} is not an EVM chain`)
  return c
}

export function byEid(eid: number): ChainDef | undefined {
  return CHAINS.find((c) => c.eid === eid)
}

/** EVM chain ids only — an svm chain has no chainId, so it can never match. */
export function byChainId(chainId: number): EvmChainDef | undefined {
  return evmChains().find((c) => c.chainId === chainId)
}

export function byKey(key: ChainKey): ChainDef {
  const c = CHAINS.find((x) => x.key === key)
  if (!c) throw new Error(`unknown chain key: ${key}`)
  return c
}

/** byKey + requireEvm, for EVM-only call sites. */
export function evmByKey(key: ChainKey): EvmChainDef {
  return requireEvm(byKey(key))
}

/** Every RPC the app may talk to — feeds the CSP `connect-src` list (§7). */
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
