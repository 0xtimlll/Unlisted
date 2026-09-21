/** Solana RPC URL list: the user's RPC (settings) first, then the registry's public ones. */
import { byKey } from '../chains'

export function svmRpcUrls(customRpc: string | undefined): string[] {
  const sol = byKey('solana')
  return customRpc ? [customRpc, ...sol.rpcUrls] : [...sol.rpcUrls]
}
