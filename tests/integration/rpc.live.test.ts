/**
 * Every registry RPC must (a) answer eth_chainId with the right chain and (b) allow browser
 * origins (CORS) — a public RPC that only works from curl silently weakens the two-RPC quorum.
 */
import { describe, expect, it } from 'vitest'
import { CHAINS, isEvm } from '@/core/chains'

const ORIGIN = 'https://oft-bridge-ui.pages.dev'

async function probe(url: string, vm: 'evm' | 'svm') {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: vm === 'evm' ? 'eth_chainId' : 'getVersion', params: [] }),
    signal: AbortSignal.timeout(15_000),
  })
  const acao = r.headers.get('access-control-allow-origin')
  const j = (await r.json().catch(() => ({}))) as { result?: string | { 'solana-core': string } }
  const chainId = typeof j.result === 'string' ? Number(j.result) : undefined
  const solanaCore = typeof j.result === 'object' && j.result ? j.result['solana-core'] : undefined
  return { status: r.status, acao, chainId, solanaCore }
}

describe('registry RPCs', () => {
  for (const c of CHAINS) {
    for (const url of c.rpcUrls) {
      it(`${c.key}: ${url} answers with the right chain id and allows browser origins`, async () => {
        const p = await probe(url, c.vm)
        expect(p.status).toBe(200)
        if (isEvm(c)) expect(p.chainId).toBe(c.chainId)
        else expect(p.solanaCore).toMatch(/^\d+\./)
        expect(p.acao === '*' || p.acao === ORIGIN).toBe(true)
      }, 30_000)
    }
  }
  it('every chain has at least two RPCs (quorum needs two opinions)', () => {
    for (const c of CHAINS) expect(c.rpcUrls.length).toBeGreaterThanOrEqual(2)
  })
})
