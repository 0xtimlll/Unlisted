#!/usr/bin/env node
/**
 * `npm audit` with a reviewed exception list (npm has none of its own).
 *
 * Fails on any advisory of severity >= moderate that is not listed in audit-exceptions.json, or
 * whose exception has expired. Every exception carries the reason it does not apply to this app
 * and an expiry date, so it is re-examined instead of forgotten. Low-severity advisories are
 * printed for information only.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ORDER = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }
const FAIL_AT = ORDER.moderate

const exceptions = JSON.parse(readFileSync(new URL('../audit-exceptions.json', import.meta.url), 'utf8'))
const today = new Date().toISOString().slice(0, 10)

let report
try {
  report = JSON.parse(execFileSync('npm', ['audit', '--json', '--audit-level=none'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
} catch (e) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  const out = e.stdout?.toString()
  if (!out) throw e
  report = JSON.parse(out)
}

// Distinct advisories (the report repeats them for every dependent package).
const advisories = new Map()
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== 'object') continue
    const id = via.url.split('/').pop()
    if (!advisories.has(id)) advisories.set(id, { id, name: via.name, severity: via.severity, range: via.range, title: via.title })
  }
}

let failed = false
for (const a of [...advisories.values()].sort((x, y) => ORDER[y.severity] - ORDER[x.severity])) {
  const ex = exceptions.find((e) => e.id === a.id)
  const line = `${a.severity.padEnd(8)} ${a.name}@${a.range}  ${a.id}  ${a.title}`
  if (ORDER[a.severity] < FAIL_AT) {
    console.log(`info     ${line}`)
    continue
  }
  if (ex && ex.package === a.name && ex.expires >= today) {
    console.log(`accepted ${line}\n           reason: ${ex.reason} (until ${ex.expires})`)
    continue
  }
  failed = true
  console.error(`FAIL     ${line}${ex ? `\n           exception expired on ${ex.expires} — re-examine it` : ''}`)
}
for (const ex of exceptions) if (!advisories.has(ex.id)) console.log(`stale    exception ${ex.id} (${ex.package}) no longer reported — remove it from audit-exceptions.json`)

if (failed) {
  console.error('audit: FAILED — fix the dependency, or add a reviewed exception with a reason and an expiry date')
  process.exit(1)
}
console.log(`audit: ok (${advisories.size} advisories reported, none unreviewed at severity >= moderate)`)
