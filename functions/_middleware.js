/**
 * Cloudflare Pages middleware: one shared password for the whole site (HTTP Basic Auth).
 *
 * The password lives in the Pages project settings as the `SITE_PASSWORD` environment
 * variable — never in the repo. Without it the site refuses to serve (fail closed).
 * Everything else stays static; this only decides whether to serve the files.
 */

const REALM = 'Unlisted'

/**
 * Security headers that do not depend on the build.
 *
 * `out/_headers` carries the full set (including the CSP, whose script-src hashes are generated
 * from the export) and Pages applies it to static assets. It does NOT apply to responses a
 * Function makes up itself — which is every 401 this file returns, i.e. the FIRST response every
 * visitor gets. That is how the site managed to advertise HSTS while never once sending it to
 * someone who had not yet typed the password. These are re-set here so that stops being true, and
 * they are only ever added to an asset response when it arrived without them.
 *
 * The CSP is deliberately not in this list: the real one is generated per build, and a fallback
 * invented here would either be wrong or would block the page's own scripts. Only the fixed
 * headers are repeated.
 */
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
}

/** The same, plus a CSP that suits a response whose whole body is one line of plain text. */
const TEXT_RESPONSE_HEADERS = {
  ...SECURITY_HEADERS,
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
}

/** Constant-time string comparison (both sides hashed to a fixed length first). */
async function equal(a, b) {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  return crypto.subtle.timingSafeEqual(ha, hb)
}

function unauthorized() {
  return new Response('Password required.', {
    status: 401,
    headers: { ...TEXT_RESPONSE_HEADERS, 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` },
  })
}

export async function onRequest(context) {
  const expected = context.env.SITE_PASSWORD
  if (typeof expected !== 'string' || expected.length < 8) {
    return new Response('Site password is not configured.', { status: 503, headers: { ...TEXT_RESPONSE_HEADERS } })
  }

  const header = context.request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Basic ')) return unauthorized()

  let supplied = ''
  try {
    // "user:password" — the user part is ignored; only the password matters. The challenge
    // declares charset="UTF-8", so the bytes are decoded as UTF-8: atob() alone yields one
    // character per byte, and a password with anything outside ASCII would never match.
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0))
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    supplied = decoded.slice(decoded.indexOf(':') + 1)
  } catch {
    return unauthorized()
  }

  if (!(await equal(supplied, expected))) return unauthorized()

  const response = await context.next()
  const out = new Response(response.body, response)
  // `_headers` normally already set these; setting them again would be identical, so only a
  // MISSING one is filled in. That way this can never quietly contradict the generated file.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name)) out.headers.set(name, value)
  }
  // Hashed build assets keep their immutable cache headers (their URLs are unguessable and the
  // bundle is open source anyway); pages must never be served from a shared cache.
  if (!new URL(context.request.url).pathname.startsWith('/_next/static/')) {
    out.headers.set('Cache-Control', 'private, no-store')
  }
  return out
}
