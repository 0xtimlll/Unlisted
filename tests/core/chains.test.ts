import { describe, expect, it } from 'vitest'
import { allRpcHosts, byChainId, byEid, byKey, CHAINS, evmByKey, evmChains, hasLz, isChainKey, isEvm, isSvm, lzChains, lzEvmChains, providerOfHost, providerOfUrl, requireEvm, ZERO_ADDRESS } from '@/core/chains'
import { NETWORKS_EXCLUDED } from '@/core/networks'
import { cspConnectSources, isAllowedRpcHost, validateRpcUrl } from '@/core/rpcPolicy'

/** The chains that were in the registry before it was generated; their numbers must never move. */
const ANCHORS: Record<string, [number, number]> = {
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
  robinhood: [4663, 30416],
  ink: [57073, 30339],
  plasma: [9745, 30383],
  monad: [143, 30390],
}

describe('chain registry', () => {
  it('keeps every hand-verified chain with its chain id and eid', () => {
    expect(evmChains().length).toBeGreaterThanOrEqual(Object.keys(ANCHORS).length)
    for (const [key, [chainId, eid]] of Object.entries(ANCHORS)) {
      const c = evmByKey(key as never)
      expect(c.vm).toBe('evm')
      expect(c.chainId).toBe(chainId)
      expect(c.eid).toBe(eid)
      expect(c.endpointV2).not.toBe(ZERO_ADDRESS)
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

  it('has unique chainIds, keys and (where LayerZero serves the chain) eids', () => {
    const ids = new Set(evmChains().map((c) => c.chainId))
    const withLz = CHAINS.filter(hasLz)
    const eids = new Set(withLz.map((c) => c.eid))
    const keys = new Set(CHAINS.map((c) => c.key))
    expect(ids.size).toBe(evmChains().length)
    expect(eids.size).toBe(withLz.length)
    expect(keys.size).toBe(CHAINS.length)
    for (const c of CHAINS) expect(c.key).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it('a chain LayerZero does not serve has eid 0 and the zero endpoint, and is never found by eid', () => {
    const without = CHAINS.filter((c) => !hasLz(c))
    for (const c of without) {
      expect(c.eid).toBe(0)
      if (isEvm(c)) expect(c.endpointV2).toBe(ZERO_ADDRESS)
    }
    expect(byEid(0)).toBeUndefined()
    expect(lzChains().every(hasLz)).toBe(true)
    expect(lzEvmChains().every((c) => hasLz(c) && isEvm(c))).toBe(true)
    expect(lzChains().some((c) => c.key === 'solana')).toBe(true)
  })

  it('is ordered most popular first (DefiLlama TVL), then by name', () => {
    for (let i = 1; i < CHAINS.length; i++) {
      const a = CHAINS[i - 1]!
      const b = CHAINS[i]!
      expect(a.tvlUsd > b.tvlUsd || (a.tvlUsd === b.tvlUsd && a.name.localeCompare(b.name) <= 0), `${a.key} before ${b.key}`).toBe(true)
    }
    expect(CHAINS[0]!.key).toBe('ethereum')
  })

  it('every chain has at least one https RPC, explorer prefixes and a positive fee step; the anchors keep two', () => {
    for (const c of CHAINS) {
      expect(c.rpcUrls.length, c.key).toBeGreaterThanOrEqual(1)
      expect(c.rpcUrls.length, c.key).toBeLessThanOrEqual(4)
      for (const u of c.rpcUrls) {
        expect(u.startsWith('https://')).toBe(true)
        expect(new URL(u).port, `${c.key}: ${u} names a port the proxy cannot reach`).toBe('')
      }
      expect(c.explorerTxUrl.startsWith('https://')).toBe(true)
      expect(c.explorerAddrUrl.startsWith('https://')).toBe(true)
      if (isEvm(c)) expect(c.feeStepWei > 0n).toBe(true)
      else expect(c.feeStepLamports > 0n).toBe(true)
      expect(c.feeCeiling > 0n).toBe(true)
      expect(c.srcConfirmationsHint).toBeGreaterThan(0)
      expect(c.nativeSymbol).toMatch(/^[A-Za-z0-9.$]{1,12}$/)
    }
    for (const key of Object.keys(ANCHORS)) expect(byKey(key as never).rpcUrls.length, key).toBeGreaterThanOrEqual(2)
  })

  it('vm discriminant: helpers narrow without casts', () => {
    expect(CHAINS.filter(isEvm)).toHaveLength(evmChains().length)
    expect(CHAINS.filter(isSvm).map((c) => c.key)).toEqual(['solana'])
    for (const c of evmChains()) expect(requireEvm(c)).toBe(c)
    expect(byChainId(30168)).toBeUndefined() // an eid is not a chainId; svm has no chainId at all
  })

  it('lookups work', () => {
    expect(byEid(30367)?.key).toBe('hyperevm')
    expect(byEid(30416)?.key).toBe('robinhood')
    expect(byChainId(4663)?.key).toBe('robinhood')
    expect(byEid(30339)?.key).toBe('ink')
    expect(byChainId(57073)?.key).toBe('ink')
    expect(byEid(30383)?.key).toBe('plasma')
    expect(byChainId(9745)?.key).toBe('plasma')
    expect(byEid(30390)?.key).toBe('monad')
    expect(byChainId(143)?.key).toBe('monad')
    expect(byChainId(1)?.key).toBe('ethereum')
    expect(byEid(1)).toBeUndefined()
    expect(byChainId(30101)).toBeUndefined()
    expect(() => byKey('nope' as never)).toThrow()
    expect(isChainKey('ethereum')).toBe(true)
    expect(isChainKey('constructor')).toBe(false)
    expect(isChainKey(1)).toBe(false)
  })

  it('an excluded chain is recorded with its reason and is not in the registry', () => {
    for (const e of NETWORKS_EXCLUDED) {
      expect(e.reason.length).toBeGreaterThan(0)
      expect(byChainId(e.chainId)).toBeUndefined()
    }
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

describe('RPC operators: a cross-check counts companies, not hostnames', () => {
  it('every registry RPC names an operator, and rpcUrls is derived from the same list', () => {
    for (const c of CHAINS) {
      expect(c.rpcs.length).toBeGreaterThan(0)
      for (const r of c.rpcs) expect(r.provider).toMatch(/^[a-z0-9-]+\.[a-z]+$/)
      expect(c.rpcUrls).toEqual(c.rpcs.map((r) => r.url))
    }
  })

  it('providerOfHost reduces a hostname to its registrable domain', () => {
    expect(providerOfHost('solana-rpc.publicnode.com')).toBe('publicnode.com')
    expect(providerOfHost('solana.publicnode.com')).toBe('publicnode.com')
    expect(providerOfHost('eth.drpc.org')).toBe('drpc.org')
    expect(providerOfHost('example.com')).toBe('example.com')
  })

  it('providerOfUrl prefers the declared operator and falls back to the host', () => {
    expect(providerOfUrl('https://eth.drpc.org')).toBe('drpc.org')
    expect(providerOfUrl('https://my-node.example.org/rpc')).toBe('example.org')
    expect(providerOfUrl('not a url')).toBe('not a url')
  })

  it("Solana's two public endpoints are ONE operator — this is the case the rule exists for", () => {
    const sol = byKey('solana')
    expect(sol.rpcs).toHaveLength(2)
    expect(new Set(sol.rpcs.map((r) => r.provider))).toEqual(new Set(['publicnode.com']))
  })

  it('every hand-verified EVM chain has two or more distinct operators; the long tail may have one, never none', () => {
    for (const key of Object.keys(ANCHORS)) {
      const providers = new Set(byKey(key as never).rpcs.map((r) => r.provider))
      expect(providers.size, `${key} has only one RPC operator`).toBeGreaterThanOrEqual(2)
    }
    for (const c of evmChains()) expect(new Set(c.rpcs.map((r) => r.provider)).size, c.key).toBeGreaterThanOrEqual(1)
  })
})
