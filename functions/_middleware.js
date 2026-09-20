/**
 * Cloudflare Pages middleware: one shared password for the whole site (HTTP Basic Auth).
 *
 * The password lives in the Pages project settings as the `SITE_PASSWORD` environment
 * variable — never in the repo. Without it the site refuses to serve (fail closed).
 * Everything else stays static; this only decides whether to serve the files.
 */

const REALM = 'Unlisted'

/** Constant-time string comparison (both sides hashed to a fixed length first). */
async function equal(a, b) {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  return crypto.subtle.timingSafeEqual(ha, hb)
}

function unauthorized() {
  return new Response('Password required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

export async function onRequest(context) {
  const expected = context.env.SITE_PASSWORD
  if (typeof expected !== 'string' || expected.length < 8) {
    return new Response('Site password is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  const header = context.request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Basic ')) return unauthorized()

  let supplied = ''
  try {
    // "user:password" — the user part is ignored; only the password matters.
    const decoded = atob(header.slice(6))
    supplied = decoded.slice(decoded.indexOf(':') + 1)
  } catch {
    return unauthorized()
  }

  if (!(await equal(supplied, expected))) return unauthorized()

  const response = await context.next()
  // Hashed build assets keep their immutable cache headers (their URLs are unguessable and the
  // bundle is open source anyway); pages must never be served from a shared cache.
  if (new URL(context.request.url).pathname.startsWith('/_next/static/')) return response
  const out = new Response(response.body, response)
  out.headers.set('Cache-Control', 'private, no-store')
  return out
}
