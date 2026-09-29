/**
 * viem PublicClient per chain, built ONLY from the registry (§4).
 * A user-supplied RPC (already validated by validateRpcUrl) goes first, then public fallbacks.
 */
import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem'
import type { EvmChainDef } from './chains'

/** Canonical Multicall3 address; deployed at the same address on every v1 chain. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

export type ReadClient = PublicClient

export function toViemChain(c: EvmChainDef): Chain {
  return {
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [...c.rpcUrls] } },
    blockExplorers: { default: explorerOf(c) },
    contracts: { multicall3: { address: MULTICALL3 } },
  }
}

/**
 * The explorer wagmi hands to `wallet_addEthereumChain`.
 *
 * Derived from `explorerTxUrl` rather than stored as a field of its own, so the two can never
 * drift: a wallet that adds Robinhood Chain from this app gets the same Blockscout the app's own
 * links point at. The name is the host, because that is the part a user can check against the
 * link they are about to be shown — a prettier label would be a claim we cannot verify.
 */
function explorerOf(c: EvmChainDef): { name: string; url: string } {
  const u = new URL(c.explorerTxUrl)
  return { name: u.hostname, url: u.origin }
}

export function makeReadClient(c: EvmChainDef, customRpc?: string): ReadClient {
  const urls = customRpc ? [customRpc, ...c.rpcUrls] : [...c.rpcUrls]
  return createPublicClient({
    chain: toViemChain(c),
    transport: fallback(
      urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })),
      { rank: false },
    ),
    batch: { multicall: { wait: 16 } },
  })
}
