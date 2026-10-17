/**
 * §Task 6: from a token to its CCIP pool, and to the chains it can actually reach.
 *
 * The starting point is the TokenAdminRegistry from our config — never an address the user typed.
 * The pool it names then has to agree three ways: it holds this token, it is wired to the official
 * router for this chain, and it lists the destination as supported. A pool wired to some other
 * router could not move anything through the router we are about to approve, so that mismatch is
 * treated as "not usable here" rather than waved through.
 */
import { getAddress, isAddressEqual, parseAbi, type Address } from 'viem'
import { readOptional, UnreadableError } from '@/core/rpcErrors'
import { sanitizeText } from '@/core/text'
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { tokenAdminRegistryAbi, tokenPoolAbi } from './abi'
import { CCIP_CHAINS, ccipConfig, chainOfCcipSelector } from './chains'
import selectorNames from './selectorNames.json'

const ZERO: Address = `0x${'0'.repeat(40)}`
const erc20DecimalsAbi = parseAbi(['function decimals() view returns (uint8)'])

/**
 * `undefined` when the contract refused (reverted, no such function). A provider that did not
 * answer throws `UnreadableError`, which `discoverCcipToken` reports as `unreadable` — never as a
 * mismatch about the pool, which would be a verdict drawn from a timeout.
 */
const read = <T,>(fn: () => Promise<T>): Promise<T | undefined> => readOptional('CCIP read', fn)

export type CcipRoute = { chain: ChainKey; selector: bigint }

/**
 * A chain the pool supports that this app does not serve over CCIP (Solana, Aptos, an EVM chain
 * outside the registry, …): shown so the user learns where the token CAN go, never offered as a
 * destination. `name` is the selector's registry name from chain-selectors, or undefined when even
 * that list does not know the selector.
 */
export type CcipOtherDestination = { selector: bigint; name: string | undefined }

const SELECTOR_NAMES: Readonly<Record<string, string>> = (selectorNames as { selectors: Record<string, string> }).selectors

/** "solana-mainnet" → "Solana", "ethereum-mainnet-xyz-1" → "Xyz": the registry name made readable. */
export function displaySelectorName(registryName: string): string {
  const words = registryName
    .replace(/^ethereum-mainnet-/, '')
    .replace(/-mainnet(-\d+)?$|^mainnet$/, '')
    .replace(/-\d+$/, '')
    .split(/[-_]/)
    .filter(Boolean)
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || registryName
}

export type CcipDiscovery =
  | {
      kind: 'token'
      token: Address
      pool: Address
      /** The pool's own view of the token's decimals on this chain. */
      decimals: number
      /** Destinations the pool supports that we also serve. */
      routes: CcipRoute[]
      /** Chains the pool supports that this app does not serve over CCIP. Shown, never offered. */
      otherDestinations: CcipOtherDestination[]
      /** The pool's own `typeAndVersion()`, e.g. "BurnMintTokenPool 1.6.1"; undefined when it has none. */
      poolVersion: string | undefined
    }
  /** A real token, but CCIP has no pool for it on this chain. */
  | { kind: 'no_pool'; token: Address }
  | { kind: 'unknown'; reason: 'unreadable' | 'pool_chains_unreadable' | 'chain_unsupported' | 'pool_token_mismatch' | 'pool_wrong_router' }

export async function discoverCcipToken(client: ReadClient, chain: ChainKey, tokenAddress: string): Promise<CcipDiscovery> {
  try {
    return await discoverUnguarded(client, chain, tokenAddress)
  } catch (e) {
    if (e instanceof UnreadableError) return { kind: 'unknown', reason: 'unreadable' }
    throw e
  }
}

