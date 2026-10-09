/**
 * Chainlink CCIP, verbatim from smartcontractkit/ccip.
 *
 * Two generations of on-ramp are live, and they emit different events:
 *   v1.5  EVM2EVMOnRamp.CCIPSendRequested(Internal.EVM2EVMMessage)
 *         contracts/src/v0.8/ccip/onRamp/EVM2EVMOnRamp.sol (release/contracts-ccip-1.5.0)
 *   v1.6  OnRamp.CCIPMessageSent(uint64 indexed, uint64 indexed, Internal.EVM2AnyRampMessage)
 *         contracts/src/v0.8/ccip/onRamp/OnRamp.sol
 *   2.0   OnRamp.CCIPMessageSent(uint64 indexed, address indexed, bytes32 indexed, address, uint256,
 *         bytes, Receipt[], bytes[]) — smartcontractkit/chainlink-ccip,
 *         chains/evm/contracts/onRamp/OnRamp.sol ("OnRamp 2.0.0"), the verifier-based generation.
 *         Robinhood Chain runs this one; the topic was confirmed against a real send there.
 * Structs: contracts/src/v0.8/ccip/libraries/Internal.sol and .../Client.sol
 *
 * The v1.5 event carries no destination selector — the on-ramp it was emitted by is what fixes the
 * destination — so a v1.5 transfer is reported with an unknown destination rather than a guess.
 *
 * What each generation says about the TOKEN is not the same thing, which is why findings carry it
 * with a label rather than as a bare address:
 *   v1.5  names the token itself
 *   v1.6  names the source POOL (`sourcePoolAddress`), never the token
 *   2.0   names neither — the transfer lives inside `encodedMessage`, in MessageV1 encoding this
 *         app does not implement, so a 2.0 send is reported without any transfer at all rather
 *         than with a guess pulled out of the other logs.
 */
import { encodeEventTopics, parseAbi, type Hex } from 'viem'

export const ccipEventsAbi = parseAbi([
  'struct EVMTokenAmount { address token; uint256 amount; }',
  'struct RampMessageHeader { bytes32 messageId; uint64 sourceChainSelector; uint64 destChainSelector; uint64 sequenceNumber; uint64 nonce; }',
  'struct EVM2AnyTokenTransfer { address sourcePoolAddress; bytes destTokenAddress; bytes extraData; uint256 amount; bytes destExecData; }',
  'struct EVM2AnyRampMessage { RampMessageHeader header; address sender; bytes data; bytes receiver; bytes extraArgs; address feeToken; uint256 feeTokenAmount; uint256 feeValueJuels; EVM2AnyTokenTransfer[] tokenAmounts; }',
  'struct EVM2EVMMessage { uint64 sourceChainSelector; address sender; address receiver; uint64 sequenceNumber; uint256 gasLimit; bool strict; uint64 nonce; address feeToken; uint256 feeTokenAmount; bytes data; EVMTokenAmount[] tokenAmounts; bytes[] sourceTokenData; bytes32 messageId; }',

  'event CCIPMessageSent(uint64 indexed destChainSelector, uint64 indexed sequenceNumber, EVM2AnyRampMessage message)',
  'event CCIPSendRequested(EVM2EVMMessage message)',
])

/**
 * The 2.0 on-ramp's event carries the SAME NAME with a different shape, and an event's name is
 * part of the signature it is hashed from — so it cannot be aliased into the ABI above without
 * changing the topic it computes to. It gets its own ABI instead, under its real name.
 */
export const ccipRamp2EventsAbi = parseAbi([
  'struct Receipt { address issuer; uint32 destGasLimit; uint32 destBytesOverhead; uint256 feeTokenAmount; bytes extraArgs; }',
  'event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, Receipt[] receipts, bytes[] verifierBlobs)',
])

export type CcipEventName = 'CCIPMessageSent' | 'CCIPSendRequested' | 'CCIPMessageSentRamp2'

export function ccipTopic(name: 'CCIPMessageSent' | 'CCIPSendRequested'): Hex {
  const [topic] = encodeEventTopics({ abi: ccipEventsAbi, eventName: name })
  if (!topic) throw new Error(`no topic0 for ${name}`)
  return topic
}

function ramp2Topic(): Hex {
  const [topic] = encodeEventTopics({ abi: ccipRamp2EventsAbi, eventName: 'CCIPMessageSent' })
  if (!topic) throw new Error('no topic0 for the 2.0 CCIPMessageSent')
  return topic
}

export const CCIP_TOPICS: Readonly<Record<CcipEventName, Hex>> = Object.freeze({
  CCIPMessageSent: ccipTopic('CCIPMessageSent'),
  CCIPSendRequested: ccipTopic('CCIPSendRequested'),
  CCIPMessageSentRamp2: ramp2Topic(),
})

/**
 * The contracts this module reads and the single call it sends.
 *
 * Sources (smartcontractkit/ccip, contracts/src/v0.8/ccip):
 *   EVM2AnyMessage, EVMTokenAmount,
 *   EVMExtraArgsV2, EVM_EXTRA_ARGS_V2_TAG   libraries/Client.sol
 *   ccipSend, getFee, isChainSupported      interfaces/IRouterClient.sol
 *   getPool, getTokenConfig, TokenConfig    tokenAdminRegistry/TokenAdminRegistry.sol
 *   pool reads                              pools/TokenPool.sol
 *   TokenBucket                             libraries/RateLimiter.sol
 */
