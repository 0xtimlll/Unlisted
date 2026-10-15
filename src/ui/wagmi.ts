/**
 * wagmi config built ONLY from the chain registry. Connectors are deliberately few:
 * injected (MetaMask/Rabby/any browser wallet) and WalletConnect when a project id is set.
 * No wallet SDKs that phone home.
 *
 * Reads go through the site's own /rpc function (core/rpcProxy.ts); the chain definitions still
 * carry the public RPC URLs, because that list is what the wallet is handed when it is asked to
 * add a network — the wallet reaches those on its own, and sends every transaction through its
 * own RPC, never through ours.
 */
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { injectedWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import { createConfig, type Config } from 'wagmi'
import { evmChains, type ChainKey } from '@/core/chains'
import { toViemChain, transportFor } from '@/core/client'
import { readUrls } from '@/core/rpcProxy'

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

  const chains = evmChains().map(toViemChain) as [ReturnType<typeof toViemChain>, ...ReturnType<typeof toViemChain>[]]
  const transports = Object.fromEntries(
    evmChains().map((c) => {
      const { urls, headers, viaProxy } = readUrls(c, customRpc[c.key])
      return [c.chainId, transportFor(urls, headers, viaProxy)]
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
