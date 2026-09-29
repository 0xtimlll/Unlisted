/**
 * §3: what a LayerZero **v1** contract is, read from the contract.
 *
 * This runs only after core/probe.ts has already said `not_oft` — the V2 probe is untouched and
 * still decides first, so nothing about the V2 path changes shape or order because v1 exists.
 * Every probe here is a staticcall in a try/catch: a contract that does not answer a question is
 * simply not that standard, which is different from a contract that answers wrongly.
 *
 * The three standards are told apart by what they answer, never by a name or a list:
 *
 *   sharedDecimals() reverts, estimateSendFee(…, bytes, …) answers    → OFT / ProxyOFT     (bytes)
 *   sharedDecimals() answers, estimateSendFee(…, bytes32, …) answers  → OFTV2 / ProxyOFTV2 (bytes32)
 *   …and quoteOFTFee(uint16,uint256) also answers                     → OFTWithFee         (bytes32_fee)
 *
 * and `token()` decides OFT vs Proxy: an adapter names someone else's ERC-20, and that is exactly
 * the contract the user has to approve, for exactly the amount being sent.
 */
import { getAddress, toFunctionSelector, type Address, type Hex } from 'viem'
import { erc20Abi } from '../../core/abi'
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { sameAddress } from '../../core/encoding'
import { labelLooksSpoofed, sanitizeLabel, suspiciousFlags } from '../../core/probe'
import type { SuspiciousFlag } from '../../core/types'
import { endpointV1Abi, lzAppAbi, nativeOftAbi, oftV1Abi, oftV2OnV1Abi, oftWithFeeAbi, PT_SEND, type V1Kind, type V1Standard, type V1Wire } from './abi'
import { lzV1, v1Destinations, type LzV1Chain } from './chains'

export type ProbeV1ErrorCode =
  | 'invalid_address'
  | 'not_contract'
  | 'chain_has_no_v1'
  | 'chain_v1_inactive'
  | 'not_lz_v1'
  | 'foreign_endpoint'
  | 'unknown_standard'
  | 'native_oft_unsupported'
  | 'token_unreadable'
  | 'shared_decimals_invalid'
  | 'no_routes'
  | 'rpc_mismatch'

export class ProbeV1Error extends Error {
  constructor(
    public readonly code: ProbeV1ErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ProbeV1Error'
  }
}

/** One destination this contract has actually been wired to. */
export type V1Route = {
  key: ChainKey
  v1ChainId: number
  /**
   * `trustedRemoteLookup(dstChainId)` verbatim: `abi.encodePacked(remoteAddress, localAddress)`.
   * Kept raw because the endpoint's `hasStoredPayload` takes these exact bytes, and re-deriving
   * them from two addresses would be a guess where a read is available.
   */
  trustedRemote: Hex
  /** The remote half, when the path is the ordinary 40-byte EVM shape. */
  remoteAddress: Address | undefined
  /** `minDstGasLookup(dstChainId, PT_SEND)`; 0 means the project never set one. */
  minDstGas: bigint
}

export type OftV1Info = {
  vm: 'evm'
  /** Always 'lz-v1'; lets one screen hold both a V2 OftInfo and this without a cast. */
  protocol: 'lz-v1'
  standard: V1Standard
  chain: ChainKey
  /** The v1 uint16 of the SOURCE chain. */
  srcV1ChainId: number
  oft: Address
  /** ERC-20 to read balances and allowance from; equals `oft` for a plain OFT. */
  token: Address
  symbol: string
  name: string
  decimals: number
  /** bytes32 standards only — the `bytes` standard has no shared decimals and no dust. */
  sharedDecimals: number | undefined
  /** 10^(decimals - sharedDecimals), or 1n where the standard has no dust to trim. */
  conversionRate: bigint
  endpoint: Address
  owner: Address | undefined
  /** An adapter pulls with transferFrom, so it must be approved — for exactly the amount. */
  approvalRequired: boolean
  /**
   * `useCustomAdapterParams()`, or undefined when the contract has no such flag. OFTCoreV2 has
   * none: it always calls `_checkGasLimit`, so adapter params are always required there.
   */
  useCustomAdapterParams: boolean | undefined
  /** Derived from the two above: must `sendFrom` carry non-empty adapter params? */
  adapterParamsRequired: boolean
  routes: V1Route[]
  /** token.balanceOf(oft) for an adapter — what the bridge actually holds. */
  lockedInAdapter: bigint | undefined
  /**
   * True when `estimateSendFee` answered for at least one of this contract's routes during the
   * probe. False is not a rejection — the standard is decided by shape — but it means the first
   * real quote is also the first time this contract has priced anything for us, so the review
   * screen has a revert to show rather than a number.
   */
  feeProbed: boolean
}

