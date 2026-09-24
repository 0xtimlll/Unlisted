'use client'
/**
 * The Touch ID hint on the welcome screen (3-touch-id-icon.jpg). Every ridge is its own line so
 * the scan can run through them: the resting copy sits underneath at low opacity, and a second
 * copy in the accent colour is drawn in on top, innermost ring first, the way the phone fills the
 * print in. `ring` is the distance from the middle, which is all the ordering the scan needs.
 */
const RIDGES: { d: string; ring: number }[] = [
  { d: 'M43.4 58.4A7.0 13.0 0 1 1 56.6 58.4', ring: 0 },
  { d: 'M37.5 59.2A13.0 19.0 0 1 1 62.7 50.0', ring: 1 },
  { d: 'M63.0 55.3A13.0 19.0 0 0 1 61.9 61.7', ring: 1 },
  { d: 'M39.0 64.1A13.0 19.0 0 0 0 42.7 69.8', ring: 1 },
  { d: 'M30.4 59.2A20.0 25.0 0 1 1 69.6 59.2', ring: 2 },
  { d: 'M32.0 65.0A20.0 25.0 0 0 0 41.2 76.5', ring: 2 },
  { d: 'M23.3 58.3A27.0 31.0 0 0 1 70.7 34.1', ring: 3 },
  { d: 'M74.7 41.4A27.0 31.0 0 0 1 76.2 61.5', ring: 3 },
  { d: 'M25.0 65.6A27.0 31.0 0 0 0 40.8 83.1', ring: 3 },
  { d: 'M75.0 65.6A27.0 31.0 0 0 1 69.4 75.5', ring: 3 },
  { d: 'M16.1 56.5A34.0 36.0 0 1 1 83.7 59.0', ring: 4 },
  { d: 'M17.7 65.1A34.0 36.0 0 0 0 39.5 88.2', ring: 4 },
  { d: 'M82.7 63.9A34.0 36.0 0 0 1 73.6 79.9', ring: 4 },
  { d: 'M9.0 54.0A41.0 41.0 0 0 1 85.5 33.5', ring: 5 },
  { d: 'M89.8 44.1A41.0 41.0 0 0 1 90.9 56.9', ring: 5 },
  { d: 'M10.2 63.9A41.0 41.0 0 0 0 24.8 86.3', ring: 5 },
  { d: 'M89.8 63.9A41.0 41.0 0 0 1 84.0 76.9', ring: 5 },
]

/** One ring after another; the last one starts at 5 × this. */
const RING_MS = 90

export function TouchId({ scanning, onActivate, label }: { scanning: boolean; onActivate: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={label}
      title={label}
      data-scan={scanning}
      className="touchid rounded-full p-1 text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      <svg viewBox="0 0 100 100" className="h-16 w-16" fill="none" strokeWidth="3.6" strokeLinecap="round" aria-hidden focusable="false">
        <g className="touchid-rest" stroke="currentColor">
          {RIDGES.map((r) => (
            <path key={r.d} d={r.d} />
          ))}
        </g>
        <g className="touchid-scan" stroke="currentColor">
          {RIDGES.map((r) => (
            <path key={r.d} d={r.d} pathLength={1} style={{ animationDelay: `${r.ring * RING_MS}ms` }} />
          ))}
        </g>
      </svg>
    </button>
  )
}
