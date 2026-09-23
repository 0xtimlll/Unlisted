/**
 * CCIP chain selectors (uint64), per chain in our registry.
 *
 * Source: smartcontractkit/chain-selectors, selectors.yml — the registry CCIP itself is generated
 * from. Each entry below quotes the yml's `name` so a value can be traced back in one search.
 *
 * Router and TokenAdminRegistry addresses are deliberately NOT here yet: they are only needed to
 * build a transfer, and they arrive with the CCIP bridge itself, taken from the CCIP Directory.
 * Detection does not need them — it authorises nothing.
 */
import type { ChainKey } from '../../core/chains.ts'

export type CcipChainConfig = {
  /** uint64 chain selector. */
  selector: bigint
  /** The `name` this selector carries in selectors.yml. */
  registryName: string
}

export const CCIP_CHAINS: Partial<Record<ChainKey, CcipChainConfig>> = {
  ethereum: { selector: 5009297550715157269n, registryName: 'ethereum-mainnet' },
  optimism: { selector: 3734403246176062136n, registryName: 'ethereum-mainnet-optimism-1' },
  bsc: { selector: 11344663589394136015n, registryName: 'binance_smart_chain-mainnet' },
  polygon: { selector: 4051577828743386545n, registryName: 'polygon-mainnet' },
  base: { selector: 15971525489660198786n, registryName: 'ethereum-mainnet-base-1' },
  arbitrum: { selector: 4949039107694359620n, registryName: 'ethereum-mainnet-arbitrum-1' },
  avalanche: { selector: 6433500567565415381n, registryName: 'avalanche-mainnet' },
  linea: { selector: 4627098889531055414n, registryName: 'ethereum-mainnet-linea-1' },
  scroll: { selector: 13204309965629103672n, registryName: 'ethereum-mainnet-scroll-1' },
  hyperevm: { selector: 2442541497099098535n, registryName: 'hyperliquid-mainnet' },
  // solana: CCIP serves Solana, but this app only bridges EVM↔EVM over CCIP.
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
