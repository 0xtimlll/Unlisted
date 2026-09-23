/**
 * The bridge protocols this app knows about, and the tab each one owns.
 *
 * One id per protocol, used everywhere: the URL of its tab (/oft, /ntt, /ccip), the badge on a
 * history entry, and — from stage 1 on — the `protocol` field of an analysis result.
 * No imports on purpose: storage, routing and the pure analysis layer all depend on this file.
 */

export const PROTOCOL_IDS = ['lz-oft', 'wormhole-ntt', 'ccip'] as const
export type ProtocolId = (typeof PROTOCOL_IDS)[number]

/** URL slug of each protocol's tab. The static export emits one page per slug. */
export const TAB_SLUGS = ['oft', 'ntt', 'ccip'] as const
export type TabSlug = (typeof TAB_SLUGS)[number]

const BY_SLUG: Record<TabSlug, ProtocolId> = {
  oft: 'lz-oft',
  ntt: 'wormhole-ntt',
  ccip: 'ccip',
}

const BY_PROTOCOL: Record<ProtocolId, TabSlug> = {
  'lz-oft': 'oft',
  'wormhole-ntt': 'ntt',
  ccip: 'ccip',
}

export function isProtocolId(v: unknown): v is ProtocolId {
  return typeof v === 'string' && (PROTOCOL_IDS as readonly string[]).includes(v)
}

export function isTabSlug(v: unknown): v is TabSlug {
  return typeof v === 'string' && (TAB_SLUGS as readonly string[]).includes(v)
}

export function protocolOfTab(slug: TabSlug): ProtocolId {
  return BY_SLUG[slug]
}

export function tabOfProtocol(id: ProtocolId): TabSlug {
  return BY_PROTOCOL[id]
}

/** "/oft" — the path the tab lives at. */
export function tabPath(slug: TabSlug): string {
  return `/${slug}`
}

/**
 * The tab a path belongs to, or undefined. Accepts an optional trailing slash and any
 * query/hash, so it can be fed `location.pathname` directly.
 */
export function tabOfPath(pathname: string): TabSlug | undefined {
  const first = pathname.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean)[0]
  return isTabSlug(first) ? first : undefined
}

/** Protocols whose bridge is implemented. Detection may still recognise the others. */
export const IMPLEMENTED: ReadonlySet<ProtocolId> = new Set<ProtocolId>(['lz-oft', 'wormhole-ntt', 'ccip'])