async function discoverUnguarded(client: ReadClient, chain: ChainKey, tokenAddress: string): Promise<CcipDiscovery> {
  const cfg = ccipConfig(chain)
  if (!cfg) return { kind: 'unknown', reason: 'chain_unsupported' }

  let token: Address
  try {
    token = getAddress(tokenAddress)
  } catch {
    return { kind: 'unknown', reason: 'unreadable' }
  }

  const pool = await read(() =>
    client.readContract({ address: getAddress(cfg.tokenAdminRegistry), abi: tokenAdminRegistryAbi, functionName: 'getPool', args: [token] }),
  )
  if (pool === undefined) return { kind: 'unknown', reason: 'unreadable' }
  if (isAddressEqual(pool, ZERO)) return { kind: 'no_pool', token }

  const [poolToken, routerV1, decimalsOfPool, version] = await Promise.all([
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getToken' })),
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getRouter' })),
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getTokenDecimals' })),
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'typeAndVersion' })),
  ])
  // A method a pool's version does not have is a different question, never a verdict:
  //   2.x pools keep the router in getDynamicConfig() and refuse getRouter();
  //   1.5.0 pools (and the *AndProxy 1.5.0 wrappers) have no getTokenDecimals() — they do not
  //   convert decimals, so the token's own decimals() are the pool's.
  const poolRouter = routerV1 ?? (await read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getDynamicConfig' })))?.[0]
  const decimals = decimalsOfPool ?? (await read(() => client.readContract({ address: token, abi: erc20DecimalsAbi, functionName: 'decimals' })))

  if (!poolToken || !isAddressEqual(poolToken, token)) return { kind: 'unknown', reason: 'pool_token_mismatch' }
  if (!poolRouter || !isAddressEqual(poolRouter, getAddress(cfg.router))) return { kind: 'unknown', reason: 'pool_wrong_router' }
  if (decimals === undefined) return { kind: 'unknown', reason: 'unreadable' }

  const supported = await supportedChains(client, pool, chain)
  if (supported === undefined) return { kind: 'unknown', reason: 'pool_chains_unreadable' }

  const routes: CcipRoute[] = []
  const otherDestinations: CcipOtherDestination[] = []
  const own = cfg.selector
  for (const selector of supported) {
    if (selector === own) continue
    const key = chainOfCcipSelector(selector)
    if (key) routes.push({ chain: key, selector })
    else otherDestinations.push({ selector, name: SELECTOR_NAMES[selector.toString()] })
  }
  return {
    kind: 'token',
    token,
    pool,
    decimals: Number(decimals),
    routes,
    otherDestinations,
    poolVersion: version === undefined ? undefined : sanitizeText(version, 64),
  }
}

/**
 * The chains a pool supports, by whichever method its version has.
 *
 * Every pool the 1.5+ TokenAdminRegistry hands out answers `getSupportedChains()`: BurnMint/
 * LockRelease/BurnFromMint/BurnWithFromMint TokenPool 1.5.x and 1.6.x, and the *AndProxy 1.5.0
 * wrappers around legacy 1.0/1.2/1.4 pools. A pool that refuses it (a future or custom version)
 * is asked `isSupportedChain(selector)` — present since 1.4 — for every selector the chain-selectors
 * registry and our config know, so a version change degrades to a slower read, not to "no
 * destinations". `undefined` only when neither method answers: the screen then says the pool's
 * networks could not be read, never that there are none.
 */
async function supportedChains(client: ReadClient, pool: Address, chain: ChainKey): Promise<readonly bigint[] | undefined> {
  const listed = await read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getSupportedChains' }))
  if (listed !== undefined) return listed
  const own = ccipConfig(chain)?.selector
  const candidates = [...new Set([...Object.keys(SELECTOR_NAMES), ...Object.values(CCIP_CHAINS).map((c) => c!.selector.toString())])].map((x) => BigInt(x)).filter((x) => x !== own)
  const answers = await Promise.all(candidates.map((selector) => read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'isSupportedChain', args: [selector] }))))
  if (answers.every((a) => a === undefined)) return undefined
  return candidates.filter((_, i) => answers[i] === true)
}

export type RemoteSide = {
  /** The token address on the destination, as the pool records it. */
  token?: Address
  /** Its decimals there, read from the destination chain. */
  decimals?: number
  /** The destination pool, from that chain's own TokenAdminRegistry. */
  pool?: Address
}

/**
 * What the token looks like on the other side. The remote token is what the POOL says it is, and
 * its decimals are read on the destination chain itself — a pool with different decimals there is
 * exactly why the amount that arrives has to be computed rather than assumed.
 */
