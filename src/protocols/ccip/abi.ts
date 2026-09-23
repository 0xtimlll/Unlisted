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
