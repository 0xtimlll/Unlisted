/**
 * Constant ABIs (§3). These are the ONLY signatures the app knows about.
 * Never fetch ABIs from explorers or external APIs.
 */
import { parseAbi } from 'viem'

/** LayerZero V2 OFT / OFTAdapter. */
export const oftAbi = parseAbi([
  'struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }',
  'struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }',
  'struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }',
  'struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }',
  'struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }',
  'struct OFTFeeDetail { int256 feeAmountLD; string description; }',

  'function send(SendParam sendParam, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt msgReceipt, OFTReceipt oftReceipt)',
  'function quoteSend(SendParam sendParam, bool payInLzToken) view returns (MessagingFee fee)',
  'function quoteOFT(SendParam sendParam) view returns (OFTLimit oftLimit, OFTFeeDetail[] oftFeeDetails, OFTReceipt receipt)',

  'function token() view returns (address)',
  'function approvalRequired() view returns (bool)',
  'function sharedDecimals() view returns (uint8)',
  'function decimalConversionRate() view returns (uint256)',
  'function oftVersion() view returns (bytes4 interfaceId, uint64 version)',
  'function peers(uint32 eid) view returns (bytes32)',
  'function endpoint() view returns (address)',
  'function owner() view returns (address)',
  'function enforcedOptions(uint32 eid, uint16 msgType) view returns (bytes)',
])

/** Minimal ERC-20. */
export const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
])

/**
 * The only state-changing functions this app may ever submit (§3, §11).
 * Enforced by scripts/check-whitelist.mjs.
 */
export const WRITE_WHITELIST = ['approve', 'send'] as const
export type WriteFunction = (typeof WRITE_WHITELIST)[number]

/** LayerZero message type for `enforcedOptions(eid, msgType)`: SEND = 1. */
export const MSG_TYPE_SEND = 1
