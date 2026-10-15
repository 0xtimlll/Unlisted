#!/usr/bin/env node
/**
 * «Обнови сети»: rebuilds src/core/networks.ts — the one committed registry every chain table in
 * the app is derived from — out of the official sources, and verifies every address on chain
 * before writing it.
 *
 *   node scripts/update-networks.ts                write networks.ts, public/chains/*.svg, ATTRIBUTION.md
 *   node scripts/update-networks.ts --check        fetch and verify again; fail if the committed file differs
 *   node scripts/update-networks.ts --skip-icons   do not download or recolour logos
 *   node scripts/update-networks.ts --only=1,56    restrict the on-chain work to these chain ids (debugging)
 *
 * Run by hand. Never part of the build and never of the runtime: an app that took a chain id, an
 * endpoint or a router from a network it does not control would be taking its routing from that
 * network (CLAUDE.md rule 1). The output is committed, read from disk, and diffed like code.
 *
 * Sources (all official, all machine-readable):
 *   LayerZero   metadata.layerzero-api.com — eid and EndpointV2 (v2), chain id and Endpoint (v1)
 *   Wormhole    wormhole-foundation/wormhole-sdk-ts, core/base/src/constants — chain ids, the EVM
 *               platform list, native chain ids, core and token bridges (NTT)
 *   Chainlink   smartcontractkit/chain-selectors (selectors.yml) + smartcontractkit/documentation
 *               (the data behind the CCIP Directory) — selector, Router, TokenAdminRegistry
 *   Hyperlane   hyperlane-xyz/hyperlane-registry — Mailbox and domain, plus public RPCs, block
 *               time and explorer as a second opinion on chain metadata
 *   chainlist   ethereum-lists/chains — chain id, name, native currency, explorer, public RPCs
 *   DefiLlama   api.llama.fi/v2/chains — TVL, the number the network picker sorts by; and
 *               coins.llama.fi for the native coin's price, which sizes a new chain's fee ceiling
 *   web3icons   0xa3k5/web3icons (MIT) — network marks and their brand colour
 *
 * A chain is included when at least one of LayerZero (v2 or v1), Wormhole NTT or CCIP serves it
 * and it is EVM. Solana is the one non-EVM chain and is curated. Testnets are dropped by name
 * (LayerZero lists Sepolia under stage "mainnet"), and scripts/networks-curated.json names the
 * rest to exclude.
 *
 * What is verified on chain, per chain, before anything is written (rule 4): every candidate RPC
 * answers eth_chainId with this chain's id and eth_getCode with bytecode at the chain's anchor
 * contract; EndpointV2 answers eid(); Endpoint v1 has code and its default libraries decide
 * `active`; the Wormhole core bridge answers chainId() with the Wormhole number; the CCIP Router
 * and TokenAdminRegistry answer typeAndVersion() with their own type; the Hyperlane Mailbox answers
 * localDomain() with the registry's domain and VERSION() 3. A protocol whose contract fails any
 * of this is dropped from that chain and the discrepancy is printed and recorded; a chain with no
 * reachable RPC, or none of its protocols verified, is excluded and recorded with the reason. Such
 * a chain is a manual check away from being added, never a silent one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { decodeAbiParameters, getAddress, isAddress, toFunctionSelector, type Hex } from 'viem'

const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'src/core/networks.ts')
const CURATED = join(ROOT, 'scripts/networks-curated.json')
const ICONS = join(ROOT, 'public/chains')
const ATTRIBUTION = join(ICONS, 'ATTRIBUTION.md')

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const SKIP_ICONS = args.includes('--skip-icons')
const VERBOSE = args.includes('--verbose')
const ONLY = new Set((args.find((a) => a.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean).map(Number))
const CONCURRENCY = Number(args.find((a) => a.startsWith('--concurrency='))?.slice(14) ?? 3)

const SOURCES = {
  layerzero: 'https://metadata.layerzero-api.com/v1/metadata/deployments',
  wormholeChains: 'https://raw.githubusercontent.com/wormhole-foundation/wormhole-sdk-ts/main/core/base/src/constants/chains.ts',
  wormholePlatforms: 'https://raw.githubusercontent.com/wormhole-foundation/wormhole-sdk-ts/main/core/base/src/constants/platforms.ts',
  wormholeNativeChainIds: 'https://raw.githubusercontent.com/wormhole-foundation/wormhole-sdk-ts/main/core/base/src/constants/nativeChainIds.ts',
  wormholeCore: 'https://raw.githubusercontent.com/wormhole-foundation/wormhole-sdk-ts/main/core/base/src/constants/contracts/core.ts',
  wormholeTokenBridge: 'https://raw.githubusercontent.com/wormhole-foundation/wormhole-sdk-ts/main/core/base/src/constants/contracts/tokenBridge.ts',
  ccipSelectors: 'https://raw.githubusercontent.com/smartcontractkit/chain-selectors/main/selectors.yml',
  ccipDirectory: 'https://raw.githubusercontent.com/smartcontractkit/documentation/main/src/config/data/ccip/v1_2_0/mainnet/chains.json',
  hyperlaneMetadata: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/chains/metadata.yaml',
  hyperlaneAddresses: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/chains/addresses.yaml',
  chainlist: 'https://chainid.network/chains.json',
  defillamaChains: 'https://api.llama.fi/v2/chains',
  defillamaPrices: 'https://coins.llama.fi/prices/current/',
  web3iconsMetadata: 'https://raw.githubusercontent.com/0xa3k5/web3icons/main/packages/common/src/metadata/networks.json',
  web3iconsSvg: 'https://raw.githubusercontent.com/0xa3k5/web3icons/main/raw-svgs/networks/',
} as const

/* ------------------------------------------------------------------------------------------ */
/* Types of what is written                                                                   */

type Rpc = { url: string; provider: string }
type LzV1 = { chainId: number; endpoint: string; uln: string | null; active: boolean; inactiveReason: string | null }
type Lz = { chainKey: string; eid: number; endpointV2: string | null; v1: LzV1 | null }
type Wormhole = { chainName: string; chainId: number; coreBridge: string; tokenBridge: string | null }
type Ccip = { selector: string; registryName: string; directoryKey: string; router: string; routerVersion: string; tokenAdminRegistry: string; tokenAdminRegistryVersion: string }
type Hyperlane = { domain: number; registryName: string; mailbox: string }
type Brand = { bg: string; dark: boolean; logo: boolean }
type Network = {
  vm: 'evm' | 'svm'
  name: string
  chainId: number | null
  nativeSymbol: string
  nativeDecimals: number
  rpcs: Rpc[]
  explorerTxUrl: string
  explorerAddrUrl: string
  srcConfirmationsHint: number
  blockTimeSec: number | null
  feeStep: string
  feeCeiling: string
  tvlUsd: number
  coingeckoPlatform: string | null
  lz: Lz | null
  wormhole: Wormhole | null
  ccip: Ccip | null
  hyperlane: Hyperlane | null
  brand: Brand
}

type Curated = {
  $note?: string
  key: string
  name: string
  nativeSymbol: string
  rpcs: Rpc[]
  explorerTxUrl: string
  explorerAddrUrl: string
  srcConfirmationsHint: number
  blockTimeSec?: number
  feeStep: string
  feeCeiling: string
  brand: { bg: string; dark?: boolean }
  logo: 'keep'
  coingeckoPlatform?: string
}
type CuratedFile = { chains: Record<string, Curated>; names: Record<string, string>; exclude: Record<string, string> }

