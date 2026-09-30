#!/usr/bin/env node
/**
 * Proposes entries for src/protocols/wormhole-ntt/locking-hubs.json.
 *
 * RUN BY HAND. Not part of `npm run build`, not part of CI, and never imported at run time. The
 * app reads only the committed JSON — see lockingHubs.ts for why a locking hub needs a committed
 * anchor at all.
 *
 *   npm run gen:ntt-hubs            # rewrite the file
 *   npm run gen:ntt-hubs -- --dry   # print what would change, write nothing
 *
 * ── Why the discovery half of this script is untrusted, and why that is fine ──
 *
 * Wormholescan publishes TOKENS, not managers, so a hub's address cannot simply be looked up. It
 * has to be walked to: a burning spoke's token names its manager as `minter()`, and that manager's
 * peer for the hub's chain is the hub. The last step is a peer — exactly the kind of claim
 * CLAUDE.md rule 2 says may never establish trust.
 *
 * That is acceptable HERE and nowhere else, because this script does not establish anything. It
 * produces a candidate; the candidate is then checked on chain (`getMode()` really is locking, and
 * `token()` really is the address Wormholescan lists for that chain); and what actually creates
 * trust is a human reading the diff and committing it. The runtime never repeats any of this.
 *
 * So: treat every diff as a security review. A new row means "I am satisfied this address is the
 * real locking hub for this token", not "the script found something".
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { getAddress, isAddressEqual, type Address } from 'viem'
import { byKey, evmChains, isEvm, type ChainKey } from '../src/core/chains.ts'
import { makeReadClient } from '../src/core/client.ts'
import { nttManagerAbi, nttTokenAnchorAbi, nttMode } from '../src/protocols/wormhole-ntt/abi.ts'
import { COINGECKO_PLATFORM, wormholeChainId, WORMHOLESCAN_API } from '../src/protocols/wormhole-ntt/chains.ts'

/**
 * The catalogue, fetched here rather than through tokenList.ts.
 *
 * Node's type stripping cannot parse that module (it uses a constructor parameter property), and
 * this script has to run under plain `node`. Only the two fields this script needs are read, and
 * nothing is trusted: every address is re-checked on chain below. COINGECKO_PLATFORM itself lives
 * in chains.ts precisely so there is no second copy of it.
 */
type NttToken = { symbol: string; platforms: Record<string, string> }

async function fetchTokenList(): Promise<NttToken[]> {
  const res = await fetch(`${WORMHOLESCAN_API}/api/v1/native-token-transfer/token-list?withLinks=false`)
  if (!res.ok) throw new Error(`token-list responded ${res.status}`)
  const json: unknown = await res.json()
  if (!Array.isArray(json)) throw new Error('token-list is not an array')
  const out: NttToken[] = []
  for (const raw of json) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (!r['platforms'] || typeof r['platforms'] !== 'object') continue
    const platforms: Record<string, string> = {}
    for (const [k, v] of Object.entries(r['platforms'] as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() !== '') platforms[k] = v.trim()
    }
    if (Object.keys(platforms).length === 0) continue
    out.push({ symbol: typeof r['symbol'] === 'string' ? r['symbol'] : '?', platforms })
  }
  return out
}

const OUT = new URL('../src/protocols/wormhole-ntt/locking-hubs.json', import.meta.url)
const DRY = process.argv.includes('--dry')

type Row = { chain: ChainKey; manager: string; token: string; symbol: string; addedAt: string; source: string }

const read = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

const clientOf = (key: ChainKey) => {
  const def = byKey(key)
  if (!isEvm(def)) throw new Error(`${key} is not EVM`)
  return makeReadClient(def)
}

/** The token's address on this chain, as Wormholescan lists it, or undefined. */
function listedOn(token: NttToken, chain: ChainKey): Address | undefined {
  const platform = COINGECKO_PLATFORM[chain]
  const raw = platform ? token.platforms[platform] : undefined
  if (!raw) return undefined
  try {
    return getAddress(raw)
  } catch {
    return undefined
  }
}

/**
 * Every (chain, address) a hub might live at for this token: for each chain where the token has a
 * burning manager, that manager's peer on each of the token's other chains.
 */
async function candidates(token: NttToken, chains: readonly ChainKey[]): Promise<Map<string, { chain: ChainKey; manager: Address }>> {
  const found = new Map<string, { chain: ChainKey; manager: Address }>()
  for (const spoke of chains) {
    const spokeToken = listedOn(token, spoke)
    if (!spokeToken) continue
    const minter = await read(() => clientOf(spoke).readContract({ address: spokeToken, abi: nttTokenAnchorAbi, functionName: 'minter' }))
    if (!minter) continue
    const spokeManager = getAddress(minter)
    // Confirm the spoke manager really manages that token before believing anything it says.
    const back = await read(() => clientOf(spoke).readContract({ address: spokeManager, abi: nttManagerAbi, functionName: 'token' }))
    if (!back || !isAddressEqual(getAddress(back), spokeToken)) continue

    for (const hubChain of chains) {
      if (hubChain === spoke) continue
      const wh = wormholeChainId(hubChain)
      if (wh === undefined) continue
      const peer = await read(() => clientOf(spoke).readContract({ address: spokeManager, abi: nttManagerAbi, functionName: 'getPeer', args: [wh] }))
      if (!peer || /^0x0+$/.test(peer.peerAddress)) continue
      const hex = peer.peerAddress.slice(2)
      // EVM peers are a left-padded address; anything else is not a chain we can check here.
      if (hex.slice(0, 24) !== '0'.repeat(24)) continue
      const manager = getAddress(`0x${hex.slice(24)}`)
      found.set(`${hubChain}:${manager.toLowerCase()}`, { chain: hubChain, manager })
    }
  }
  return found
}

