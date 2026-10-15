/**
 * CCIP chain selectors and the two contracts we may ever call, per chain in our registry — read
 * from the generated src/core/networks.ts.
 *
 * Sources (scripts/update-networks.ts), both official and machine-readable:
 *   selectors            smartcontractkit/chain-selectors, selectors.yml (the registry CCIP is
 *                        generated from) — `registryName` quotes the `name` a selector carries there
 *   router,
 *   tokenAdminRegistry   smartcontractkit/documentation,
 *                        src/config/data/ccip/v1_2_0/mainnet/chains.json — the data behind the
 *                        CCIP Directory at docs.chain.link/ccip/directory/mainnet.
 *                        `directoryKey` is that file's own key, so any value here can be traced
 *                        back with one search.
 *
 * Every router and registry was read back on chain before it was written: `typeAndVersion()`
 * answers "Router …" and "… TokenAdminRegistry …" respectively. These addresses are configuration,
 * never input: §Task 6 requires the router and the registry to come from here and nowhere else,
 * because the router is the approve spender.
 */
import type { ChainKey } from '../../core/chains.ts'
import { NETWORKS } from '../../core/networks.ts'

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

function build(): Partial<Record<ChainKey, CcipChainConfig>> {
  const out: Partial<Record<ChainKey, CcipChainConfig>> = {}
  for (const key of Object.keys(NETWORKS) as ChainKey[]) {
    const c = NETWORKS[key].ccip
    if (!c) continue
    out[key] = {
      selector: BigInt(c.selector),
      registryName: c.registryName,
      directoryKey: c.directoryKey,
      router: c.router,
      routerVersion: c.routerVersion,
      tokenAdminRegistry: c.tokenAdminRegistry,
      tokenAdminRegistryVersion: c.tokenAdminRegistryVersion,
    }
  }
  return out
}

export const CCIP_CHAINS: Partial<Record<ChainKey, CcipChainConfig>> = build()

const KEY_OF_SELECTOR = new Map<bigint, ChainKey>()
for (const [key, cfg] of Object.entries(CCIP_CHAINS)) if (cfg) KEY_OF_SELECTOR.set(cfg.selector, key as ChainKey)

export function ccipConfig(key: ChainKey): CcipChainConfig | undefined {
  return CCIP_CHAINS[key]
}

export function ccipSelector(key: ChainKey): bigint | undefined {
  return CCIP_CHAINS[key]?.selector
}

/** Our chain key for a CCIP selector, or undefined for a chain we do not serve. */
export function chainOfCcipSelector(selector: bigint): ChainKey | undefined {
  return KEY_OF_SELECTOR.get(selector)
}

/** Is this address the official router on that chain? Nothing else may ever be an approve spender. */
export function isCcipRouter(key: ChainKey, address: string): boolean {
  const r = CCIP_CHAINS[key]?.router
  return !!r && r.toLowerCase() === address.toLowerCase()
}
