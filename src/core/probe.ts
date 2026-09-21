/**
 * probeOft (§5.1): everything we know about an OFT comes from the contract itself,
 * in one multicall. Contracts that do not answer like an OFT are rejected.
 */
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { erc20Abi, MSG_TYPE_SEND, oftAbi } from './abi'
import { ALL_EIDS } from './chains'
import type { ReadClient } from './client'
import { isZeroBytes32, sameAddress } from './encoding'
import type { OftInfo, SuspiciousFlag } from './types'

export type ProbeErrorCode = 'invalid_address' | 'not_contract' | 'not_oft' | 'token_unreadable' | 'rate_mismatch' | 'rpc_mismatch'

export class ProbeError extends Error {
  constructor(
    public readonly code: ProbeErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ProbeError'
  }
}

export type ProbeResult = { info: OftInfo; flags: SuspiciousFlag[] }

/** EIP-1967 implementation / beacon slots. */
const IMPL_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const BEACON_SLOT: Hex = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const ZERO_SLOT = `0x${'0'.repeat(64)}`

/** Chain text is rendered as text only, trimmed to 32 chars, no control characters (§7). */
export function sanitizeLabel(s: unknown, max = 32): string {
  if (typeof s !== 'string') return ''
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max)
}

export async function probeOft(
  client: ReadClient,
  address: string,
  eids: readonly number[] = ALL_EIDS,
): Promise<ProbeResult> {
  if (!isAddress(address, { strict: false })) throw new ProbeError('invalid_address')
  const oft = getAddress(address)

  const code = await client.getCode({ address: oft })
  if (!code || code === '0x') throw new ProbeError('not_contract')

  const base = { address: oft, abi: oftAbi } as const
  const [fixedRes, peerRes, enforcedRes] = await Promise.all([
    client.multicall({
      contracts: [
        { ...base, functionName: 'token' },
        { ...base, functionName: 'approvalRequired' },
        { ...base, functionName: 'sharedDecimals' },
        { ...base, functionName: 'decimalConversionRate' },
        { ...base, functionName: 'endpoint' },
        { ...base, functionName: 'owner' },
        { ...base, functionName: 'oftVersion' },
      ],
      allowFailure: true,
    }),
    client.multicall({
      contracts: eids.map((eid) => ({ ...base, functionName: 'peers', args: [eid] }) as const),
      allowFailure: true,
    }),
    client.multicall({
      contracts: eids.map((eid) => ({ ...base, functionName: 'enforcedOptions', args: [eid, MSG_TYPE_SEND] }) as const),
      allowFailure: true,
    }),
  ])
  const [rToken, rApproval, rShared, rRate, rEndpoint, rOwner, rVersion] = fixedRes

  // Anything an OFT V2 must answer; a revert on any of these means "not an OFT".
  const must = <T,>(r: { status: 'success'; result: T } | { status: 'failure'; error: Error } | undefined, what: string): T => {
    if (!r || r.status !== 'success') throw new ProbeError('not_oft', `${what}() failed — not an OFT V2`)
    return r.result
  }
  for (const p of peerRes) must(p, 'peers')

  const token = getAddress(must(rToken, 'token'))
  const kind = sameAddress(token, oft) ? 'OFT' : 'OFTAdapter'
  const approvalRequired = must(rApproval, 'approvalRequired')
  const sharedDecimals = Number(must(rShared, 'sharedDecimals'))
  const conversionRate = must(rRate, 'decimalConversionRate')
  const endpoint = getAddress(must(rEndpoint, 'endpoint'))
  const owner = rOwner?.status === 'success' ? getAddress(rOwner.result) : undefined
  void rVersion // informational only

  // ERC-20 metadata from the token (== oft for plain OFT), plus what the adapter holds.
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
  if (!mDec || mDec.status !== 'success') throw new ProbeError('token_unreadable', 'token.decimals() failed')
  const decimals = Number(mDec.result)
  const symbol = sanitizeLabel(mSym?.status === 'success' ? mSym.result : '')
  const name = sanitizeLabel(mName?.status === 'success' ? mName.result : '')

  // OFT defines rate = 10^(decimals - sharedDecimals). Anything else is not an OFT we understand.
  if (decimals < sharedDecimals || conversionRate !== 10n ** BigInt(decimals - sharedDecimals)) {
    throw new ProbeError('rate_mismatch', `rate ${conversionRate} != 10^(${decimals}-${sharedDecimals})`)
  }

  const routes: OftInfo['routes'] = []
  const enforced: Record<number, Hex> = {}
  eids.forEach((eid, i) => {
    const p = peerRes[i]
    // Keep the raw bytes32: an EVM peer is a padded address, a Solana peer is a 32-byte pubkey.
    if (p?.status === 'success' && !isZeroBytes32(p.result)) routes.push({ eid, peer: p.result })
    const e = enforcedRes[i]
    enforced[eid] = e?.status === 'success' ? e.result : '0x'
  })

  const flags = await suspiciousFlags(client, oft, owner)
  // A lock/unlock adapter that holds nothing has never bridged anything — or is not the real one.
  const lockedInAdapter = kind === 'OFTAdapter' && approvalRequired && mLocked?.status === 'success' ? mLocked.result : undefined
  if (lockedInAdapter === 0n) flags.push('adapter_empty')

  return {
    info: {
      vm: 'evm',
      oft, kind, token, symbol, name, decimals, sharedDecimals, conversionRate,
      approvalRequired, endpoint, ...(owner ? { owner } : {}), routes, enforced,
      ...(lockedInAdapter !== undefined ? { lockedInAdapter } : {}),
    },
    flags,
  }
}

/** §6.16: yellow flags. Never block. Errors here are swallowed — flags are best-effort. */
export async function suspiciousFlags(client: ReadClient, oft: Address, owner: Address | undefined): Promise<SuspiciousFlag[]> {
  const flags: SuspiciousFlag[] = []
  try {
    const [impl, beacon] = await Promise.all([
      client.getStorageAt({ address: oft, slot: IMPL_SLOT }),
      client.getStorageAt({ address: oft, slot: BEACON_SLOT }),
    ])
    if ((impl && impl !== ZERO_SLOT) || (beacon && beacon !== ZERO_SLOT)) flags.push('behind_proxy')
  } catch {
    /* best-effort */
  }
  if (owner) {
    try {
      const c = await client.getCode({ address: owner })
      if (!c || c === '0x') flags.push('owner_is_eoa')
    } catch {
      /* best-effort */
    }
  }
  return flags
}
