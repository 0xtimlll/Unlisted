/**
 * viem PublicClient per chain, built ONLY from the registry (§4).
 *
 * In the browser the transport is the site's own `/rpc/<chain>` function (core/rpcProxy.ts): the
 * function holds the public RPC list, fails over and hedges, and a personal RPC from Settings
 * rides along in a header. In Node (tests, scripts) the transport is the public RPCs themselves,
 * the user's first, as it always was.
 */
import { createPublicClient, fallback, http, type Chain, type PublicClient } from 'viem'
import type { EvmChainDef } from './chains'
import { readUrls } from './rpcProxy'

/** Canonical Multicall3 address; deployed at the same address on every v1 chain. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

export type ReadClient = PublicClient

export function toViemChain(c: EvmChainDef): Chain {
  return {
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: c.nativeDecimals },
    // The public RPCs, not the proxy: this is what wagmi hands the wallet in
    // `wallet_addEthereumChain`, and the wallet has to reach them on its own.
    rpcUrls: { default: { http: [...c.rpcUrls] } },
    blockExplorers: { default: explorerOf(c) },
    // Only where the contract exists: a chain without it batches deploylessly (batchFor below).
    ...(c.multicall3 ? { contracts: { multicall3: { address: MULTICALL3 } } } : {}),
  }
}

/**
 * How reads are batched. Where Multicall3 is deployed, through it. Where it is not, the same batch
 * goes out as a deployless multicall: one eth_call that carries Multicall3's bytecode itself, so the
 * chain answers exactly as if the contract were there. Both `client.multicall` and the automatic
 * batching of `readContract` follow this.
 */
function batchFor(c: EvmChainDef) {
  return { multicall: c.multicall3 ? { wait: 16 } : { wait: 16, deployless: true } }
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

/** The timeout a read gets: the function answers within its own budget, so the browser waits a little longer than that. */
export const READ_TIMEOUT_MS = 20_000

/**
 * The transport for a list of URLs that are one opinion: they fall back among each other.
 *
 * Through the proxy there is no retry: the function has already tried every node of the operator
 * and a 502 from it means none answered, so asking again only doubles the wait — on a search that
 * fans out to a hundred chains, the slowest chain's doubled wait is everyone's.
 */
export function transportFor(urls: readonly string[], headers: Record<string, string>, viaProxy = false) {
  const one = (u: string) => http(u, { timeout: READ_TIMEOUT_MS, retryCount: viaProxy ? 0 : 1, ...(Object.keys(headers).length ? { fetchOptions: { headers } } : {}) })
  return urls.length === 1 ? one(urls[0]!) : fallback(urls.map(one), { rank: false })
}

export function makeReadClient(c: EvmChainDef, customRpc?: string): ReadClient {
  const { urls, headers, viaProxy } = readUrls(c, customRpc)
  return createPublicClient({
    chain: toViemChain(c),
    transport: transportFor(urls, headers, viaProxy),
    batch: batchFor(c),
  })
}

/** A client bound to exactly the given URLs (one operator), for the cross-check's separate opinions. */
export function makeReadClientFor(c: EvmChainDef, urls: readonly string[], headers: Record<string, string> = {}, viaProxy = false): ReadClient {
  return createPublicClient({
    chain: toViemChain(c),
    transport: transportFor(urls, headers, viaProxy),
    batch: batchFor(c),
  })
}
