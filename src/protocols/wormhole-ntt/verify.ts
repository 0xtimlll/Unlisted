/**
 * §Task 5: may this NttManager be given an approve?
 *
 * The manager is the spender. A contract that merely answers `token()` with the right address is
 * trivial to deploy, so naming the token proves nothing — the TOKEN has to name the manager back.
 * All of these must hold ON CHAIN, and a check that cannot be completed counts as a failure:
 *
 *   1. The manager agrees about its own identity: token(), chainId() for this chain, getMode(),
 *      tokenDecimals() — all readable, and the chain id is the one we are actually on.
 *   2. A token-side anchor ON THE SOURCE SIDE: the token this manager names must name it back —
 *      minter() == manager, or hasRole(MINTER_ROLE, manager) for AccessControl tokens, with the
 *      role read from the token itself. This is the only fact in the whole gate the manager's
 *      deployer cannot write, so it is the only one that can establish trust (CLAUDE.md rule 2).
 *      A locking hub has no minter, so the token cannot establish it. What can is money: the share
 *      of the token's supply the manager holds (`balanceOf(manager) / totalSupply()`, both read from
 *      the token). A real hub holds what circulates on its spokes; a fake manager for a real token
 *      holds nothing, and buying 0.1% of a real token's supply to pass is not worth the theft. Below
 *      that share, guard 2b holds the button (`ntt_unvouched`, owner's decision 2026-10-02); above
 *      it the route verifies and the indicator says in red that no one but the balance vouches.
 *   3. Peers in both directions: source.getPeer(dst) == destination manager AND
 *      destination.getPeer(src) == source manager, read on the destination's own RPC.
 *   4. A Wormhole transceiver: it reports the Wormhole type and points at the core bridge whose
 *      address is in OUR committed config, and it has automatic relaying enabled for the
 *      destination. That committed address is the anchor the whole chain of evidence hangs from.
 *
 * Wormholescan's token list is NOT part of this. It is a search hint — it helps find a manager
 * from a token address — and it can never make a verdict better: a token missing from it is
 * verified or refused on exactly the same on-chain evidence as one that is in it. It used to be
 * check 1, which put an external API in the path of an approve; CLAUDE.md rule 1 says the opposite,
 * and the committed core-bridge address is the anchor that rule asks for.
 *
 * Wormholescan's decoded operations are deliberately NOT evidence here: `sourceNttManager` is
 * written by the manager itself, so one self-made transfer would launder a fake. They are shown as
 * context in the details and never feed a decision.
 *
 * Neither is the DESTINATION-side anchor, and that one was a real hole rather than a precaution.
 * It used to substitute for the source anchor, but the only way to reach the destination is
 * `manager.getPeer()` — the manager's own claim — so an attacker supplied both halves: a fake
 * manager naming real USDC, peered to a fake manager on the far side naming a token the attacker
 * also wrote, which duly named it back. Every other check passed, because a contract can return
 * the real core bridge address as easily as any other. The destination anchor is still read and
 * still shown, and it can now only ever be context.
 */
import { getAddress, isAddressEqual, type Address } from 'viem'
import { erc20Abi } from '../../core/abi'
import { sanitizeLabel } from '../../core/text'
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { isZeroBytes32, peerToAddress } from '../../core/encoding'
import { nttManagerAbi, nttTokenAnchorAbi, WORMHOLE_TRANSCEIVER_TYPE, wormholeTransceiverAbi, nttMode, type NttMode } from './abi'
import { WORMHOLE_CHAINS, wormholeChainId } from './chains'
import { findListedToken, type NttToken } from './tokenList'

export type NttRejectionCode =
  | 'chain_unsupported'
  | 'manager_token_mismatch'
  | 'manager_wrong_chain_id'
  | 'peer_missing'
  | 'peer_not_evm'
  | 'peer_mismatch'
  | 'no_wormhole_transceiver'
  | 'transceiver_wrong_core_bridge'
  | 'manual_delivery_only'
  | 'unverifiable'

/**
 * What established this manager: the token on the SOURCE chain naming it as minter, or granting it
 * the minter role. That is the only fact an attacker cannot author. A destination-side anchor is
 * reported separately as `alsoOnDestination` and is never a reason on its own.
 */