/** The on-chain gate every candidate must pass before it is written down. */
async function verifyHub(chain: ChainKey, manager: Address, token: NttToken): Promise<{ ok: true; row: Row } | { ok: false; why: string }> {
  const listed = listedOn(token, chain)
  if (!listed) return { ok: false, why: 'Wormholescan does not list this token on that chain' }

  const client = clientOf(chain)
  const modeRaw = await read(() => client.readContract({ address: manager, abi: nttManagerAbi, functionName: 'getMode' }))
  if (modeRaw === undefined) return { ok: false, why: 'getMode() unreadable' }
  const mode = nttMode(Number(modeRaw))
  if (mode !== 'locking') return { ok: false, why: `getMode() is ${mode ?? modeRaw}, not locking` }

  const onChainToken = await read(() => client.readContract({ address: manager, abi: nttManagerAbi, functionName: 'token' }))
  if (!onChainToken) return { ok: false, why: 'token() unreadable' }
  if (!isAddressEqual(getAddress(onChainToken), listed)) {
    return { ok: false, why: `token() is ${getAddress(onChainToken)}, Wormholescan lists ${listed}` }
  }

  const wh = wormholeChainId(chain)
  if (wh === undefined) return { ok: false, why: 'no Wormhole chain id' }
  const claimed = await read(() => client.readContract({ address: manager, abi: nttManagerAbi, functionName: 'chainId' }))
  if (claimed === undefined || Number(claimed) !== wh) return { ok: false, why: `chainId() is ${claimed}, expected ${wh}` }

  return {
    ok: true,
    row: {
      chain,
      manager,
      token: listed,
      symbol: token.symbol,
      addedAt: new Date().toISOString().slice(0, 10),
      source: 'wormholescan token-list + on-chain getMode/token/chainId',
    },
  }
}

async function main() {
  const chains = evmChains().map((c) => c.key)
  console.log(`Chains searched: ${chains.join(', ')}`)

  const tokens = await fetchTokenList()
  console.log(`Wormholescan lists ${tokens.length} NTT token(s).\n`)

  let rows: Row[] = []
  const rejected: string[] = []

  for (const token of tokens) {
    const onOurChains = chains.filter((c) => !!listedOn(token, c))
    if (onOurChains.length < 2) continue
    let found: Map<string, { chain: ChainKey; manager: Address }>
    try {
      found = await candidates(token, onOurChains)
    } catch (e) {
      rejected.push(`${token.symbol}: candidate search failed — ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    for (const { chain, manager } of found.values()) {
      const v = await verifyHub(chain, manager, token)
      if (v.ok) {
        rows.push(v.row)
        console.log(`  keep   ${token.symbol.padEnd(10)} ${chain.padEnd(10)} ${manager}`)
      } else {
        rejected.push(`${token.symbol} on ${chain} (${manager}): ${v.why}`)
      }
    }
  }

  // One catalogue token can appear under several symbols (VITA / VitaDAO are the same manager and
  // the same token), so the same hub is proposed more than once. Keep one row per
  // chain+manager+token — the key `listedLockingHub` actually matches on.
  const unique = new Map<string, Row>()
  for (const r of rows) {
    const key = `${r.chain}:${r.manager.toLowerCase()}:${r.token.toLowerCase()}`
    const seen = unique.get(key)
    // Prefer the shorter symbol when they differ: it is the ticker rather than the project name.
    if (!seen || r.symbol.length < seen.symbol.length) unique.set(key, r)
  }
  rows = [...unique.values()]

  // Sorted so the diff reads as a record rather than as churn.
  rows.sort((a, b) => a.chain.localeCompare(b.chain) || a.symbol.localeCompare(b.symbol) || a.manager.localeCompare(b.manager))

  console.log(`\nRejected ${rejected.length} candidate(s):`)
  for (const r of rejected) console.log(`  drop   ${r}`)

  const byChain = new Map<string, number>()
  for (const r of rows) byChain.set(r.chain, (byChain.get(r.chain) ?? 0) + 1)
  console.log(`\n${rows.length} locking hub(s) verified:`)
  for (const [c, n] of [...byChain].sort()) console.log(`  ${c}: ${n}`)

  // `addedAt` is preserved for rows that already exist, so re-running does not restamp history.
  let previous: Row[] = []
  try {
    previous = (JSON.parse(readFileSync(OUT, 'utf8')) as { hubs?: Row[] }).hubs ?? []
  } catch {
    /* first run */
  }
  for (const r of rows) {
    const old = previous.find((o) => o.chain === r.chain && o.manager.toLowerCase() === r.manager.toLowerCase())
    if (old?.addedAt) r.addedAt = old.addedAt
  }

  const json = `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), source: 'scripts/update-ntt-hubs.ts', hubs: rows }, null, 2)}\n`
  if (DRY) {
    console.log('\n--dry: nothing written.')
    return
  }
  writeFileSync(OUT, json)
  console.log(`\nWrote ${OUT.pathname}`)
  console.log('Read the diff before committing: each row is an address this app will trust.')
}

await main()
