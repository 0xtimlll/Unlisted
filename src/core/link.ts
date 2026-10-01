/**
 * A shareable link: the tab's address carries the bridge, the token and the route, nothing else.
 *
 *   /bridge?from=ethereum&token=0x…&to=bsc      LayerZero OFT (V2 and v1)
 *   /ntt?from=ethereum&token=0x…&to=bsc         Wormhole NTT
 *   /ccip?from=base&token=0x…&to=ethereum       Chainlink CCIP
 *   /bridge?from=solana&token=<OFT Store, base58>&to=ethereum
 *
 * The bridge is the path, as it already was. The link is written as the form is filled in and
 * read when the page opens, so a route can be handed to someone as a URL instead of "paste this,
 * pick that". What it carries is exactly what a person would have typed into the token field and
 * picked from the two chain menus — and it is treated the same way: the contract is probed from
 * scratch on arrival (CLAUDE.md rule 1, a link narrows the search and never raises trust).
 *
 * What it never carries: the recipient (where the money goes is typed and confirmed by the person
 * sending, never preset by a link), the amount (everyone has their own balance), the wallet, the
 * RPC settings. A link with any of those is simply read for the three fields above.
 *
 * Pure: the screens call these with `window.location.search` and `history.replaceState`.
 */
import { isAddress } from 'viem'
import type { AnalysisTarget } from './analysis/result'
import { byKey, CHAINS, type ChainKey } from './chains'
import type { TabSlug } from './protocols'
import { isBase58 } from './svm/base58'

export type LinkState = {
  from: ChainKey
  /** The token, adapter, manager or OFT Store, as the token field would hold it. */
  token: string
  to?: ChainKey | undefined
}

const CHAIN_KEYS: ReadonlySet<string> = new Set(CHAINS.map((c) => c.key))
const isChainKey = (v: string | null): v is ChainKey => v !== null && CHAIN_KEYS.has(v)

/** An EVM address for an EVM chain, a 32-byte base58 key for Solana. Anything else is not a token. */
function tokenFor(chain: ChainKey, raw: string | null): string | undefined {
  if (!raw) return undefined
  const v = raw.trim()
  if (byKey(chain).vm === 'svm') return v.length >= 32 && v.length <= 44 && isBase58(v) ? v : undefined
  return isAddress(v, { strict: false }) ? v : undefined
}

/**
 * Reads a link. Only `from` + `token` make a link; `to` is kept when it is a different, known
 * chain. The NTT and CCIP tabs are EVM-only, so a Solana side is not a link there.
 */
export function parseLink(search: string, tab: TabSlug): LinkState | undefined {
  if (tab === 'rescue') return undefined
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const from = q.get('from')
  if (!isChainKey(from)) return undefined
  if (tab !== 'oft' && byKey(from).vm !== 'evm') return undefined
  const token = tokenFor(from, q.get('token'))
  if (!token) return undefined
  const to = q.get('to')
  const toKey = isChainKey(to) && to !== from && (tab === 'oft' || byKey(to).vm === 'evm') ? to : undefined
  return { from, token, ...(toKey ? { to: toKey } : {}) }
}

/** The query string for a state, or '' when there is nothing worth linking yet. */
export function buildLink(state: LinkState | undefined): string {
  if (!state) return ''
  const q = new URLSearchParams()
  q.set('from', state.from)
  q.set('token', state.token)
  if (state.to) q.set('to', state.to)
  return `?${q.toString()}`
}

/** A link, as the tab that opens it already knows how to take a target from another tab. */
export function linkTarget(state: LinkState, tab: TabSlug): AnalysisTarget | undefined {
  const kind = tab === 'oft' ? (byKey(state.from).vm === 'svm' ? 'oft-store' : 'oft') : tab === 'ntt' ? 'ntt-manager' : tab === 'ccip' ? 'ccip-token' : undefined
  if (!kind) return undefined
  return {
    chain: state.from,
    address: state.token,
    kind,
    ...(kind === 'ccip-token' ? { token: state.token } : {}),
    ...(state.to ? { dstChain: state.to } : {}),
    via: 'link',
  }
}
