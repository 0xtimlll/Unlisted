/**
 * §Task 4: turn revert bytes into something a person can act on.
 *
 * Order of attempts: the standard Error(string) / Panic(uint256), then every custom error we know
 * from the protocols' own contracts, then the contract's own ABI when the caller has one (a token
 * with its own errors), and finally the raw selector — labelled as unknown, never guessed at.
 *
 * Nothing here calls out to a signature database: an unknown selector is shown as-is with a link
 * the user may click, and that click is the only thing that ever leaves the browser.
 */
import { decodeErrorResult, type Abi, type Hex } from 'viem'
import { knownErrorsAbi, meaningOf, type RevertMeaning } from './errors'

export type { RevertMeaning }

export type DecodedRevert =
  /** A named error, ours or the contract's own. */
  | { kind: 'error'; name: string; args: readonly unknown[]; meaning: RevertMeaning; selector: Hex }
  /** require(false, "…") */
  | { kind: 'string'; message: string; meaning: RevertMeaning }
  /** Solidity's built-in Panic(uint256). */
  | { kind: 'panic'; code: bigint; meaning: RevertMeaning }
  /** Four bytes we cannot name. `lookupUrl` is for the user to open by hand, if they want. */
  | { kind: 'unknown'; selector: Hex; data: Hex; lookupUrl: string }
  /** The call reverted with no data at all (out of gas, a bare `revert()`, a failed assertion). */
  | { kind: 'empty'; meaning: RevertMeaning }

/** Where a person can look a selector up themselves. Opened only by an explicit click. */
export function selectorLookupUrl(selector: string): string {
  return `https://openchain.xyz/signatures?query=${encodeURIComponent(selector)}`
}

const isHexData = (v: unknown): v is Hex => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v)

function tryDecode(data: Hex, abi: Abi): { name: string; args: readonly unknown[] } | undefined {
  try {
    const d = decodeErrorResult({ abi, data })
    return { name: d.errorName, args: (d.args ?? []) as readonly unknown[] }
  } catch {
    return undefined
  }
}

/**
 * `data` is the revert payload. `contractAbi` is optional: pass the token's or the implementation's
 * ABI when it is known, so a project's own custom errors decode too.
 */
export function decodeRevert(data: Hex | undefined, contractAbi?: Abi): DecodedRevert {
  if (!data || data === '0x') return { kind: 'empty', meaning: 'generic' }
  if (!isHexData(data) || data.length < 10) return { kind: 'empty', meaning: 'generic' }
  const selector = data.slice(0, 10).toLowerCase() as Hex

  // Error(string) and Panic(uint256) are part of the ABI spec; viem knows both.
  const std = tryDecode(data, [] as unknown as Abi)
  if (std) {
    if (std.name === 'Error') return { kind: 'string', message: String(std.args[0] ?? '').slice(0, 240), meaning: 'generic' }
    if (std.name === 'Panic') return { kind: 'panic', code: BigInt(std.args[0] as bigint), meaning: 'generic' }
  }

  const known = tryDecode(data, knownErrorsAbi as unknown as Abi)
  if (known) return { kind: 'error', name: known.name, args: known.args, meaning: meaningOf(known.name), selector }

  if (contractAbi) {
    const own = tryDecode(data, contractAbi)
    if (own) return { kind: 'error', name: own.name, args: own.args, meaning: meaningOf(own.name), selector }
  }

  return { kind: 'unknown', selector, data, lookupUrl: selectorLookupUrl(selector) }
}

/**
 * Digs the revert payload out of whatever a client threw. viem nests the original error, and the
 * bytes live on `.data` (or `.raw`) of one of the causes.
 */
export function revertDataFromError(e: unknown): Hex | undefined {
  const seen = new Set<unknown>()
  let cur: unknown = e
  for (let depth = 0; cur && depth < 12; depth++) {
    if (seen.has(cur)) break
    seen.add(cur)
    const o = cur as { data?: unknown; raw?: unknown; cause?: unknown }
    if (isHexData(o.data) && o.data.length >= 10) return o.data
    if (isHexData(o.raw) && o.raw.length >= 10) return o.raw
    // viem's ContractFunctionRevertedError keeps the decoded shape on `.data` as an object.
    const asObj = o.data as { data?: unknown } | undefined
    if (asObj && typeof asObj === 'object' && isHexData(asObj.data)) return asObj.data
    cur = o.cause
  }
  return undefined
}

/** What this revert means for the user. An unnamed selector means nothing in particular. */
export function revertMeaning(r: DecodedRevert | undefined): RevertMeaning | undefined {
  if (!r) return undefined
  return r.kind === 'unknown' ? 'generic' : r.meaning
}

/** One line for the raw details block: "SlippageExceeded(1000, 1001)". */
export function formatRevert(r: DecodedRevert): string {
  switch (r.kind) {
    case 'error':
      return `${r.name}(${r.args.map(stringifyArg).join(', ')})`
    case 'string':
      return `Error("${r.message}")`
    case 'panic':
      return `Panic(0x${r.code.toString(16)})`
    case 'unknown':
      return r.selector
    case 'empty':
      return 'reverted without data'
  }
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'bigint') return a.toString()
  if (typeof a === 'string') return a
  if (Array.isArray(a)) return `[${a.map(stringifyArg).join(', ')}]`
  return String(a)
}
