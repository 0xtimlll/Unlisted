/**
 * §5: the signatures the Status / Rescue tab reads and, for four of them, submits.
 *
 * Sources, all read rather than recalled:
 *   Endpoint (v1)        LayerZero-Labs/LayerZero, contracts/Endpoint.sol
 *                        — `StoredPayload{payloadLength,dstAddress,payloadHash}`, the
 *                          `storedPayload` mapping, `retryPayload`, and the `PayloadStored` /
 *                          `PayloadCleared` / `UaForceResumeReceive` events
 *   UltraLightNodeV2     same repo, contracts/UltraLightNodeV2.sol — `Packet(bytes payload)`,
 *                        `RelayerParams(bytes adapterParams, uint16 outboundProofType)`
 *   NonblockingLzApp     LayerZero-Labs/solidity-examples, contracts/lzApp/NonblockingLzApp.sol
 *                        — `failedMessages`, `retryMessage`, `MessageFailed`
 *   EndpointV2           LayerZero-Labs/LayerZero-v2, protocol/contracts/interfaces/
 *                        {ILayerZeroEndpointV2,IMessagingChannel}.sol — `lzReceive`, `verifiable`,
 *                        `inboundPayloadHash`, `lazyInboundNonce`
 *   ReceiveUln302        same repo, messagelib/contracts/uln/uln302/ReceiveUln302.sol —
 *                        `commitVerification(bytes packetHeader, bytes32 payloadHash)`
 *   ReceiveUlnBase       same directory — `verifiable(UlnConfig, bytes32, bytes32)`, `hashLookup`
 *
 * The four writable entries are the whole of §5's action whitelist. Every one of them takes a
 * payload that this app must have read from an on-chain event and hashed against the contract's own
 * record first; none of them moves a token, and all of them are submitted with `msg.value` 0.
 */
import { parseAbi } from 'viem'

/** Endpoint V1: the stuck-payload side of a v1 rescue. */
export const endpointV1RescueAbi = parseAbi([
  'struct StoredPayload { uint64 payloadLength; address dstAddress; bytes32 payloadHash; }',
  'function storedPayload(uint16 _srcChainId, bytes _srcAddress) view returns (uint64 payloadLength, address dstAddress, bytes32 payloadHash)',
  'function hasStoredPayload(uint16 _srcChainId, bytes _srcAddress) view returns (bool)',
  'function getInboundNonce(uint16 _srcChainId, bytes _srcAddress) view returns (uint64)',
  'function retryPayload(uint16 _srcChainId, bytes _srcAddress, bytes _payload)',
  'event PayloadStored(uint16 srcChainId, bytes srcAddress, address dstAddress, uint64 nonce, bytes payload, bytes reason)',
  'event PayloadCleared(uint16 srcChainId, bytes srcAddress, uint64 nonce, address dstAddress)',
  'event UaForceResumeReceive(uint16 chainId, bytes srcAddress)',
])

/** UltraLightNodeV2: where a v1 packet and its adapter params are published on the source. */
export const ulnRescueAbi = parseAbi([
  'event Packet(bytes payload)',
  'event RelayerParams(bytes adapterParams, uint16 outboundProofType)',
])

/** NonblockingLzApp: the app-level side of a v1 rescue. */
export const lzAppRescueAbi = parseAbi([
  'function failedMessages(uint16 _srcChainId, bytes _srcAddress, uint64 _nonce) view returns (bytes32)',
  'function retryMessage(uint16 _srcChainId, bytes _srcAddress, uint64 _nonce, bytes _payload) payable',
  'event MessageFailed(uint16 _srcChainId, bytes _srcAddress, uint64 _nonce, bytes _payload, bytes _reason)',
  'event RetryMessageSuccess(uint16 _srcChainId, bytes _srcAddress, uint64 _nonce, bytes32 _payloadHash)',
  'function owner() view returns (address)',
])

/** EndpointV2: the executable side of a V2 rescue. */
export const endpointV2RescueAbi = parseAbi([
  'struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }',
  'function lzReceive(Origin _origin, address _receiver, bytes32 _guid, bytes _message, bytes _extraData) payable',
  'function verifiable(Origin _origin, address _receiver) view returns (bool)',
  'function initializable(Origin _origin, address _receiver) view returns (bool)',
  'function inboundPayloadHash(address _receiver, uint32 _srcEid, bytes32 _sender, uint64 _nonce) view returns (bytes32)',
  'function lazyInboundNonce(address _receiver, uint32 _srcEid, bytes32 _sender) view returns (uint64)',
  'function inboundNonce(address _receiver, uint32 _srcEid, bytes32 _sender) view returns (uint64)',
  'function getReceiveLibrary(address _receiver, uint32 _eid) view returns (address lib, bool isDefault)',
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
  'event PacketVerified(Origin origin, address receiver, bytes32 payloadHash)',
  'event PacketDelivered(Origin origin, address receiver)',
])

/** ReceiveUln302: the commit step between the DVNs signing and the endpoint being able to execute. */
export const receiveUlnRescueAbi = parseAbi([
  'struct UlnConfig { uint64 confirmations; uint8 requiredDVNCount; uint8 optionalDVNCount; uint8 optionalDVNThreshold; address[] requiredDVNs; address[] optionalDVNs; }',
  'struct Verification { bool submitted; uint64 confirmations; }',
  'function commitVerification(bytes _packetHeader, bytes32 _payloadHash)',
  'function verifiable(UlnConfig _config, bytes32 _headerHash, bytes32 _payloadHash) view returns (bool)',
  'function getUlnConfig(address _oapp, uint32 _remoteEid) view returns (UlnConfig)',
  'function hashLookup(bytes32 _headerHash, bytes32 _payloadHash, address _dvn) view returns (bool submitted, uint64 confirmations)',
])

/**
 * §5's action whitelist, as names. `scripts/check-whitelist.mjs` allows exactly these four inside
 * this module and nowhere else, and the module is separately held to `msg.value` 0.
 */
export const RESCUE_WRITES = ['retryPayload', 'retryMessage', 'commitVerification', 'lzReceive'] as const
export type RescueWrite = (typeof RESCUE_WRITES)[number]
