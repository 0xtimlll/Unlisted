/**
 * Cross-check critical reads on two independent RPCs. A single lying RPC can make a fake
 * contract look legitimate (and "simulate" it successfully); two unrelated providers agreeing
 * is a much higher bar. Disagreement blocks; a second provider being down only warns.
 */
import type { ChainDef } from './chains'
import { makeReadClient, type ReadClient } from './client'
import { decodeTx, DecodeTxError, type TxPrefill } from './decodeTx'
import { sameAddress } from './encoding'
import { probeOft, ProbeError, type ProbeResult } from './probe'
import type { OftInfo } from './types'

export type Pair = { primary: ReadClient; secondaries: ReadClient[] }

/**
 * Primary = user's RPC if set, else registry[0]. Secondaries = every other registry RPC,
 * each bound to a single URL so their opinions are independent. All are asked; one definite
 * answer is enough to cross-check, and any disagreement blocks.
 */
export function clientPair(chain: ChainDef, customRpc?: string): Pair {
  const primaryUrl = customRpc ?? chain.rpcUrls[0]!
  return {
    primary: makeReadClient(chain, customRpc ? customRpc : undefined),
    secondaries: chain.rpcUrls.filter((u) => u !== primaryUrl).map((u) => makeReadClientSingle(chain, u)),
  }
}

/** A client bound to exactly one URL (no fallback), so the two opinions stay independent. */
function makeReadClientSingle(chain: ChainDef, url: string): ReadClient {
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
  const [p, ...others] = await Promise.all([probeOft(pair.primary, address), ...pair.secondaries.map((c) => settle(probeOft(c, address)))])
  let agreed = false
  for (const s of others) {
    if (s.ok) {
      if (!sameOftInfo(p.info, s.r.info)) throw new ProbeError('rpc_mismatch', 'RPC providers disagree about this contract')
      agreed = true
    } else if (s.e instanceof ProbeError && (s.e.code === 'not_oft' || s.e.code === 'not_contract' || s.e.code === 'rate_mismatch')) {
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
  const [p, ...others] = await Promise.all([decodeTx(pair.primary, hash), ...pair.secondaries.map((c) => settle(decodeTx(c, hash)))])
  let agreed = false
  for (const s of others) {
    if (s.ok) {
      if (!sameTx(p, s.r)) throw new DecodeTxError('rpc_mismatch', 'RPC providers disagree about this transaction')
      agreed = true
    } else if (s.e instanceof DecodeTxError && s.e.code === 'not_send') {
      throw new DecodeTxError('rpc_mismatch', 'another RPC returned a different transaction')
    }
  }
  return { ...p, crossChecked: agreed }
}
