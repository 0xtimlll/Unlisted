#!/usr/bin/env node
/**
 * `npm run build`: next build (static export) + security headers.
 * The commit hash shown in the footer comes from the host's env or from git.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

function commit() {
  const fromEnv = process.env.NEXT_PUBLIC_COMMIT || process.env.CF_PAGES_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA
  if (fromEnv) return fromEnv
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * `next build` writes into out/ without emptying it first, so anything a previous build — or a
 * `next dev` session — left behind stays there and ships. A stale export accumulates pages that no
 * longer exist and dev-mode chunks that use eval(), and gen-headers.mjs derives the CSP by scanning
 * whatever HTML it finds in this folder, so leftovers can put hashes in the live policy for scripts
 * that are not in the build. One line, and the export is only ever what this build produced.
 */
const OUT = join(new URL('..', import.meta.url).pathname, 'out')
rmSync(OUT, { recursive: true, force: true })

const env = { ...process.env, NEXT_PUBLIC_COMMIT: commit(), NEXT_TELEMETRY_DISABLED: '1' }
const steps = [
  ['npx', ['next', 'build']],
  // The theme has to be applied before the first paint; React will not emit that script itself.
  [process.execPath, ['scripts/inject-theme.mjs']],
  [process.execPath, ['scripts/gen-headers.mjs']],
]
for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