export type ProbeV1Result = { info: OftV1Info; flags: SuspiciousFlag[] }

/** A staticcall that is allowed to fail: failure is an answer ("not this standard"). */
async function attempt<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p
  } catch {
    return undefined
  }
}

/**
 * A probe amount and recipient that exercise `estimateSendFee` without committing to anything.
 * The fee is quoted again for real numbers before anything is signed; this call only asks whether
 * the function answers with this parameter list.
 *
 * Two things this probe has to get right, both learned from mainnet rather than assumed:
 *
 *   - **the destination must be one the contract is actually wired to.** Quoting a route the
 *     contract has no trusted remote for reaches an UltraLightNode with no price configured for
 *     that pair and reverts, which says nothing about the contract's shape.
 *   - **the adapter params must be ones the relayer accepts.** `RelayerV2._getPrices` requires
 *     34 bytes or more than 66, and the ULN substitutes `defaultAdapterParams` for empty bytes —
 *     which is itself unset on most live routes, so an empty probe reverts on contracts that are
 *     perfectly fine. The probe therefore sends type 1 with the route's own `minDstGasLookup`.
 */
const PROBE_AMOUNT = 1n
const PROBE_BYTES32: Hex = `0x${'0'.repeat(24)}${'1'.repeat(40)}`
const PROBE_BYTES: Hex = `0x${'1'.repeat(40)}`

/** `abi.encodePacked(uint16(1), uint256(gas))`, built here so the probe owes nothing to plan.ts. */
function probeParams(minDstGas: bigint): Hex {
  const gas = minDstGas > 0n ? minDstGas : 200_000n
  return `0x0001${gas.toString(16).padStart(64, '0')}` as Hex
}

/**
 * NativeOFT wraps the chain's own coin, and its `sendFrom` takes the amount out of `msg.value`
 * alongside the fee (`messageFee = msg.value - mintAmount`). Every money invariant in this app
 * rests on `value === fee`, so rather than loosen that for one contract shape, the contract is
 * named and refused.
 *
 * Recognised from its own deployed code: both `deposit()` and `withdraw(uint256)` selectors
 * present in a contract that is its own token. A false positive only refuses a send. A false
 * negative is harmless too, and not by luck: guard 5 already requires the wallet's balance to
 * cover the amount, and that is precisely the condition under which NativeOFT's wrapping branch
 * is not taken and `messageFee` is the whole `msg.value`.
 */
async function looksLikeNativeOft(client: ReadClient, oft: Address, isSelfToken: boolean): Promise<boolean> {
  if (!isSelfToken) return false
  const code = await attempt(client.getCode({ address: oft }))
  if (!code) return false
  const needles = nativeOftAbi
    .filter((f): f is Extract<typeof f, { type: 'function' }> => f.type === 'function')
    .map((f) => toFunctionSelector(f).slice(2).toLowerCase())
  const hex = code.slice(2).toLowerCase()
  return needles.every((n) => hex.includes(n))
}

/**
 * §3: read a v1 OFT from its address alone.
 *
 * `chain` is the registry key of the chain `client` talks to — the v1 chain id and the canonical
 * Endpoint V1 both come from the committed table, never from the contract's own claim.
 */
