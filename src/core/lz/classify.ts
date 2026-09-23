/**
 * §Task 1.10: what is this address, really?
 *
 * probeOft() already refuses anything that does not answer like an OFT V2. This adds the two
 * answers the user actually needs when it refuses:
 *   - "a LayerZero app, but not an OFT" — the endpoint knows it, so bridging it here is impossible
 *     and the project's own site is the only way;
 *   - the implementation behind an EIP-1967 proxy, so the code being trusted can be looked at.
 */
import { getAddress, parseAbi, type Address, type Hex } from 'viem'
import { oftAbi } from '../abi'
import type { ReadClient } from '../client'
import { probeOft, ProbeError, type ProbeResult } from '../probe'

/** IOAppCore (LayerZero-v2, oapp/contracts/oapp/interfaces/IOAppCore.sol). */
const oappAbi = parseAbi([
  'function oAppVersion() view returns (uint64 senderVersion, uint64 receiverVersion)',
  'function endpoint() view returns (address)',
])

/** EIP-1967 implementation and beacon slots. */
export const IMPL_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const BEACON_SLOT: Hex = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const ZERO_SLOT = `0x${'0'.repeat(64)}`

export type LzClassification =
  | { kind: 'oft'; probe: ProbeResult; implementation?: Address }
  /** Answers oAppVersion()/endpoint() but not the OFT interface. */
  | { kind: 'oapp_not_oft'; endpoint: Address; implementation?: Address }
  /** A contract, but nothing to do with LayerZero. */
  | { kind: 'not_lz'; reason: string }
  | { kind: 'not_contract' }

/** The implementation address behind an EIP-1967 proxy, when there is one. */
export async function proxyImplementation(client: ReadClient, address: Address): Promise<Address | undefined> {
  try {
    const [impl, beacon] = await Promise.all([
      client.getStorageAt({ address, slot: IMPL_SLOT }),
      client.getStorageAt({ address, slot: BEACON_SLOT }),
    ])
    const slot = impl && impl !== ZERO_SLOT ? impl : beacon && beacon !== ZERO_SLOT ? beacon : undefined
    if (!slot) return undefined
    const hex = slot.slice(2).slice(24)
    const candidate = getAddress(`0x${hex}`)
    return candidate === '0x0000000000000000000000000000000000000000' ? undefined : candidate
  } catch {
    return undefined
  }
}

export async function classifyLzAddress(client: ReadClient, address: string, eids?: readonly number[]): Promise<LzClassification> {
  let probe: ProbeResult
  try {
    probe = eids ? await probeOft(client, address, eids) : await probeOft(client, address)
  } catch (e) {
    if (e instanceof ProbeError && e.code === 'not_contract') return { kind: 'not_contract' }
    if (!(e instanceof ProbeError)) throw e
    // Not an OFT. Is it a LayerZero app at all?
    const addr = getAddress(address)
    const [endpoint, implementation] = await Promise.all([lzEndpointOf(client, addr), proxyImplementation(client, addr)])
    if (endpoint) return { kind: 'oapp_not_oft', endpoint, ...(implementation ? { implementation } : {}) }
    return { kind: 'not_lz', reason: e.code }
  }
  const implementation = await proxyImplementation(client, probe.info.oft)
  return { kind: 'oft', probe, ...(implementation ? { implementation } : {}) }
}

/**
 * The endpoint a LayerZero app names, or undefined. Both oAppVersion() and endpoint() are asked:
 * some OApps predate one of them, and a contract answering either with a real endpoint address is
 * a LayerZero app by any useful definition.
 */
async function lzEndpointOf(client: ReadClient, address: Address): Promise<Address | undefined> {
  const [version, endpoint] = await Promise.all([
    client.readContract({ address, abi: oappAbi, functionName: 'oAppVersion' }).then(
      () => true,
      () => false,
    ),
    client.readContract({ address, abi: oftAbi, functionName: 'endpoint' }).then(
      (a) => a,
      () => undefined,
    ),
  ])
  if (!endpoint || endpoint === '0x0000000000000000000000000000000000000000') return undefined
  // An endpoint address that is not a contract proves nothing.
  const code = await client.getCode({ address: endpoint }).catch(() => undefined)
  if (!code || code === '0x') return undefined
  void version
  return getAddress(endpoint)
}
