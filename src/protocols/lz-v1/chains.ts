/**
 * LayerZero **v1** chain ids and endpoints, read from the committed chains.json.
 *
 * This is deliberately NOT part of src/core/chains.ts. That registry's `eid` is a V2 endpoint id
 * and `byEid()` is used everywhere on that assumption; a v1 chain id is a different number in a
 * different space (uint16: Ethereum 101, not 30101) and mixing the two in one field would be the
 * kind of silent confusion that sends a transfer to the wrong chain. So v1 gets its own table,
 * its own accessors, and one link back to the registry: the ChainKey.
 *
 * The data comes from LayerZero's metadata API through scripts/gen-lz-v1.mjs and is committed.
 * Nothing here ever reaches the network.
 */
import { getAddress, type Address } from 'viem'
import { byKey, evmChains, isEvm, type ChainDef, type ChainKey, type EvmChainDef } from '../../core/chains'
import raw from './chains.json'

export type LzV1Chain = {
  key: ChainKey
  /** LayerZero's own name for the chain, kept so a row can be traced back to the source file. */
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
   * scripts/gen-lz-v1.mjs. A deployed endpoint that answers `getChainId()` is not a working
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

const V1_CHAINS: readonly LzV1Chain[] = Object.entries(raw.chains)
  .map(([key, v]) => {
    const k = key as ChainKey
    const registry = byKey(k) // throws if the JSON names a chain the registry does not have
    if (!isEvm(registry) || registry.chainId !== v.nativeChainId) {
      throw new Error(`lz-v1/chains.json: ${key} does not match the registry (chainId ${v.nativeChainId})`)
    }
    if (!isV1ChainId(v.v1ChainId)) throw new Error(`lz-v1/chains.json: ${key} has a v1 chain id outside uint16`)
    const uln = 'uln' in v && typeof v.uln === 'string' ? getAddress(v.uln) : undefined
    // Absent rather than false is treated as inactive: a table written before this field existed
    // says nothing about the libraries, and "unknown" must not read as "fine".
    const v1Active = 'v1Active' in v && v.v1Active === true
    const reason = 'v1InactiveReason' in v && typeof v.v1InactiveReason === 'string' ? v.v1InactiveReason : undefined
    return {
      key: k,
      lzChainKey: v.lzChainKey,
      v1ChainId: v.v1ChainId,
      endpoint: getAddress(v.endpoint),
      uln,
      v1Active,
      v1InactiveReason: v1Active ? undefined : (reason ?? 'no v1Active flag in the committed table'),
    }
  })
  .sort((a, b) => a.v1ChainId - b.v1ChainId)

const BY_KEY = new Map<ChainKey, LzV1Chain>(V1_CHAINS.map((c) => [c.key, c]))
const BY_V1_ID = new Map<number, LzV1Chain>(V1_CHAINS.map((c) => [c.v1ChainId, c]))

/** Where the committed file came from — shown in the UI so the number can be traced. */
export const LZ_V1_SOURCE: string = raw.$source
export const LZ_V1_GENERATED: string = raw.$generated

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

/** Registry EVM chains with no v1 deployment — none today, but the UI must not assume that. */
export function evmChainsWithoutV1(): readonly EvmChainDef[] {
  return evmChains().filter((c) => !BY_KEY.has(c.key))
}
