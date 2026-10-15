#!/usr/bin/env node
/**
 * Minimal static server for `out/` that applies `out/_headers` (Cloudflare format),
 * so the CSP can be tested locally exactly as it will ship. No dependencies.
 *   node scripts/serve.mjs [port]
 *
 * `/rpc/<chain>` is served by the same Pages Function the deployment runs (functions/rpc), called
 * the way Cloudflare calls it — so the page's reads go through the proxy here too, and the whole
 * thing can be walked in a browser before it is pushed. The site password middleware is not
 * mounted: this server listens on loopback only.
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { onRequest as rpcProxy } from '../functions/rpc/[chain].ts'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const ROOT = new URL('../out/', import.meta.url).pathname
const PORT = Number(process.argv[2] ?? 3000)

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
}

/** Parses the Cloudflare `_headers` file into [{ pattern: RegExp, headers: {} }]. */
function parseHeaders() {
  const p = join(ROOT, '_headers')
  if (!existsSync(p)) return []
  const rules = []
  let cur = null
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    if (raw.trim() === '') continue
    if (!raw.startsWith(' ')) {
      const re = new RegExp('^' + raw.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      cur = { pattern: re, headers: {} }
      rules.push(cur)
    } else if (cur) {
      const i = raw.indexOf(':')
      cur.headers[raw.slice(0, i).trim()] = raw.slice(i + 1).trim()
    }
  }
  return rules
}

const rules = parseHeaders()

createServer((req, res) => {
  try {
    if (req.url?.startsWith('/rpc/')) {
      void proxy(req, res)
      return
    }
    serve(req, res)
  } catch {
    // A malformed path (`/%`) makes decodeURIComponent throw, and an uncaught throw in this
    // callback takes the whole process down — which is a one-request kill for anyone who can
    // reach the port. Answer 400 and stay up.
    if (!res.headersSent) res.writeHead(400)
    res.end()
  }
}).listen(PORT, '127.0.0.1', () => console.log(`serving out/ with _headers at http://127.0.0.1:${PORT}`))

/** Runs the Pages Function for /rpc/<chain> with a Fetch-shaped request, as Cloudflare would. */
async function proxy(req, res) {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    const chain = url.pathname.slice('/rpc/'.length).split('/')[0] ?? ''
    const chunks = []
    for await (const c of req) chunks.push(c)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const request = new Request(url, { method: req.method ?? 'GET', headers, body: chunks.length ? Buffer.concat(chunks) : undefined })
    const response = await rpcProxy({ request, env: process.env, params: { chain } })
    res.statusCode = response.status
    response.headers.forEach((v, k) => res.setHeader(k, v))
    if (response.body) Readable.fromWeb(response.body).pipe(res)
    else res.end()
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(e?.message ?? e) }))
  }
}

function serve(req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  // Trailing slashes are dropped the way Cloudflare Pages drops them, so /bridge/ resolves too.
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '').replace(/(.)\/$/, '$1')
  let file = join(ROOT, path)
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file) && existsSync(file + '.html')) file += '.html'
  if (!existsSync(file)) { file = join(ROOT, '404.html'); res.statusCode = 404 }
  for (const r of rules) if (r.pattern.test(path)) for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
  res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream')
  res.end(readFileSync(file))
}