/* ------------------------------------------------------------------------------------------ */
/* Fetching                                                                                   */

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`${url} answered ${r.status}`)
  return r.text()
}
const fetchJson = async (url: string): Promise<unknown> => JSON.parse(await fetchText(url))

/* ------------------------------------------------------------------------------------------ */
/* Source parsing                                                                             */

type LzRow = { lzChainKey: string; name: string | undefined; chainType: string; status: string; chainId: number | undefined; symbol: string | undefined; decimals: number | undefined; cgId: string | undefined; blockTimeMs: number | undefined; explorer: string | undefined; v2: { eid: number; endpointV2: string } | undefined; v1: { eid: number; endpoint: string; uln: string | undefined } | undefined }

const TESTNET = /testnet|sepolia|holesky|hoodi|goerli|devnet|fuji|mumbai|amoy|chapel|cardona|baklava|alfajores|moonbase|shibuya|bartio|bepolia/i

function parseLayerZero(raw: unknown): LzRow[] {
  const rows: LzRow[] = []
  for (const e of Object.values(raw as Record<string, Record<string, unknown>>)) {
    const cd = e['chainDetails'] as Record<string, unknown> | undefined
    if (!cd) continue
    const deployments = (e['deployments'] as Record<string, unknown>[] | undefined) ?? []
    const d2 = deployments.find((d) => d['version'] === 2 && d['stage'] === 'mainnet')
    const d1 = deployments.find((d) => d['version'] === 1 && d['stage'] === 'mainnet')
    const addr = (d: Record<string, unknown> | undefined, k: string): string | undefined => (d?.[k] as { address?: string } | undefined)?.address
    const nc = cd['nativeCurrency'] as Record<string, unknown> | undefined
    rows.push({
      lzChainKey: String(cd['chainKey'] ?? e['chainKey']),
      name: typeof cd['name'] === 'string' ? cd['name'] : undefined,
      chainType: String(cd['chainType']),
      status: String(cd['chainStatus']),
      chainId: typeof cd['nativeChainId'] === 'number' ? cd['nativeChainId'] : undefined,
      symbol: typeof nc?.['symbol'] === 'string' ? nc['symbol'] : undefined,
      decimals: typeof nc?.['decimals'] === 'number' ? nc['decimals'] : undefined,
      cgId: typeof nc?.['cgId'] === 'string' ? nc['cgId'] : undefined,
      blockTimeMs: typeof cd['averageBlockTime'] === 'number' ? cd['averageBlockTime'] : undefined,
      explorer: ((e['blockExplorers'] as { url?: string }[] | undefined) ?? [])[0]?.url,
      v2: d2 && addr(d2, 'endpointV2') && Number.isInteger(Number(d2['eid'])) ? { eid: Number(d2['eid']), endpointV2: addr(d2, 'endpointV2')! } : undefined,
      v1: d1 && addr(d1, 'endpoint') && Number.isInteger(Number(d1['eid'])) ? { eid: Number(d1['eid']), endpoint: addr(d1, 'endpoint')!, uln: addr(d1, 'ultraLightNodeV2') } : undefined,
    })
  }
  return rows
}

type WhRow = { name: string; wormholeChainId: number; coreBridge: string; tokenBridge: string | undefined }

