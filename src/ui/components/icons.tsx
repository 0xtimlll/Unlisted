/**
 * Inline SVG icons. Every one of them draws in `currentColor`, so the colour is whatever the
 * theme has put on the element around it — never a colour of its own.
 */

/**
 * The settings gear (5-settings-icon.jpg): straight teeth whose corners are rounded by a
 * round-joined stroke, a thick ring, and three cut-outs inside separated by three spokes that
 * meet in the middle. Twelve teeth rather than the reference's sixteen — at the 24px this is
 * drawn at, sixteen close up into a blur.
 */
const GEAR_TEETH =
  'M95.5 56.5 L95.5 43.5 L82.7 45.4 L80.6 37.7 L92.7 32.8 L86.2 21.6 L76.0 29.6 L70.4 24.0 L78.4 13.8 L67.2 7.3 L62.3 19.4 L54.6 17.3 L56.5 4.5 L43.5 4.5 L45.4 17.3 L37.7 19.4 L32.8 7.3 L21.6 13.8 L29.6 24.0 L24.0 29.6 L13.8 21.6 L7.3 32.8 L19.4 37.7 L17.3 45.4 L4.5 43.5 L4.5 56.5 L17.3 54.6 L19.4 62.3 L7.3 67.2 L13.8 78.4 L24.0 70.4 L29.6 76.0 L21.6 86.2 L32.8 92.7 L37.7 80.6 L45.4 82.7 L43.5 95.5 L56.5 95.5 L54.6 82.7 L62.3 80.6 L67.2 92.7 L78.4 86.2 L70.4 76.0 L76.0 70.4 L86.2 78.4 L92.7 67.2 L80.6 62.3 L82.7 54.6 Z'
/** The hole in the middle of the ring, as a second subpath: with evenodd it cuts the ring open. */
const GEAR_HOLE = 'M50 24 A26 26 0 1 0 50 76 A26 26 0 1 0 50 24 Z'
/** Where the three spokes point: up, lower-left, lower-right. */
const SPOKES = [90, 210, 330]

export function GearIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="currentColor" aria-hidden focusable="false">
      <path d={`${GEAR_TEETH} ${GEAR_HOLE}`} fillRule="evenodd" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <g stroke="currentColor" strokeWidth="9" strokeLinecap="round">
        {SPOKES.map((a) => (
          <line key={a} x1="50" y1="50" x2={(50 + 29 * Math.cos((a * Math.PI) / 180)).toFixed(1)} y2={(50 - 29 * Math.sin((a * Math.PI) / 180)).toFixed(1)} />
        ))}
      </g>
    </svg>
  )
}

export function MoonIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden focusable="false">
      <path d="M20.7 14.6A8.6 8.6 0 0 1 9.4 3.3a8.9 8.9 0 1 0 11.3 11.3Z" />
    </svg>
  )
}

export function SunIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = (a * Math.PI) / 180
        return <line key={a} x1={(12 + 7 * Math.cos(r)).toFixed(1)} y1={(12 - 7 * Math.sin(r)).toFixed(1)} x2={(12 + 9.4 * Math.cos(r)).toFixed(1)} y2={(12 - 9.4 * Math.sin(r)).toFixed(1)} />
      })}
    </svg>
  )
}