export async function probeOftV1(client: ReadClient, chain: ChainKey, address: string): Promise<ProbeV1Result> {
  let oft: Address
  try {
    oft = getAddress(address)
  } catch {
    throw new ProbeV1Error('invalid_address')
  }
  const here = lzV1(chain)
  if (!here) throw new ProbeV1Error('chain_has_no_v1', chain)
  // The endpoint is deployed and answers, but with no default libraries nothing can leave this
  // chain over v1. Refusing here rather than at send time means the contract is never presented as
  // bridgeable from a network that cannot carry it.
  if (!here.v1Active) throw new ProbeV1Error('chain_v1_inactive', here.v1InactiveReason ?? chain)

  const code = await client.getCode({ address: oft })
  if (!code || code === '0x') throw new ProbeV1Error('not_contract')

  // 1. Is this a LzApp at all, and is it on the endpoint we know about?
  const lzEndpoint = await attempt(client.readContract({ address: oft, abi: lzAppAbi, functionName: 'lzEndpoint' }))
  if (!lzEndpoint) throw new ProbeV1Error('not_lz_v1', 'lzEndpoint() did not answer')
  const endpoint = getAddress(lzEndpoint)
  if (!sameAddress(endpoint, here.endpoint)) {
    // One Endpoint V1 per chain. A contract naming a different one is not on the network this
    // app would be quoting and sending through, whatever else it is.
    throw new ProbeV1Error('foreign_endpoint', `${endpoint} is not ${chain}'s Endpoint V1 (${here.endpoint})`)
  }

  // 2. The token, the owner, and the one number that separates the two families.
  const [tokenRes, sharedRes, owner] = await Promise.all([
    attempt(client.readContract({ address: oft, abi: oftV1Abi, functionName: 'token' })),
    attempt(client.readContract({ address: oft, abi: oftV2OnV1Abi, functionName: 'sharedDecimals' })),
    attempt(client.readContract({ address: oft, abi: lzAppAbi, functionName: 'owner' })),
  ])
  if (!tokenRes) throw new ProbeV1Error('not_lz_v1', 'token() did not answer')
  const token = getAddress(tokenRes)
  const kind: V1Kind = sameAddress(token, oft) ? 'OFT' : 'Proxy'

  // 3. Routes first, because the fee probe needs a destination the contract is wired to.
  const dsts = v1Destinations(chain)
  const [remotes, minGas] = await Promise.all([
    client.multicall({
      contracts: dsts.map((d) => ({ address: oft, abi: lzAppAbi, functionName: 'trustedRemoteLookup', args: [d.v1ChainId] }) as const),
      allowFailure: true,
    }),
    client.multicall({
      contracts: dsts.map((d) => ({ address: oft, abi: lzAppAbi, functionName: 'minDstGasLookup', args: [d.v1ChainId, PT_SEND] }) as const),
      allowFailure: true,
    }),
  ])
  const routes: V1Route[] = []
  dsts.forEach((d: LzV1Chain, i) => {
    const r = remotes[i]
    if (!r || r.status !== 'success') return
    const path = r.result
    if (!path || path === '0x') return
    routes.push({
      key: d.key,
      v1ChainId: d.v1ChainId,
      trustedRemote: path,
      remoteAddress: remoteOf(path),
      minDstGas: minGas[i]?.status === 'success' ? minGas[i]!.result : 0n,
    })
  })
  if (routes.length === 0) throw new ProbeV1Error('no_routes', 'no trustedRemoteLookup entry for any chain in the registry')

  /** Does `estimateSendFee` with this parameter list answer, on any route the contract has? */
  async function feeAnswers(wire: V1Wire): Promise<boolean> {
    for (const r of routes) {
      const params = probeParams(r.minDstGas)
      const got =
        wire === 'bytes'
          ? await attempt(
              client.readContract({
                address: oft,
                abi: oftV1Abi,
                functionName: 'estimateSendFee',
                args: [r.v1ChainId, PROBE_BYTES, PROBE_AMOUNT, false, params],
              }),
            )
          : await attempt(
              client.readContract({
                address: oft,
                abi: wire === 'bytes32' ? oftV2OnV1Abi : oftWithFeeAbi,
                functionName: 'estimateSendFee',
                args: [r.v1ChainId, PROBE_BYTES32, PROBE_AMOUNT, false, params],
              }),
            )
      if (got !== undefined) return true
    }
    return false
  }

  // 4. Which standard. `sharedDecimals` is the discriminator: OFTCoreV2 declares it, OFTCore has
  //    no such notion at all. `quoteOFTFee` then separates the fee variant, whose `sendFrom`
  //    carries an extra `_minAmount` and therefore a different selector.
  let wire: V1Wire
  let feeProbed: boolean
  if (sharedRes !== undefined) {
    const feeQuote = await attempt(
      client.readContract({ address: oft, abi: oftWithFeeAbi, functionName: 'quoteOFTFee', args: [routes[0]!.v1ChainId, PROBE_AMOUNT] }),
    )
    wire = feeQuote !== undefined ? 'bytes32_fee' : 'bytes32'
    // Corroboration, not the verdict: a route whose relayer prices are unset reverts for reasons
    // that say nothing about the contract. The plan quotes for real and shows that revert by name.
    feeProbed = await feeAnswers(wire)
  } else {
    // No shared decimals: the `bytes` family, but only on positive evidence. `estimateSendFee`
    // with a `bytes` recipient answering, or OFTCore's own `useCustomAdapterParams`, is that
    // evidence; without either, this is a LayerZero v1 app of some other kind and is refused.
    feeProbed = await feeAnswers('bytes')
    const hasOftCoreFlag = (await attempt(client.readContract({ address: oft, abi: lzAppAbi, functionName: 'useCustomAdapterParams' }))) !== undefined
    if (!feeProbed && !hasOftCoreFlag) {
      throw new ProbeV1Error('unknown_standard', 'no sharedDecimals, and neither estimateSendFee(bytes) nor useCustomAdapterParams answers')
    }
    wire = 'bytes'
  }

  if (await looksLikeNativeOft(client, oft, kind === 'OFT')) {
    throw new ProbeV1Error('native_oft_unsupported', 'NativeOFT takes the amount out of msg.value')
  }

  // 3. ERC-20 facts, from the token the contract named.
  const meta = await client.multicall({
    contracts: [
      { address: token, abi: erc20Abi, functionName: 'decimals' },
      { address: token, abi: erc20Abi, functionName: 'symbol' },
      { address: token, abi: erc20Abi, functionName: 'name' },
      { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [oft] },
    ],
    allowFailure: true,
  })
  const [mDec, mSym, mName, mLocked] = meta
  if (!mDec || mDec.status !== 'success') throw new ProbeV1Error('token_unreadable', 'token.decimals() failed')
  const decimals = Number(mDec.result)
  const symbol = sanitizeLabel(mSym?.status === 'success' ? mSym.result : '')
  const name = sanitizeLabel(mName?.status === 'success' ? mName.result : '')

  const sharedDecimals = sharedRes === undefined ? undefined : Number(sharedRes)
  if (sharedDecimals !== undefined && (sharedDecimals < 0 || sharedDecimals > decimals)) {
    throw new ProbeV1Error('shared_decimals_invalid', `sharedDecimals ${sharedDecimals} > decimals ${decimals}`)
  }
  // OFTCoreV2 fixes ld2sdRate = 10^(decimals - sharedDecimals) in its constructor and keeps it
  // internal, so it is computed here from the two numbers the contract does expose.
  const conversionRate = sharedDecimals === undefined ? 1n : 10n ** BigInt(decimals - sharedDecimals)

  // 5. Adapter params policy, taken from the code that enforces it rather than from the flag alone.
  //
  //    OFTCore._checkAdapterParams (the `bytes` family) consults `useCustomAdapterParams`: false
  //    means the bytes MUST be empty. OFTCoreV2._send (both bytes32 families) has no such branch —
  //    it calls `_checkGasLimit` unconditionally, so params are always required there even when the
  //    contract happens to define the flag as well, which several live ones do.
  //
  //    A `bytes` contract that does not answer the flag at all is treated as requiring params: if
  //    that is wrong the send reverts, and guard 13 runs the real transaction before anything is
  //    signed, so a wrong guess here costs a clear error rather than a lost transfer.
  const useCustomAdapterParams = await attempt(
    client.readContract({ address: oft, abi: lzAppAbi, functionName: 'useCustomAdapterParams' }),
  )
  const adapterParamsRequired = wire === 'bytes' ? (useCustomAdapterParams ?? true) : true

  const flags = await suspiciousFlags(client, oft, owner ? getAddress(owner) : undefined)
  if (labelLooksSpoofed(symbol) || labelLooksSpoofed(name)) flags.push('label_lookalike')
  const lockedInAdapter = kind === 'Proxy' && mLocked?.status === 'success' ? mLocked.result : undefined
  if (lockedInAdapter === 0n) flags.push('adapter_empty')

  return {
    info: {
      vm: 'evm',
      protocol: 'lz-v1',
      standard: { wire, kind },
      chain,
      srcV1ChainId: here.v1ChainId,
      oft,
      token,
      symbol,
      name,
      decimals,
      sharedDecimals,
      conversionRate,
      endpoint,
      owner: owner ? getAddress(owner) : undefined,
      approvalRequired: kind === 'Proxy',
      useCustomAdapterParams,
      adapterParamsRequired,
      routes,
      lockedInAdapter,
      feeProbed,
    },
    flags,
  }
}