/** The SDK's constant tables are TypeScript, read as text: `[ 46, "Ink" ]`, `["Ink", "0x…"]`, `["Ink", 57073n]`. */
function parseWormhole(chainsTs: string, platformsTs: string, nativeIdsTs: string, coreTs: string, tokenBridgeTs: string): { evm: Map<number, WhRow>; solana: WhRow | undefined } {
  const ids = new Map([...chainsTs.matchAll(/\[\s*(\d+),\s*"([A-Za-z0-9]+)"\s*\]/g)].map((m) => [m[2]!, Number(m[1])]))
  const evmStart = platformsTs.indexOf('"Evm", [')
  const evmBlock = platformsTs.slice(evmStart, platformsTs.indexOf(']]', evmStart))
  const evmNames = new Set([...evmBlock.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]!).filter((n) => n !== 'Evm'))
  const mainnet = (ts: string) => ts.slice(ts.indexOf('"Mainnet"'), ts.indexOf('"Testnet"'))
  const nativeIds = new Map([...mainnet(nativeIdsTs).matchAll(/\[\s*"([A-Za-z0-9]+)",\s*(\d+)n\s*\]/g)].map((m) => [m[1]!, Number(m[2])]))
  const core = new Map([...mainnet(coreTs).matchAll(/\[\s*"([A-Za-z0-9]+)",\s*"([^"]+)"\s*\]/g)].map((m) => [m[1]!, m[2]!]))
  const tokenBridge = new Map([...mainnet(tokenBridgeTs).matchAll(/\[\s*"([A-Za-z0-9]+)",\s*"([^"]+)"\s*\]/g)].map((m) => [m[1]!, m[2]!]))
  const evm = new Map<number, WhRow>()
  for (const name of evmNames) {
    const chainId = nativeIds.get(name)
    const cb = core.get(name)
    const id = ids.get(name)
    if (chainId === undefined || id === undefined || !cb || !isAddress(cb)) continue
    const tb = tokenBridge.get(name)
    evm.set(chainId, { name, wormholeChainId: id, coreBridge: getAddress(cb), tokenBridge: tb && isAddress(tb) ? getAddress(tb) : undefined })
  }
  const solCore = core.get('Solana')
  const solana = solCore && ids.has('Solana') ? { name: 'Solana', wormholeChainId: ids.get('Solana')!, coreBridge: solCore, tokenBridge: undefined } : undefined
  return { evm, solana }
}

type CcipRow = Ccip & { chainId: number }

/** selectors.yml is read as text: a uint64 selector does not survive a YAML number. */
function parseCcip(selectorsYml: string, directory: unknown): Map<number, CcipRow> {
  const bySelector = new Map<string, { chainId: number; name: string; testnet: boolean }>()
  for (const m of selectorsYml.matchAll(/^ {2}(\d+):\s*\n\s+selector:\s*(\d+)\s*\n\s+name:\s*"([^"]+)"(?:\s*\n\s+network_type:\s*(\w+))?/gm)) {
    bySelector.set(m[2]!, { chainId: Number(m[1]), name: m[3]!, testnet: m[4] === 'testnet' })
  }
  const out = new Map<number, CcipRow>()
  for (const [directoryKey, v] of Object.entries(directory as Record<string, Record<string, unknown>>)) {
    const sel = bySelector.get(String(v['chainSelector']))
    const router = v['router'] as { address?: string; version?: string } | undefined
    const tar = v['tokenAdminRegistry'] as { address?: string; version?: string } | undefined
    if (!sel || sel.testnet || !router?.address || !isAddress(router.address) || !tar?.address || !isAddress(tar.address)) continue
    out.set(sel.chainId, {
      chainId: sel.chainId,
      selector: String(v['chainSelector']),
      registryName: sel.name,
      directoryKey,
      router: getAddress(router.address),
      routerVersion: router.version ?? '',
      tokenAdminRegistry: getAddress(tar.address),
      tokenAdminRegistryVersion: tar.version ?? '',
    })
  }
  return out
}

type HlRow = { name: string; displayName: string | undefined; domain: number; mailbox: string | undefined; rpcs: string[]; blockTimeSec: number | undefined; explorer: string | undefined; symbol: string | undefined; decimals: number | undefined; cgId: string | undefined }

function parseHyperlane(metadataYaml: string, addressesYaml: string): Map<number, HlRow> {
  const meta = yaml.load(metadataYaml) as Record<string, Record<string, unknown>>
  const addr = yaml.load(addressesYaml) as Record<string, Record<string, unknown>>
  const out = new Map<number, HlRow>()
  for (const [name, c] of Object.entries(meta)) {
    if (c['protocol'] !== 'ethereum' || c['isTestnet'] === true || typeof c['chainId'] !== 'number' || typeof c['domainId'] !== 'number') continue
    const avail = c['availability'] as { status?: string } | undefined
    if (avail?.status === 'disabled') continue
    const nt = c['nativeToken'] as Record<string, unknown> | undefined
    const mailbox = (addr[name]?.['mailbox'] as string | undefined) ?? undefined
    const explorers = (c['blockExplorers'] as { url?: string; family?: string }[] | undefined) ?? []
    out.set(c['chainId'], {
      name,
      displayName: typeof c['displayName'] === 'string' ? c['displayName'] : undefined,
      domain: c['domainId'],
      mailbox: mailbox && isAddress(mailbox) ? getAddress(mailbox) : undefined,
      rpcs: ((c['rpcUrls'] as { http?: string }[] | undefined) ?? []).map((r) => r.http ?? '').filter((u) => u.startsWith('https://')),
      blockTimeSec: typeof (c['blocks'] as { estimateBlockTime?: number } | undefined)?.estimateBlockTime === 'number' ? (c['blocks'] as { estimateBlockTime: number }).estimateBlockTime : undefined,
      explorer: (explorers.find((x) => x.family === 'etherscan' || x.family === 'blockscout' || x.family === 'routescan') ?? explorers[0])?.url,
      symbol: typeof nt?.['symbol'] === 'string' ? nt['symbol'] : undefined,
      decimals: typeof nt?.['decimals'] === 'number' ? nt['decimals'] : undefined,
      cgId: typeof c['gasCurrencyCoinGeckoId'] === 'string' ? c['gasCurrencyCoinGeckoId'] : undefined,
    })
  }
  return out
}

type ClRow = { name: string; rpcs: string[]; symbol: string | undefined; decimals: number | undefined; explorer: string | undefined; deprecated: boolean }

function parseChainlist(raw: unknown): Map<number, ClRow> {
  const out = new Map<number, ClRow>()
  for (const c of raw as Record<string, unknown>[]) {
    if (typeof c['chainId'] !== 'number') continue
    const nc = c['nativeCurrency'] as Record<string, unknown> | undefined
    const explorers = (c['explorers'] as { url?: string; standard?: string }[] | undefined) ?? []
    out.set(c['chainId'], {
      name: String(c['name'] ?? ''),
      rpcs: ((c['rpc'] as string[] | undefined) ?? []).filter((u) => typeof u === 'string' && u.startsWith('https://') && !u.includes('${')),
      symbol: typeof nc?.['symbol'] === 'string' ? nc['symbol'] : undefined,
      decimals: typeof nc?.['decimals'] === 'number' ? nc['decimals'] : undefined,
      explorer: (explorers.find((x) => x.standard === 'EIP3091') ?? explorers[0])?.url,
      deprecated: c['status'] === 'deprecated',
    })
  }
  return out
}

/* ------------------------------------------------------------------------------------------ */
/* JSON-RPC, straight over fetch, with the same short timeout the proxy uses                  */

const RPC_TIMEOUT_MS = 8_000

/** One JSON-RPC call; a 429 is waited out and retried twice, because it says "busy", not "wrong". */
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpcOnce(url, method, params)
    } catch (e) {
      if (attempt < 2 && /HTTP 429/.test(String((e as Error).message))) {
        await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)))
        continue
      }
      throw e
    }
  }
}

async function rpcOnce(url: string, method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = (await r.json()) as { result?: unknown; error?: { message?: string; code?: number } }
  if (j.error) throw new Error(`${method}: ${j.error.message ?? j.error.code}`)
  return j.result
}

