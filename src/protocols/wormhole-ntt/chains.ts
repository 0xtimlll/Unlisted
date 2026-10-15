/**
 * Wormhole's own numbering and its canonical contracts, per chain in our registry — read from the
 * generated src/core/networks.ts.
 *
 * Sources (scripts/update-networks.ts):
 *   chain ids      wormhole-foundation/wormhole-sdk-ts, core/base/src/constants/chains.ts
 *   core bridge    wormhole-foundation/wormhole-sdk-ts, core/base/src/constants/contracts/core.ts
 *   token bridge   wormhole-foundation/wormhole-sdk-ts, core/base/src/constants/contracts/tokenBridge.ts
 *
 * Every core bridge below was read back on chain before it was written: it answers `chainId()`
 * with the Wormhole number next to it, and the token bridge answers the same. A chain the SDK
 * lists without a mainnet core bridge, or whose bridge did not confirm its number, has no entry,
 * and NTT is simply unavailable there. The token bridge address is what lets us tell Portal apart
 * from NTT: both publish through the same core bridge, so only the publisher's identity separates them.
 */
import type { ChainKey } from '../../core/chains.ts'
import { NETWORKS } from '../../core/networks.ts'

/**
 * Wormhole's explorer API: the official NTT token list and delivery status come from here.
 * Declared in this file because scripts/gen-headers.mjs loads it with plain Node to build the
 * Content-Security-Policy, so it must stay free of any runtime import.
 */
export const WORMHOLESCAN_API = 'https://api.wormholescan.io'

export type WormholeChainConfig = {
  /** Wormhole chain id (uint16) — NOT an EVM chain id and NOT a LayerZero eid. */
  wormholeChainId: number
  /** The SDK's own name for the chain ("Bsc", "Seievm"), so a row can be traced back to the source. */
  chainName: string
  /** Core bridge (publishes LogMessagePublished). */
  coreBridge: string
  /** Token Bridge, a.k.a. Portal. Transfers through it are not NTT and we do not bridge them. */
  tokenBridge?: string
}

function build(): Partial<Record<ChainKey, WormholeChainConfig>> {
  const out: Partial<Record<ChainKey, WormholeChainConfig>> = {}
  for (const key of Object.keys(NETWORKS) as ChainKey[]) {
    const w = NETWORKS[key].wormhole
    if (!w) continue
    out[key] = { wormholeChainId: w.chainId, chainName: w.chainName, coreBridge: w.coreBridge, ...(w.tokenBridge ? { tokenBridge: w.tokenBridge } : {}) }
  }
  return out
}

export const WORMHOLE_CHAINS: Partial<Record<ChainKey, WormholeChainConfig>> = build()

const KEY_OF_ID = new Map<number, ChainKey>()
for (const [key, cfg] of Object.entries(WORMHOLE_CHAINS)) if (cfg) KEY_OF_ID.set(cfg.wormholeChainId, key as ChainKey)

export function wormholeChainId(key: ChainKey): number | undefined {
  return WORMHOLE_CHAINS[key]?.wormholeChainId
}

/** Our chain key for a Wormhole chain id, or undefined when it is a chain we do not serve. */
export function chainOfWormholeId(id: number): ChainKey | undefined {
  return KEY_OF_ID.get(id)
}

/** Is this address the canonical Portal token bridge on that chain? */
export function isTokenBridge(key: ChainKey, address: string): boolean {
  const tb = WORMHOLE_CHAINS[key]?.tokenBridge
  return !!tb && tb.toLowerCase() === address.toLowerCase()
}

export function isCoreBridge(key: ChainKey, address: string): boolean {
  const cb = WORMHOLE_CHAINS[key]?.coreBridge
  return !!cb && cb.toLowerCase() === address.toLowerCase()
}

/**
 * Can NTT reach this chain at all: Wormhole numbers it AND has a core bridge there that confirmed
 * its number on chain. Anything else is never a destination.
 */
export function nttServed(key: ChainKey): boolean {
  return !!WORMHOLE_CHAINS[key]?.coreBridge
}

/**
 * CoinGecko asset-platform ids, which is how the Wormholescan NTT token list keys its `platforms`
 * map. A wrong entry here can only ever fail to find a token (the address must still match
 * exactly), never match the wrong one — so this mapping cannot turn into an approval for something
 * else. Known for the hand-curated chains (scripts/networks-curated.json); a chain without one is
 * simply not looked up in the list, which since 2026-10-15 is a search hint and not the gate.
 */
export const COINGECKO_PLATFORM: Partial<Record<ChainKey, string>> = Object.fromEntries(
  (Object.keys(NETWORKS) as ChainKey[]).flatMap((key) => (NETWORKS[key].coingeckoPlatform ? [[key, NETWORKS[key].coingeckoPlatform]] : [])),
) as Partial<Record<ChainKey, string>>
