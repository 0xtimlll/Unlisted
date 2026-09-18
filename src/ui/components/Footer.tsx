'use client'
import { useDict } from '@/i18n'

const COMMIT = process.env['NEXT_PUBLIC_COMMIT'] ?? 'dev'
const REPO = process.env['NEXT_PUBLIC_REPO_URL'] ?? ''

export function Footer() {
  const d = useDict()
  return (
    <footer className="mt-8 space-y-2 border-t border-neutral-200 pt-4 text-xs opacity-70 dark:border-neutral-800">
      <p>{d.footer.disclaimer}</p>
      <p className="mono">
        {d.footer.build}: {COMMIT.slice(0, 12)}
        {REPO ? (
          <>
            {' · '}
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="underline">
              {d.footer.source}
            </a>
          </>
        ) : null}
      </p>
    </footer>
  )
}
