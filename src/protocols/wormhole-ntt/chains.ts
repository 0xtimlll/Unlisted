/**
 * Wormhole's own numbering and its canonical contracts, per chain in our registry.
 *
 * Sources (quoted per value below):
 *   chain ids      wormhole-foundation/wormhole-sdk-ts, core/base/src/constants/chains.ts
 *   core bridge    wormhole-foundation/wormhole-sdk-ts, core/base/src/constants/contracts/core.ts
 *   token bridge   wormhole-foundation/wormhole-sdk-ts, core/base/src/constants/contracts/tokenBridge.ts
 *
 * A chain missing from this table is a chain Wormhole does not serve (Scroll), and NTT is simply
 * unavailable there. The token bridge address is what lets us tell Portal apart from NTT: both
 * publish through the same core bridge, so only the publisher's identity separates them.
 */
import type { ChainKey } from '../../core/chains.ts'

/**
 * Wormhole's explorer API: the official NTT token list and delivery status come from here.
 * Declared in this file because scripts/gen-headers.mjs loads it with plain Node to build the
 * Content-Security-Policy, so it must stay free of any runtime import.
 */
export const WORMHOLESCAN_API = 'https://api.wormholescan.io'

export type WormholeChainConfig = {
  /** Wormhole chain id (uint16) — NOT an EVM chain id and NOT a LayerZero eid. */
  wormholeChainId: number
  /** Core bridge (publishes LogMessagePublished). */
  coreBridge: string
  /** Token Bridge, a.k.a. Portal. Transfers through it are not NTT and we do not bridge them. */
  tokenBridge?: string
}

export const WORMHOLE_CHAINS: Partial<Record<ChainKey, WormholeChainConfig>> = {
  ethereum: {
    wormholeChainId: 2,
    coreBridge: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
    tokenBridge: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585',
  },
  bsc: {
    wormholeChainId: 4,
    coreBridge: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
    tokenBridge: '0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7',
  },
  polygon: {
    wormholeChainId: 5,
    coreBridge: '0x7A4B5a56256163F07b2C80A7cA55aBE66c4ec4d7',
    tokenBridge: '0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE',
  },
  avalanche: {
    wormholeChainId: 6,
    coreBridge: '0x54a8e5f9c4CbA08F9943965859F6c34eAF03E26c',
    tokenBridge: '0x0e082F06FF657D94310cB8cE8B0D9a04541d8052',
  },
  arbitrum: {
    wormholeChainId: 23,
    coreBridge: '0xa5f208e072434bC67592E4C49C1B991BA79BCA46',
    tokenBridge: '0x0b2402144Bb366A632D14B83F244D2e0e21bD39c',
  },
  optimism: {
    wormholeChainId: 24,
    coreBridge: '0xEe91C335eab126dF5fDB3797EA9d6aD93aeC9722',
    tokenBridge: '0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b',
  },
  base: {
    wormholeChainId: 30,
    coreBridge: '0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6',
    tokenBridge: '0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627',
  },
  linea: {
    // No Token Bridge deployment is listed for Linea in the mainnet table above, so Portal
    // transfers cannot originate here and no address is claimed.
    wormholeChainId: 38,
    coreBridge: '0x0C56aebD76E6D9e4a1Ec5e94F4162B4CBbf77b32',
  },
  hyperevm: {
    // Listed as [47, "HyperEVM"] in chains.ts; no core/token bridge address is published in the
    // mainnet tables we read, so only the numbering is recorded.
    wormholeChainId: 47,
    coreBridge: '',
  },
  solana: {
    wormholeChainId: 1,
    coreBridge: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
  },
  // scroll: Wormhole does not list a chain id for Scroll.
}

export function wormholeChainId(key: ChainKey): number | undefined {
  return WORMHOLE_CHAINS[key]?.wormholeChainId
}

/** Our chain key for a Wormhole chain id, or undefined when it is a chain we do not serve. */
export function chainOfWormholeId(id: number): ChainKey | undefined {
  for (const [key, cfg] of Object.entries(WORMHOLE_CHAINS)) {
    if (cfg?.wormholeChainId === id) return key as ChainKey
  }
  return undefined
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
