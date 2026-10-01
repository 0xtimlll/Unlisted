/**
 * Cross-check critical reads on two independent RPCs. A single lying RPC can make a fake
 * contract look legitimate (and "simulate" it successfully); two unrelated providers agreeing
 * is a much higher bar. Disagreement blocks; a second provider being down only warns.
 */
import { providerOfUrl, type ChainKey, type EvmChainDef } from './chains'
import { makeReadClient, type ReadClient } from './client'
import { decodeTx, DecodeTxError, type TxPrefill } from './decodeTx'
import { sameAddress } from './encoding'
import { probeOft, ProbeError, type ProbeResult } from './probe'
import type { OftInfo } from './types'
import { probeOftV1, ProbeV1Error, type ProbeV1Result } from '../protocols/lz-v1/detect'
import type { OftV1Info } from '../protocols/lz-v1/detect'

/** A second opinion, and whose it is. */
export type Secondary = { client: ReadClient; provider: string }

export type Pair = {
  primary: ReadClient
  primaryProvider: string
  secondaries: Secondary[]
  /** The chain's committed EndpointV2, handed to probeOft so it can refuse a foreign one. */
  endpointV2: `0x${string}`
}

/**
 * Primary = user's RPC if set, else registry[0]. Secondaries = every other registry RPC, each
 * bound to a single URL so their opinions stay separate. All are asked; any disagreement blocks.
 *
 * `crossChecked` is a different question from "did anyone else answer": it is only earned by an
 * answer from a DIFFERENT operator. Two endpoints of one company share whatever is wrong with that
 * company, so counting them twice would turn one opinion into a quorum by arithmetic alone.
 */
export function clientPair(chain: EvmChainDef, customRpc?: string): Pair {
  const primaryUrl = customRpc ?? chain.rpcUrls[0]!
  const primaryProvider = providerOfUrl(primaryUrl)
  // The primary falls back only within ITS OWN operator. With every registry URL behind it, a
  // primary whose first URL was down would quietly answer from a secondary's operator, and the
  // "two operators agree" below would be one operator agreeing with itself.
  const primaryUrls = customRpc ? [customRpc] : chain.rpcUrls.filter((u) => providerOfUrl(u) === primaryProvider)
  return {
    primary: makeReadClient({ ...chain, rpcUrls: primaryUrls }),
    primaryProvider,
    endpointV2: chain.endpointV2,
    secondaries: chain.rpcUrls
      .filter((u) => u !== primaryUrl)
      .map((u) => ({ client: makeReadClientSingle(chain, u), provider: providerOfUrl(u) })),
  }
}

/** True when this pair can produce a real cross-check at all — someone other than the primary. */
export function canCrossCheck(pair: Pair): boolean {
  return pair.secondaries.some((s) => s.provider !== pair.primaryProvider)
}

/**
 * The first secondary run by a DIFFERENT operator, for the checks that take exactly one second
 * opinion (NTT's manager gate, CCIP's pool discovery). Undefined when the registry has no spare
 * operator for this chain — which those callers already treat as "no cross-check", not as a pass.
 */
export function independentSecondary(pair: Pair): ReadClient | undefined {
  return pair.secondaries.find((s) => s.provider !== pair.primaryProvider)?.client
}

/** A client bound to exactly one URL (no fallback), so the two opinions stay independent. */
function makeReadClientSingle(chain: EvmChainDef, url: string): ReadClient {
  return makeReadClient({ ...chain, rpcUrls: [url] })
}

export type Quorum<T> = T & { crossChecked: boolean }

function sameRoutes(a: OftInfo['routes'], b: OftInfo['routes']): boolean {
  if (a.length !== b.length) return false
  const bm = new Map(b.map((r) => [r.eid, r.peer.toLowerCase()]))
  return a.every((r) => bm.get(r.eid) === r.peer.toLowerCase())
}

export function sameOftInfo(a: OftInfo, b: OftInfo): boolean {
  return (
    sameAddress(a.oft, b.oft) &&
    a.kind === b.kind &&
    sameAddress(a.token, b.token) &&
    a.approvalRequired === b.approvalRequired &&
    a.decimals === b.decimals &&
    a.sharedDecimals === b.sharedDecimals &&
    a.conversionRate === b.conversionRate &&
    sameAddress(a.endpoint, b.endpoint) &&
    sameRoutes(a.routes, b.routes)
  )
}

type Opinion<T> = { ok: true; r: T } | { ok: false; e: unknown }
const settle = <T,>(p: Promise<T>): Promise<Opinion<T>> => p.then((r) => ({ ok: true as const, r })).catch((e: unknown) => ({ ok: false as const, e }))

