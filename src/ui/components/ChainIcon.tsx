'use client'
/**
 * Chain logos as inline SVG in brand colours. Bundled with the app — nothing is fetched
 * from third-party hosts (§7, CSP img-src 'self'). Marks are simplified renderings of the
 * public network logos, used only to identify the network.
 */
import type { ChainKey } from '@/core/chains'

const ICONS: Record<ChainKey, React.ReactNode> = {
  ethereum: (
    <>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff">
        <path fillOpacity=".6" d="M16.5 5v8.1l6.9 3.1z" />
        <path d="M16.5 5 9.6 16.2l6.9-3.1z" />
        <path fillOpacity=".6" d="M16.5 21.6V27l6.9-9.5z" />
        <path d="M16.5 27v-5.4l-6.9-4.1z" />
        <path fillOpacity=".2" d="m16.5 20.3 6.9-4.1-6.9-3.1z" />
        <path fillOpacity=".6" d="m9.6 16.2 6.9 4.1v-7.2z" />
      </g>
    </>
  ),
  arbitrum: (
    <>
      <circle cx="16" cy="16" r="16" fill="#2D374B" />
      <path fill="#96BEDC" d="m16 6.5 9.4 16.3h-3.6L16 12.9l-5.8 9.9H6.6z" />
      <path fill="#28A0F0" d="m16 15.4 4.3 7.4h-8.6z" />
    </>
  ),
  optimism: (
    <>
      <circle cx="16" cy="16" r="16" fill="#FF0420" />
      <text x="16" y="20.6" textAnchor="middle" fontSize="12.5" fontWeight="800" fontStyle="italic" fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">
        OP
      </text>
    </>
  ),
  base: (
    <>
      <circle cx="16" cy="16" r="16" fill="#0052FF" />
      <circle cx="16" cy="16" r="9.5" fill="#fff" />
      <circle cx="16" cy="16" r="7" fill="#0052FF" />
      <rect x="2" y="14.6" width="14.5" height="2.8" fill="#fff" />
    </>
  ),
  bsc: (
    <>
      <circle cx="16" cy="16" r="16" fill="#F3BA2F" />
      <g fill="#fff">
        <path d="m16 7.6 3.1 3.1-3.1 3.1-3.1-3.1z" />
        <path d="m16 18.2 3.1 3.1-3.1 3.1-3.1-3.1z" />
        <path d="m10.7 12.9 3.1 3.1-3.1 3.1L7.6 16z" />
        <path d="m21.3 12.9 3.1 3.1-3.1 3.1-3.1-3.1z" />
        <path d="m16 12.9 3.1 3.1-3.1 3.1-3.1-3.1z" />
      </g>
    </>
  ),
  polygon: (
    <>
      <circle cx="16" cy="16" r="16" fill="#8247E5" />
      <path fill="none" stroke="#fff" strokeWidth="2.3" strokeLinejoin="round" d="M12.2 11.6 8 14v5l4.2 2.4 4.2-2.4v-2.4M19.8 20.4 24 18v-5l-4.2-2.4-4.2 2.4v2.4" />
    </>
  ),
  avalanche: (
    <>
      <circle cx="16" cy="16" r="16" fill="#E84142" />
      <path fill="#fff" d="M15.2 8.2 8.4 20c-.5.9.1 2 1.2 2h3.2c.5 0 1-.3 1.2-.7l1.9-3.4c.3-.5.3-1 0-1.5l-.3-.5c-.3-.5-.3-1 0-1.5l1.4-2.5c.5-.9 1.8-.9 2.3 0l1 1.8c.3.5 1 .5 1.3 0l1.4-2.5-4.9-8.4c-.5-.9-1.8-.9-2.3 0zM20.6 15.9l-3.6 6.2c-.5.9.1 2 1.2 2h4.4c1 0 1.7-1.1 1.2-2l-1.9-3.3z" />
    </>
  ),
  hyperevm: (
    <>
      <circle cx="16" cy="16" r="16" fill="#072723" />
      <path fill="#97FCE4" d="M7.5 12.2c2.2-3.2 5.3-2.5 6.7.6 1 2.2 1.9 3.6 3.6 3.6 1.6 0 2.4-1.4 3.2-3 .8-1.7 2.3-2.1 3.5-.4v6.8c-2.2 3.2-5.3 2.5-6.7-.6-1-2.2-1.9-3.6-3.6-3.6-1.6 0-2.4 1.4-3.2 3-.8 1.7-2.3 2.1-3.5.4z" />
    </>
  ),
  linea: (
    <>
      <circle cx="16" cy="16" r="16" fill="#121212" />
      <path fill="#fff" d="M11 10.5h2.8v9h8.2V22H11z" />
      <circle cx="21.2" cy="11.7" r="2" fill="#fff" />
    </>
  ),
  scroll: (
    <>
      <circle cx="16" cy="16" r="16" fill="#FFEEDA" />
      <path fill="none" stroke="#1B1B1B" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" d="M10.5 10.5H20a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-8.3a2.7 2.7 0 0 1 0-5.4H19" />
      <path fill="none" stroke="#1B1B1B" strokeWidth="2.1" strokeLinecap="round" d="M10.5 10.5a2.7 2.7 0 0 0 0 5.4" />
    </>
  ),
}

export function ChainIcon({ chain, size = 32, className = '' }: { chain: ChainKey; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={`shrink-0 ${className}`} aria-hidden>
      {ICONS[chain]}
    </svg>
  )
}