export type AnchorSide = 'source'
export type AnchorKind = 'minter' | 'role'

/**
 * The share of the token's supply a manager with no token-side anchor must hold to be given an
 * approve: 0.1%, the same floor the LayerZero adapters use (lz-risk/adapters.ts). In basis points.
 */
export const NTT_MIN_LOCKED_BPS = 10

export type VerifiedNttManager = {
  chain: ChainKey
  manager: Address
  token: Address
  /** ERC-20 symbol(), read from the token itself and stripped of layout controls. */
  tokenSymbol: string
  /**
   * Whether Wormhole's published list happens to mention this token. Context for the screen only —
   * nothing in this verdict depends on it, in either direction.
   */
  listed: boolean
  mode: NttMode
  tokenDecimals: number
  dst: {
    chain: ChainKey
    wormholeChainId: number
    manager: Address
    /** The listed token on the destination — a contract, so never a valid recipient (guard 4). */
    token: Address
    /** The destination token's decimals, as the peer entry records them. */
    tokenDecimals: number
  }
  /** The Wormhole transceiver that will carry the message. */
  transceiver: Address
  /**
   * What established this manager, or `null` when nothing did.
   *
   * `null` is not a refusal. Unlisted is a tool that informs: a locking hub looks exactly like a
   * fake from the source chain, and refusing outright made the tab useless for anything that
   * locks. The route is verified in every other respect and the indicator says, in red, that the
   * one thing nobody could confirm is the contract itself.
   */
  anchor: { side: AnchorSide; kind: AnchorKind } | null
  /**
   * How much of the token's supply this manager holds, in basis points — read from the token when
   * it names no minter, because then the balance is the only fact the manager's deployer cannot
   * write. Absent when the anchor made it unnecessary, or when the token did not answer; guard 2b
   * treats "not readable" like "nothing".
   */
  lockedBps?: number
  /**
   * The destination token also names the destination manager. Context for the details panel only:
   * we reached that token through this manager's own `getPeer()`, so it says nothing about whether
   * this manager is real.
   */
  alsoOnDestination: boolean
}

export type NttVerification = { ok: true; verified: VerifiedNttManager } | { ok: false; code: NttRejectionCode; detail?: string }

const fail = (code: NttRejectionCode, detail?: string): NttVerification => (detail === undefined ? { ok: false, code } : { ok: false, code, detail })

/** A read that must succeed. `undefined` means the provider could not answer, which blocks. */
async function read<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

export type VerifyInput = {
  srcChain: ChainKey
  dstChain: ChainKey
  manager: string
  srcClient: ReadClient
  dstClient: ReadClient
  tokenList: readonly NttToken[]
}

