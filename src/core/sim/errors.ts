/**
 * §Task 4: the custom errors a bridge transaction can revert with, quoted from the contracts that
 * declare them, plus what each one means for the person trying to send.
 *
 * Sources:
 *   InvalidLocalDecimals, SlippageExceeded   LayerZero-v2 oapp/contracts/oft/interfaces/IOFT.sol
 *   NoPeer, OnlyPeer, InvalidEndpointCall,
 *   InvalidDelegate                          LayerZero-v2 oapp/contracts/oapp/interfaces/IOAppCore.sol
 *   NotEnoughNative, LzTokenUnavailable      LayerZero-v2 oapp/contracts/oapp/OAppSender.sol
 *   LZ_*                                     LayerZero-v2 protocol/contracts/libs/Errors.sol
 *   LZ_ULN_*                                 LayerZero-v2 messagelib/contracts/uln/UlnBase.sol
 *   ERC20*                                   OpenZeppelin contracts/interfaces/IERC6093.sol
 *   EnforcedPause, ExpectedPause             OpenZeppelin contracts/utils/Pausable.sol
 *   Ownable*                                 OpenZeppelin contracts/access/Ownable.sol
 *   Ntt*                                     native-token-transfers evm/src/interfaces/INttManager.sol
 *   Ccip*                                    ccip contracts/src/v0.8/ccip/interfaces/IRouterClient.sol
 */
import { parseAbi } from 'viem'

/** What a revert means for the user. The dictionary turns each into a sentence and an action. */
export type RevertMeaning =
  | 'no_peer'
  | 'slippage'
  | 'needs_approve'
  | 'insufficient_balance'
  | 'paused'
  | 'fee_too_low'
  | 'config_missing'
  | 'unsupported_chain'
  | 'rate_limit'
  | 'dust'
  | 'not_owner'
  | 'generic'

export const knownErrorsAbi = parseAbi([
  // --- LayerZero OFT / OApp ---------------------------------------------------
  'error InvalidLocalDecimals()',
  'error SlippageExceeded(uint256 amountLD, uint256 minAmountLD)',
  'error NoPeer(uint32 eid)',
  'error OnlyPeer(uint32 eid, bytes32 sender)',
  'error InvalidEndpointCall()',
  'error InvalidDelegate()',
  'error NotEnoughNative(uint256 msgValue)',
  'error LzTokenUnavailable()',

  // --- LayerZero EndpointV2 ---------------------------------------------------
  'error LZ_LzTokenUnavailable()',
  'error LZ_InvalidReceiveLibrary()',
  'error LZ_InvalidNonce(uint64 nonce)',
  'error LZ_InvalidArgument()',
  'error LZ_InvalidExpiry()',
  'error LZ_InvalidAmount(uint256 required, uint256 supplied)',
  'error LZ_OnlyRegisteredOrDefaultLib()',
  'error LZ_OnlyRegisteredLib()',
  'error LZ_OnlyNonDefaultLib()',
  'error LZ_Unauthorized()',
  'error LZ_DefaultSendLibUnavailable()',
  'error LZ_DefaultReceiveLibUnavailable()',
  'error LZ_PathNotInitializable()',
  'error LZ_PathNotVerifiable()',
  'error LZ_OnlySendLib()',
  'error LZ_OnlyReceiveLib()',
  'error LZ_UnsupportedEid()',
  'error LZ_UnsupportedInterface()',
  'error LZ_AlreadyRegistered()',
  'error LZ_SameValue()',
  'error LZ_InvalidPayloadHash()',
  'error LZ_PayloadHashNotFound(bytes32 expected, bytes32 actual)',
  'error LZ_ComposeNotFound(bytes32 expected, bytes32 actual)',
  'error LZ_ComposeExists()',
  'error LZ_SendReentrancy()',
  'error LZ_NotImplemented()',
  'error LZ_InsufficientFee(uint256 requiredNative, uint256 suppliedNative, uint256 requiredLzToken, uint256 suppliedLzToken)',
  'error LZ_ZeroLzTokenFee()',

  // --- LayerZero ULN (send library) -------------------------------------------
  'error LZ_ULN_Unsorted()',
  'error LZ_ULN_InvalidRequiredDVNCount()',
  'error LZ_ULN_InvalidOptionalDVNCount()',
  'error LZ_ULN_AtLeastOneDVN()',
  'error LZ_ULN_InvalidOptionalDVNThreshold()',
  'error LZ_ULN_InvalidConfirmations()',
  'error LZ_ULN_UnsupportedEid(uint32 eid)',

  // --- OpenZeppelin v5 ---------------------------------------------------------
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidSender(address sender)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InvalidApprover(address approver)',
  'error ERC20InvalidSpender(address spender)',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error OwnableUnauthorizedAccount(address account)',
  'error OwnableInvalidOwner(address owner)',

  // --- Wormhole NTT -------------------------------------------------------------
  'error TransferAmountHasDust(uint256 amount, uint256 dust)',
  'error InvalidMode(uint8 mode)',
  'error InvalidTargetChain(uint16 targetChain, uint16 thisChain)',
  'error ZeroAmount()',
  'error InvalidRecipient()',
  'error InvalidRefundAddress()',
  'error BurnAmountDifferentThanBalanceDiff(uint256 burnAmount, uint256 balanceDiff)',
  'error InvalidPeer(uint16 chainId, bytes32 peerAddress)',
  'error InvalidPeerChainIdZero()',
  'error InvalidPeerZeroAddress()',
  'error InvalidPeerDecimals()',
  'error InvalidPeerSameChainId()',
  'error CancellerNotSender(address canceller, address sender)',
  'error UnexpectedMsgValue()',

  // --- Chainlink CCIP -----------------------------------------------------------
  'error UnsupportedDestinationChain(uint64 destChainSelector)',
  'error InsufficientFeeTokenAmount()',
  'error InvalidMsgValue()',
])

