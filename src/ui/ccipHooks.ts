'use client'
/** Queries for the Chainlink CCIP tab. */
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { erc20Abi } from '@/core/abi'
import { evmByKey, type ChainKey } from '@/core/chains'
import { makeReadClient } from '@/core/client'
import { sanitizeLabel } from '@/core/probe'
import type { Recipient } from '@/core/recipient'
import { ccipConfig } from '@/protocols/ccip/chains'
import { discoverCcipToken, readRemoteSide, type CcipDiscovery, type RemoteSide } from '@/protocols/ccip/discover'
import { buildCcipPlan, type CcipPlan } from '@/protocols/ccip/plan'
import { previewCcipSend, type CcipPreview } from '@/protocols/ccip/preview'

const clientFor = (chain: ChainKey, customRpc: Partial<Record<ChainKey, string>>) => makeReadClient(evmByKey(chain), customRpc[chain])

/** The token's pool, from the TokenAdminRegistry in our config, and the chains it can reach. */
export function useCcipToken(chain: ChainKey, token: string | null, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['ccipToken', chain, token?.toLowerCase()],
    queryFn: (): Promise<CcipDiscovery> => discoverCcipToken(clientFor(chain, customRpc), chain, token!),
    enabled: !!token,
    staleTime: 60_000,
    retry: false,
  })
}

export type TokenMeta = { symbol: string; decimals: number }

export function useTokenMeta(chain: ChainKey, token: Address | undefined, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['tokenMeta', chain, token],
    queryFn: async (): Promise<TokenMeta> => {
      const client = clientFor(chain, customRpc)
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: token!, abi: erc20Abi, functionName: 'symbol' }).catch(() => ''),
        client.readContract({ address: token!, abi: erc20Abi, functionName: 'decimals' }),
      ])
      return { symbol: sanitizeLabel(symbol), decimals: Number(decimals) }
    },
    enabled: !!token,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** What the token looks like on the destination — its address there, its decimals and its pool. */
export function useCcipRemote(
  chain: ChainKey,
  dstChain: ChainKey | undefined,
  pool: Address | undefined,
  customRpc: Partial<Record<ChainKey, string>>,
) {
  return useQuery({
    queryKey: ['ccipRemote', chain, dstChain, pool],
    queryFn: (): Promise<RemoteSide> => {
      const selector = ccipConfig(dstChain!)!.selector
      return readRemoteSide(clientFor(chain, customRpc), clientFor(dstChain!, customRpc), pool!, dstChain!, selector)
    },
    enabled: !!pool && !!dstChain && !!ccipConfig(dstChain),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useCcipPlan(p: {
  chain: ChainKey
  dstChain: ChainKey | undefined
  token: Address | undefined
  meta: TokenMeta | undefined
  pool: Address | undefined
  remote: RemoteSide | undefined
  sender: Address | undefined
  recipient: Recipient | undefined
  amount: bigint | undefined
  customRpc: Partial<Record<ChainKey, string>>
}) {
  const selector = p.dstChain ? ccipConfig(p.dstChain)?.selector : undefined
  return useQuery({
    queryKey: ['ccipPlan', p.chain, p.dstChain, p.token, p.pool, p.sender, p.recipient?.display, p.amount?.toString()],
    queryFn: (): Promise<CcipPlan> =>
      buildCcipPlan({
        chain: p.chain,
        dstChain: p.dstChain!,
        dstSelector: selector!,
        token: p.token!,
        tokenSymbol: p.meta!.symbol,
        decimals: p.meta!.decimals,
        pool: p.pool!,
        remote: p.remote ?? {},
        sender: p.sender!,
        recipient: p.recipient!,
        amount: p.amount!,
        srcClient: clientFor(p.chain, p.customRpc),
        dstClient: clientFor(p.dstChain!, p.customRpc),
      }),
    enabled:
      !!p.token && !!p.pool && !!p.meta && !!p.dstChain && selector !== undefined && !!p.sender && !!p.recipient && p.amount !== undefined && p.amount > 0n,
    refetchInterval: 30_000, // the fee and the buckets move
    retry: false,
  })
}

export type CcipCheckResult = CcipPreview

export function useCcipCheck(plan: CcipPlan | undefined, ready: boolean, customRpc: Partial<Record<ChainKey, string>>) {
  return useQuery({
    queryKey: ['ccipCheck', plan?.router, plan?.token, plan?.amount.toString(), plan?.recipient, plan?.value.toString()],
    queryFn: () => previewCcipSend(clientFor(plan!.chain, customRpc), plan!, evmByKey(plan!.chain).chainId),
    enabled: !!plan && ready,
    staleTime: 20_000,
    retry: false,
  })
}
