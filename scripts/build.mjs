#!/usr/bin/env node
/**
 * `npm run build`: next build (static export) + security headers.
 * The commit hash shown in the footer comes from the host's env or from git.
 */
import { execFileSync, spawnSync } from 'node:child_process'

function commit() {
  const fromEnv = process.env.NEXT_PUBLIC_COMMIT || process.env.CF_PAGES_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA
  if (fromEnv) return fromEnv
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

const env = { ...process.env, NEXT_PUBLIC_COMMIT: commit(), NEXT_TELEMETRY_DISABLED: '1' }
const steps = [
  ['npx', ['next', 'build']],
  [process.execPath, ['scripts/gen-headers.mjs']],
]
for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
