/**
 * Hyperlane domain ids and the ONE protocol contract this module trusts per chain: the Mailbox.
 *
 * Sources, both official and machine-readable:
 *   mailbox, domainId   hyperlane-xyz/hyperlane-registry, chains/<name>/addresses.yaml and
 *                       chains/<name>/metadata.yaml — the registry Hyperlane's own tooling reads.
 *                       `registryName` is that directory's name, so every value here can be traced
 *                       back with one search.
 *
 * Every mailbox below was read back on chain before it was written here (CLAUDE.md rule 4): on
 * two RPC operators per chain, `localDomain()` answers the domain id listed next to it and
 * `VERSION()` answers 3 (selector 0x8d3638f4, from `toFunctionSelector('function localDomain()')`).
 *
 * Why the mailbox is the anchor. A warp route (TokenRouter) is a contract whoever deployed it
 * controls: `wrappedToken()`, `routers(domain)` and `mailbox()` are all its own claims. The one
 * fact it cannot write is which Mailbox this registry names for the chain — so a route is only
 * read through, quoted through and watched through the Mailbox from this table. A router that
 * names another mailbox is refused outright (`foreign_mailbox`, the same rule probeOft applies to
 * an OFT naming a foreign Endpoint), and every delivery state is read from the destination's
 * mailbox here, never from the one the router points at.
 *
 * Domain ids happen to equal EVM chain ids on every chain served here. They are still written
 * down rather than derived: Hyperlane assigns domains, and nothing says the next chain's will match.
 */
import type { ChainKey } from '../../core/chains.ts'

export type HyperlaneChainConfig = {
  /** uint32 domain id, as the Mailbox answers `localDomain()`. */
  domain: number
  /** The chain's directory name in hyperlane-registry/chains. */
  registryName: string
  /** Mailbox. The only Hyperlane contract this app reads as an authority. */
  mailbox: string
}

export const HYPERLANE_CHAINS: Partial<Record<ChainKey, HyperlaneChainConfig>> = {
  ethereum: { domain: 1, registryName: 'ethereum', mailbox: '0xc005dc82818d67AF737725bD4bf75435d065D239' },
  arbitrum: { domain: 42161, registryName: 'arbitrum', mailbox: '0x979Ca5202784112f4738403dBec5D0F3B9daabB9' },
  optimism: { domain: 10, registryName: 'optimism', mailbox: '0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D' },
  base: { domain: 8453, registryName: 'base', mailbox: '0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D' },
  bsc: { domain: 56, registryName: 'bsc', mailbox: '0x2971b9Aec44bE4eb673DF1B88cDB57b96eefe8a4' },
  polygon: { domain: 137, registryName: 'polygon', mailbox: '0x5d934f4e2f797775e53561bB72aca21ba36B96BB' },
  avalanche: { domain: 43114, registryName: 'avalanche', mailbox: '0xFf06aFcaABaDDd1fb08371f9ccA15D73D51FeBD6' },
  hyperevm: { domain: 999, registryName: 'hyperevm', mailbox: '0x3a464f746D23Ab22155710f44dB16dcA53e0775E' },
  linea: { domain: 59144, registryName: 'linea', mailbox: '0x02d16BC51af6BfD153d67CA61754cF912E82C4d9' },
  scroll: { domain: 534352, registryName: 'scroll', mailbox: '0x2f2aFaE1139Ce54feFC03593FeE8AB2aDF4a85A7' },
  robinhood: { domain: 4663, registryName: 'robinhood', mailbox: '0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7' },
  ink: { domain: 57073, registryName: 'ink', mailbox: '0x7f50C5776722630a0024fAE05fDe8b47571D7B39' },
  // The same mailbox address as HyperEVM's (one deployer, one salt); each answers its own domain.
  plasma: { domain: 9745, registryName: 'plasma', mailbox: '0x3a464f746D23Ab22155710f44dB16dcA53e0775E' },
  // solana: Hyperlane serves Solana (sealevel), but this app only bridges EVM to EVM over Hyperlane.
}

export function hyperlaneConfig(key: ChainKey): HyperlaneChainConfig | undefined {
  return HYPERLANE_CHAINS[key]
}

export function hyperlaneDomain(key: ChainKey): number | undefined {
  return HYPERLANE_CHAINS[key]?.domain
}

/** Our chain key for a Hyperlane domain, or undefined for a chain we do not serve. */
export function chainOfHyperlaneDomain(domain: number | bigint): ChainKey | undefined {
  const d = Number(domain)
  for (const [key, cfg] of Object.entries(HYPERLANE_CHAINS)) {
    if (cfg?.domain === d) return key as ChainKey
  }
  return undefined
}

/** Is this address the registry's Mailbox on that chain? Nothing else is ever read as one. */
export function isHyperlaneMailbox(key: ChainKey, address: string): boolean {
  const m = HYPERLANE_CHAINS[key]?.mailbox
  return !!m && m.toLowerCase() === address.toLowerCase()
}