export async function verifyNttManager(p: VerifyInput): Promise<NttVerification> {
  const srcWh = wormholeChainId(p.srcChain)
  const dstWh = wormholeChainId(p.dstChain)
  if (srcWh === undefined || dstWh === undefined) return fail('chain_unsupported', `${p.srcChain} -> ${p.dstChain}`)

  let manager: Address
  try {
    manager = getAddress(p.manager)
  } catch {
    return fail('unverifiable', 'not an address')
  }
  const base = { address: manager, abi: nttManagerAbi } as const

  // ---- 1. the manager's own answers ----------------------------------------
  const tokenRaw = await read(() => p.srcClient.readContract({ ...base, functionName: 'token' }))
  if (!tokenRaw) return fail('unverifiable', 'manager.token()')
  let token: Address
  try {
    token = getAddress(tokenRaw)
  } catch {
    return fail('manager_token_mismatch', tokenRaw)
  }
  // Wormhole's list is consulted for CONTEXT only, after the fact. Absence is not a refusal and
  // presence is not a pass: the on-chain evidence below is the whole gate.
  const listed = !!findListedToken(p.tokenList, p.srcChain, token)

  const chainIdOnChain = await read(() => p.srcClient.readContract({ ...base, functionName: 'chainId' }))
  if (chainIdOnChain === undefined) return fail('unverifiable', 'manager.chainId()')
  if (Number(chainIdOnChain) !== srcWh) return fail('manager_wrong_chain_id', `${chainIdOnChain} != ${srcWh}`)

  const modeRaw = await read(() => p.srcClient.readContract({ ...base, functionName: 'getMode' }))
  if (modeRaw === undefined) return fail('unverifiable', 'manager.getMode()')
  const mode = nttMode(Number(modeRaw))
  if (!mode) return fail('unverifiable', `unknown mode ${modeRaw}`)

  const tokenDecimals = await read(() => p.srcClient.readContract({ ...base, functionName: 'tokenDecimals' }))
  if (tokenDecimals === undefined) return fail('unverifiable', 'manager.tokenDecimals()')

  // ---- 3. peers, both directions -------------------------------------------
  const peer = await read(() => p.srcClient.readContract({ ...base, functionName: 'getPeer', args: [dstWh] }))
  if (!peer) return fail('unverifiable', 'manager.getPeer()')
  if (isZeroBytes32(peer.peerAddress)) return fail('peer_missing', p.dstChain)
  const dstManager = peerToAddress(peer.peerAddress)
  if (!dstManager) return fail('peer_not_evm', peer.peerAddress)
  if (peer.tokenDecimals === 0) return fail('unverifiable', 'peer decimals are zero')

  const dstBase = { address: dstManager, abi: nttManagerAbi } as const
  const backPeer = await read(() => p.dstClient.readContract({ ...dstBase, functionName: 'getPeer', args: [srcWh] }))
  if (!backPeer) return fail('unverifiable', 'destination getPeer()')
  const backAddress = peerToAddress(backPeer.peerAddress)
  if (!backAddress || !isAddressEqual(backAddress, manager)) return fail('peer_mismatch', backPeer.peerAddress)

  const dstTokenRaw = await read(() => p.dstClient.readContract({ ...dstBase, functionName: 'token' }))
  if (!dstTokenRaw) return fail('unverifiable', 'destination token()')
  let dstToken: Address
  try {
    dstToken = getAddress(dstTokenRaw)
  } catch {
    return fail('unverifiable', 'destination token() is not an address')
  }

  // ---- 2. the token-side anchor — SOURCE side only --------------------------
  //
  // The token the manager named has to name it back. That is a fact about a contract the manager's
  // deployer does not control, which is what makes it worth anything. Everything else in this
  // function is the manager's own account of itself.
  const srcAnchor = await tokenAnchors(p.srcClient, token, manager)

  // Read for the details panel, never for the verdict: we only know about `dstToken` because this
  // manager told us where to look.
  const dstAnchor = await tokenAnchors(p.dstClient, dstToken, dstManager)

  // No anchor from the token means a genuine locking hub — nothing is minted there — or something
  // pretending to be one. Nothing on chain can tell them apart, and `getMode()` is deliberately
  // not consulted: the mode is the manager's own claim, so "I am a locking hub" can never be the
  // reason to trust a locking hub.
  //
  // When nothing speaks for it, the verdict is still `ok` and `anchor` is null. Guard 2b carries
  // that as a note the indicator shows in red (core/indicator.ts) rather than a refusal.
  const anchor: { side: AnchorSide; kind: AnchorKind } | null = srcAnchor ? { side: 'source', kind: srcAnchor } : null

  // ---- 2b. with no anchor, the only fact left is money: the share of supply the manager holds.
  // Both numbers come from the token, not from the manager (CLAUDE.md rule 3). Not read when the
  // token already vouched; unreadable counts as nothing, which guard 2b turns into a refusal.
  let lockedBps: number | undefined
  if (!srcAnchor) {
    const [held, supply] = await Promise.all([
      read(() => p.srcClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [manager] })),
      read(() => p.srcClient.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })),
    ])
    if (held !== undefined && supply !== undefined) lockedBps = supply === 0n ? 0 : Number((held * 10_000n) / supply)
  }

  // ---- 4. a Wormhole transceiver with automatic delivery --------------------
  const transceivers = await read(() => p.srcClient.readContract({ ...base, functionName: 'getTransceivers' }))
  if (!transceivers) return fail('unverifiable', 'manager.getTransceivers()')
  const coreBridge = WORMHOLE_CHAINS[p.srcChain]?.coreBridge
  if (!coreBridge) return fail('chain_unsupported', `no core bridge for ${p.srcChain}`)

  let wormholeTransceiver: Address | undefined
  let sawWormholeType = false
  let wrongCoreBridge = false
  for (const t of transceivers) {
    const type = await read(() => p.srcClient.readContract({ address: t, abi: wormholeTransceiverAbi, functionName: 'getTransceiverType' }))
    if (type !== WORMHOLE_TRANSCEIVER_TYPE) continue
    sawWormholeType = true
    const core = await read(() => p.srcClient.readContract({ address: t, abi: wormholeTransceiverAbi, functionName: 'wormhole' }))
    if (!core || !isAddressEqual(getAddress(core), getAddress(coreBridge))) {
      wrongCoreBridge = true
      continue
    }
    wormholeTransceiver = t
    break
  }
  if (!wormholeTransceiver) {
    if (wrongCoreBridge) return fail('transceiver_wrong_core_bridge', coreBridge)
    return fail('no_wormhole_transceiver', sawWormholeType ? 'core bridge unreadable' : `${transceivers.length} transceiver(s)`)
  }

  // Automatic delivery only. A transfer that would need a manual redeem is refused, and a build
  // that does not expose these getters counts as "cannot confirm" — which is also a refusal.
  const [viaRelayer, viaSpecial] = await Promise.all([
    read(() => p.srcClient.readContract({ address: wormholeTransceiver!, abi: wormholeTransceiverAbi, functionName: 'isWormholeRelayingEnabled', args: [dstWh] })),
    read(() => p.srcClient.readContract({ address: wormholeTransceiver!, abi: wormholeTransceiverAbi, functionName: 'isSpecialRelayingEnabled', args: [dstWh] })),
  ])
  if (viaRelayer === undefined && viaSpecial === undefined) return fail('unverifiable', 'relaying getters unavailable')
  if (viaRelayer !== true && viaSpecial !== true) return fail('manual_delivery_only', p.dstChain)

  // The symbol shown next to an amount comes from the token contract, like every other fact here.
  // A token that does not answer symbol() is still bridgeable; it just has no name to print.
  const symbolRaw = await read(() => p.srcClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }))
  const symbol = sanitizeLabel(symbolRaw ?? '')

  return {
    ok: true,
    verified: {
      chain: p.srcChain,
      manager,
      token,
      tokenSymbol: symbol,
      listed,
      mode,
      tokenDecimals: Number(tokenDecimals),
      dst: { chain: p.dstChain, wormholeChainId: dstWh, manager: dstManager, token: dstToken, tokenDecimals: peer.tokenDecimals },
      transceiver: wormholeTransceiver,
      anchor,
      ...(lockedBps !== undefined ? { lockedBps } : {}),
      alsoOnDestination: !!dstAnchor,
    },
  }
}

