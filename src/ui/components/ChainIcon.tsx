'use client'
/**
 * A network tile: the network's brand colour as a rounded square with its mark centred on it —
 * the same tile at 16px in a list row and at 48px in the From/To rows. The mark is a static SVG
 * from /public/chains (ATTRIBUTION.md there), served from our own origin: nothing is fetched
 * from third-party hosts (CSP img-src 'self'). A network with no mark shows its initials.
 */
import { byKey, type ChainKey } from '@/core/chains'
import { BRAND, initialsOf } from '../brand'

export function ChainIcon({ chain, size = 32, className = '' }: { chain: ChainKey; size?: number; className?: string }) {
  const logo = Math.round(size * 0.62)
  const b = BRAND[chain]
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
      style={{ width: size, height: size, borderRadius: Math.max(4, Math.round(size / 4)), background: b.bg }}
      aria-hidden
    >
      {b.mark ? (
        // Static file from /public; next/image is pointless for a static export.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/chains/${b.mark}`} alt="" width={logo} height={logo} loading="lazy" decoding="async" draggable={false} style={{ width: logo, height: logo }} />
      ) : (
        <span className={`font-semibold leading-none ${b.dark ? 'text-[#0b0e11]' : 'text-white'}`} style={{ fontSize: Math.max(8, Math.round(size * 0.36)) }}>
          {initialsOf(byKey(chain).name)}
        </span>
      )}
    </span>
  )
}
