/**
 * Chainlink CCIP, verbatim from smartcontractkit/ccip.
 *
 * Two generations of on-ramp are live, and they emit different events:
 *   v1.5  EVM2EVMOnRamp.CCIPSendRequested(Internal.EVM2EVMMessage)
 *         contracts/src/v0.8/ccip/onRamp/EVM2EVMOnRamp.sol (release/contracts-ccip-1.5.0)
 *   v1.6  OnRamp.CCIPMessageSent(uint64 indexed, uint64 indexed, Internal.EVM2AnyRampMessage)
 *         contracts/src/v0.8/ccip/onRamp/OnRamp.sol
 * Structs: contracts/src/v0.8/ccip/libraries/Internal.sol and .../Client.sol
 *
 * The v1.5 event carries no destination selector — the on-ramp it was emitted by is what fixes the
 * destination — so a v1.5 transfer is reported with an unknown destination rather than a guess.
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

export type CcipEventName = 'CCIPMessageSent' | 'CCIPSendRequested'

export function ccipTopic(name: CcipEventName): Hex {
  const [topic] = encodeEventTopics({ abi: ccipEventsAbi, eventName: name })
  if (!topic) throw new Error(`no topic0 for ${name}`)
  return topic
}

export const CCIP_TOPICS: Readonly<Record<CcipEventName, Hex>> = Object.freeze({
  CCIPMessageSent: ccipTopic('CCIPMessageSent'),
  CCIPSendRequested: ccipTopic('CCIPSendRequested'),
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
 * `bytes4(keccak256("CCIP EVMExtraArgsV2"))` — cross-checked against @noble/hashes, not copied.
 * The newer releases rename the struct to GenericExtraArgsV2; the tag is the same.
 */
export const EVM_EXTRA_ARGS_V2_TAG: Hex = '0x181dcf10'
