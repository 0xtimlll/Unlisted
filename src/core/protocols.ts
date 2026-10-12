/**
 * The bridge protocols this app knows about, and the tab each one owns.
 *
 * One id per protocol, used everywhere: the URL of its tab (/bridge, /ntt, /ccip, /hyperlane), the
 * badge on a history entry, and — from stage 1 on — the `protocol` field of an analysis result.
 * No imports on purpose: storage, routing and the pure analysis layer all depend on this file.
 */

export const PROTOCOL_IDS = ['lz-oft', 'wormhole-ntt', 'ccip', 'hyperlane'] as const
export type ProtocolId = (typeof PROTOCOL_IDS)[number]

/**
 * URL slug of each tab, in the order the header shows them. The static export emits one page per
 * slug.
 *
 * `rescue` is a tab without a protocol: §5's Status / Rescue screen takes a transaction hash and
 * works out which protocol it belongs to, rather than being one tab's form. That is why
 * `protocolOfTab` is partial — a tab is not always a protocol, even though every protocol has one.
 * It stays last; a protocol added later goes in front of it.
 */
export const TAB_SLUGS = ['oft', 'ntt', 'ccip', 'hyperlane', 'rescue'] as const
export type TabSlug = (typeof TAB_SLUGS)[number]

const BY_SLUG: Partial<Record<TabSlug, ProtocolId>> = {
  oft: 'lz-oft',
  ntt: 'wormhole-ntt',
  ccip: 'ccip',
  hyperlane: 'hyperlane',
}

const BY_PROTOCOL: Record<ProtocolId, TabSlug> = {
  'lz-oft': 'oft',
  'wormhole-ntt': 'ntt',
  ccip: 'ccip',
  hyperlane: 'hyperlane',
}

export function isProtocolId(v: unknown): v is ProtocolId {
  return typeof v === 'string' && (PROTOCOL_IDS as readonly string[]).includes(v)
}

export function isTabSlug(v: unknown): v is TabSlug {
  return typeof v === 'string' && (TAB_SLUGS as readonly string[]).includes(v)
}

/** The protocol a tab builds for, or undefined for a tab that is not one protocol's form. */
export function protocolOfTab(slug: TabSlug): ProtocolId | undefined {
  return BY_SLUG[slug]
}

export function tabOfProtocol(id: ProtocolId): TabSlug {
  return BY_PROTOCOL[id]
}

/**
 * The path each tab lives at. The OFT tab is the bridge's own entry point, so it owns /bridge:
 * that is the address to bookmark, and the one the welcome screen at / opens.
 */
const TAB_PATH: Record<TabSlug, string> = { oft: '/bridge', ntt: '/ntt', ccip: '/ccip', hyperlane: '/hyperlane', rescue: '/rescue' }
const TAB_OF_SEGMENT: Record<string, TabSlug> = { bridge: 'oft', ntt: 'ntt', ccip: 'ccip', hyperlane: 'hyperlane', rescue: 'rescue' }

/** "/bridge" — the path the tab lives at. */
export function tabPath(slug: TabSlug): string {
  return TAB_PATH[slug]
}

/**
 * The tab a path belongs to, or undefined (the welcome screen at / belongs to none). Accepts an
 * optional trailing slash and any query/hash, so it can be fed `location.pathname` directly.
 */
export function tabOfPath(pathname: string): TabSlug | undefined {
  const first = pathname.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean)[0]
  return first === undefined ? undefined : TAB_OF_SEGMENT[first]
}

/** Protocols whose bridge is implemented. Detection may still recognise the others. */
export const IMPLEMENTED: ReadonlySet<ProtocolId> = new Set<ProtocolId>(['lz-oft', 'wormhole-ntt', 'ccip', 'hyperlane'])
