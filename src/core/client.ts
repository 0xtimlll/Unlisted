/**
 * viem PublicClient per chain, built ONLY from the registry (§4).
 * A user-supplied RPC (already validated by validateRpcUrl) goes first, then public fallbacks.
 */
import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem'
import type { ChainDef } from './chains'

/** Canonical Multicall3 address; deployed at the same address on every v1 chain. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

export type ReadClient = PublicClient

export function toViemChain(c: ChainDef): Chain {
  return {
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [...c.rpcUrls] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  }
}

export function makeReadClient(c: ChainDef, customRpc?: string): ReadClient {
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
