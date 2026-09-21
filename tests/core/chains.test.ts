import { describe, expect, it } from 'vitest'
import { allRpcHosts, byChainId, byEid, byKey, CHAINS, evmByKey, evmChains, isEvm, isSvm, requireEvm } from '@/core/chains'
import { cspConnectSources, isAllowedRpcHost, validateRpcUrl } from '@/core/rpcPolicy'

describe('chain registry', () => {
  it('has all v1 chains with the right eids', () => {
    const expected: Record<string, [number, number]> = {
      ethereum: [1, 30101],
      arbitrum: [42161, 30110],
      optimism: [10, 30111],
      base: [8453, 30184],
      bsc: [56, 30102],
      polygon: [137, 30109],
      avalanche: [43114, 30106],
      hyperevm: [999, 30367],
      linea: [59144, 30183],
      scroll: [534352, 30214],
    }
    expect(evmChains()).toHaveLength(Object.keys(expected).length)
    for (const [key, [chainId, eid]] of Object.entries(expected)) {
      const c = evmByKey(key as never)
      expect(c.vm).toBe('evm')
      expect(c.chainId).toBe(chainId)
      expect(c.eid).toBe(eid)
    }
  })

  it('Solana is an svm chain with eid 30168', () => {
    const sol = byKey('solana')
    expect(sol.vm).toBe('svm')
    expect(sol.eid).toBe(30168)
    expect(isSvm(sol) && sol.feeStepLamports).toBe(10_000n)
    expect(byEid(30168)?.key).toBe('solana')
    expect(() => requireEvm(sol)).toThrow(/not an EVM chain/)
    expect(() => evmByKey('solana')).toThrow()
  })

  it('has unique chainIds, eids and keys', () => {
    const ids = new Set(evmChains().map((c) => c.chainId))
    const eids = new Set(CHAINS.map((c) => c.eid))
    const keys = new Set(CHAINS.map((c) => c.key))
    expect(ids.size).toBe(evmChains().length)
    expect(eids.size).toBe(CHAINS.length)
    expect(keys.size).toBe(CHAINS.length)
  })

  it('every chain has >= 2 https RPCs, explorer prefixes and a positive fee step', () => {
    for (const c of CHAINS) {
      expect(c.rpcUrls.length).toBeGreaterThanOrEqual(2)
      for (const u of c.rpcUrls) expect(u.startsWith('https://')).toBe(true)
      expect(c.explorerTxUrl.startsWith('https://')).toBe(true)
      expect(c.explorerAddrUrl.startsWith('https://')).toBe(true)
      if (isEvm(c)) expect(c.feeStepWei > 0n).toBe(true)
      else expect(c.feeStepLamports > 0n).toBe(true)
      expect(c.srcConfirmationsHint).toBeGreaterThan(0)
    }
  })

  it('vm discriminant: helpers narrow without casts', () => {
    expect(CHAINS.filter(isEvm)).toHaveLength(evmChains().length)
    expect(CHAINS.filter(isSvm).map((c) => c.key)).toEqual(['solana'])
    for (const c of evmChains()) expect(requireEvm(c)).toBe(c)
    expect(byChainId(30168)).toBeUndefined() // an eid is not a chainId; svm has no chainId at all
  })

  it('lookups work', () => {
    expect(byEid(30367)?.key).toBe('hyperevm')
    expect(byChainId(1)?.key).toBe('ethereum')
    expect(byEid(1)).toBeUndefined()
    expect(byChainId(30101)).toBeUndefined()
    expect(() => byKey('nope' as never)).toThrow()
  })

  it('allRpcHosts returns sorted https origins', () => {
    const hosts = allRpcHosts()
    expect(hosts.length).toBeGreaterThan(10)
    for (const h of hosts) expect(h).toMatch(/^https:\/\/[^/]+$/)
    expect([...hosts].sort()).toEqual(hosts)
  })
})

describe('validateRpcUrl', () => {
  it('accepts https on registry hosts and known providers (the CSP allow-list)', () => {
    expect(validateRpcUrl('https://ethereum-rpc.publicnode.com')).toEqual({ ok: true, url: 'https://ethereum-rpc.publicnode.com/' })
    expect(validateRpcUrl('  https://mainnet.helius-rpc.com/?api-key=x  ').ok).toBe(true)
    expect(validateRpcUrl('https://eth-mainnet.g.alchemy.com/v2/key').ok).toBe(true)
    expect(validateRpcUrl('https://my-node.solana-mainnet.quiknode.pro/abc/').ok).toBe(true)
  })
  it('refuses hosts the CSP would block, with a dedicated reason', () => {
    expect(validateRpcUrl('https://rpc.example.com/v1')).toEqual({ ok: false, reason: 'host_not_allowed' })
    expect(validateRpcUrl('https://alchemy.com')).toEqual({ ok: false, reason: 'host_not_allowed' }) // apex is not *.alchemy.com
    expect(validateRpcUrl('https://evil-alchemy.com')).toEqual({ ok: false, reason: 'host_not_allowed' })
  })
  it('CSP sources and the validator come from one list', () => {
    for (const src of cspConnectSources()) {
      const host = src.replace('https://', '').replace('*.', 'x.')
      expect(isAllowedRpcHost(host)).toBe(true)
    }
    for (const c of CHAINS) for (const u of c.rpcUrls) expect(validateRpcUrl(u).ok).toBe(true)
  })
  it('accepts http only for localhost', () => {
    expect(validateRpcUrl('http://localhost:8545').ok).toBe(true)
    expect(validateRpcUrl('http://127.0.0.1:8545').ok).toBe(true)
    expect(validateRpcUrl('http://rpc.example.com')).toEqual({ ok: false, reason: 'insecure' })
    expect(validateRpcUrl('http://192.168.1.1:8545')).toEqual({ ok: false, reason: 'insecure' })
  })
  it('rejects other schemes, credentials and garbage', () => {
    expect(validateRpcUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateRpcUrl('not a url')).toEqual({ ok: false, reason: 'not_url' })
    expect(validateRpcUrl('ws://rpc.example.com')).toEqual({ ok: false, reason: 'bad_scheme' })
    expect(validateRpcUrl('javascript:alert(1)')).toEqual({ ok: false, reason: 'bad_scheme' })
    expect(validateRpcUrl('file:///etc/passwd')).toEqual({ ok: false, reason: 'bad_scheme' })
    expect(validateRpcUrl('https://user:pass@rpc.example.com')).toEqual({ ok: false, reason: 'not_url' })
  })
})
