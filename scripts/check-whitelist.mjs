#!/usr/bin/env node
/**
 * §11: the app may submit ONLY `approve` and `send`. This script greps src/
 * for every state-changing / signing primitive and fails on anything else.
 * It is intentionally dumb (regex, no AST) so it is easy to audit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const WHITELIST = new Set(['approve', 'send'])

// Any of these anywhere in src/ is a bug.
const FORBIDDEN = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /dangerouslySetInnerHTML/,
  /\bsignMessage\b/,
  /\bsignTypedData\b/,
  /\beth_sign\b/,
  /\bpersonal_sign\b/,
  /\bpermit\s*\(/i,
  /\bsendTransaction\b/, // raw tx = arbitrary calldata; we only use writeContract
  /\bsendRawTransaction\b/,
  /import\s*\(\s*['"]https?:/,
  /<script[^>]+src=['"]https?:/i,
]

// Write/simulate CALL sites: every occurrence must sit next to a whitelisted functionName.
// (The hook `useWriteContract()` itself carries no functionName; the `.writeContract({...})` call does.)
const WRITE_CALL = /\b(writeContract|writeContractAsync|simulateContract|estimateContractGas|sendCalls)\s*\(/g
const FUNCTION_NAME = /functionName\s*:\s*['"]([A-Za-z0-9_]+)['"]/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

/** Blank out comment-only lines (keeps line numbers). Code inside comments is not code. */
function stripCommentLines(text) {
  return text
    .split('\n')
    .map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l))
    .join('\n')
}

const errors = []
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  const text = stripCommentLines(readFileSync(file, 'utf8'))
  const lines = text.split('\n')

  lines.forEach((line, idx) => {
    for (const re of FORBIDDEN) {
      if (re.test(line)) errors.push(`${rel}:${idx + 1}: forbidden pattern ${re}`)
    }
  })

  // Every write call must be followed (within 12 lines) by a whitelisted functionName.
  let m
  WRITE_CALL.lastIndex = 0
  while ((m = WRITE_CALL.exec(text)) !== null) {
    const lineNo = text.slice(0, m.index).split('\n').length
    const window = lines.slice(lineNo - 1, lineNo + 12).join('\n')
    const names = [...window.matchAll(FUNCTION_NAME)].map((x) => x[1])
    if (names.length === 0) {
      errors.push(`${rel}:${lineNo}: ${m[1]} without a literal functionName nearby`)
    }
    for (const n of names) {
      if (!WHITELIST.has(n)) errors.push(`${rel}:${lineNo}: ${m[1]} with non-whitelisted functionName "${n}"`)
    }
  }

  // Also flag any functionName literal in src/ that is neither a read nor whitelisted write.
  // Reads are allowed; we only care that no *other* write sneaks in via a different helper.
  FUNCTION_NAME.lastIndex = 0
  while ((m = FUNCTION_NAME.exec(text)) !== null) {
    const n = m[1]
    const lineNo = text.slice(0, m.index).split('\n').length
    const KNOWN_READS = new Set([
      'quoteSend', 'quoteOFT', 'token', 'approvalRequired', 'sharedDecimals', 'decimalConversionRate',
      'oftVersion', 'peers', 'endpoint', 'owner', 'enforcedOptions',
      'decimals', 'symbol', 'name', 'balanceOf', 'allowance',
    ])
    if (!WHITELIST.has(n) && !KNOWN_READS.has(n)) {
      errors.push(`${rel}:${lineNo}: unknown functionName "${n}" (not in ABI §3)`)
    }
  }
}

if (errors.length) {
  console.error('check-whitelist: FAILED')
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log('check-whitelist: ok (only approve/send may be written)')
