import type { Address, Hex } from 'viem'
import type { SvmSourceInfo } from './svm/source'

export type OftKind = 'OFT' | 'OFTAdapter'

/** Result of probeOft() (§5.1). Everything here comes from the contract itself. */
export type OftInfo = {
  vm: 'evm'
  oft: Address
  kind: OftKind
  /** ERC-20 whose balanceOf/allowance we read. Equals `oft` for plain OFT. */
  token: Address
  symbol: string
  name: string
  decimals: number
  sharedDecimals: number
  conversionRate: bigint
  /** ONLY from the contract; never derived. */
  approvalRequired: boolean
  endpoint: Address
  owner?: Address
  /**
   * Destinations with peers(eid) != 0, across the chain registry. `peer` is the raw bytes32 from
   * the contract: an EVM address left-padded to 32 bytes, or a Solana OFT Store pubkey where all
   * 32 bytes matter. Use peerToAddress() for display on EVM destinations only.
   */
  routes: { eid: number; peer: Hex }[]
  /** enforcedOptions(eid, 1) per destination eid. */
  enforced: Record<number, Hex>
  /** For lock/unlock adapters (approvalRequired): token.balanceOf(oft) — what the bridge holds. */
  lockedInAdapter?: bigint
}

/** The OFT chosen as the source, on either VM. Shared fields (symbol, decimals, routes, enforced…) are read alike. */
export type SourceInfo = OftInfo | SvmSourceInfo

/** Soft warnings (§6.16). Shown before signing, never block. */
export type SuspiciousFlag =
  | 'owner_is_eoa'
  | 'behind_proxy'
  | 'not_verified'
  | 'adapter_empty'
  | 'not_cross_checked'
  | 'svm_recipient_not_activated'
  | 'svm_paused'
  | 'svm_source_paused'
  | 'svm_fee'
  | 'svm_single_provider'