export async function readRemoteSide(
  srcClient: ReadClient,
  dstClient: ReadClient,
  pool: Address,
  dstChain: ChainKey,
  dstSelector: bigint,
): Promise<RemoteSide> {
  const out: RemoteSide = {}
  const encoded = await read(() => srcClient.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getRemoteToken', args: [dstSelector] }))
  // The pool stores it abi-encoded, because a destination may not be an EVM chain at all.
  if (encoded && encoded.length === 66) {
    try {
      out.token = getAddress(`0x${encoded.slice(26)}`)
    } catch {
      /* not an EVM-shaped address: left undefined */
    }
  }

  const cfg = ccipConfig(dstChain)
  if (out.token && cfg) {
    const [dstPool, dstDecimals] = await Promise.all([
      read(() => dstClient.readContract({ address: getAddress(cfg.tokenAdminRegistry), abi: tokenAdminRegistryAbi, functionName: 'getPool', args: [out.token!] })),
      read(() => dstClient.readContract({ address: out.token!, abi: erc20DecimalsAbi, functionName: 'decimals' })),
    ])
    if (dstPool && !isAddressEqual(dstPool, ZERO)) out.pool = dstPool
    if (dstDecimals !== undefined) out.decimals = Number(dstDecimals)
  }
  return out
}

// ------------------------------------------------------------------ quorum ----

/**
 * The same discovery, answered twice by unrelated providers (core/quorum.ts does this for the OFT
 * tab). The approve spender here already comes from the config rather than the chain, so this is
 * not about the spender — it is about the POOL: `pool_token_mismatch` and `pool_wrong_router` are
 * the two verdicts that stop a token being bridged at all, and a single provider that answers
 * `getPool` with an address of its choosing decides both of them on its own.
 *
 * Rules: an operator that could not read is an outage, never an opinion; the first operator that
 * did answer gives the answer, and it counts as cross-checked only when another operator agrees;
 * any operator that answers differently blocks. One answer alone is shown as "not cross-checked".
 */
export type CcipDiscoveryQuorum = CcipDiscovery & { crossChecked: boolean }

/** Do two opinions name the same pool for the same token? Routes are not compared: a provider one
 * block behind can legitimately see a destination the other has not indexed yet, and the route set
 * only decides what is offered in a dropdown, never where anything is sent. */
function sameDiscovery(a: CcipDiscovery, b: CcipDiscovery): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'token' && b.kind === 'token') {
    return isAddressEqual(a.token, b.token) && isAddressEqual(a.pool, b.pool) && a.decimals === b.decimals
  }
  if (a.kind === 'no_pool' && b.kind === 'no_pool') return isAddressEqual(a.token, b.token)
  return true
}

/** A provider that could not answer: an outage, not an opinion about the token. */
const outage = (d: CcipDiscovery | undefined) => !d || (d.kind === 'unknown' && (d.reason === 'unreadable' || d.reason === 'pool_chains_unreadable'))

/**
 * Asks the primary and every independent operator. An operator that could not read is an outage,
 * never a verdict: if the primary was the one that could not, the first operator that did answer
 * gives the answer (and the cross-check then needs yet another one to agree). Only when every
 * operator failed is the result `unreadable` — and the screen offers to try again.
 */
export async function discoverCcipTokenQuorum(
  primary: ReadClient,
  secondaries: ReadClient | readonly ReadClient[] | undefined,
  chain: ChainKey,
  tokenAddress: string,
): Promise<CcipDiscoveryQuorum> {
  const others = secondaries === undefined ? [] : Array.isArray(secondaries) ? [...secondaries] : [secondaries as ReadClient]
  const ask = (c: ReadClient) => discoverCcipToken(c, chain, tokenAddress).catch((): undefined => undefined)
  const answers = await Promise.all([ask(primary), ...others.map(ask)])
  const usable = answers.filter((a): a is CcipDiscovery => !outage(a))
  if (usable.length === 0) {
    const first = answers[0]
    return { ...(first ?? { kind: 'unknown', reason: 'unreadable' }), crossChecked: false }
  }
  const [answer, ...rest] = usable
  if (rest.length === 0) return { ...answer!, crossChecked: false }
  for (const other of rest) {
    if (!sameDiscovery(answer!, other)) {
      const reason = other.kind === 'unknown' ? other.reason : 'unreadable'
      return { kind: 'unknown', reason, crossChecked: true }
    }
  }
  return { ...answer!, crossChecked: true }
}
