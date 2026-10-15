/**
 * LayerZero **v1** chain ids and endpoints, read from the generated src/core/networks.ts.
 *
 * This is deliberately NOT part of src/core/chains.ts's `eid`. That field is a V2 endpoint id
 * and `byEid()` is used everywhere on that assumption; a v1 chain id is a different number in a
 * different space (uint16: Ethereum 101, not 30101) and mixing the two in one field would be the
 * kind of silent confusion that sends a transfer to the wrong chain. So v1 gets its own table,
 * its own accessors, and one link back to the registry: the ChainKey.
 *
 * The data comes from LayerZero's metadata API through scripts/update-networks.ts, which also
 * reads each Endpoint's default libraries on chain, and is committed. Nothing here reaches the
 * network.
 */
import { getAddress, type Address } from 'viem'
import { byKey, evmChains, isEvm, type ChainDef, type ChainKey, type EvmChainDef } from '../../core/chains'
import { NETWORKS, NETWORKS_GENERATED, NETWORKS_SOURCES } from '../../core/networks'

export type LzV1Chain = {
  key: ChainKey
  /** LayerZero's own name for the chain, kept so a row can be traced back to the source. */
  lzChainKey: string
  /** The uint16 the v1 contracts take. */
  v1ChainId: number
  /** EndpointV1 on this chain, checksummed. */
  endpoint: Address
  /**
   * UltraLightNodeV2, when the chain has one.
   *
   * It matters because it — not the Endpoint — is the contract that knows this chain's v1 id:
   * `UltraLightNodeV2.send` stamps its own `localChainId` into every packet, while the Endpoint's
   * `getChainId()` on the six first-wave chains still returns the number it was deployed with
   * before LayerZero renumbered mainnet (Ethereum answers 1, not 101). So an on-chain check of a
   * v1 chain id asks the ULN; asking the Endpoint would "fail" against correct data.
   */
  uln: Address | undefined
  /**
   * False when this chain's Endpoint V1 has no default send or receive library, read on chain by
   * scripts/update-networks.ts. A deployed endpoint that answers `getChainId()` is not a working
   * network: with no library there is nothing to route a message through, so the chain is offered
   * as neither a source nor a destination for v1.
   */
  v1Active: boolean
  /** Why it is inactive, in the generator's own words. Shown to the user, not paraphrased. */
  v1InactiveReason: string | undefined
}

/** uint16 — the type every v1 signature declares for a chain id. */
export function isV1ChainId(v: number): boolean {
  return Number.isInteger(v) && v > 0 && v <= 0xffff
}

const V1_CHAINS: readonly LzV1Chain[] = (Object.keys(NETWORKS) as ChainKey[])
  .flatMap((key) => {
    const spec = NETWORKS[key]
    const v1 = spec.lz?.v1
    if (!v1 || spec.vm !== 'evm') return []
    if (!isV1ChainId(v1.chainId)) throw new Error(`networks.ts: ${key} has a v1 chain id outside uint16`)
    return [
      {
        key,
        lzChainKey: spec.lz!.chainKey,
        v1ChainId: v1.chainId,
        endpoint: getAddress(v1.endpoint),
        uln: v1.uln ? getAddress(v1.uln) : undefined,
        v1Active: v1.active,
        v1InactiveReason: v1.active ? undefined : (v1.inactiveReason ?? 'no reason recorded'),
      },
    ]
  })
  .sort((a, b) => a.v1ChainId - b.v1ChainId)

const BY_KEY = new Map<ChainKey, LzV1Chain>(V1_CHAINS.map((c) => [c.key, c]))
const BY_V1_ID = new Map<number, LzV1Chain>(V1_CHAINS.map((c) => [c.v1ChainId, c]))

/** Where the committed table came from — shown in the UI so the number can be traced. */
export const LZ_V1_SOURCE: string = NETWORKS_SOURCES.layerzero
export const LZ_V1_GENERATED: string = NETWORKS_GENERATED

/**
 * Every registry chain that has a v1 deployment, in v1 chain-id order — including the ones whose
 * messaging is not wired. Use activeV1Chains() for anything a user can pick.
 */
export function lzV1Chains(): readonly LzV1Chain[] {
  return V1_CHAINS
}

/** The chains v1 can actually carry a message on. This is what the UI offers. */
export function activeV1Chains(): readonly LzV1Chain[] {
  return V1_CHAINS.filter((c) => c.v1Active)
}

/** True when this chain can be a v1 source or destination at all. */
export function isV1Active(key: ChainKey): boolean {
  return BY_KEY.get(key)?.v1Active === true
}

export function lzV1(key: ChainKey): LzV1Chain | undefined {
  return BY_KEY.get(key)
}

/** The chain a v1 uint16 names, or undefined when it is not one this app serves. */
export function byV1ChainId(id: number): LzV1Chain | undefined {
  return BY_V1_ID.get(id)
}

/**
 * Destinations a v1 send could reach from `from`.
 *
 * v1 exists only on EVM — there is no LayerZero v1 on Solana, so an svm chain is never a route —
 * and a chain with no default libraries is left out for the same reason a chain with no endpoint
 * would be: a message sent there has nothing to carry it.
 */
export function v1Destinations(from: ChainKey): readonly LzV1Chain[] {
  return V1_CHAINS.filter((c) => c.key !== from && c.v1Active)
}

/** The registry entry behind a v1 chain. Always EVM by construction. */
export function evmOf(c: LzV1Chain): EvmChainDef {
  const def: ChainDef = byKey(c.key)
  if (!isEvm(def)) throw new Error(`${c.key} is not an EVM chain`)
  return def
}

/** Registry EVM chains with no v1 deployment. The UI must not assume there are none. */
export function evmChainsWithoutV1(): readonly EvmChainDef[] {
  return evmChains().filter((c) => !BY_KEY.has(c.key))
}
