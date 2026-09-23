/**
 * Wormhole NTT, verbatim from wormhole-foundation/native-token-transfers.
 *
 * `TransferSent` exists in two shapes, and BOTH are live on mainnet:
 *
 *   v1.x (evm/src/interfaces/INttManager.sol @ v1.0.0+evm, v1.1.0+evm)
 *     event TransferSent(bytes32 recipient, bytes32 refundAddress, uint256 amount,
 *                        uint256 fee, uint16 recipientChain, uint64 msgSequence);
 *   v2+  (evm/src/interfaces/INttManager.sol @ main) — the first two became indexed, and a
 *     digest-only overload was added:
 *     event TransferSent(bytes32 indexed recipient, bytes32 indexed refundAddress, …);
 *     event TransferSent(bytes32 indexed digest);
 *
 * Indexing does not change a signature, so v1 and v2 share topic0 and differ only in how many
 * topics a log carries. Decoding therefore picks the variant by topic count — guessing wrong is
 * how a real NTT transfer gets mistaken for a plain Wormhole message.
 */
import { encodeEventTopics, parseAbi, type Hex } from 'viem'

/** v1.x: nothing indexed — all six values live in the log's data. */
export const nttTransferSentV1Abi = parseAbi([
  'event TransferSent(bytes32 recipient, bytes32 refundAddress, uint256 amount, uint256 fee, uint16 recipientChain, uint64 msgSequence)',
])

/** v2+: recipient and refundAddress are topics. */
export const nttTransferSentV2Abi = parseAbi([
  'event TransferSent(bytes32 indexed recipient, bytes32 indexed refundAddress, uint256 amount, uint256 fee, uint16 recipientChain, uint64 msgSequence)',
])

/** v2+ only: the digest-only overload. */
export const nttTransferSentDigestAbi = parseAbi(['event TransferSent(bytes32 indexed digest)'])

export const nttRedeemedAbi = parseAbi(['event TransferRedeemed(bytes32 indexed digest)'])

/**
 * NttManager reads and the single write. Signatures from the contracts that declare them:
 *   token, chainId, getMode, getThreshold, quoteDeliveryPrice   evm/src/interfaces/IManagerBase.sol
 *   getPeer, NttManagerPeer, transfer                           evm/src/interfaces/INttManager.sol
 *   getCurrentOutboundCapacity, getCurrentInboundCapacity       evm/src/interfaces/IRateLimiter.sol
 *   getTransceivers                                             evm/src/NttManager/TransceiverRegistry.sol
 */
export const nttManagerAbi = parseAbi([
  'struct NttManagerPeer { bytes32 peerAddress; uint8 tokenDecimals; }',

  'function token() view returns (address)',
  'function chainId() view returns (uint16)',
  'function getMode() view returns (uint8)',
  'function getThreshold() view returns (uint8)',
  'function getPeer(uint16 chainId_) view returns (NttManagerPeer)',
  'function tokenDecimals() view returns (uint8)',
  'function getCurrentOutboundCapacity() view returns (uint256)',
  'function getCurrentInboundCapacity(uint16 chainId_) view returns (uint256)',
  'function getTransceivers() view returns (address[])',
  'function quoteDeliveryPrice(uint16 recipientChain, bytes transceiverInstructions) view returns (uint256[], uint256)',

  // The only state-changing call this protocol module may make. shouldQueue is always false:
  // a transfer over the rate limit must revert, never sit in a queue the user cannot see.
  'function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient, bytes32 refundAddress, bool shouldQueue, bytes transceiverInstructions) payable returns (uint64)',
])

/**
 * Transceiver reads.
 *   getTransceiverType, getNttManagerToken   evm/src/interfaces/ITransceiver.sol
 *   encodeWormholeTransceiverInstruction,
 *   WormholeTransceiverInstruction           evm/src/interfaces/IWormholeTransceiver.sol
 *   wormhole, isWormholeRelayingEnabled,
 *   isSpecialRelayingEnabled, getWormholePeer
 *                                            evm/src/Transceiver/WormholeTransceiver/
 *                                            WormholeTransceiverState.sol (v1.1.0+evm — the shape
 *                                            deployed on mainnet; newer builds may drop the
 *                                            relaying getters, which we treat as "cannot confirm")
 */
export const wormholeTransceiverAbi = parseAbi([
  'struct WormholeTransceiverInstruction { bool shouldSkipRelayerSend; }',

  'function getTransceiverType() view returns (string)',
  'function getNttManagerToken() view returns (address)',
  'function wormhole() view returns (address)',
  'function getWormholePeer(uint16 chainId_) view returns (bytes32)',
  'function isWormholeRelayingEnabled(uint16 chainId_) view returns (bool)',
  'function isSpecialRelayingEnabled(uint16 chainId_) view returns (bool)',
  'function encodeWormholeTransceiverInstruction(WormholeTransceiverInstruction instruction) pure returns (bytes)',
])

/** The transceiver type string the official Wormhole transceiver reports. */
export const WORMHOLE_TRANSCEIVER_TYPE = 'wormhole'

/**
 * The token-side anchor (§the manager must be named by the TOKEN, not only name the token).
 * `minter()` is what the reference NTT token exposes; AccessControl tokens answer
 * `hasRole(MINTER_ROLE, manager)` instead, with the role read from the token itself.
 */
export const nttTokenAnchorAbi = parseAbi([
  'function minter() view returns (address)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
])

const topic0 = (abi: readonly unknown[], eventName: string): Hex => {
  const [t] = encodeEventTopics({ abi: abi as Parameters<typeof encodeEventTopics>[0]['abi'], eventName })
  if (!t) throw new Error(`no topic0 for ${eventName}`)
  return t
}

export const NTT_TOPICS = Object.freeze({
  /** The same hash for v1 and v2 — only the topic count tells them apart. */
  TransferSentDetailed: topic0(nttTransferSentV1Abi, 'TransferSent'),
  TransferSentDigest: topic0(nttTransferSentDigestAbi, 'TransferSent'),
  TransferRedeemed: topic0(nttRedeemedAbi, 'TransferRedeemed'),
})

/** Number of topics a log carries for each shape: topic0 plus the indexed parameters. */
export const NTT_TOPIC_COUNT = Object.freeze({ v1: 1, v2: 3, digest: 2 })

/** The `mode` an NttManager reports: 0 = LOCKING, 1 = BURNING (INttManager.Mode). */
export type NttMode = 'locking' | 'burning'
export function nttMode(raw: number): NttMode | undefined {
  return raw === 0 ? 'locking' : raw === 1 ? 'burning' : undefined
}
