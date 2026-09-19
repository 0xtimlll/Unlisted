'use client'
import { useDict } from '@/i18n'

const COMMIT = process.env['NEXT_PUBLIC_COMMIT'] ?? 'dev'
const REPO = process.env['NEXT_PUBLIC_REPO_URL'] ?? ''

export function Footer() {
  const d = useDict()
  return (
    <footer className="mx-auto max-w-[408px] space-y-2 px-2 pb-6 pt-6 text-center text-[11px] text-muted">
      <p>{d.footer.disclaimer}</p>
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