export const ccipRouterAbi = parseAbi([
  'struct EVMTokenAmount { address token; uint256 amount; }',
  'struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',

  'function isChainSupported(uint64 destChainSelector) view returns (bool supported)',
  'function getFee(uint64 destinationChainSelector, EVM2AnyMessage message) view returns (uint256 fee)',
  // The only state-changing call this module makes.
  'function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)',
])

export const tokenAdminRegistryAbi = parseAbi([
  'struct TokenConfig { address administrator; address pendingAdministrator; address tokenPool; }',
  'function getPool(address token) view returns (address)',
  'function getTokenConfig(address token) view returns (TokenConfig)',
])

export const tokenPoolAbi = parseAbi([
  'struct TokenBucket { uint128 tokens; uint32 lastUpdated; bool isEnabled; uint128 capacity; uint128 rate; }',
  'function getToken() view returns (address)',
  'function getTokenDecimals() view returns (uint8)',
  'function getRouter() view returns (address)',
  'function isSupportedChain(uint64 remoteChainSelector) view returns (bool)',
  'function getSupportedChains() view returns (uint64[])',
  'function getRemoteToken(uint64 remoteChainSelector) view returns (bytes)',
  'function getRemotePools(uint64 remoteChainSelector) view returns (bytes[])',
  'function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector) view returns (TokenBucket)',
  'function getCurrentInboundRateLimiterState(uint64 remoteChainSelector) view returns (TokenBucket)',
])

/**
 * Status reads (the Status tab). All view; none moves a token. Sources:
 *   getOnRamp, getOffRamps, OffRamp   Router.sol — the same in release/contracts-ccip-1.5.0 of
 *                                     smartcontractkit/ccip and in chains/evm/contracts/Router.sol of
 *                                     smartcontractkit/chainlink-ccip (tag contracts-ccip-v1.6.0 and
 *                                     main); every deployed router answers typeAndVersion "Router 1.2.0"
 *   typeAndVersion                    shared/interfaces/ITypeAndVersion.sol, implemented by every ramp —
 *                                     how the destination's off-ramp generation is told apart
 */
export const ccipRouterRampsAbi = parseAbi([
  'struct OffRamp { uint64 sourceChainSelector; address offRamp; }',
  'function getOnRamp(uint64 destChainSelector) view returns (address)',
  'function getOffRamps() view returns (OffRamp[])',
])

export const typeAndVersionAbi = parseAbi(['function typeAndVersion() view returns (string)'])

/**
 * Three off-ramp generations, one per on-ramp generation above, each keyed differently:
 *   1.5  EVM2EVMOffRamp: one lane per contract, state by sequence number; `getStaticConfig().onRamp`
 *        names the on-ramp it serves           offRamp/EVM2EVMOffRamp.sol (release/contracts-ccip-1.5.0)
 *   1.6  OffRamp: every source chain in one contract, state by (sourceChainSelector, sequenceNumber);
 *        `getSourceChainConfig(src).onRamp` is the abi-encoded on-ramp
 *                                              chains/evm/contracts/offRamp/OffRamp.sol (contracts-ccip-v1.6.0)
 *   2.0  OffRamp: state by messageId; `getSourceChainConfig(src).onRamps` lists the allowed on-ramps,
 *        "for EVM source chains … abi-encoded (32 bytes)"
 *                                              chains/evm/contracts/offRamp/OffRamp.sol (main, "OffRamp 2.0.0")
 * `Internal.MessageExecutionState` has the same four members in all three releases' Internal.sol:
 * UNTOUCHED, IN_PROGRESS, SUCCESS, FAILURE — an enum is a uint8 on the wire.
 */
export const ccipOffRamp15Abi = parseAbi([
  'struct StaticConfig { address commitStore; uint64 chainSelector; uint64 sourceChainSelector; address onRamp; address prevOffRamp; address rmnProxy; address tokenAdminRegistry; }',
  'function getExecutionState(uint64 sequenceNumber) view returns (uint8)',
  'function getStaticConfig() view returns (StaticConfig)',
])

export const ccipOffRamp16Abi = parseAbi([
  'struct SourceChainConfig { address router; bool isEnabled; uint64 minSeqNr; bool isRMNVerificationDisabled; bytes onRamp; }',
  'function getExecutionState(uint64 sourceChainSelector, uint64 sequenceNumber) view returns (uint8)',
  'function getSourceChainConfig(uint64 sourceChainSelector) view returns (SourceChainConfig)',
])

export const ccipOffRamp20Abi = parseAbi([
  'struct SourceChainConfig { address router; bool isEnabled; bytes[] onRamps; address[] defaultCCVs; address[] laneMandatedCCVs; }',
  'function getExecutionState(bytes32 messageId) view returns (uint8)',
  'function getSourceChainConfig(uint64 sourceChainSelector) view returns (SourceChainConfig)',
])

export const CCIP_EXECUTION_STATES = ['UNTOUCHED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE'] as const
export type CcipExecutionState = (typeof CCIP_EXECUTION_STATES)[number]
export function ccipExecutionState(raw: number): CcipExecutionState | undefined {
  return CCIP_EXECUTION_STATES[raw]
}

/**
 * `bytes4(keccak256("CCIP EVMExtraArgsV2"))` — cross-checked against @noble/hashes, not copied.
 * The newer releases rename the struct to GenericExtraArgsV2; the tag is the same.
 */
export const EVM_EXTRA_ARGS_V2_TAG: Hex = '0x181dcf10'
