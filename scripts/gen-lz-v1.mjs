#!/usr/bin/env node
/**
 * Regenerates src/protocols/lz-v1/chains.json from LayerZero's own metadata.
 *
 *   node scripts/gen-lz-v1.mjs          write the file
 *   node scripts/gen-lz-v1.mjs --check  fail if the committed file is not what the API says
 *
 * Source: https://metadata.layerzero-api.com/v1/metadata/deployments — the same endpoint the
 * LayerZero CLI reads. Filter, exactly as §3 specifies it:
 *
 *   chainDetails.chainType === 'evm'
 *   chainDetails.chainStatus !== 'DEPRECATED'
 *   deployments[] entry with version === 1 && stage === 'mainnet'
 *
 * For a v1 mainnet deployment the `eid` IS the uint16 chain id the contracts take (Ethereum 101,
 * BNB 102, …) — v2's eids are the same number plus 30000. Nothing here converts between them;
 * the number is copied as the API gives it.
 *
 * The result is COMMITTED and read from disk at runtime. This script is never part of the build:
 * an app that fetched this list on load would take its routing from a server it does not control,
 * and a chain id or endpoint arriving from a network is exactly what §0 forbids.
 *
 * Chains that have a v1 deployment but are not in the app's registry are printed, never written —
 * adding a chain is a decision, not a side effect of running a script.
 *
 * **A deployed endpoint is not a working network.** Endpoint V1 routes messages through whatever
 * `defaultSendLibrary` / `defaultReceiveLibraryAddress` point at, and a chain can have the endpoint
 * deployed and answering while neither is set — Robinhood Chain is exactly that today. Such a chain
 * is written with `v1Active: false` and the reason, and the app then offers it as neither a source
 * nor a destination for v1. So this script talks to each chain's RPC: the answer is committed, and
 * `--check` re-asks, which is what turns "LayerZero wired it up since" into a failing check rather
 * than a silent gap.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, fallback, http, parseAbi } from 'viem'
import { CHAINS } from '../src/core/chains.ts'

const SOURCE = 'https://metadata.layerzero-api.com/v1/metadata/deployments'
const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'src/protocols/lz-v1/chains.json')

const check = process.argv.includes('--check')

/**
 * Endpoint.sol (LayerZero-Labs/LayerZero, contracts/Endpoint.sol):
 *   ILayerZeroMessagingLibrary public defaultSendLibrary;
 *   address public defaultReceiveLibraryAddress;
 * Both are set by `newVersion`/`setDefaultSendVersion`/`setDefaultReceiveVersion`; zero means the
 * endpoint has no library for that direction and nothing can travel it.
 */
const endpointAbi = parseAbi([
  'function defaultSendLibrary() view returns (address)',
  'function defaultReceiveLibraryAddress() view returns (address)',
])
const ZERO = '0x0000000000000000000000000000000000000000'

/** Reads both default libraries. A chain whose RPCs cannot be reached is reported, never guessed. */
async function messagingState(chain, endpoint) {
  const client = createPublicClient({
    transport: fallback(
      chain.rpcUrls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })),
      { rank: false },
    ),
  })
  const read = (functionName) => client.readContract({ address: endpoint, abi: endpointAbi, functionName })
  let send, receive
  try {
    ;[send, receive] = await Promise.all([read('defaultSendLibrary'), read('defaultReceiveLibraryAddress')])
  } catch (e) {
    return { ok: false, reason: `could not be read: ${(e.shortMessage ?? e.message ?? String(e)).split('\n')[0]}` }
  }
  const dead = []
  if (!send || send.toLowerCase() === ZERO) dead.push('defaultSendLibrary')
  if (!receive || receive.toLowerCase() === ZERO) dead.push('defaultReceiveLibraryAddress')
  if (dead.length) return { ok: true, active: false, reason: `${dead.join(' and ')} ${dead.length > 1 ? 'are' : 'is'} the zero address` }
  return { ok: true, active: true, send, receive }
}

const res = await fetch(SOURCE)
if (!res.ok) {
  console.error(`${SOURCE} answered ${res.status}`)
  process.exit(1)
}
const metadata = await res.json()

