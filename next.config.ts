import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'

const shim = (name: string) => fileURLToPath(new URL(`./shims/${name}/index.js`, import.meta.url))

const nextConfig: NextConfig = {
  // Static export: no server runtime. Security headers live in the host config (§7).
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  // Do not ship source maps or telemetry from the build.
  productionBrowserSourceMaps: false,
  webpack: (config) => {
    // @wagmi/connectors bundles every wallet SDK. We use injected + WalletConnect only;
    // stub the heavy/unused ones so they neither break the build nor ship to users.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@base-org/account': false,
      '@coinbase/cdp-sdk': false,
      '@coinbase/wallet-sdk': false,
      '@metamask/sdk': false,
      '@gemini-wallet/core': false,
      'pino-pretty': false,
      '@react-native-async-storage/async-storage': false,
      // The LayerZero Solana SDK declares helper packages that drag in mnemonic/keypair tooling for
      // six chains plus node core modules. Only six pure functions are used: see shims/README.md.
      '@layerzerolabs/lz-utilities': shim('lz-utilities'),
      '@layerzerolabs/lz-foundation': shim('lz-foundation'),
      '@layerzerolabs/lz-serdes': false,
      '@layerzerolabs/lz-corekit-solana': false,
      '@layerzerolabs/tron-utilities': false,
      // Exact-match alias ($): the `/umi` sub-path the OFT SDK builds `send` with stays real.
      '@layerzerolabs/lz-solana-sdk-v2$': shim('lz-solana-sdk-v2'),
    }
    return config
  },
}

export default nextConfig
