/**
 * CCIP chain selectors and the two contracts we may ever call, per chain in our registry.
 *
 * Sources, both official and machine-readable:
 *   selectors            smartcontractkit/chain-selectors, selectors.yml (the registry CCIP is
 *                        generated from) — `registryName` quotes the `name` a selector carries there
 *   router,
 *   tokenAdminRegistry   smartcontractkit/documentation,
 *                        src/config/data/ccip/v1_2_0/mainnet/chains.json — the data behind the
 *                        CCIP Directory at docs.chain.link/ccip/directory/mainnet.
 *                        `directoryKey` is that file's own key, so any value here can be traced
 *                        back with one search.
 *
 * These addresses are configuration, never input: §Task 6 requires the router and the registry to
 * come from here and nowhere else, because the router is the approve spender.
 */
import type { ChainKey } from '../../core/chains.ts'

export type CcipChainConfig = {
  /** uint64 chain selector. */
  selector: bigint
  /** The `name` this selector carries in selectors.yml. */
  registryName: string
  /** This chain's key in the CCIP Directory data file. */
  directoryKey: string
  /** Router. The only contract this app calls to send, and the only allowed approve spender. */
  router: string
  routerVersion: string
  /** TokenAdminRegistry: maps a token to its pool. */
  tokenAdminRegistry: string
  tokenAdminRegistryVersion: string
}

export const CCIP_CHAINS: Partial<Record<ChainKey, CcipChainConfig>> = {
  ethereum: {
    selector: 5009297550715157269n,
    registryName: 'ethereum-mainnet',
    directoryKey: 'mainnet',
    router: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0xb22764f98dD05c789929716D677382Df22C05Cb6',
    tokenAdminRegistryVersion: '1.5.0',
  },
  optimism: {
    selector: 3734403246176062136n,
    registryName: 'ethereum-mainnet-optimism-1',
    directoryKey: 'ethereum-mainnet-optimism-1',
    router: '0x3206695CaE29952f4b0c22a169725a865bc8Ce0f',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0x657c42abE4CD8aa731Aec322f871B5b90cf6274F',
    tokenAdminRegistryVersion: '1.5.0',
  },
  bsc: {
    selector: 11344663589394136015n,
    registryName: 'binance_smart_chain-mainnet',
    directoryKey: 'bsc-mainnet',
    router: '0x34B03Cb9086d7D758AC55af71584F81A598759FE',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc',
    tokenAdminRegistryVersion: '1.5.0',
  },
  polygon: {
    selector: 4051577828743386545n,
    registryName: 'polygon-mainnet',
    directoryKey: 'matic-mainnet',
    router: '0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0x00F027eA6D0fb03256A15E9182B2B9227A4931d8',
    tokenAdminRegistryVersion: '1.5.0',
  },
  base: {
    selector: 15971525489660198786n,
    registryName: 'ethereum-mainnet-base-1',
    directoryKey: 'ethereum-mainnet-base-1',
    router: '0x881e3A65B4d4a04dD529061dd0071cf975F58bCD',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0x6f6C373d09C07425BaAE72317863d7F6bb731e37',
    tokenAdminRegistryVersion: '1.5.0',
  },
  arbitrum: {
    selector: 4949039107694359620n,
    registryName: 'ethereum-mainnet-arbitrum-1',
    directoryKey: 'ethereum-mainnet-arbitrum-1',
    router: '0x141fa059441E0ca23ce184B6A78bafD2A517DdE8',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0x39AE1032cF4B334a1Ed41cdD0833bdD7c7E7751E',
    tokenAdminRegistryVersion: '1.5.0',
  },
  avalanche: {
    selector: 6433500567565415381n,
    registryName: 'avalanche-mainnet',
    directoryKey: 'avalanche-mainnet',
    router: '0xF4c7E640EdA248ef95972845a62bdC74237805dB',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0xc8df5D618c6a59Cc6A311E96a39450381001464F',
    tokenAdminRegistryVersion: '1.5.0',
  },
  linea: {
    selector: 4627098889531055414n,
    registryName: 'ethereum-mainnet-linea-1',
    directoryKey: 'ethereum-mainnet-linea-1',
    router: '0x549FEB73F2348F6cD99b9fc8c69252034897f06C',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0xBc933cEE67d2b1c08490ee8C51E2dF653a713534',
    tokenAdminRegistryVersion: '1.5.0',
  },
  scroll: {
    selector: 13204309965629103672n,
    registryName: 'ethereum-mainnet-scroll-1',
    directoryKey: 'ethereum-mainnet-scroll-1',
    router: '0x9a55E8Cab6564eb7bbd7124238932963B8Af71DC',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0x846dEA1c1706FC35b4aa78B32d31F1599DAA47b4',
    tokenAdminRegistryVersion: '1.5.0',
  },
  hyperevm: {
    selector: 2442541497099098535n,
    registryName: 'hyperliquid-mainnet',
    directoryKey: 'hyperliquid-mainnet',
    router: '0x13b3332b66389B1467CA6eBd6fa79775CCeF65ec',
    routerVersion: '1.2.0',
    tokenAdminRegistry: '0xcE44363496ABc3a9e53B3F404a740F992D977bDF',
    tokenAdminRegistryVersion: '1.5.0',
  },
  // solana: CCIP serves Solana, but this app only bridges EVM to EVM over CCIP.
}

export function ccipConfig(key: ChainKey): CcipChainConfig | undefined {
  return CCIP_CHAINS[key]
}

export function ccipSelector(key: ChainKey): bigint | undefined {
  return CCIP_CHAINS[key]?.selector
}

/** Our chain key for a CCIP selector, or undefined for a chain we do not serve. */
export function chainOfCcipSelector(selector: bigint): ChainKey | undefined {
  for (const [key, cfg] of Object.entries(CCIP_CHAINS)) {
    if (cfg?.selector === selector) return key as ChainKey
  }
  return undefined
}

/** Is this address the official router on that chain? Nothing else may ever be an approve spender. */
export function isCcipRouter(key: ChainKey, address: string): boolean {
  const r = CCIP_CHAINS[key]?.router
  return !!r && r.toLowerCase() === address.toLowerCase()
}
