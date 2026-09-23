'use client'
/**
 * §Task 1: the search box, end to end. One pasted line becomes one or more verdicts.
 *
 *   contract address     -> the existing probe flow decides (this hook stays out of the way)
 *   transaction hash     -> found across chains, then read from its logs
 *   LayerZero Scan link  -> the same, or the message GUID looked up on the Scan API
 *
 * Failures are kept apart on purpose: "no chain has this transaction" and "we could not reach
 * some chains" are different answers and never share a message.
 */
import { useQuery } from '@tanstack/react-query'
import { analyzeTx } from '@/core/analysis/analyze'
import { fetchEvmTx } from '@/core/analysis/evmTx'
import type { AnalysisInput } from '@/core/analysis/input'
import { result, type AnalysisResult } from '@/core/analysis/result'
import { searchTx, type SearchFailure } from '@/core/analysis/search'
import { byEid, byKey, evmChains, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { fetchStatusByGuid } from '@/core/track'

export type AnalysisOutcome = {
  results: AnalysisResult[]
  /** Chains that could not be reached, so the UI never claims more than it checked. */
  failed: SearchFailure[]
}

export function useAnalysis(input: AnalysisInput | null, selected: ChainKey, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['analysis', input ? JSON.stringify(input) : '', selected, JSON.stringify(customRpc)],
    queryFn: async (): Promise<AnalysisOutcome> => {
      const i = input!
      if (i.kind === 'lz_guid') return { results: [await fromGuid(i.guid)], failed: [] }
      if (i.kind !== 'evm_tx') throw new Error('this input is handled elsewhere')

      const chains = evmChains().map((c) => c.key)
      const found = await searchTx(i.hash, {
        selected: chains.includes(selected) ? selected : undefined,
        chains,
        fetch: async (chain, hash) => {
          const def = byKey(chain)
          if (def.vm !== 'evm') return null
          return fetchEvmTx(makeReadClient(def, customRpc[chain]), hash)
        },
      })

      if (found.status === 'found') {
        return { results: analyzeTx(found.tx, { chain: found.chain, selected }), failed: found.failed }
      }
      // Not on any chain we could reach. A bare bytes32 may still be a LayerZero message id.
      if (i.mayBeGuid) {
        const viaGuid = await fromGuid(i.hash).catch(() => undefined)
        if (viaGuid && viaGuid.code !== 'tx_not_found') return { results: [viaGuid], failed: found.failed }
      }
      return {
        results: [
          result('unknown', 'tx_not_found', {
            vars: { searched: String(found.searched.length), unreachable: String(found.failed.length) },
            details: { txHash: i.hash },
          }),
        ],
        failed: found.failed,
      }
    },
    enabled: !!input && (input.kind === 'evm_tx' || input.kind === 'lz_guid'),
    staleTime: 60_000,
    retry: false,
  })
}

/**
 * §Task 1.7: the LayerZero Scan API by message GUID. The pathway names the OApp on each side, so
 * the source contract can be used straight away.
 */
async function fromGuid(guid: string): Promise<AnalysisResult> {
  const state = await fetchStatusByGuid(guid)
  if (state.phase === 'no_data' || state.srcEid === undefined) {
    return result('unknown', 'tx_not_found', { vars: { searched: '0', unreachable: '0' }, details: { txHash: guid } })
  }
  const src = byEid(state.srcEid)
  const dst = state.dstEid !== undefined ? byEid(state.dstEid) : undefined
  const fields: Record<string, string> = { guid, srcEid: String(state.srcEid) }
  if (state.dstEid !== undefined) fields['dstEid'] = String(state.dstEid)
  if (state.raw) fields['status'] = state.raw
  if (state.srcTxHash) fields['srcTx'] = state.srcTxHash
  if (state.receiver) fields['receiver'] = state.receiver

  if (!src || !state.sender) {
    return result('unknown', 'lz_packet_no_oft', {
      protocol: 'lz-oft',
      vars: { address: state.sender ?? '', chain: src?.name ?? String(state.srcEid), destination: dst?.name ?? '' },
      details: { ...(state.srcTxHash ? { txHash: state.srcTxHash } : {}), fields },
    })
  }
  return result('unknown', 'lz_packet_no_oft', {
    protocol: 'lz-oft',
    vars: { address: state.sender, chain: src.name, destination: dst?.name ?? String(state.dstEid ?? '') },
    details: { chain: src.key, ...(state.srcTxHash ? { txHash: state.srcTxHash } : {}), fields },
    target: { chain: src.key, address: state.sender, kind: 'lz-oapp', ...(dst ? { dstChain: dst.key } : {}) },
    action: { kind: 'use_address', chain: src.key, address: state.sender },
  })
}
