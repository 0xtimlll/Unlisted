/**
 * Solana RPC URLs, for two different callers.
 *
 * `svmRpcUrls` is the direct list — the user's RPC (settings) first, then the registry's public
 * ones — and feeds the send path (core/svm/send.ts): the LayerZero SDK's umi client assembles,
 * dry-runs and SUBMITS the transaction through it, and a submit is the one call the site's /rpc
 * function refuses. So the Solana send path talks to its RPC directly, and the CSP's connect-src
 * keeps the Solana hosts for exactly that (core/rpcPolicy.ts).
 *
 * `svmReadRpc` is everything else — the probe, balances, a sample transaction, delivery status —
 * and goes through /rpc/solana in the browser like every EVM read (core/rpcProxy.ts).
 */
import { byKey } from '../chains'
import { readUrls } from '../rpcProxy'

export function svmRpcUrls(customRpc: string | undefined): string[] {
  const sol = byKey('solana')
  return customRpc ? [customRpc, ...sol.rpcUrls] : [...sol.rpcUrls]
}

/** URLs and headers for a read-only Solana client: the proxy in the browser, the direct list in Node. */
export function svmReadRpc(customRpc: string | undefined): { urls: string[]; headers: Record<string, string> } {
  const { urls, headers } = readUrls(byKey('solana'), customRpc)
  return { urls: [...urls], headers }
}
