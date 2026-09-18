import type { NextConfig } from 'next'

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
    }
    return config
  },
}

export default nextConfig
