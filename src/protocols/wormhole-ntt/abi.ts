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

/** Reads used to describe an NTT manager found in a transaction. */
export const nttManagerAbi = parseAbi([
  'function token() view returns (address)',
  'function getMode() view returns (uint8)',
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
