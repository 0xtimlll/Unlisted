/**
 * From a pasted address to a Hyperlane warp route, and to the chains it can actually reach.
 *
 * The starting point is the Mailbox from our config — never an address the user typed. A router is
 * only a router here if it names that Mailbox and reports this chain's domain; everything else it
 * says about itself (which token it holds, which chains it serves, which router sits on the far
 * side) is its own claim, read through that anchor and checked again wherever a second fact exists.
 *
 * Three shapes of route, told apart by what the contract answers (see abi.ts):
 *   collateral   holds a real ERC-20 (`wrappedToken()`, or `token()` naming another contract):
 *                the approve goes to the router, which pulls the tokens and locks them
 *   synthetic    the router IS the ERC-20 (`token() == this`, or a 5.x/7.x router that answers
 *                `decimals()`): `transferRemote` burns from the sender, no approve
 *   native       the chain's own coin (`token() == 0`, or a router that is none of the above):
 *                the amount travels in msg.value alongside the fee
 *
 * A plain ERC-20 that is not a router is reported as such, so the screen can look its candidate
 * routers up in the committed registry hint table and probe each one of them through this same
 * function. The hint says WHERE to look; this function decides.
 */
import { getAddress, isAddressEqual, type Address } from 'viem'
import { erc20Abi } from '../../core/abi'
import { byKey, type ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { ZERO_ADDRESS } from '../../core/encoding'
import { readOptional, UnreadableError } from '../../core/rpcErrors'
import { sanitizeLabel } from '../../core/text'
import { ADAPTER_MIN_LOCKED_BPS, ADAPTER_MIN_OUTBOUND_NONCE, lockedBps } from '../lz-risk/adapters'
import { attempt, pickEvent, READ_TIMEOUT_MS, scanWidening, type LogWindow } from '../lz-risk/probe'
import { bytes32ToEvmAddress, mailboxEventsAbi, warpRouteAbi } from './abi'
import { chainOfHyperlaneDomain, hyperlaneConfig } from './chains'

/**
 * `undefined` when the contract refused (reverted, no such function). A provider that did not
 * answer throws `UnreadableError`, which the discovery reports as `unreadable` — never as a verdict
 * about the router, which would be a verdict drawn from a timeout.
 */
const read = <T,>(fn: () => Promise<T>): Promise<T | undefined> => readOptional('Hyperlane read', fn)

export type WarpKind = 'collateral' | 'synthetic' | 'native'

/** How the amount is scaled onto the wire: messageAmount = amount × numerator / denominator. */
export type WarpScale = {
  numerator: bigint
  denominator: bigint
  /** Which generation answered: `scale()` (7.x), the fraction (12+), or neither (5.x: 1/1). */
  source: 'scale' | 'fraction' | 'none'
}

export const UNSCALED: WarpScale = { numerator: 1n, denominator: 1n, source: 'none' }

/** A destination this router names, as it names it. The far side is checked separately. */
export type WarpRoute = { chain: ChainKey; domain: number; router: Address }

export type WarpRouter = {
  kind: 'router'
  router: Address
  warpKind: WarpKind
  /** The ERC-20 that moves: the collateral, or the router itself; undefined for the native coin. */
  token: Address | undefined
  decimals: number
  symbol: string
  /** The Mailbox the router names — equal to the registry's, or the router was refused. */
  mailbox: Address
  domain: number
  scale: WarpScale
  /** core 10+: the route's own fee goes here. Undefined on older routes, which have none. */
  feeRecipient: Address | undefined
  /** core 12+ can charge the dispatch fee in the token; this app only builds native-fee sends. */
  feeTokenIsNative: boolean
  version: string | undefined
  owner: Address | undefined
  hook: Address | undefined
  ism: Address | undefined
  /** Destinations the router names that we also serve, as EVM addresses. */
  routes: WarpRoute[]
}

export type HyperlaneDiscovery =
  | WarpRouter
  /** An ERC-20 that is not a router: the registry hint table says which routers may hold it. */
  | { kind: 'token'; token: Address; decimals: number; symbol: string }
  | {
      kind: 'unknown'
      reason: 'unreadable' | 'chain_unsupported' | 'invalid_address' | 'not_a_contract' | 'not_a_router' | 'foreign_mailbox' | 'wrong_domain' | 'token_unreadable'
    }

export async function discoverWarpRoute(client: ReadClient, chain: ChainKey, address: string): Promise<HyperlaneDiscovery> {
  try {
    return await discoverUnguarded(client, chain, address)
  } catch (e) {
    if (e instanceof UnreadableError) return { kind: 'unknown', reason: 'unreadable' }
    throw e
  }
}

async function discoverUnguarded(client: ReadClient, chain: ChainKey, input: string): Promise<HyperlaneDiscovery> {
  const cfg = hyperlaneConfig(chain)
  if (!cfg) return { kind: 'unknown', reason: 'chain_unsupported' }

  let address: Address
  try {
    address = getAddress(input)
  } catch {
    return { kind: 'unknown', reason: 'invalid_address' }
  }

  let code: string | undefined
  try {
    code = await client.getCode({ address })
  } catch (e) {
    throw new UnreadableError('getCode', e)
  }
  if (!code || code === '0x') return { kind: 'unknown', reason: 'not_a_contract' }

  const route = { address, abi: warpRouteAbi } as const
  const mailbox = await read(() => client.readContract({ ...route, functionName: 'mailbox' }))
  if (mailbox === undefined) {
    // Not a router. An ERC-20 is still useful: the hint table may know who holds it.
    const [decimals, symbol] = await Promise.all([
      read(() => client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })),
      read(() => client.readContract({ address, abi: erc20Abi, functionName: 'symbol' })),
    ])
    if (decimals === undefined) return { kind: 'unknown', reason: 'not_a_router' }
    return { kind: 'token', token: address, decimals: Number(decimals), symbol: sanitizeLabel(symbol ?? '') }
  }
  if (!isAddressEqual(mailbox, getAddress(cfg.mailbox))) return { kind: 'unknown', reason: 'foreign_mailbox' }

  const localDomain = await read(() => client.readContract({ ...route, functionName: 'localDomain' }))
  if (localDomain === undefined) return { kind: 'unknown', reason: 'unreadable' }
  if (Number(localDomain) !== cfg.domain) return { kind: 'unknown', reason: 'wrong_domain' }

  const [domains, wrappedToken, tokenFn, decimalsSelf, symbolSelf, scale, scaleNum, scaleDen, feeRecipient, feeToken, version, owner, hook, ism] = await Promise.all([
    read(() => client.readContract({ ...route, functionName: 'domains' })),
    read(() => client.readContract({ ...route, functionName: 'wrappedToken' })),
    read(() => client.readContract({ ...route, functionName: 'token' })),
    read(() => client.readContract({ address, abi: erc20Abi, functionName: 'decimals' })),
    read(() => client.readContract({ address, abi: erc20Abi, functionName: 'symbol' })),
    read(() => client.readContract({ ...route, functionName: 'scale' })),
    read(() => client.readContract({ ...route, functionName: 'scaleNumerator' })),
    read(() => client.readContract({ ...route, functionName: 'scaleDenominator' })),
    read(() => client.readContract({ ...route, functionName: 'feeRecipient' })),
    read(() => client.readContract({ ...route, functionName: 'feeToken' })),
    read(() => client.readContract({ ...route, functionName: 'PACKAGE_VERSION' })),
    read(() => client.readContract({ ...route, functionName: 'owner' })),
    read(() => client.readContract({ ...route, functionName: 'hook' })),
    read(() => client.readContract({ ...route, functionName: 'interchainSecurityModule' })),
  ])
  if (domains === undefined) return { kind: 'unknown', reason: 'unreadable' }

  // Which of the three shapes, from what the contract answers (abi.ts has the generations).
  let warpKind: WarpKind
  let token: Address | undefined
  if (wrappedToken !== undefined) {
    warpKind = 'collateral'
    token = getAddress(wrappedToken)
  } else if (tokenFn !== undefined) {
    if (isAddressEqual(tokenFn, ZERO_ADDRESS)) {
      warpKind = 'native'
    } else if (isAddressEqual(tokenFn, address)) {
      warpKind = 'synthetic'
      token = address
    } else {
      warpKind = 'collateral'
      token = getAddress(tokenFn)
    }
  } else if (decimalsSelf !== undefined) {
    warpKind = 'synthetic'
    token = address
  } else {
    warpKind = 'native'
  }

  let decimals: number
  let symbol: string
  if (warpKind === 'collateral') {
    const [d, s] = await Promise.all([
      read(() => client.readContract({ address: token!, abi: erc20Abi, functionName: 'decimals' })),
      read(() => client.readContract({ address: token!, abi: erc20Abi, functionName: 'symbol' })),
    ])
    if (d === undefined) return { kind: 'unknown', reason: 'token_unreadable' }
    decimals = Number(d)
    symbol = sanitizeLabel(s ?? '')
  } else if (warpKind === 'synthetic') {
    if (decimalsSelf === undefined) return { kind: 'unknown', reason: 'token_unreadable' }
    decimals = Number(decimalsSelf)
    symbol = sanitizeLabel(symbolSelf ?? '')
  } else {
    decimals = 18
    symbol = byKey(chain).nativeSymbol
  }

  const scaleOf: WarpScale =
    scaleNum !== undefined && scaleDen !== undefined && scaleNum > 0n && scaleDen > 0n
      ? { numerator: scaleNum, denominator: scaleDen, source: 'fraction' }
      : scale !== undefined && scale > 0n
        ? { numerator: scale, denominator: 1n, source: 'scale' }
        : UNSCALED

  // The remote routers, one read per served domain. A bytes32 that is not a left-padded address
  // is a destination that is not EVM-shaped, which this app does not serve.
  const served = [...domains].map((d) => ({ domain: Number(d), chain: chainOfHyperlaneDomain(d) })).filter((x): x is { domain: number; chain: ChainKey } => !!x.chain && x.chain !== chain)
  const remotes = await Promise.all(served.map((s) => read(() => client.readContract({ ...route, functionName: 'routers', args: [s.domain] }))))
  const routes: WarpRoute[] = []
  served.forEach((s, i) => {
    const raw = remotes[i]
    if (!raw) return
    const remote = bytes32ToEvmAddress(raw)
    if (remote && !isAddressEqual(remote, ZERO_ADDRESS)) routes.push({ chain: s.chain, domain: s.domain, router: remote })
  })

  return {
    kind: 'router',
    router: address,
    warpKind,
    token,
    decimals,
    symbol,
    mailbox: getAddress(mailbox),
    domain: cfg.domain,
    scale: scaleOf,
    feeRecipient: feeRecipient && !isAddressEqual(feeRecipient, ZERO_ADDRESS) ? getAddress(feeRecipient) : undefined,
    feeTokenIsNative: feeToken === undefined || isAddressEqual(feeToken, ZERO_ADDRESS),
    version: version === undefined ? undefined : sanitizeLabel(version, 24),
    owner: owner ? getAddress(owner) : undefined,
    hook: hook && !isAddressEqual(hook, ZERO_ADDRESS) ? getAddress(hook) : undefined,
    ism: ism && !isAddressEqual(ism, ZERO_ADDRESS) ? getAddress(ism) : undefined,
    routes,
  }
}