/**
 * Does this token name the manager as its minter? `minter()` first (the reference NTT token), then
 * AccessControl, with MINTER_ROLE read from the token so no role hash is assumed here.
 */
async function tokenAnchors(client: ReadClient, token: Address, manager: Address): Promise<AnchorKind | undefined> {
  const minter = await read(() => client.readContract({ address: token, abi: nttTokenAnchorAbi, functionName: 'minter' }))
  if (minter && isAddressEqual(getAddress(minter), manager)) return 'minter'

  const role = await read(() => client.readContract({ address: token, abi: nttTokenAnchorAbi, functionName: 'MINTER_ROLE' }))
  if (!role) return undefined
  const has = await read(() => client.readContract({ address: token, abi: nttTokenAnchorAbi, functionName: 'hasRole', args: [role, manager] }))
  return has === true ? 'role' : undefined
}

// ------------------------------------------------------------------ quorum ----

/**
 * The same gate, answered twice by unrelated providers (core/quorum.ts does this for the OFT tab).
 *
 * This verification is the only thing that lets an approve name a spender at all, and until now it
 * ran entirely on one endpoint — which, when the user has set a custom RPC, is an endpoint they
 * were told to paste. One provider that lies about `token()`, `getPeer()` and `minter()` together
 * can walk a fake manager through all four parts. Two unrelated providers is a much higher bar.
 *
 * The rules are the OFT ones, deliberately:
 *   - the primary's verdict is the verdict; a second opinion can only ever take a pass away
 *   - a second provider that is down or throttled answers `unverifiable`, which is an OUTAGE:
 *     the cross-checked flag drops and nothing blocks
 *   - a second provider that answers with any other rejection, or with a different manager/token/
 *     peer, is a DISAGREEMENT and blocks
 */
