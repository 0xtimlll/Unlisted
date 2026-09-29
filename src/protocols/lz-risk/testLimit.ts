/**
 * §4: the test-amount limit, remembered per token.
 *
 * There is deliberately **no default**. A limit is a number only the person moving the token can
 * choose: one unit of a token is a rounding error for some and a month's rent for others, and a
 * pre-filled "1" would be a recommendation this app is in no position to make. So the field starts
 * empty on a token that has never had one set, and an unverified route sends nothing at all until it
 * is filled in — the cap is not a suggestion to be clicked past.
 *
 * Once set it is remembered for that token, because the second route for the same token should not
 * ask the same question again. Keyed by chain and token address, so the same symbol on two chains
 * keeps two limits, and stored separately from everything else with every access in try/catch: with
 * storage blocked or cleared the field is simply empty again.
 */

const KEY = 'oft-bridge-ui:test-limits:v1'

/** As many characters as a decimal amount could plausibly need, and no more. */
const MAX_LEN = 40

export type TokenId = { chain: string; token: string }

export function tokenKey(t: TokenId): string {
  return `${t.chain}:${t.token.toLowerCase()}`
}

type Table = Record<string, string>

function read(): Table {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Table = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // A limit is a plain decimal string. Anything else is someone else's data or damage, and it
      // must never reach parseAmount as if the user had typed it.
      if (typeof v === 'string' && v.length <= MAX_LEN && /^[0-9]*[.,]?[0-9]*$/.test(v) && v !== '') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** The limit this token was last given, or '' when it has never had one. */
export function rememberedTestLimit(t: TokenId): string {
  return read()[tokenKey(t)] ?? ''
}

/** Remembers what was typed. An empty or unparseable value clears the memory rather than storing it. */
export function rememberTestLimit(t: TokenId, value: string): void {
  const v = value.trim()
  const table = read()
  if (v === '' || v.length > MAX_LEN || !/^[0-9]*[.,]?[0-9]*$/.test(v)) delete table[tokenKey(t)]
  else table[tokenKey(t)] = v
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(table))
  } catch {
    /* storage unavailable: the field just starts empty next time */
  }
}

export function forgetTestLimits(): void {
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* nothing to do */
  }
}
