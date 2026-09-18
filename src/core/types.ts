import type { Address, Hex } from 'viem'

export type OftKind = 'OFT' | 'OFTAdapter'

/** Result of probeOft() (§5.1). Everything here comes from the contract itself. */
export type OftInfo = {
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
  /** Destinations with peers(eid) != 0, across the chain registry. */
  routes: { eid: number; peer: Address }[]
  /** enforcedOptions(eid, 1) per destination eid. */
  enforced: Record<number, Hex>
}

/** Soft warnings (§6.16). Shown before signing, never block. */
export type SuspiciousFlag = 'owner_is_eoa' | 'behind_proxy' | 'not_verified'
