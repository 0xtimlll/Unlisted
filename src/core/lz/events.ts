/**
 * LayerZero V2 events, verbatim from the protocol's own contracts. Topic hashes are never written
 * down here — they are derived from these signatures by viem, so a typo in a signature changes the
 * topic and fails the golden test rather than silently matching nothing.
 *
 * Sources (LayerZero-Labs/LayerZero-v2, packages/layerzero-v2/evm):
 *   OFTSent, OFTReceived            oapp/contracts/oft/interfaces/IOFT.sol
 *   PacketSent, PacketDelivered,
 *   PacketVerified, Origin          protocol/contracts/interfaces/ILayerZeroEndpointV2.sol
 *   getSendLibrary, getConfig       protocol/contracts/interfaces/IMessageLibManager.sol
 *   UlnConfig, getUlnConfig         messagelib/contracts/uln/UlnBase.sol
 */
import { encodeEventTopics, parseAbi, type Hex } from 'viem'

export const lzEventsAbi = parseAbi([
  'struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }',

  // OFT, source side.
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  // OFT, destination side.
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',

  // EndpointV2, source side: carries the whole packet, so it works even without OFTSent.
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
  // EndpointV2, destination side.
  'event PacketVerified(Origin origin, address receiver, bytes32 payloadHash)',
  'event PacketDelivered(Origin origin, address receiver)',
])

/** Reads used to describe how a project configured its send path (informational only). */
export const lzConfigAbi = parseAbi([
  'struct UlnConfig { uint64 confirmations; uint8 requiredDVNCount; uint8 optionalDVNCount; uint8 optionalDVNThreshold; address[] requiredDVNs; address[] optionalDVNs; }',
  'function getSendLibrary(address _sender, uint32 _eid) view returns (address lib)',
  'function getUlnConfig(address _oapp, uint32 _remoteEid) view returns (UlnConfig)',
])

export type LzEventName = 'OFTSent' | 'OFTReceived' | 'PacketSent' | 'PacketVerified' | 'PacketDelivered'

/** topic0 of a LayerZero event, computed from the signature above. */
export function lzTopic(name: LzEventName): Hex {
  const [topic] = encodeEventTopics({ abi: lzEventsAbi, eventName: name })
  if (!topic) throw new Error(`no topic0 for ${name}`)
  return topic
}

/** All LayerZero topics, by name — built once. */
export const LZ_TOPICS: Readonly<Record<LzEventName, Hex>> = Object.freeze({
  OFTSent: lzTopic('OFTSent'),
  OFTReceived: lzTopic('OFTReceived'),
  PacketSent: lzTopic('PacketSent'),
  PacketVerified: lzTopic('PacketVerified'),
  PacketDelivered: lzTopic('PacketDelivered'),
})