export type NttVerificationQuorum = NttVerification & { crossChecked: boolean }

function withFlag(v: NttVerification, crossChecked: boolean): NttVerificationQuorum {
  return v.ok
    ? { ok: true, verified: v.verified, crossChecked }
    : { ok: false, code: v.code, ...(v.detail !== undefined ? { detail: v.detail } : {}), crossChecked }
}

/**
 * Do two opinions name the same contracts? Only the fields that decide where money and allowance
 * go are compared.
 *
 * `anchor` and `tokenSymbol` are deliberately left out. The anchor is a REASON, not a destination,
 * and it has a benign way to differ: tokenAnchors() swallows read errors, so a flaky source-side
 * token read alone flips a provider from `source` to `destination` without either being wrong.
 * Blocking on that would turn a slow RPC into a broken tab.
 */
export function sameNttVerdict(a: VerifiedNttManager, b: VerifiedNttManager): boolean {
  return (
    isAddressEqual(a.manager, b.manager) &&
    isAddressEqual(a.token, b.token) &&
    isAddressEqual(a.transceiver, b.transceiver) &&
    a.mode === b.mode &&
    // The anchor is a REASON, and reasons may legitimately differ between providers only in the
    // ways noted below — but WHICH KIND of reason decides the verdict, so `side` is compared.
    // `listed` is deliberately absent: it comes from one shared HTTP response, not from either
    // provider, so comparing it would compare the API with itself.

    a.tokenDecimals === b.tokenDecimals &&
    a.dst.chain === b.dst.chain &&
    a.dst.wormholeChainId === b.dst.wormholeChainId &&
    a.dst.tokenDecimals === b.dst.tokenDecimals &&
    isAddressEqual(a.dst.manager, b.dst.manager) &&
    isAddressEqual(a.dst.token, b.dst.token)
  )
}

/** A second, independent view of the same two chains. Absent when the registry has no spare RPC. */
export type NttSecondOpinion = { srcClient: ReadClient; dstClient: ReadClient }

export async function verifyNttManagerQuorum(p: VerifyInput, second: NttSecondOpinion | undefined): Promise<NttVerificationQuorum> {
  const [first, other] = await Promise.all([
    verifyNttManager(p),
    second
      ? verifyNttManager({ ...p, srcClient: second.srcClient, dstClient: second.dstClient }).catch((): undefined => undefined)
      : Promise.resolve(undefined),
  ])

  if (!first.ok || !other) return withFlag(first, false)
  if (!other.ok) {
    // Exactly what an unreachable provider produces — an outage, not a second opinion.
    if (other.code === 'unverifiable') return withFlag(first, false)
    return withFlag({ ok: false, code: other.code, detail: `another RPC: ${other.detail ?? other.code}` }, true)
  }
  if (!sameNttVerdict(first.verified, other.verified)) {
    return withFlag({ ok: false, code: 'unverifiable', detail: 'RPC providers disagree about this manager' }, true)
  }
  // The anchor is a REASON, not a destination, so it is not part of `sameNttVerdict` — and it has a
  // benign way to differ: tokenAnchors() swallows read errors, so one flaky token read alone can
  // turn `source` into `null`. Disagreement therefore LOWERS the verdict to the weaker of the two
  // rather than refusing it: a hiccup must not look like a finding, and a missing anchor is a
  // warning anyway (guard 2b).
  const anchor = first.verified.anchor && other.verified.anchor ? first.verified.anchor : null
  // The locked share is money, so two readings are reconciled downwards: the smaller one stands.
  // One provider failing to read it is an outage, and the other's reading is kept.
  const a = first.verified.lockedBps
  const b = other.verified.lockedBps
  const lockedBps = a !== undefined && b !== undefined ? Math.min(a, b) : (a ?? b)
  const { lockedBps: _drop, ...rest } = first.verified
  void _drop
  return withFlag({ ok: true, verified: { ...rest, anchor, ...(lockedBps !== undefined ? { lockedBps } : {}) } }, true)
}
