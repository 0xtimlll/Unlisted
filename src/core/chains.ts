/**
 * Chain registry (§4). `eid` values live ONLY here and are never editable from the UI.
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

export type ChainDef = {
  key: ChainKey
  name: string
  chainId: number
  /** LayerZero V2 endpoint id. */
  eid: number
  nativeSymbol: string
  /** Public RPCs, tried in order. A user-supplied RPC (settings) goes first. */
  rpcUrls: readonly string[]
  /** Prefix; append the tx hash. */
  explorerTxUrl: string
  /** Prefix; append the address. */
  explorerAddrUrl: string
  /** Fee rounding step (wei). `value` is rounded UP to a multiple of this so the wallet shows a clean number. */
  feeStepWei: bigint
  /** Rough number of source confirmations before LZ DVNs verify — for the "usually ~N min" hint only. */
  srcConfirmationsHint: number
}

export const CHAINS: readonly ChainDef[] = [
  {
    key: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    eid: 30101,
    nativeSymbol: 'ETH',
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth'],
    explorerTxUrl: 'https://etherscan.io/tx/',
    explorerAddrUrl: 'https://etherscan.io/address/',
    feeStepWei: 10n ** 14n, // 0.0001 ETH
    srcConfirmationsHint: 32,
  },
  {
    key: 'arbitrum',
    name: 'Arbitrum',
    chainId: 42161,
    eid: 30110,
    nativeSymbol: 'ETH',
    rpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorerTxUrl: 'https://arbiscan.io/tx/',
    explorerAddrUrl: 'https://arbiscan.io/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
  },
  {
    key: 'optimism',
    name: 'Optimism',
    chainId: 10,
    eid: 30111,
    nativeSymbol: 'ETH',
    rpcUrls: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    explorerTxUrl: 'https://optimistic.etherscan.io/tx/',
    explorerAddrUrl: 'https://optimistic.etherscan.io/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
  },
  {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    eid: 30184,
    nativeSymbol: 'ETH',
    rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorerTxUrl: 'https://basescan.org/tx/',
    explorerAddrUrl: 'https://basescan.org/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 10,
  },
  {
    key: 'bsc',
    name: 'BNB Chain',
    chainId: 56,
    eid: 30102,
    nativeSymbol: 'BNB',
    rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
    explorerTxUrl: 'https://bscscan.com/tx/',
    explorerAddrUrl: 'https://bscscan.com/address/',
    feeStepWei: 10n ** 15n, // 0.001 BNB
    srcConfirmationsHint: 20,
  },
  {
    key: 'polygon',
    name: 'Polygon',
    chainId: 137,
    eid: 30109,
    nativeSymbol: 'POL',
    rpcUrls: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
    explorerTxUrl: 'https://polygonscan.com/tx/',
    explorerAddrUrl: 'https://polygonscan.com/address/',
    feeStepWei: 10n ** 16n, // 0.01 POL
    srcConfirmationsHint: 512,
  },
  {
    key: 'avalanche',
    name: 'Avalanche',
    chainId: 43114,
    eid: 30106,
    nativeSymbol: 'AVAX',
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    explorerTxUrl: 'https://snowtrace.io/tx/',
    explorerAddrUrl: 'https://snowtrace.io/address/',
    feeStepWei: 10n ** 15n,
    srcConfirmationsHint: 12,
  },
  {
    key: 'hyperevm',
    name: 'HyperEVM',
    chainId: 999,
    eid: 30367,
    nativeSymbol: 'HYPE',
    rpcUrls: ['https://rpc.hyperliquid.xyz/evm', 'https://rpc.hypurrscan.io', 'https://hyperliquid-json-rpc.stakely.io'],
    explorerTxUrl: 'https://hyperevmscan.io/tx/',
    explorerAddrUrl: 'https://hyperevmscan.io/address/',
    feeStepWei: 10n ** 16n, // 0.01 HYPE
    srcConfirmationsHint: 20,
  },
  {
    key: 'linea',
    name: 'Linea',
    chainId: 59144,
    eid: 30183,
    nativeSymbol: 'ETH',
    rpcUrls: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'],
    explorerTxUrl: 'https://lineascan.build/tx/',
    explorerAddrUrl: 'https://lineascan.build/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
  },
  {
    key: 'scroll',
    name: 'Scroll',
    chainId: 534352,
    eid: 30214,
    nativeSymbol: 'ETH',
    rpcUrls: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'],
    explorerTxUrl: 'https://scrollscan.com/tx/',
    explorerAddrUrl: 'https://scrollscan.com/address/',
    feeStepWei: 10n ** 13n,
    srcConfirmationsHint: 20,
  },
] as const

export const ALL_EIDS: readonly number[] = CHAINS.map((c) => c.eid)

export function byEid(eid: number): ChainDef | undefined {
  return CHAINS.find((c) => c.eid === eid)
}

export function byChainId(chainId: number): ChainDef | undefined {
  return CHAINS.find((c) => c.chainId === chainId)
}

export function byKey(key: ChainKey): ChainDef {
  const c = CHAINS.find((x) => x.key === key)
  if (!c) throw new Error(`unknown chain key: ${key}`)
  return c
}

/** Every RPC the app may talk to — feeds the CSP `connect-src` list (§7). */
export function allRpcHosts(): string[] {
  const hosts = new Set<string>()
  for (const c of CHAINS) for (const u of c.rpcUrls) hosts.add(new URL(u).origin)
  return [...hosts].sort()
}

export type RpcValidation = { ok: true; url: string } | { ok: false; reason: 'empty' | 'not_url' | 'insecure' | 'bad_scheme' }

/**
 * Validates a user-supplied RPC URL (§4): `https://` only; `http://` allowed only for localhost.
 * Returns the normalized origin+path (no credentials, no hash).
 */
export function validateRpcUrl(input: string): RpcValidation {
  const s = input.trim()
  if (s === '') return { ok: false, reason: 'empty' }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, reason: 'not_url' }
  }
  if (u.username || u.password) return { ok: false, reason: 'not_url' }
  if (u.protocol === 'https:') return { ok: true, url: u.toString() }
  if (u.protocol === 'http:') {
    const h = u.hostname
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return { ok: true, url: u.toString() }
    return { ok: false, reason: 'insecure' }
  }
  return { ok: false, reason: 'bad_scheme' }
}
