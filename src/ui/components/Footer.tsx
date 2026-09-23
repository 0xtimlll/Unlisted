'use client'
/**
 * The disclaimer, the canonical domain and the build stamp. Not mounted anywhere at the moment —
 * this belongs on the entry veil (components/Gate.tsx) and is put back there once the app is
 * finished, which is why the wiring is kept intact rather than deleted.
 */
import { useDict } from '@/i18n'

const COMMIT = process.env['NEXT_PUBLIC_COMMIT'] ?? 'dev'
const REPO = process.env['NEXT_PUBLIC_REPO_URL'] ?? ''
const DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? ''

export function Footer() {
  const d = useDict()
  return (
    <footer className="mx-auto w-full max-w-[560px] space-y-2 px-4 pb-8 pt-6 text-center text-xs text-muted">
      <p>{d.footer.disclaimer}</p>
      {DOMAIN ? (
        <p className="mono">
          {d.app.domainNotice} <span className="text-ink">{DOMAIN}</span>
        </p>
      ) : null}
      <p className="mono">
        {d.footer.build}: {REPO ? (
          <a href={`${REPO}/commit/${COMMIT}`} target="_blank" rel="noopener noreferrer" className="hover:text-ink">
            {COMMIT.slice(0, 12)}
          </a>
        ) : (
          COMMIT.slice(0, 12)
        )}
        {REPO ? (
          <>
            {' · '}
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="hover:text-ink">
              {d.footer.source} ↗
            </a>
          </>
        ) : null}
      </p>
    </footer>
  )
}
