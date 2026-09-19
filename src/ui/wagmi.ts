/**
 * wagmi config built ONLY from the chain registry. Connectors are deliberately few:
 * injected (MetaMask/Rabby/any browser wallet) and WalletConnect when a project id is set.
 * No wallet SDKs that phone home.
 */
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { injectedWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import { createConfig, fallback, http, type Config } from 'wagmi'
import { CHAINS, type ChainKey } from '@/core/chains'
import { toViemChain } from '@/core/client'

export const WC_PROJECT_ID = process.env['NEXT_PUBLIC_WC_PROJECT_ID'] ?? ''

export function makeWagmiConfig(customRpc: Partial<Record<ChainKey, string>>): Config {
  const wallets = [injectedWallet, rabbyWallet, ...(WC_PROJECT_ID ? [walletConnectWallet] : [])]
  const connectors = connectorsForWallets([{ groupName: 'Wallets', wallets }], {
    appName: 'Unlisted',
    projectId: WC_PROJECT_ID || '00000000000000000000000000000000',
    walletConnectParameters: {
      // No usage events to pulse.walletconnect.org (§0). CSP blocks it as well.
      telemetryEnabled: false,
    },
  })

  const chains = CHAINS.map(toViemChain) as [ReturnType<typeof toViemChain>, ...ReturnType<typeof toViemChain>[]]
  const transports = Object.fromEntries(
    CHAINS.map((c) => {
      const custom = customRpc[c.key]
      const urls = custom ? [custom, ...c.rpcUrls] : [...c.rpcUrls]
      return [c.chainId, fallback(urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })), { rank: false })]
    }),
  )

  return createConfig({
    chains,
    connectors,
    transports,
    multiInjectedProviderDiscovery: true,
    // Few reads per screen; plain eth_call keeps every request auditable in the network tab.
    batch: { multicall: false },
    ssr: false,
  })
}