// ------------------------------------------------------------------ quorum ----

/**
 * The same discovery, answered twice by unrelated providers (core/quorum.ts does this for the OFT
 * tab). Here the stakes are the approve spender itself: the router is what the collateral is
 * approved to, and a single provider that answers `mailbox()` and `wrappedToken()` with values of
 * its choosing decides on its own that a stranger's contract is a route for the real token.
 *
 * Same rules as everywhere else: the primary's answer is the answer, an unreachable second
 * provider (`unreadable`) only drops the flag, and a second provider that answers differently
 * blocks. Routes are not compared: a provider one block behind can legitimately miss a domain the
 * other has indexed, and the route set only decides what is offered in a dropdown.
 */
export type HyperlaneDiscoveryQuorum = HyperlaneDiscovery & { crossChecked: boolean }

function sameDiscovery(a: HyperlaneDiscovery, b: HyperlaneDiscovery): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'router' && b.kind === 'router') {
    const sameToken = a.token === undefined && b.token === undefined ? true : !!a.token && !!b.token && isAddressEqual(a.token, b.token)
    return (
      isAddressEqual(a.router, b.router) &&
      a.warpKind === b.warpKind &&
      sameToken &&
      isAddressEqual(a.mailbox, b.mailbox) &&
      a.domain === b.domain &&
      a.decimals === b.decimals &&
      a.scale.numerator === b.scale.numerator &&
      a.scale.denominator === b.scale.denominator
    )
  }
  if (a.kind === 'token' && b.kind === 'token') return isAddressEqual(a.token, b.token) && a.decimals === b.decimals
  return true
}