/** Every v1 mainnet EVM deployment the API lists, in chain-id order. */
const found = []
for (const entry of Object.values(metadata)) {
  const cd = entry?.chainDetails
  if (!cd || cd.chainType !== 'evm' || cd.chainStatus === 'DEPRECATED') continue
  const dep = (entry.deployments ?? []).find((d) => d.version === 1 && d.stage === 'mainnet')
  if (!dep) continue
  const endpoint = dep.endpoint?.address
  const v1ChainId = Number(dep.eid)
  if (!endpoint || !Number.isInteger(v1ChainId)) continue
  found.push({
    lzChainKey: cd.chainKey,
    name: cd.name ?? cd.shortName ?? cd.chainKey,
    nativeChainId: cd.nativeChainId,
    status: cd.chainStatus,
    v1ChainId,
    endpoint,
    // UltraLightNodeV2, when this chain has one. It is the contract that stamps the source chain
    // id into every packet (`localChainId`), so it — not the Endpoint, whose own `getChainId()`
    // still returns the pre-renumbering value on the first six chains — is what an on-chain check
    // of a v1 chain id has to ask. Absent for a chain served only through the 301 libraries.
    uln: dep.ultraLightNodeV2?.address,
  })
}
found.sort((a, b) => a.v1ChainId - b.v1ChainId)

// uint16 is the type the contracts take; anything outside it would silently truncate on the wire.
for (const f of found) {
  if (f.v1ChainId <= 0 || f.v1ChainId > 0xffff) {
    console.error(`${f.lzChainKey}: v1 chain id ${f.v1ChainId} does not fit in uint16`)
    process.exit(1)
  }
}

const evm = CHAINS.filter((c) => c.vm === 'evm')
const byNativeChainId = new Map(found.map((f) => [f.nativeChainId, f]))

const chains = {}
const missing = []
const unreadable = []
for (const c of evm) {
  const f = byNativeChainId.get(c.chainId)
  if (!f) {
    missing.push(c)
    continue
  }
  const state = await messagingState(c, f.endpoint)
  if (!state.ok) {
    // Never written as either active or inactive: an RPC that did not answer is not a fact about
    // the chain, and writing a guess here would decide routing for every user of this build.
    unreadable.push({ key: c.key, reason: state.reason })
    console.error(`${c.key}: ${state.reason}`)
    continue
  }
  chains[c.key] = {
    lzChainKey: f.lzChainKey,
    v1ChainId: f.v1ChainId,
    endpoint: f.endpoint,
    nativeChainId: f.nativeChainId,
    ...(f.uln ? { uln: f.uln } : {}),
    v1Active: state.active,
    ...(state.active ? {} : { v1InactiveReason: state.reason }),
  }
}
if (unreadable.length) {
  console.error(`\n${unreadable.length} chain(s) could not be read; refusing to write a partial table.`)
  process.exit(1)
}

const doc = {
  $source: SOURCE,
  $filter: "chainType === 'evm', chainStatus !== 'DEPRECATED', deployments[]: version === 1 && stage === 'mainnet'",
  $generated: new Date().toISOString().slice(0, 10),
  $note:
    'Generated by scripts/gen-lz-v1.mjs. Addresses are verbatim from the metadata source (lowercase); chains.ts checksums them on read. Never fetched at runtime. `v1Active` is read from each Endpoint V1 on chain: false means it has no default send or receive library, so nothing can travel that network over v1.',
  chains,
}
const text = `${JSON.stringify(doc, null, 2)}\n`

if (check) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`${OUT} does not exist — run without --check`)
    process.exit(1)
  }
  // The date changes on every run and says nothing about the data, so it is not what is compared.
  const strip = (s) => JSON.stringify({ ...JSON.parse(s), $generated: '' })
  if (strip(current) !== strip(text)) {
    console.error('src/protocols/lz-v1/chains.json is out of date with the metadata API')
    process.exit(1)
  }
  const active = Object.values(chains).filter((c) => c.v1Active).length
  console.log(`chains.json matches ${SOURCE} and the chains themselves (${active}/${Object.keys(chains).length} active for v1)`)
} else {
  writeFileSync(OUT, text)
  const active = Object.values(chains).filter((c) => c.v1Active).length
  console.log(`wrote ${OUT} — ${Object.keys(chains).length} of ${evm.length} EVM chains, ${active} active for v1`)
  for (const [key, c] of Object.entries(chains)) {
    if (!c.v1Active) console.log(`  v1 INACTIVE: ${key} — ${c.v1InactiveReason}`)
  }
}

for (const c of missing) {
  console.log(`no v1 deployment for a chain in the registry: ${c.key} (chainId ${c.chainId})`)
}

const inProject = new Set(evm.map((c) => c.chainId))
const rest = found.filter((f) => !inProject.has(f.nativeChainId))
console.log(`\n${rest.length} chains have a LayerZero v1 mainnet deployment and are NOT in the registry:`)
for (const f of rest) {
  const id = f.nativeChainId === undefined ? 'chainId unknown' : `chainId ${f.nativeChainId}`
  console.log(`  ${String(f.v1ChainId).padStart(3)}  ${f.lzChainKey.padEnd(20)} ${id}${f.status === 'PRIVATE' ? '  [PRIVATE]' : ''}`)
}