/** Reads on the first URL that answers at all; a transport failure moves on, a revert does not. */
async function readOn(urls: readonly string[], to: string, data: Hex): Promise<Hex> {
  let last: unknown
  for (const url of urls) {
    try {
      const r = await rpc(url, 'eth_call', [{ to, data }, 'latest'])
      if (typeof r !== 'string' || !r.startsWith('0x')) throw new Error('eth_call answered without data')
      return r as Hex
    } catch (e) {
      last = e
      const msg = String((e as Error).message ?? e).toLowerCase()
      // A revert is the contract's answer, not the provider's absence; do not ask another node.
      if (msg.includes('revert') || msg.includes('execution')) throw e
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

async function codeAt(urls: readonly string[], address: string): Promise<boolean> {
  let last: unknown
  for (const url of urls) {
    try {
      const code = await rpc(url, 'eth_getCode', [address, 'latest'])
      return typeof code === 'string' && code.length > 2
    } catch (e) {
      last = e
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

const SEL = {
  eid: toFunctionSelector('function eid() view returns (uint32)'),
  chainId: toFunctionSelector('function chainId() view returns (uint16)'),
  localDomain: toFunctionSelector('function localDomain() view returns (uint32)'),
  version: toFunctionSelector('function VERSION() view returns (uint8)'),
  typeAndVersion: toFunctionSelector('function typeAndVersion() view returns (string)'),
  defaultSendLibrary: toFunctionSelector('function defaultSendLibrary() view returns (address)'),
  defaultReceiveLibraryAddress: toFunctionSelector('function defaultReceiveLibraryAddress() view returns (address)'),
} as const

const uint = (hex: Hex): number => Number(decodeAbiParameters([{ type: 'uint256' }], hex)[0])
const str = (hex: Hex): string => decodeAbiParameters([{ type: 'string' }], hex)[0]
const address = (hex: Hex): string => decodeAbiParameters([{ type: 'address' }], hex)[0]
const ZERO = '0x0000000000000000000000000000000000000000'

/* ------------------------------------------------------------------------------------------ */
/* RPC discovery                                                                              */

/** The operator a hostname belongs to: its registrable domain, the same rule src/core/chains.ts applies. */
function providerOfHost(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean)
  const domain = parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.')
  return OPERATOR_ALIASES[domain] ?? domain
}

/** Domains that belong to one company: two of its hostnames are one opinion, never a cross-check. */
const OPERATOR_ALIASES: Record<string, string> = {
  'binance.org': 'bnbchain.org',
  'bnbchain.org': 'bnbchain.org',
}

/**
 * Hosts never offered as a registry RPC. Tenderly gateways front virtual networks whose state the
 * creator chooses (see src/core/rpcPolicy.ts, where the same rule has stood since the first audit).
 */
const DENIED_RPC = /tenderly|localhost|127\.0\.0\.1|\.local(?:$|\/)|\/ws(?:$|\/)|wss?:/i

type Probe = { url: string; provider: string; latencyMs: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One probe, retried once after a pause when the answer was a timeout or a 429: both say "busy", not "wrong". */
async function probeRpc(url: string, chainId: number, anchor: string | undefined): Promise<Probe | { url: string; error: string }> {
  const first = await probeOnce(url, chainId, anchor)
  if (!('error' in first) || !/timeout|429|fetch failed/i.test(first.error)) return first
  await sleep(2_500)
  return probeOnce(url, chainId, anchor)
}

async function probeOnce(url: string, chainId: number, anchor: string | undefined): Promise<Probe | { url: string; error: string }> {
  const t0 = performance.now()
  try {
    const id = await rpc(url, 'eth_chainId', [])
    if (typeof id !== 'string' || Number(id) !== chainId) return { url, error: `eth_chainId answered ${String(id)}` }
    if (anchor) {
      const code = await rpc(url, 'eth_getCode', [anchor, 'latest'])
      if (typeof code !== 'string' || code.length <= 2) return { url, error: `no code at ${anchor}` }
    }
    return { url, provider: providerOfHost(new URL(url).hostname), latencyMs: Math.round(performance.now() - t0) }
  } catch (e) {
    return { url, error: String((e as Error).message ?? e).split('\n')[0]!.slice(0, 80) }
  }
}

/**
 * Pinned (curated) RPCs first, in their order, each still verified; then discovered ones in the
 * sources' order (latency decides nothing, so two runs agree), at most one URL per operator until
 * there are three operators, at most four in all.
 */
async function chooseRpcs(chainId: number, pinned: Rpc[], candidates: string[], anchor: string | undefined, log: string[]): Promise<Rpc[]> {
  const seen = new Set<string>()
  const list: string[] = []
  for (const u of [...pinned.map((r) => r.url), ...candidates]) {
    let normalized: string
    try {
      const url = new URL(u)
      // Workers' fetch reaches only the default port, so a URL naming another one is no use to the proxy.
      if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || DENIED_RPC.test(u)) continue
      normalized = url.toString()
    } catch {
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    list.push(u)
  }
  // A curated chain keeps exactly its curated list: nothing is discovered for it, so the operators
  // its cross-checks count stay the ones written down on purpose.
  const toProbe = pinned.length ? list.filter((u) => pinned.some((p) => p.url === u)) : list.slice(0, 20)
  const results: (Probe | { url: string; error: string })[] = []
  for (let i = 0; i < toProbe.length; i += 5) results.push(...(await Promise.all(toProbe.slice(i, i + 5).map((u) => probeRpc(u, chainId, anchor)))))
  const good = new Map<string, Probe>()
  const throttled = new Set<string>()
  for (const r of results) {
    if ('error' in r) {
      const isPinned = pinned.some((p) => p.url === r.url)
      // A pinned RPC that answers 429 is alive and throttling this script's burst; it stays.
      if (isPinned && /429/.test(r.error)) {
        throttled.add(r.url)
        log.push(`pinned RPC kept although it answered 429 during the run: ${r.url}`)
      } else if (isPinned) log.push(`pinned RPC dropped: ${r.url} — ${r.error}`)
      else if (VERBOSE) console.error(`  ${chainId}: ${r.url} — ${r.error}`)
      continue
    }
    good.set(r.url, r)
  }
  const out: Rpc[] = []
  for (const p of pinned) if (good.has(p.url) || throttled.has(p.url)) out.push({ url: p.url, provider: p.provider })
  const providers = new Set(out.map((r) => r.provider))
  const rest = list.map((u) => good.get(u)).filter((g): g is Probe => !!g && !pinned.some((p) => p.url === g.url))
  for (const g of rest) {
    if (out.length >= 4) break
    if (providers.has(g.provider) && providers.size < 3) continue
    out.push({ url: g.url, provider: g.provider })
    providers.add(g.provider)
  }
  return out
}

/* ------------------------------------------------------------------------------------------ */
/* Colours and marks                                                                          */

function hexToRgb(hex: string): [number, number, number] | undefined {
  let h = hex.replace('#', '')
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6)
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return undefined
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function saturation([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  return max === 0 ? 0 : (max - min) / max
}

/** The neutral tile for a network with no mark of its own, or whose mark carries no colour. */
const NEUTRAL_BG = '#3a3a3a'

/** The most-used saturated colour in a branded mark; undefined when the mark is only greys. */
function dominantColour(svg: string): string | undefined {
  const counts = new Map<string, number>()
  for (const m of svg.matchAll(/(?:fill|stop-color|stroke)\s*[:=]\s*["']?(#[0-9a-fA-F]{3,8})\b/g)) {
    const rgb = hexToRgb(m[1]!)
    if (!rgb) continue
    const L = luminance(rgb)
    if (L > 0.9 || L < 0.03 || saturation(rgb) < 0.15) continue
    const key = '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best: string | undefined
  let n = 0
  for (const [k, v] of counts) {
    if (v > n) {
      best = k
      n = v
    }
  }
  return best
}

/** web3icons publishes mono marks in white; on a light tile the mark is turned near-black. */
function recolourMono(svg: string, dark: boolean): string {
  if (!dark) return svg
  return svg.replace(/(fill|stroke)=["'](?:white|#fff|#ffffff)["']/gi, '$1="#0B0E11"').replace(/(fill|stroke):\s*(?:white|#fff|#ffffff)/gi, '$1:#0B0E11')
}

/* ------------------------------------------------------------------------------------------ */
/* Fee ceiling for a chain the curated file does not size: about 100 USD of the native coin,     */
/* rounded up to one significant digit — generous by design (guard 21 asks, never refuses).      */

function ceilingFor(priceUsd: number | undefined, decimals: number): string {
  const units = priceUsd && priceUsd > 0 ? 100 / priceUsd : 100
  const exp = Math.floor(Math.log10(units))
  const lead = Math.ceil(units / 10 ** exp)
  // Exact in bigint: the ceiling is m × 10^e with m a single digit, so the wei figure is m × 10^(e + decimals).
  const m = BigInt(lead >= 10 ? 1 : lead)
  const e = (lead >= 10 ? exp + 1 : exp) + decimals
  if (e < 0) return '1'
  return (m * 10n ** BigInt(e)).toString()
}

/* ------------------------------------------------------------------------------------------ */
/* Main                                                                                       */

async function main() {
  const curated = JSON.parse(readFileSync(CURATED, 'utf8')) as CuratedFile
  const curatedByKey = new Map(Object.values(curated.chains).map((c) => [c.key, c]))

  console.error('fetching sources…')
  const [lzRaw, whChainsTs, whPlatformsTs, whNativeTs, whCoreTs, whTokenTs, ccipSelectorsYml, ccipDir, hlMeta, hlAddr, chainlistRaw, llamaRaw, w3Raw] = await Promise.all([
    fetchJson(SOURCES.layerzero),
    fetchText(SOURCES.wormholeChains),
    fetchText(SOURCES.wormholePlatforms),
    fetchText(SOURCES.wormholeNativeChainIds),
    fetchText(SOURCES.wormholeCore),
    fetchText(SOURCES.wormholeTokenBridge),
    fetchText(SOURCES.ccipSelectors),
    fetchJson(SOURCES.ccipDirectory),
    fetchText(SOURCES.hyperlaneMetadata),
    fetchText(SOURCES.hyperlaneAddresses),
    fetchJson(SOURCES.chainlist),
    fetchJson(SOURCES.defillamaChains),
    fetchJson(SOURCES.web3iconsMetadata),
  ])

  const lzRows = parseLayerZero(lzRaw)
  const lz = new Map<number, LzRow>()
  for (const r of lzRows) {
    if (r.chainType !== 'evm' || r.status === 'DEPRECATED' || r.status === 'PRIVATE' || r.chainId === undefined) continue
    if (TESTNET.test(r.lzChainKey) || (r.name && TESTNET.test(r.name))) continue
    if (!r.v2 && !r.v1) continue
    lz.set(r.chainId, r)
  }
  const lzSolana = lzRows.find((r) => r.lzChainKey === 'solana' && r.chainType === 'solana')
  const wh = parseWormhole(whChainsTs, whPlatformsTs, whNativeTs, whCoreTs, whTokenTs)
  const ccip = parseCcip(ccipSelectorsYml, ccipDir)
  const hl = parseHyperlane(hlMeta, hlAddr)
  const cl = parseChainlist(chainlistRaw)
  const llama = (llamaRaw as { chainId?: number | string | null; name?: string; tvl?: number; gasTokenGeckoId?: string | null }[]).filter((l) => typeof l.tvl === 'number')
  // DefiLlama lists a few chains twice under two names (BSC / Binance, OP Mainnet / Optimism), one
  // of them with a zero figure; the larger one is the chain's TVL.
  const llamaById = new Map<number, (typeof llama)[number]>()
  for (const l of llama) {
    if (l.chainId === null || l.chainId === undefined || !Number.isInteger(Number(l.chainId))) continue
    const id = Number(l.chainId)
    const prev = llamaById.get(id)
    if (!prev || (l.tvl ?? 0) > (prev.tvl ?? 0)) llamaById.set(id, l)
  }
  const llamaByName = new Map(llama.map((l) => [String(l.name).toLowerCase(), l]))
  const w3 = (w3Raw as { id: string; chainId?: number | string; variants?: string[] }[]).filter((x) => x.chainId !== undefined && x.variants?.includes('mono'))
  const w3ByChainId = new Map(w3.map((x) => [Number(x.chainId), x]))

  console.error(`LayerZero ${lz.size} EVM mainnets · Wormhole ${wh.evm.size} · CCIP ${ccip.size} · Hyperlane ${hl.size} · chainlist ${cl.size} · web3icons ${w3.length} marks`)

  const chainIds = [...new Set([...lz.keys(), ...wh.evm.keys(), ...ccip.keys()])].filter((id) => !(String(id) in curated.exclude)).filter((id) => ONLY.size === 0 || ONLY.has(id)).sort((a, b) => a - b)

  type Built = { key: string; chainId: number; net: Network; iconId: string | undefined; notes: string[] }
  const built: Built[] = []
  const excluded: { chainId: number; name: string; reason: string }[] = []
  const discrepancies: string[] = []
  const usedKeys = new Set<string>(curatedByKey.keys())

  const keyFor = (chainId: number, name: string): string => {
    const cur = curated.chains[String(chainId)]
    if (cur) return cur.key
    const candidates = [lz.get(chainId)?.lzChainKey, hl.get(chainId)?.name, name].filter((x): x is string => !!x).map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ''))
    for (const c of candidates) {
      const k = /^[a-z]/.test(c) ? c : `chain${c}`
      if (k && !usedKeys.has(k)) return k
    }
    return `chain${chainId}`
  }

  const nameFor = (chainId: number): string => {
    const cur = curated.chains[String(chainId)]
    if (cur) return cur.name
    const named = curated.names[String(chainId)]
    if (named) return named
    const h = hl.get(chainId)?.displayName
    const l = lz.get(chainId)?.name
    const c = cl.get(chainId)?.name
    const pick = h ?? l ?? c ?? wh.evm.get(chainId)?.name ?? `Chain ${chainId}`
    return pick.replace(/\s+(mainnet|network)$/i, '').replace(/\s+mainnet\b/i, '').trim()
  }

  const explorerFor = (chainId: number): { tx: string; addr: string } | undefined => {
    const base = cl.get(chainId)?.explorer ?? hl.get(chainId)?.explorer ?? lz.get(chainId)?.explorer
    if (!base) return undefined
    try {
      const u = new URL(base)
      if (u.protocol !== 'https:') return undefined
      const root = u.toString().replace(/\/+$/, '')
      return { tx: `${root}/tx/`, addr: `${root}/address/` }
    } catch {
      return undefined
    }
  }

  // One chain at a time inside a worker; CONCURRENCY workers.
  let cursor = 0
  const worker = async () => {
    while (cursor < chainIds.length) {
      const chainId = chainIds[cursor++]!
      const name = nameFor(chainId)
      const cur = curated.chains[String(chainId)]
      const log: string[] = []
      const l = lz.get(chainId)
      const w = wh.evm.get(chainId)
      const c = ccip.get(chainId)
      const h = hl.get(chainId)
      const chainlist = cl.get(chainId)
      const anchor = l?.v2?.endpointV2 ?? w?.coreBridge ?? c?.router ?? l?.v1?.endpoint

      // The Hyperlane registry's list is curated by people who run relayers on it; chainlist's is longer and looser.
      const rpcs = await chooseRpcs(chainId, cur?.rpcs ?? [], [...(h?.rpcs ?? []), `https://${chainId}.rpc.thirdweb.com`, ...(chainlist?.rpcs ?? [])], anchor, log)
      if (rpcs.length === 0) {
        excluded.push({ chainId, name, reason: 'no public https RPC answered eth_chainId with this id and served the anchor contract' })
        console.error(`✗ ${name} (${chainId}): ${excluded[excluded.length - 1]!.reason}`)
        continue
      }
      const urls = rpcs.map((r) => r.url)
      const fail = (what: string) => {
        discrepancies.push(`${name} (${chainId}): ${what}`)
        log.push(what)
      }

      // LayerZero
      let lzOut: Lz | null = null
      if (l?.v2 || l?.v1) {
        let v2Ok = false
        if (l.v2) {
          try {
            if (!(await codeAt(urls, l.v2.endpointV2))) fail(`LayerZero EndpointV2 ${l.v2.endpointV2} has no code`)
            else {
              const eid = uint(await readOn(urls, l.v2.endpointV2, SEL.eid))
              if (eid !== l.v2.eid) fail(`LayerZero EndpointV2 answers eid() ${eid}, metadata says ${l.v2.eid}`)
              else v2Ok = true
            }
          } catch (e) {
            fail(`LayerZero EndpointV2 could not be read: ${String((e as Error).message).split('\n')[0]}`)
          }
        }
        let v1: LzV1 | null = null
        if (l.v1) {
          try {
            if (!(await codeAt(urls, l.v1.endpoint))) fail(`LayerZero Endpoint v1 ${l.v1.endpoint} has no code`)
            else {
              const send = address(await readOn(urls, l.v1.endpoint, SEL.defaultSendLibrary))
              const recv = address(await readOn(urls, l.v1.endpoint, SEL.defaultReceiveLibraryAddress))
              const dead = [...(send.toLowerCase() === ZERO ? ['defaultSendLibrary'] : []), ...(recv.toLowerCase() === ZERO ? ['defaultReceiveLibraryAddress'] : [])]
              v1 = {
                chainId: l.v1.eid,
                endpoint: getAddress(l.v1.endpoint),
                uln: l.v1.uln && isAddress(l.v1.uln) ? getAddress(l.v1.uln) : null,
                active: dead.length === 0,
                inactiveReason: dead.length ? `${dead.join(' and ')} ${dead.length > 1 ? 'are' : 'is'} the zero address` : null,
              }
            }
          } catch (e) {
            fail(`LayerZero Endpoint v1 could not be read: ${String((e as Error).message).split('\n')[0]}`)
          }
        }
        if (v2Ok || v1) lzOut = { chainKey: l.lzChainKey, eid: v2Ok ? l.v2!.eid : 0, endpointV2: v2Ok ? getAddress(l.v2!.endpointV2) : null, v1 }
      }

      // Wormhole
      let whOut: Wormhole | null = null
      if (w) {
        try {
          if (!(await codeAt(urls, w.coreBridge))) fail(`Wormhole core bridge ${w.coreBridge} has no code`)
          else {
            const id = uint(await readOn(urls, w.coreBridge, SEL.chainId))
            if (id !== w.wormholeChainId) fail(`Wormhole core bridge answers chainId() ${id}, the SDK says ${w.wormholeChainId}`)
            else {
              let tokenBridge: string | null = null
              if (w.tokenBridge) {
                try {
                  if ((await codeAt(urls, w.tokenBridge)) && uint(await readOn(urls, w.tokenBridge, SEL.chainId)) === w.wormholeChainId) tokenBridge = w.tokenBridge
                  else fail(`Wormhole token bridge ${w.tokenBridge} has no code or another chainId(); not recorded`)
                } catch (e) {
                  fail(`Wormhole token bridge could not be read: ${String((e as Error).message).split('\n')[0]}; not recorded`)
                }
              }
              whOut = { chainName: w.name, chainId: w.wormholeChainId, coreBridge: w.coreBridge, tokenBridge }
            }
          }
        } catch (e) {
          fail(`Wormhole core bridge could not be read: ${String((e as Error).message).split('\n')[0]}`)
        }
      }

      // CCIP
      let ccipOut: Ccip | null = null
      if (c) {
        try {
          const rOk = (await codeAt(urls, c.router)) && str(await readOn(urls, c.router, SEL.typeAndVersion)).startsWith('Router')
          const tOk = (await codeAt(urls, c.tokenAdminRegistry)) && str(await readOn(urls, c.tokenAdminRegistry, SEL.typeAndVersion)).includes('TokenAdminRegistry')
          if (!rOk) fail(`CCIP Router ${c.router} has no code or another typeAndVersion()`)
          else if (!tOk) fail(`CCIP TokenAdminRegistry ${c.tokenAdminRegistry} has no code or another typeAndVersion()`)
          else {
            const { chainId: _cid, ...rest } = c
            void _cid
            ccipOut = rest
          }
        } catch (e) {
          fail(`CCIP contracts could not be read: ${String((e as Error).message).split('\n')[0]}`)
        }
      }

      // Hyperlane
      let hlOut: Hyperlane | null = null
      if (h?.mailbox) {
        try {
          if (!(await codeAt(urls, h.mailbox))) fail(`Hyperlane Mailbox ${h.mailbox} has no code`)
          else {
            const domain = uint(await readOn(urls, h.mailbox, SEL.localDomain))
            const version = uint(await readOn(urls, h.mailbox, SEL.version))
            if (domain !== h.domain) fail(`Hyperlane Mailbox answers localDomain() ${domain}, the registry says ${h.domain}`)
            else if (version !== 3) fail(`Hyperlane Mailbox answers VERSION() ${version}, not 3`)
            else hlOut = { domain: h.domain, registryName: h.name, mailbox: h.mailbox }
          }
        } catch (e) {
          fail(`Hyperlane Mailbox could not be read: ${String((e as Error).message).split('\n')[0]}`)
        }
      }

      if (!lzOut && !whOut && !ccipOut) {
        excluded.push({ chainId, name, reason: `none of its protocol contracts verified on chain: ${log.join('; ')}` })
        console.error(`✗ ${name} (${chainId}): ${excluded[excluded.length - 1]!.reason}`)
        continue
      }

      const explorer = cur ? { tx: cur.explorerTxUrl, addr: cur.explorerAddrUrl } : explorerFor(chainId)
      if (!explorer) {
        excluded.push({ chainId, name, reason: 'no https block explorer in any source' })
        console.error(`✗ ${name} (${chainId}): no explorer`)
        continue
      }
      const plausible = (sym: string | undefined) => (sym && /^[A-Za-z0-9.$]{1,12}$/.test(sym) ? sym : undefined)
      const symbol = cur?.nativeSymbol ?? plausible(chainlist?.symbol) ?? plausible(h?.symbol) ?? plausible(l?.symbol)
      const decimals = chainlist?.decimals ?? h?.decimals ?? l?.decimals ?? 18
      if (!symbol) {
        excluded.push({ chainId, name, reason: 'no native currency symbol in any source' })
        console.error(`✗ ${name} (${chainId}): no native symbol`)
        continue
      }
      const key = keyFor(chainId, name)
      usedKeys.add(key)
      const tvl = llamaById.get(chainId) ?? llamaByName.get(name.toLowerCase())
      const blockTimeSec = cur?.blockTimeSec ?? (l?.blockTimeMs ? Math.round(l.blockTimeMs) / 1000 : undefined) ?? h?.blockTimeSec ?? null
      const net: Network = {
        vm: 'evm',
        name,
        chainId,
        nativeSymbol: symbol,
        nativeDecimals: decimals,
        rpcs,
        explorerTxUrl: explorer.tx,
        explorerAddrUrl: explorer.addr,
        srcConfirmationsHint: cur?.srcConfirmationsHint ?? 20,
        blockTimeSec,
        feeStep: cur?.feeStep ?? (symbol === 'ETH' ? '10000000000000' : '1000000000000000'),
        feeCeiling: cur?.feeCeiling ?? '',
        tvlUsd: Math.round(tvl?.tvl ?? 0),
        coingeckoPlatform: cur?.coingeckoPlatform ?? null,
        lz: lzOut,
        wormhole: whOut,
        ccip: ccipOut,
        hyperlane: hlOut,
        brand: { bg: cur?.brand.bg ?? NEUTRAL_BG, dark: cur?.brand.dark ?? false, logo: cur?.logo === 'keep' },
      }
      const iconId = cur ? undefined : w3ByChainId.get(chainId)?.id
      built.push({ key, chainId, net, iconId, notes: [...log, ...(cur ? [] : [`cgId ${l?.cgId ?? h?.cgId ?? llamaById.get(chainId)?.gasTokenGeckoId ?? '-'}`])] })
      const tags = [net.lz ? 'LZ' : '', net.wormhole ? 'WH' : '', net.ccip ? 'CCIP' : '', net.hyperlane ? 'HL' : ''].filter(Boolean).join(' ')
      console.error(`✓ ${name} (${chainId}) ${tags} · ${rpcs.length} RPC${log.length ? ` · ${log.length} note(s)` : ''}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  // Fee ceilings for the chains the curated file does not size: ~100 USD of the native coin.
  const needPrice = built.filter((b) => b.net.feeCeiling === '')
  const cgIdOf = (b: Built) => lz.get(b.chainId)?.cgId ?? hl.get(b.chainId)?.cgId ?? llamaById.get(b.chainId)?.gasTokenGeckoId ?? undefined
  const cgIds = [...new Set(needPrice.map(cgIdOf).filter((x): x is string => !!x))]
  const prices = new Map<string, number>()
  for (let i = 0; i < cgIds.length; i += 50) {
    const batch = cgIds.slice(i, i + 50)
    try {
      const r = (await fetchJson(SOURCES.defillamaPrices + batch.map((id) => `coingecko:${id}`).join(','))) as { coins?: Record<string, { price?: number }> }
      for (const [k, v] of Object.entries(r.coins ?? {})) if (typeof v.price === 'number') prices.set(k.replace('coingecko:', ''), v.price)
    } catch (e) {
      console.error(`DefiLlama prices: ${String((e as Error).message)}`)
    }
  }
  for (const b of needPrice) {
    const id = cgIdOf(b)
    const price = id ? prices.get(id) : undefined
    b.net.feeCeiling = ceilingFor(price, b.net.nativeDecimals)
    if (price === undefined) b.notes.push('no native coin price — fee ceiling defaulted to 100 units')
  }

  // Marks and brand colours for the chains the curated file does not draw.
  const attributionRows: string[] = []
  if (!SKIP_ICONS) {
    for (const b of built) {
      if (b.net.brand.logo) continue
      if (!b.iconId) {
        b.notes.push('no mark in web3icons — the tile shows initials')
        continue
      }
      try {
        const [mono, branded] = await Promise.all([fetchText(`${SOURCES.web3iconsSvg}mono/${b.iconId}.svg`), fetchText(`${SOURCES.web3iconsSvg}branded/${b.iconId}.svg`).catch(() => '')])
        if (!mono.includes('<svg')) throw new Error('not an svg')
        const bg = dominantColour(branded) ?? NEUTRAL_BG
        const rgb = hexToRgb(bg)!
        const dark = luminance(rgb) > 0.5
        b.net.brand = { bg, dark, logo: true }
        const file = join(ICONS, `${b.key}.svg`)
        if (!CHECK) writeFileSync(file, recolourMono(mono, dark))
        else if (!existsSync(file)) discrepancies.push(`${b.net.name}: public/chains/${b.key}.svg is missing`)
        attributionRows.push(`| ${b.key}.svg | networks/mono/${b.iconId}.svg | mono, ${dark ? '#0B0E11 (recoloured)' : 'white (as published)'}; tile ${bg} from networks/branded/${b.iconId}.svg |`)
      } catch (e) {
        b.notes.push(`web3icons mark ${b.iconId} could not be fetched (${String((e as Error).message)}) — the tile shows initials`)
      }
    }
  }

  // Solana: curated, with the two protocol numbers read from the sources and checked against it.
  const sol = curated.chains['solana']
  if (!sol) throw new Error('networks-curated.json has no solana entry')
  const solEid = lzSolana?.v2?.eid
  if (solEid !== 30168) throw new Error(`LayerZero metadata gives Solana v2 eid ${String(solEid)}, expected 30168`)
  if (!wh.solana || wh.solana.wormholeChainId !== 1) throw new Error('Wormhole SDK no longer lists Solana as chain 1')
  const solTvl = llamaByName.get('solana')?.tvl ?? 0
  const solana: Network = {
    vm: 'svm',
    name: sol.name,
    chainId: null,
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    rpcs: sol.rpcs,
    explorerTxUrl: sol.explorerTxUrl,
    explorerAddrUrl: sol.explorerAddrUrl,
    srcConfirmationsHint: sol.srcConfirmationsHint,
    blockTimeSec: sol.blockTimeSec ?? null,
    feeStep: sol.feeStep,
    feeCeiling: sol.feeCeiling,
    tvlUsd: Math.round(solTvl),
    coingeckoPlatform: sol.coingeckoPlatform ?? null,
    lz: { chainKey: 'solana', eid: 30168, endpointV2: null, v1: null },
    wormhole: { chainName: 'Solana', chainId: 1, coreBridge: wh.solana.coreBridge, tokenBridge: null },
    ccip: null,
    hyperlane: null,
    brand: { bg: sol.brand.bg, dark: sol.brand.dark ?? false, logo: true },
  }

  const entries = [...built.map((b) => [b.key, b.net] as const), ['solana', solana] as const].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const generated = new Date().toISOString().slice(0, 10)
  const text = render(entries, generated, excluded, discrepancies)

  if (CHECK) {
    let current = ''
    try {
      current = readFileSync(OUT, 'utf8')
    } catch {
      console.error(`${OUT} does not exist — run without --check`)
      process.exit(1)
    }
    // Dates and TVL move on every run and say nothing about the configuration; everything else must match.
    const strip = (s: string) => s.replace(/NETWORKS_GENERATED = '[^']*'/, '').replace(/tvlUsd: \d+/g, '').replace(/^ \* .*$/gm, '')
    if (strip(current) !== strip(text)) {
      writeFileSync(join(ROOT, '.networks.check.ts'), text)
      console.error(`${OUT} differs from the sources (the fresh output is in .networks.check.ts — diff it, then run without --check)`)
      process.exit(1)
    }
    console.log(`networks.ts matches the sources and the chains themselves (${entries.length} networks)`)
  } else {
    writeFileSync(OUT, text)
    if (!SKIP_ICONS) writeAttribution(attributionRows, entries.filter(([, n]) => !n.brand.logo).map(([k]) => k))
    console.log(`wrote ${OUT}: ${entries.length} networks`)
  }

  // The report the owner reads.
  const by = (f: (n: Network) => boolean) => entries.filter(([, n]) => f(n)).length
  console.log(`\nLayerZero v2 ${by((n) => !!n.lz?.endpointV2)} · LayerZero v1 ${by((n) => !!n.lz?.v1)} (active ${by((n) => n.lz?.v1?.active === true)}) · Wormhole ${by((n) => !!n.wormhole)} · CCIP ${by((n) => !!n.ccip)} · Hyperlane ${by((n) => !!n.hyperlane)}`)
  const single = entries.filter(([, n]) => new Set(n.rpcs.map((r) => r.provider)).size < 2).map(([k]) => k)
  console.log(`one RPC operator only (${single.length}): ${single.join(' ')}`)
  const noIcon = entries.filter(([, n]) => !n.brand.logo).map(([k]) => k)
  console.log(`no mark, initials shown (${noIcon.length}): ${noIcon.join(' ')}`)
  const noTvl = entries.filter(([, n]) => n.tvlUsd === 0).map(([k]) => k)
  console.log(`no TVL on DefiLlama (${noTvl.length}): ${noTvl.join(' ')}`)
  if (discrepancies.length) {
    console.log(`\n${discrepancies.length} discrepancy/ies (a protocol dropped from a chain, or a pinned RPC dropped):`)
    for (const d of discrepancies) console.log(`  ${d}`)
  }
  if (excluded.length) {
    console.log(`\n${excluded.length} chain(s) excluded:`)
    for (const e of excluded) console.log(`  ${e.name} (${e.chainId}): ${e.reason}`)
  }
  const notes = built.filter((b) => b.notes.length)
  if (notes.length) {
    console.log(`\nnotes:`)
    for (const b of notes) for (const n of b.notes) console.log(`  ${b.key}: ${n}`)
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Rendering                                                                                  */

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const v = (x: string | number | boolean | null) => (typeof x === 'string' ? q(x) : String(x))

function renderObject(o: Record<string, string | number | boolean | null | object>, indent: string): string {
  const lines: string[] = []
  for (const [k, val] of Object.entries(o)) {
    const key = /^[a-z][a-zA-Z0-9]*$/.test(k) ? k : q(k)
    if (val === null || typeof val !== 'object') lines.push(`${indent}${key}: ${v(val as string | number | boolean | null)},`)
    else if (Array.isArray(val)) lines.push(`${indent}${key}: [${val.map((x) => (typeof x === 'object' ? `{ ${Object.entries(x as Record<string, string>).map(([a, b]) => `${a}: ${v(b)}`).join(', ')} }` : v(x))).join(', ')}],`)
    else lines.push(`${indent}${key}: {\n${renderObject(val as Record<string, never>, indent + '  ')}\n${indent}},`)
  }
  return lines.join('\n')
}

function render(entries: readonly (readonly [string, Network])[], generated: string, excluded: { chainId: number; name: string; reason: string }[], discrepancies: string[]): string {
  const head = `/**
 * GENERATED by scripts/update-networks.ts — do not edit by hand; run \`npm run update:networks\`.
 *
 * Every chain this app serves, with every protocol address it will ever trust on that chain. Each
 * address was read from the official source named in the script and then verified on chain
 * before it was written here (eid(), chainId(), typeAndVersion(), localDomain(); see the script).
 * src/core/chains.ts turns this into the registry; the protocol modules take their tables from it.
 *
 * Numbers that are strings are bigints in the smallest native unit. \`tvlUsd\` is DefiLlama's
 * figure on the day of generation and only orders the network picker. A chain without LayerZero
 * has \`lz: null\`; the registry then gives it eid 0, which no LayerZero route can name.
 *
 * Keep this file free of imports: scripts/gen-headers.mjs and the Cloudflare Pages function in
 * functions/rpc load it with plain Node and the Pages bundler.
 */

export type NetworkRpc = { readonly url: string; readonly provider: string }
export type NetworkLzV1 = { readonly chainId: number; readonly endpoint: string; readonly uln: string | null; readonly active: boolean; readonly inactiveReason: string | null }
export type NetworkLz = { readonly chainKey: string; readonly eid: number; readonly endpointV2: string | null; readonly v1: NetworkLzV1 | null }
export type NetworkWormhole = { readonly chainName: string; readonly chainId: number; readonly coreBridge: string; readonly tokenBridge: string | null }
export type NetworkCcip = {
  readonly selector: string
  readonly registryName: string
  readonly directoryKey: string
  readonly router: string
  readonly routerVersion: string
  readonly tokenAdminRegistry: string
  readonly tokenAdminRegistryVersion: string
}
export type NetworkHyperlane = { readonly domain: number; readonly registryName: string; readonly mailbox: string }
export type NetworkBrand = { readonly bg: string; readonly dark: boolean; readonly logo: boolean }
export type NetworkSpec = {
  readonly vm: 'evm' | 'svm'
  readonly name: string
  readonly chainId: number | null
  readonly nativeSymbol: string
  readonly nativeDecimals: number
  readonly rpcs: readonly NetworkRpc[]
  readonly explorerTxUrl: string
  readonly explorerAddrUrl: string
  readonly srcConfirmationsHint: number
  readonly blockTimeSec: number | null
  readonly feeStep: string
  readonly feeCeiling: string
  readonly tvlUsd: number
  readonly coingeckoPlatform: string | null
  readonly lz: NetworkLz | null
  readonly wormhole: NetworkWormhole | null
  readonly ccip: NetworkCcip | null
  readonly hyperlane: NetworkHyperlane | null
  readonly brand: NetworkBrand
}

export const NETWORKS_GENERATED = '${generated}'

export const NETWORKS_SOURCES = {
${Object.entries(SOURCES)
  .map(([k, u]) => `  ${k}: ${q(u)},`)
  .join('\n')}
} as const

/** Chains the sources list that were not written, and why. A manual check away from being added. */
export const NETWORKS_EXCLUDED: readonly { readonly chainId: number; readonly name: string; readonly reason: string }[] = [
${excluded
  .sort((a, b) => a.chainId - b.chainId)
  .map((e) => `  { chainId: ${e.chainId}, name: ${q(e.name)}, reason: ${q(e.reason)} },`)
  .join('\n')}
]

/** Addresses a source named that the chain did not confirm; the protocol was dropped from that chain. */
export const NETWORKS_DISCREPANCIES: readonly string[] = [
${discrepancies
  .sort()
  .map((d) => `  ${q(d)},`)
  .join('\n')}
]

export const NETWORKS = {
`
  const body = entries.map(([key, n]) => `  ${/^[a-z][a-z0-9]*$/.test(key) ? key : q(key)}: {\n${renderObject(n as unknown as Record<string, never>, '    ')}\n  },`).join('\n')
  return `${head}${body}\n} as const\n`
}

function writeAttribution(rows: string[], initials: string[]) {
  const header = `# Network logos

Vector marks from [web3icons](https://github.com/0xa3k5/web3icons) (\`raw-svgs/networks/\`, MIT
licence), vendored here so the app never loads images from third-party hosts (CSP \`img-src 'self'\`).
Each mark is a trademark of the respective network and is used solely to identify that network.
Unlisted is not affiliated with or endorsed by any of them.

The "mono" variants were recoloured (white or near-black) to sit on the network's brand colour, which
is applied by the tile around them (\`src/core/networks.ts\`, \`brand\`); the "branded" variants are
used as published. The first table is hand-placed; the second is written by
\`scripts/update-networks.ts\`, which takes the tile colour from the most-used colour of the branded
mark. A network with no mark in web3icons shows its initials on a neutral tile instead; those are
listed at the end.

| file | source | variant |
|---|---|---|
| ethereum.svg | networks/branded/ethereum.svg | branded |
| arbitrum.svg | networks/mono/arbitrum-one.svg | mono, white |
| optimism.svg | networks/mono/optimism.svg | mono, white |
| base.svg | networks/mono/base.svg | mono, white |
| bsc.svg | networks/mono/binance-smart-chain.svg | mono, #0B0E11 |
| polygon.svg | networks/mono/polygon.svg | mono, white |
| avalanche.svg | networks/mono/avalanche.svg | mono, white |
| hyperevm.svg | networks/branded/hyper-evm.svg | branded |
| linea.svg | networks/mono/linea.svg | mono, #0B0E11 |
| scroll.svg | networks/mono/scroll.svg | mono, #101010 |
| robinhood.svg | networks/branded/robinhood.svg | branded |
| ink.svg | networks/mono/ink.svg | mono, white |
| plasma.svg | networks/mono/plasma.svg | mono, white (as published) |
| monad.svg | networks/mono/monad.svg | mono, white (as published) |
| solana.svg | networks/branded/solana.svg | branded |

## Generated

| file | source | variant |
|---|---|---|
${rows.sort().join('\n')}

## No mark (initials on a neutral tile)

${initials.sort().join(', ')}
`
  if (!existsSync(ICONS)) mkdirSync(ICONS, { recursive: true })
  writeFileSync(ATTRIBUTION, header)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