export async function discoverWarpRouteQuorum(
  primary: ReadClient,
  secondary: ReadClient | undefined,
  chain: ChainKey,
  address: string,
): Promise<HyperlaneDiscoveryQuorum> {
  const [first, other] = await Promise.all([
    discoverWarpRoute(primary, chain, address),
    secondary ? discoverWarpRoute(secondary, chain, address).catch((): undefined => undefined) : Promise.resolve(undefined),
  ])
  if (!other) return { ...first, crossChecked: false }
  // What an unreachable provider produces. An outage, not a second opinion.
  if (other.kind === 'unknown' && other.reason === 'unreadable') return { ...first, crossChecked: false }
  if (!sameDiscovery(first, other)) {
    const reason = other.kind === 'unknown' ? other.reason : 'unreadable'
    return { kind: 'unknown', reason, crossChecked: true }
  }
  return { ...first, crossChecked: true }
}

// ------------------------------------------------------------- the far side ----

/**
 * What the router on the destination says, read on the destination chain itself.
 *
 * Reached through the source router's own `routers(domain)` — a claim, so nothing here raises
 * trust (CLAUDE.md rule 3). It can only lower it: a far side that names a different mailbox than
 * the registry's cannot be delivered to by the real one (Router.handle accepts its own mailbox
 * only), and a far side that does not name the source router back will refuse the message
 * ("Enrolled router does not match sender"). Both are said in red; neither holds the button.
 */