export async function probeOftQuorum(pair: Pair, address: string): Promise<Quorum<ProbeResult>> {
  const [p, ...others] = await Promise.all([
    probeOft(pair.primary, address, pair.endpointV2),
    ...pair.secondaries.map((c) => settle(probeOft(c.client, address, pair.endpointV2))),
  ])
  let agreed = false
  for (const [i, s] of others.entries()) {
    const independent = pair.secondaries[i]!.provider !== pair.primaryProvider
    if (s.ok) {
      if (!sameOftInfo(p.info, s.r.info)) throw new ProbeError('rpc_mismatch', 'RPC providers disagree about this contract')
      if (independent) agreed = true
    } else if (
      s.e instanceof ProbeError &&
      (s.e.code === 'not_oft' || s.e.code === 'not_contract' || s.e.code === 'rate_mismatch' || s.e.code === 'foreign_endpoint')
    ) {
      // A definite "not an OFT" from another provider is a disagreement, not an outage.
      throw new ProbeError('rpc_mismatch', `another RPC: ${s.e.code}`)
    }
  }
  return { ...p, crossChecked: agreed }
}

export function sameTx(a: TxPrefill, b: TxPrefill): boolean {
  return sameAddress(a.oft, b.oft) && a.dstEid === b.dstEid && a.extraOptions.toLowerCase() === b.extraOptions.toLowerCase() && sameAddress(a.observed.from, b.observed.from) && a.observed.amountLD === b.observed.amountLD
}

export async function decodeTxQuorum(pair: Pair, hash: string): Promise<Quorum<TxPrefill>> {
  const [p, ...others] = await Promise.all([decodeTx(pair.primary, hash), ...pair.secondaries.map((c) => settle(decodeTx(c.client, hash)))])
  let agreed = false
  for (const [i, s] of others.entries()) {
    const independent = pair.secondaries[i]!.provider !== pair.primaryProvider
    if (s.ok) {
      if (!sameTx(p, s.r)) throw new DecodeTxError('rpc_mismatch', 'RPC providers disagree about this transaction')
      if (independent) agreed = true
    } else if (s.e instanceof DecodeTxError && s.e.code === 'not_send') {
      throw new DecodeTxError('rpc_mismatch', 'another RPC returned a different transaction')
    }
  }
  return { ...p, crossChecked: agreed }
}

/**
 * The same cross-check for LayerZero v1 (§3).
 *
 * A v1 contract earns more scrutiny than a V2 one, not less: there is no `peers` mapping to read
 * back in one call, the recipient's wire shape depends on which standard the probe decided on, and
 * an adapter's allowance is granted to whatever `token()` returned. So the standard, the token,
 * the endpoint, the adapter-params policy and every trusted remote have to be the same on two
 * unrelated providers, or nothing is sent.
 */
export function sameOftV1Info(a: OftV1Info, b: OftV1Info): boolean {
  if (a.standard.wire !== b.standard.wire || a.standard.kind !== b.standard.kind) return false
  if (!sameAddress(a.oft, b.oft) || !sameAddress(a.token, b.token) || !sameAddress(a.endpoint, b.endpoint)) return false
  if (a.decimals !== b.decimals || a.sharedDecimals !== b.sharedDecimals || a.conversionRate !== b.conversionRate) return false
  if (a.approvalRequired !== b.approvalRequired || a.adapterParamsRequired !== b.adapterParamsRequired) return false
  if (a.srcV1ChainId !== b.srcV1ChainId) return false
  if (a.routes.length !== b.routes.length) return false
  const bm = new Map(b.routes.map((r) => [r.v1ChainId, r]))
  return a.routes.every((r) => {
    const o = bm.get(r.v1ChainId)
    return !!o && o.trustedRemote.toLowerCase() === r.trustedRemote.toLowerCase() && o.minDstGas === r.minDstGas
  })
}

export async function probeOftV1Quorum(pair: Pair, chain: ChainKey, address: string): Promise<Quorum<ProbeV1Result>> {
  const [p, ...others] = await Promise.all([
    probeOftV1(pair.primary, chain, address),
    ...pair.secondaries.map((c) => settle(probeOftV1(c.client, chain, address))),
  ])
  let agreed = false
  for (const [i, s] of others.entries()) {
    const independent = pair.secondaries[i]!.provider !== pair.primaryProvider
    if (s.ok) {
      if (!sameOftV1Info(p.info, s.r.info)) throw new ProbeV1Error('rpc_mismatch', 'RPC providers disagree about this contract')
      if (independent) agreed = true
    } else if (
      s.e instanceof ProbeV1Error &&
      // A definite "this is not that" from another provider is a disagreement, not an outage.
      (s.e.code === 'not_lz_v1' || s.e.code === 'not_contract' || s.e.code === 'unknown_standard' || s.e.code === 'foreign_endpoint' || s.e.code === 'native_oft_unsupported')
    ) {
      throw new ProbeV1Error('rpc_mismatch', `another RPC: ${s.e.code}`)
    }
  }
  return { ...p, crossChecked: agreed }
}