/**
 * The remote half of `abi.encodePacked(remoteAddress, localAddress)`.
 *
 * Only the ordinary 40-byte EVM path yields an address; anything else (a non-EVM remote, or a
 * path this app does not recognise) yields undefined rather than a guess, and the raw bytes stay
 * available for the checks that need them.
 */
export function remoteOf(path: Hex): Address | undefined {
  const h = path.slice(2)
  if (h.length !== 80) return undefined
  try {
    return getAddress(`0x${h.slice(0, 40)}`)
  } catch {
    return undefined
  }
}

/** The local half — used to confirm a destination's path points back at our own contract. */
export function localOf(path: Hex): Address | undefined {
  const h = path.slice(2)
  if (h.length !== 80) return undefined
  try {
    return getAddress(`0x${h.slice(40)}`)
  } catch {
    return undefined
  }
}

/**
 * The destination's own view of this route: does the remote contract trust us back?
 *
 * v1's answer to core/verify.ts. A look-alike adapter can point at a real OFT; the real OFT will
 * not point back at the look-alike, because only its owner can call `setTrustedRemote`.
 */
export type V1PeerBack = { status: 'ok' } | { status: 'mismatch'; theirRemote: string } | { status: 'unavailable'; reason: string }

export async function checkV1TrustedRemoteBack(
  dstClient: ReadClient,
  remote: Address,
  srcV1ChainId: number,
  ours: Address,
): Promise<V1PeerBack> {
  let path: Hex
  try {
    path = await dstClient.readContract({ address: remote, abi: lzAppAbi, functionName: 'trustedRemoteLookup', args: [srcV1ChainId] })
  } catch (e) {
    return { status: 'unavailable', reason: e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e) }
  }
  if (!path || path === '0x') return { status: 'mismatch', theirRemote: '0x' }
  // Their path is packed (remote=us, local=them): the first 20 bytes must be our contract.
  const theirs = remoteOf(path)
  if (!theirs) return { status: 'mismatch', theirRemote: path }
  return sameAddress(theirs, ours) ? { status: 'ok' } : { status: 'mismatch', theirRemote: theirs }
}

/**
 * §3: is the destination endpoint holding a stuck packet for this exact path?
 *
 * The bytes are the destination contract's own `trustedRemoteLookup(srcChainId)`, which is the
 * `srcAddress` the endpoint keyed the stored payload under. Reading them rather than rebuilding
 * them is the difference between a check and a guess.
 */
export async function hasStoredPayloadOnDst(
  dstClient: ReadClient,
  dstEndpoint: Address,
  srcV1ChainId: number,
  pathOnDst: Hex,
): Promise<boolean | undefined> {
  try {
    return await dstClient.readContract({
      address: dstEndpoint,
      abi: endpointV1Abi,
      functionName: 'hasStoredPayload',
      args: [srcV1ChainId, pathOnDst],
    })
  } catch {
    return undefined
  }
}

/** The destination contract's path for us — the bytes `hasStoredPayload` needs. */
export async function pathOnDestination(dstClient: ReadClient, remote: Address, srcV1ChainId: number): Promise<Hex | undefined> {
  try {
    const p = await dstClient.readContract({ address: remote, abi: lzAppAbi, functionName: 'trustedRemoteLookup', args: [srcV1ChainId] })
    return p && p !== '0x' ? p : undefined
  } catch {
    return undefined
  }
}