export type RemoteWarp = {
  chain: ChainKey
  domain: number
  router: Address
  /** False when the provider could not be reached: every field below is then undefined. */
  readable: boolean
  /** The far router names the registry's Mailbox for its chain. */
  mailboxOk: boolean | undefined
  /** The far router names the source router as its peer for the source domain. */
  pointsBack: boolean | undefined
  warpKind?: WarpKind | undefined
  /** The ERC-20 that arrives, when the far side is not native. */
  token?: Address | undefined
  decimals?: number | undefined
  symbol?: string | undefined
  scale?: WarpScale | undefined
}

export async function readRemoteWarp(
  dstClient: ReadClient,
  dstChain: ChainKey,
  dstRouter: Address,
  srcChain: ChainKey,
  srcRouter: Address,
): Promise<RemoteWarp> {
  const cfg = hyperlaneConfig(dstChain)
  const srcCfg = hyperlaneConfig(srcChain)
  const base = { chain: dstChain, domain: cfg?.domain ?? 0, router: dstRouter }
  if (!cfg || !srcCfg) return { ...base, readable: false, mailboxOk: undefined, pointsBack: undefined }
  try {
    const route = { address: dstRouter, abi: warpRouteAbi } as const
    const [mailbox, back, wrappedToken, tokenFn, decimalsSelf, symbolSelf, scale, scaleNum, scaleDen] = await Promise.all([
      read(() => dstClient.readContract({ ...route, functionName: 'mailbox' })),
      read(() => dstClient.readContract({ ...route, functionName: 'routers', args: [srcCfg.domain] })),
      read(() => dstClient.readContract({ ...route, functionName: 'wrappedToken' })),
      read(() => dstClient.readContract({ ...route, functionName: 'token' })),
      read(() => dstClient.readContract({ address: dstRouter, abi: erc20Abi, functionName: 'decimals' })),
      read(() => dstClient.readContract({ address: dstRouter, abi: erc20Abi, functionName: 'symbol' })),
      read(() => dstClient.readContract({ ...route, functionName: 'scale' })),
      read(() => dstClient.readContract({ ...route, functionName: 'scaleNumerator' })),
      read(() => dstClient.readContract({ ...route, functionName: 'scaleDenominator' })),
    ])
    const backAddress = back ? bytes32ToEvmAddress(back) : undefined
    const out: RemoteWarp = {
      ...base,
      readable: true,
      mailboxOk: mailbox === undefined ? undefined : isAddressEqual(mailbox, getAddress(cfg.mailbox)),
      pointsBack: back === undefined ? undefined : !!backAddress && isAddressEqual(backAddress, srcRouter),
    }

    let warpKind: WarpKind | undefined
    let token: Address | undefined
    if (wrappedToken !== undefined) {
      warpKind = 'collateral'
      token = getAddress(wrappedToken)
    } else if (tokenFn !== undefined) {
      if (isAddressEqual(tokenFn, ZERO_ADDRESS)) warpKind = 'native'
      else if (isAddressEqual(tokenFn, dstRouter)) {
        warpKind = 'synthetic'
        token = dstRouter
      } else {
        warpKind = 'collateral'
        token = getAddress(tokenFn)
      }
    } else if (decimalsSelf !== undefined) {
      warpKind = 'synthetic'
      token = dstRouter
    } else if (mailbox !== undefined) {
      warpKind = 'native'
    }
    if (warpKind) out.warpKind = warpKind
    if (token) out.token = token

    if (warpKind === 'collateral' && token) {
      const [d, s] = await Promise.all([
        read(() => dstClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })),
        read(() => dstClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })),
      ])
      if (d !== undefined) out.decimals = Number(d)
      if (s !== undefined) out.symbol = sanitizeLabel(s)
    } else if (warpKind === 'synthetic') {
      if (decimalsSelf !== undefined) out.decimals = Number(decimalsSelf)
      if (symbolSelf !== undefined) out.symbol = sanitizeLabel(symbolSelf)
    } else if (warpKind === 'native') {
      out.decimals = 18
      out.symbol = byKey(dstChain).nativeSymbol
    }

    out.scale =
      scaleNum !== undefined && scaleDen !== undefined && scaleNum > 0n && scaleDen > 0n
        ? { numerator: scaleNum, denominator: scaleDen, source: 'fraction' }
        : scale !== undefined && scale > 0n
          ? { numerator: scale, denominator: 1n, source: 'scale' }
          : UNSCALED
    return out
  } catch (e) {
    if (e instanceof UnreadableError) return { ...base, readable: false, mailboxOk: undefined, pointsBack: undefined }
    throw e
  }
}

