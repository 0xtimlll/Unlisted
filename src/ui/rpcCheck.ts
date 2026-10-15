/**
 * Does a personal RPC serve the chain it is being set for? Asked through the site's own /rpc
 * function (core/rpcProxy.ts), which fetches the URL — the page never does — and refuses it
 * unless it answers `eth_chainId` (Solana: `getGenesisHash`) for that chain. The same check runs
 * again inside the function on every later use, so this is the user's early answer, not the gate.
 */
import { sanitizeText } from '@/core/text'
import type { ChainDef } from '@/core/chains'
import { providerOfUrl } from '@/core/chains'
import { proxyHeaders, proxyUrl } from '@/core/rpcProxy'

export type RpcCheck = { ok: true } | { ok: false; reason: string }

export async function checkCustomRpc(chain: ChainDef, url: string): Promise<RpcCheck> {
  const target = proxyUrl(chain, providerOfUrl(url))
  if (!target) return { ok: false, reason: 'no /rpc relay here' }
  const method = chain.vm === 'evm' ? 'eth_chainId' : 'getGenesisHash'
  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...proxyHeaders(url) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      signal: AbortSignal.timeout(20_000),
    })
    const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string } }
    if (r.ok && j.result !== undefined) return { ok: true }
    const reason = j.error?.message ? sanitizeText(String(j.error.message), 160).replace(/^custom RPC refused: /, '') : `HTTP ${r.status}`
    return { ok: false, reason }
  } catch (e) {
    return { ok: false, reason: sanitizeText(String((e as Error)?.message ?? e), 120) }
  }
}
