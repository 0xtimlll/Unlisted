import { describe, expect, it, vi } from 'vitest'
import { SvmRpc, SvmRpcError } from '@/core/svm/rpc'

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response

describe('SvmRpc', () => {
  it('calls fetch as a free function (browser "Illegal invocation" regression)', async () => {
    const original = globalThis.fetch
    const seen: unknown[] = []
    // A fetch that throws when invoked with a foreign `this`, like window.fetch does.
    globalThis.fetch = function (this: unknown, url: string | URL | Request, init?: RequestInit) {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation')
      seen.push(JSON.parse(String(init?.body)).method)
      return Promise.resolve(json({ jsonrpc: '2.0', id: 1, result: { 'solana-core': '2.0.0' } }))
    } as typeof fetch
    try {
      const rpc = new SvmRpc(['https://a.example'])
      expect(await rpc.getVersion()).toBe('2.0.0')
      expect(seen).toEqual(['getVersion'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('falls back to the next URL on HTTP / JSON-RPC errors and surfaces the last error', async () => {
    const calls: string[] = []
    const f = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/1')) return json({}, 500)
      if (url.endsWith('/2')) return json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } })
      return json({ jsonrpc: '2.0', id: 1, result: { value: null } })
    })
    const rpc = new SvmRpc(['https://x/1', 'https://x/2', 'https://x/3'], f as never)
    expect(await rpc.getAccountInfo('11111111111111111111111111111111')).toBeNull()
    expect(calls).toEqual(['https://x/1', 'https://x/2', 'https://x/3'])
    const dead = new SvmRpc(['https://x/1', 'https://x/2'], f as never)
    await expect(dead.getVersion()).rejects.toBeInstanceOf(SvmRpcError)
  })

  it('decodes base64 account data and bigint lamports', async () => {
    const f = async () => json({ jsonrpc: '2.0', id: 1, result: { value: { owner: 'o', data: ['AQID', 'base64'], lamports: 5, executable: false } } })
    const rpc = new SvmRpc(['https://x'], f as never)
    const a = await rpc.getAccountInfo('k')
    expect(a).toEqual({ owner: 'o', data: new Uint8Array([1, 2, 3]), lamports: 5n, executable: false })
    expect(() => new SvmRpc([])).toThrow(SvmRpcError)
  })
})
