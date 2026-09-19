'use client'
/**
 * Official network logos, vendored as static PNGs in /public/chains (see ATTRIBUTION.md there).
 * Served from our own origin — nothing is fetched from third-party hosts (§7, CSP img-src 'self').
 */
import type { ChainKey } from '@/core/chains'

export function ChainIcon({ chain, size = 32, className = '' }: { chain: ChainKey; size?: number; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* Static file from /public; next/image is pointless for a static export. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/chains/${chain}.png`} alt="" width={size} height={size} draggable={false} className="h-full w-full object-cover" />
    </span>
  )
}
