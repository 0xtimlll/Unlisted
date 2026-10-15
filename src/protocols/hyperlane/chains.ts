/**
 * Hyperlane domain ids and the ONE protocol contract this module trusts per chain: the Mailbox —
 * read from the generated src/core/networks.ts.
 *
 * Source (scripts/update-networks.ts), official and machine-readable:
 *   mailbox, domainId   hyperlane-xyz/hyperlane-registry, chains/addresses.yaml and
 *                       chains/metadata.yaml — the registry Hyperlane's own tooling reads.
 *                       `registryName` is the chain's name there, so every value here can be
 *                       traced back with one search.
 *
 * Every mailbox was read back on chain before it was written here (CLAUDE.md rule 4):
 * `localDomain()` answers the domain id listed next to it and `VERSION()` answers 3.
 *
 * Why the mailbox is the anchor. A warp route (TokenRouter) is a contract whoever deployed it
 * controls: `wrappedToken()`, `routers(domain)` and `mailbox()` are all its own claims. The one
 * fact it cannot write is which Mailbox this registry names for the chain — so a route is only
 * read through, quoted through and watched through the Mailbox from this table. A router that
 * names another mailbox is refused outright (`foreign_mailbox`, the same rule probeOft applies to
 * an OFT naming a foreign Endpoint), and every delivery state is read from the destination's
 * mailbox here, never from the one the router points at.
 *
 * Domain ids happen to equal EVM chain ids on most chains. They are still written down rather
 * than derived: Hyperlane assigns domains, and nothing says the next chain's will match.
 */
import type { ChainKey } from '../../core/chains.ts'
import { NETWORKS } from '../../core/networks.ts'

export type HyperlaneChainConfig = {
  /** uint32 domain id, as the Mailbox answers `localDomain()`. */
  domain: number
  /** The chain's name in hyperlane-registry/chains. */
  registryName: string
  /** Mailbox. The only Hyperlane contract this app reads as an authority. */
  mailbox: string
}

function build(): Partial<Record<ChainKey, HyperlaneChainConfig>> {
  const out: Partial<Record<ChainKey, HyperlaneChainConfig>> = {}
  for (const key of Object.keys(NETWORKS) as ChainKey[]) {
    const h = NETWORKS[key].hyperlane
    if (!h) continue
    out[key] = { domain: h.domain, registryName: h.registryName, mailbox: h.mailbox }
  }
  return out
}

export const HYPERLANE_CHAINS: Partial<Record<ChainKey, HyperlaneChainConfig>> = build()

const KEY_OF_DOMAIN = new Map<number, ChainKey>()
for (const [key, cfg] of Object.entries(HYPERLANE_CHAINS)) if (cfg) KEY_OF_DOMAIN.set(cfg.domain, key as ChainKey)

export function hyperlaneConfig(key: ChainKey): HyperlaneChainConfig | undefined {
  return HYPERLANE_CHAINS[key]
}

export function hyperlaneDomain(key: ChainKey): number | undefined {
  return HYPERLANE_CHAINS[key]?.domain
}

/** Our chain key for a Hyperlane domain, or undefined for a chain we do not serve. */
export function chainOfHyperlaneDomain(domain: number | bigint): ChainKey | undefined {
  return KEY_OF_DOMAIN.get(Number(domain))
}

/** Is this address the registry's Mailbox on that chain? Nothing else is ever read as one. */
export function isHyperlaneMailbox(key: ChainKey, address: string): boolean {
  const m = HYPERLANE_CHAINS[key]?.mailbox
  return !!m && m.toLowerCase() === address.toLowerCase()
}