/**
 * What each error tells the user to do. Anything not listed still decodes — it is simply shown by
 * name, which is far better than a hex selector.
 */
export const ERROR_MEANING: Readonly<Record<string, RevertMeaning>> = Object.freeze({
  NoPeer: 'no_peer',
  OnlyPeer: 'config_missing',
  SlippageExceeded: 'slippage',
  NotEnoughNative: 'fee_too_low',
  LZ_InsufficientFee: 'fee_too_low',
  LZ_InvalidAmount: 'fee_too_low',
  LZ_UnsupportedEid: 'unsupported_chain',
  LZ_ULN_UnsupportedEid: 'unsupported_chain',
  LZ_DefaultSendLibUnavailable: 'config_missing',
  LZ_DefaultReceiveLibUnavailable: 'config_missing',
  LZ_PathNotInitializable: 'config_missing',
  LZ_PathNotVerifiable: 'config_missing',
  LZ_ULN_AtLeastOneDVN: 'config_missing',
  LZ_ULN_InvalidRequiredDVNCount: 'config_missing',
  LZ_ULN_InvalidConfirmations: 'config_missing',

  ERC20InsufficientAllowance: 'needs_approve',
  ERC20InsufficientBalance: 'insufficient_balance',
  EnforcedPause: 'paused',
  OwnableUnauthorizedAccount: 'not_owner',

  TransferAmountHasDust: 'dust',
  InvalidTargetChain: 'unsupported_chain',
  InvalidPeer: 'config_missing',
  InvalidPeerChainIdZero: 'config_missing',
  InvalidPeerZeroAddress: 'config_missing',
  InvalidRecipient: 'generic',

  UnsupportedDestinationChain: 'unsupported_chain',
  InsufficientFeeTokenAmount: 'fee_too_low',
})

export function meaningOf(errorName: string): RevertMeaning {
  return ERROR_MEANING[errorName] ?? 'generic'
}
