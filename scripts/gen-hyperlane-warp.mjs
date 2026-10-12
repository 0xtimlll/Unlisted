#!/usr/bin/env node
/**
 * Regenerates src/protocols/hyperlane/warpRoutes.json from Hyperlane's own registry.
 *
 *   node scripts/gen-hyperlane-warp.mjs          write the file
 *   node scripts/gen-hyperlane-warp.mjs --check  fail if the committed file is not what the registry says
 *
 * Source: hyperlane-xyz/hyperlane-registry, deployments/warp_routes/warpRouteConfigs.yaml — the
 * file the registry generates from every warp route it lists, and the one Hyperlane's own tooling
 * reads. Only tokens on chains this app serves, and only the EVM standards, are kept.
 *
 * What the file is FOR, and what it is not. Hyperlane has no on-chain index from a token to the
 * router that moves it: the registry is off-chain, in git. A HypERC20 (synthetic) token IS its
 * router, so pasting it works with no list at all; a plain ERC-20 held by a HypERC20Collateral has
 * nothing on chain that points at the router. This table is the SEARCH HINT for that case — a
 * pasted token looks up its candidate routers here, and each candidate is then probed from scratch
 * like any pasted address: it must name the registry Mailbox, hold exactly this token, and answer
 * every other question itself. CLAUDE.md rule 1: a list narrows the search and never raises trust;
 * a token missing from it is not refused, and nothing here colours the indicator.
 *
 * The result is COMMITTED and read from disk at runtime, so a route's candidates cannot change
 * under the app between one build and the next.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { CHAINS } from '../src/core/chains.ts'
import { HYPERLANE_CHAINS } from '../src/protocols/hyperlane/chains.ts'

const SOURCE = 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/warp_routes/warpRouteConfigs.yaml'
const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'src/protocols/hyperlane/warpRoutes.json')

const check = process.argv.includes('--check')

const r = await fetch(SOURCE)
if (!r.ok) {
  console.error(`${SOURCE} answered ${r.status}`)
  process.exit(1)
}
const configs = yaml.load(await r.text())
if (!configs || typeof configs !== 'object') {
  console.error('the registry file did not parse as a YAML map')
  process.exit(1)
}

/** registry chain name -> our chain key, from the committed Hyperlane table. */
const keyOfRegistryName = new Map()
for (const c of CHAINS) {
  const cfg = HYPERLANE_CHAINS[c.key]
  if (cfg) keyOfRegistryName.set(cfg.registryName, c.key)
}

const isAddress = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/** chainKey -> { tokens: { lowercased collateral token -> [entry] }, native: [entry] } */
const chains = {}
for (const key of keyOfRegistryName.values()) chains[key] = { tokens: {}, native: [] }

let kept = 0
for (const [routeId, cfg] of Object.entries(configs)) {
  const tokens = cfg?.tokens
  if (!Array.isArray(tokens)) continue
  for (const t of tokens) {
    const key = keyOfRegistryName.get(t?.chainName)
    if (!key) continue
    const standard = typeof t.standard === 'string' ? t.standard : ''
    if (!standard.startsWith('EvmHyp')) continue
    if (!isAddress(t.addressOrDenom)) continue
    const entry = {
      router: t.addressOrDenom,
      standard,
      symbol: typeof t.symbol === 'string' ? t.symbol.slice(0, 32) : '',
      route: routeId,
    }
    if (standard === 'EvmHypNative') {
      chains[key].native.push(entry)
      kept++
      continue
    }
    // A synthetic token is its own router: pasting it needs no hint. Everything else holds some
    // other token, which the registry names as the collateral.
    if (standard === 'EvmHypSynthetic' || standard === 'EvmHypSyntheticRebase') continue
    if (!isAddress(t.collateralAddressOrDenom)) continue
    const token = t.collateralAddressOrDenom.toLowerCase()
    ;(chains[key].tokens[token] ??= []).push(entry)
    kept++
  }
}

// Deterministic: sorted keys, sorted entries, so --check compares content and nothing else.
const byRouter = (a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.router.toLowerCase() < b.router.toLowerCase() ? -1 : 1)
const out = { source: SOURCE, chains: {} }
for (const key of Object.keys(chains).sort()) {
  const tokens = {}
  for (const token of Object.keys(chains[key].tokens).sort()) tokens[token] = chains[key].tokens[token].sort(byRouter)
  out.chains[key] = { tokens, native: chains[key].native.sort(byRouter) }
}
const text = JSON.stringify(out, null, 2) + '\n'

if (check) {
  let current
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`${OUT} does not exist — run without --check`)
    process.exit(1)
  }
  if (current !== text) {
    console.error(`${OUT} is out of date — run \`npm run gen:hyperlane-warp\``)
    process.exit(1)
  }
  console.log(`gen-hyperlane-warp: ${OUT} matches the registry (${kept} entries)`)
} else {
  writeFileSync(OUT, text)
  console.log(`gen-hyperlane-warp: wrote ${OUT} (${kept} entries on ${Object.keys(out.chains).length} chains)`)
}
