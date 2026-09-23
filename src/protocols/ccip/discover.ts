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
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { tokenAdminRegistryAbi, tokenPoolAbi } from './abi'
import { ccipConfig, chainOfCcipSelector } from './chains'

const ZERO: Address = `0x${'0'.repeat(40)}`
const erc20DecimalsAbi = parseAbi(['function decimals() view returns (uint8)'])

const read = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

export type CcipRoute = { chain: ChainKey; selector: bigint }

export type CcipDiscovery =
  | {
      kind: 'token'
      token: Address
      pool: Address
      /** The pool's own view of the token's decimals on this chain. */
      decimals: number
      /** Destinations the pool supports that we also serve. */
      routes: CcipRoute[]
    }
  /** A real token, but CCIP has no pool for it on this chain. */
  | { kind: 'no_pool'; token: Address }
  | { kind: 'unknown'; reason: 'unreadable' | 'chain_unsupported' | 'pool_token_mismatch' | 'pool_wrong_router' }

export async function discoverCcipToken(client: ReadClient, chain: ChainKey, tokenAddress: string): Promise<CcipDiscovery> {
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

  const [poolToken, poolRouter, decimals, supported] = await Promise.all([
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getToken' })),
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getRouter' })),
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getTokenDecimals' })),
    read(() => client.readContract({ address: pool, abi: tokenPoolAbi, functionName: 'getSupportedChains' })),
  ])

  if (!poolToken || !isAddressEqual(poolToken, token)) return { kind: 'unknown', reason: 'pool_token_mismatch' }
  if (!poolRouter || !isAddressEqual(poolRouter, getAddress(cfg.router))) return { kind: 'unknown', reason: 'pool_wrong_router' }
  if (decimals === undefined || supported === undefined) return { kind: 'unknown', reason: 'unreadable' }

  const routes: CcipRoute[] = []
  for (const selector of supported) {
    const key = chainOfCcipSelector(selector)
    if (key && key !== chain) routes.push({ chain: key, selector })
  }
  return { kind: 'token', token, pool, decimals: Number(decimals), routes }
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