// ---------------------------------------------------------------- standing ----

/**
 * The two indirect signals behind a collateral or native route, read the way lz-risk/adapters.ts
 * reads them for an OFTAdapter — and for the same reason. A collateral router is a lockbox for a
 * token that knows nothing about it: the token grants it no role, so there is no `minter()`-shaped
 * fact on this chain that could vouch for it. What its deployer does not write:
 *
 *   locked       `token.balanceOf(router) / token.totalSupply()`, both from the REAL token; for a
 *                native route the router's own coin balance (no supply to divide by)
 *   dispatches   `Dispatch` events the registry Mailbox emitted with this router as the sender,
 *                in the newest window a public provider will serve — each one a fee somebody paid
 *
 * Neither proves anything; together they raise the cost of a fake from "deploy a contract" to
 * "tie up capital and pay fees". A route that clears both floors is an ordinary route; one that
 * does not is a yellow "fresh route" nuance with the numbers in it. A synthetic route has no
 * standing to read: it is the token, exactly like a plain OFT.
 */
export type WarpStanding = {
  /** Locked share in basis points (collateral only); undefined when unreadable or not applicable. */
  lockedBps: number | undefined
  /** What the router holds: the collateral token, or the native coin. */
  held: bigint | undefined
  /** Dispatches by this router through the registry Mailbox inside `window`. */
  dispatches: number | undefined
  window: LogWindow | undefined
}

/**
 * Dispatches by this router, newest blocks first, widening only until the floor of twenty is met
 * (lz-risk/probe.ts scanWidening: a provider that refuses wide ranges is not asked for them again).
 */
async function countDispatches(client: ReadClient, mailbox: Address, router: Address): Promise<{ count: number; window: LogWindow } | undefined> {
  const event = pickEvent(mailboxEventsAbi, 'Dispatch')
  const got = await scanWidening(
    client,
    (fromBlock, toBlock) => client.getLogs({ address: mailbox, event, args: { sender: router }, fromBlock, toBlock }),
    (logs) => BigInt(logs.length) >= ADAPTER_MIN_OUTBOUND_NONCE,
  )
  return got.status === 'ok' ? { count: got.logs.length, window: got.window } : undefined
}

export async function readWarpStanding(client: ReadClient, chain: ChainKey, router: WarpRouter): Promise<WarpStanding> {
  const cfg = hyperlaneConfig(chain)
  const none: WarpStanding = { lockedBps: undefined, held: undefined, dispatches: undefined, window: undefined }
  if (!cfg || router.warpKind === 'synthetic') return none

  const [held, supply, scan] = await Promise.all([
    router.warpKind === 'collateral' && router.token
      ? attempt(client.readContract({ address: router.token, abi: erc20Abi, functionName: 'balanceOf', args: [router.router] }), READ_TIMEOUT_MS, 'balanceOf')
      : attempt(client.getBalance({ address: router.router }), READ_TIMEOUT_MS, 'getBalance'),
    router.warpKind === 'collateral' && router.token
      ? attempt(client.readContract({ address: router.token, abi: erc20Abi, functionName: 'totalSupply' }), READ_TIMEOUT_MS, 'totalSupply')
      : Promise.resolve(undefined),
    countDispatches(client, getAddress(cfg.mailbox), router.router),
  ])
  return {
    lockedBps: held.ok && supply?.ok ? lockedBps(held.value, supply.value) : undefined,
    held: held.ok ? held.value : undefined,
    dispatches: scan?.count,
    window: scan?.window,
  }
}

/** Does the standing clear the floors? A read that did not answer is NOT a pass. */
export function warpStandingOk(kind: WarpKind, s: WarpStanding): boolean {
  if (kind === 'synthetic') return true
  if (s.dispatches === undefined || BigInt(s.dispatches) < ADAPTER_MIN_OUTBOUND_NONCE) return false
  if (kind === 'collateral') return s.lockedBps !== undefined && s.lockedBps >= ADAPTER_MIN_LOCKED_BPS
  return s.held !== undefined && s.held > 0n
}
