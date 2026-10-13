import type { Address, Hex } from 'viem'
import type { SvmSourceInfo } from './svm/source'

/**
 * `NativeOFTAdapter` (LayerZero devtools, packages/oft-evm/contracts/NativeOFTAdapter.sol) is the
 * lockbox for a chain's own coin: `token()` answers the zero address, `approvalRequired()` is
 * false, and `send` takes the amount out of `msg.value` next to the fee — exactly
 * `fee.nativeFee + removeDust(amountLD)`, or it reverts with IncorrectMessageValue.
 */
export type OftKind = 'OFT' | 'OFTAdapter' | 'NativeOFTAdapter'

/** Result of probeOft() (§5.1). Everything here comes from the contract itself. */
export type OftInfo = {
  vm: 'evm'
  oft: Address
  kind: OftKind
  /**
   * ERC-20 whose balanceOf/allowance we read. Equals `oft` for plain OFT. The ZERO address for a
   * NativeOFTAdapter, where there is no ERC-20 at all: the balance is the wallet's coin balance,
   * and nothing is ever approved.
   */
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

/** True for the one shape whose amount travels in msg.value rather than through an ERC-20. */
export function isNativeAdapter(info: SourceInfo | undefined): boolean {
  return info?.vm === 'evm' && info.kind === 'NativeOFTAdapter'
}

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
  /** The peer account exists but is neither official store layout. Warns; never blocks. */
  | 'svm_store_unrecognised'
  /** The same, plus LayerZero Scan confirming this very path has already delivered. */
  | 'svm_store_unrecognised_delivered'
  /**
   * §6.16 The contract's OWN enforced options, decoded. Unlike `extraOptions` these are appended
   * by the OFT on every send and paid for by the sender, so they are the half of the options an
   * attacker controls. Surfaced, never blocking — see core/options.ts inspectEnforcedOptions().
   */
  | 'enforced_native_drop'
  | 'enforced_compose'
  | 'enforced_over_cap'
  | 'enforced_malformed'
  /** The token's symbol or name mixes scripts that can impersonate ASCII (Cyrillic "\u0410" for "A"). */
  | 'label_lookalike'
