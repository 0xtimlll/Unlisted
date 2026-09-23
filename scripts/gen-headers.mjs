#!/usr/bin/env node
/**
 * Post-build: writes security headers (§7) next to the static export.
 *
 *   out/_headers   Cloudflare Pages / Netlify format
 *   out/csp.txt    the CSP value alone, for nginx/Caddy/other hosts
 *
 * script-src is 'self' plus SHA-256 hashes of the inline scripts Next.js emits
 * (React flight data). No 'unsafe-inline' for scripts, ever.
 * connect-src comes from src/core/rpcPolicy.ts (registry hosts + RPC provider wildcards, the
 * same list settings validate against) + LayerZero Scan + Wormholescan (the official NTT token
 * list and delivery status) + Sourcify (a reverting contract's own verified error ABI)
 * + WalletConnect relay.
 * Extra hosts (e.g. a self-hosted RPC) can be appended via CSP_CONNECT_EXTRA="https://a https://b".
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cspConnectSources } from '../src/core/rpcPolicy.ts'
import { LZ_SCAN_API } from '../src/core/track.ts'
import { WORMHOLESCAN_API } from '../src/protocols/wormhole-ntt/chains.ts'
import { SOURCIFY_SERVER } from '../src/core/sim/sourcify.ts'

const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'out')

function htmlFiles(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) htmlFiles(p, acc)
    else if (n.endsWith('.html')) acc.push(p)
  }
  return acc
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi
const hashes = new Set()
let inlineCount = 0
for (const f of htmlFiles(OUT)) {
  const html = readFileSync(f, 'utf8')
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const attrs = m[1] ?? ''
    const body = m[2] ?? ''
    if (/type=["'](application\/json|application\/ld\+json)["']/i.test(attrs)) continue // data, not code
    if (body.trim() === '') continue
    inlineCount++
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
}

// WalletConnect hosts are opened ONLY when the connector is actually enabled (project id set).
const WALLETCONNECT = process.env.NEXT_PUBLIC_WC_PROJECT_ID
  ? [
      'wss://relay.walletconnect.com',
      'wss://relay.walletconnect.org',
      'https://rpc.walletconnect.com',
      'https://rpc.walletconnect.org',
      'https://verify.walletconnect.com',
      'https://verify.walletconnect.org',
    ]
  : []
const extra = (process.env.CSP_CONNECT_EXTRA ?? '').split(/\s+/).filter(Boolean)
// Registry hosts + known RPC providers (wildcards) — the same list validateRpcUrl() enforces.
const connect = ["'self'", ...cspConnectSources(), LZ_SCAN_API, WORMHOLESCAN_API, new URL(SOURCIFY_SERVER).origin, ...WALLETCONNECT, ...extra]

const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].sort().join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  `connect-src ${connect.join(' ')}`,
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  'upgrade-insecure-requests',
].join('; ')

const headers = [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '  X-Robots-Tag: noindex, nofollow, noarchive',
  '  Referrer-Policy: no-referrer',
  '  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  '  Cross-Origin-Opener-Policy: same-origin',
  '  Strict-Transport-Security: max-age=63072000; includeSubDomains',
  '',
  '/_next/static/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
].join('\n')

writeFileSync(join(OUT, '_headers'), headers)
writeFileSync(join(OUT, 'csp.txt'), csp + '\n')
console.log(
  `gen-headers: ${inlineCount} inline script(s) → ${hashes.size} hash(es); connect-src has ${connect.length} entries` +
    (WALLETCONNECT.length ? ' (WalletConnect enabled)' : ' (WalletConnect disabled)'),
)
