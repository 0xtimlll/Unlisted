/**
 * LayerZero **v1** (Endpoint V1) signatures, verbatim from the protocol's own contracts.
 *
 * Sources — LayerZero-Labs/solidity-examples, `main`:
 *   IOFTCore            contracts/token/oft/v1/interfaces/IOFTCore.sol
 *   OFTCore             contracts/token/oft/v1/OFTCore.sol          (useCustomAdapterParams)
 *   OFT / ProxyOFT      contracts/token/oft/v1/{OFT,ProxyOFT}.sol
 *   NativeOFT           contracts/token/oft/v1/NativeOFT.sol        (deposit/withdraw)
 *   ICommonOFT/IOFTV2   contracts/token/oft/v2/interfaces/{ICommonOFT,IOFTV2}.sol
 *   OFTCoreV2           contracts/token/oft/v2/OFTCoreV2.sol        (sharedDecimals)
 *   IOFTWithFee / Fee   contracts/token/oft/v2/fee/{IOFTWithFee,Fee}.sol
 *   LzApp               contracts/lzApp/LzApp.sol                   (trustedRemote, minDstGas)
 * and LayerZero-Labs/LayerZero, `main`:
 *   ILayerZeroEndpoint  contracts/interfaces/ILayerZeroEndpoint.sol
 *
 * Nothing here is a hand-written 4-byte value: selectors are derived from these signatures by
 * viem, so a typo changes a selector and fails a test instead of quietly matching the wrong
 * function. That matters more here than in V2, because the three v1 `sendFrom`s differ only in
 * one parameter and the wrong one would put an amount where a recipient belongs.
 */
import { parseAbi, toFunctionSelector, type AbiFunction, type Hex } from 'viem'

/**
 * The wire shape of a v1 `sendFrom`. This — not the marketing name — is what decides how the
 * destination reads the recipient, so it is what the self-check is written against.
 *
 *   bytes        OFT / ProxyOFT          `_toAddress` is `bytes`, and the destination reads the
 *                                        FIRST 20 bytes of it (BytesLib.toAddress(payload, 0)).
 *   bytes32      OFTV2 / ProxyOFTV2      `_toAddress` is `bytes32`, left-padded; the destination
 *                                        takes the LAST 20 bytes.
 *   bytes32_fee  OFTWithFee / Proxy…     the same bytes32, plus a `_minAmount` the contract
 *                                        enforces after taking its own fee.
 */
export type V1Wire = 'bytes' | 'bytes32' | 'bytes32_fee'

/** Whether the contract is the token itself or an adapter holding someone else's token. */
export type V1Kind = 'OFT' | 'Proxy'

export type V1Standard = { wire: V1Wire; kind: V1Kind }

/** IOFTCore — the original OFT. `_toAddress` is `bytes`. */
export const oftV1Abi = parseAbi([
  'function estimateSendFee(uint16 _dstChainId, bytes _toAddress, uint256 _amount, bool _useZro, bytes _adapterParams) view returns (uint256 nativeFee, uint256 zroFee)',
  'function sendFrom(address _from, uint16 _dstChainId, bytes _toAddress, uint256 _amount, address _refundAddress, address _zroPaymentAddress, bytes _adapterParams) payable',
  'function circulatingSupply() view returns (uint256)',
  'function token() view returns (address)',
])

/** ICommonOFT + IOFTV2 — "OFT V1.2", the bytes32 form that still talks to Endpoint V1. */
export const oftV2OnV1Abi = parseAbi([
  'struct LzCallParams { address refundAddress; address zroPaymentAddress; bytes adapterParams; }',
  'function estimateSendFee(uint16 _dstChainId, bytes32 _toAddress, uint256 _amount, bool _useZro, bytes _adapterParams) view returns (uint256 nativeFee, uint256 zroFee)',
  'function sendFrom(address _from, uint16 _dstChainId, bytes32 _toAddress, uint256 _amount, LzCallParams _callParams) payable',
  'function sharedDecimals() view returns (uint8)',
  'function circulatingSupply() view returns (uint256)',
  'function token() view returns (address)',
])

/**
 * IOFTWithFee — the same bytes32 recipient with two differences that both touch money: the
 * contract takes a fee of its own (`quoteOFTFee`), and `sendFrom` carries a `_minAmount` it
 * enforces afterwards. Different parameter list, therefore a different selector.
 */
export const oftWithFeeAbi = parseAbi([
  'struct LzCallParams { address refundAddress; address zroPaymentAddress; bytes adapterParams; }',
  'function estimateSendFee(uint16 _dstChainId, bytes32 _toAddress, uint256 _amount, bool _useZro, bytes _adapterParams) view returns (uint256 nativeFee, uint256 zroFee)',
  'function sendFrom(address _from, uint16 _dstChainId, bytes32 _toAddress, uint256 _amount, uint256 _minAmount, LzCallParams _callParams) payable',
  'function quoteOFTFee(uint16 _dstChainId, uint256 _amount) view returns (uint256 fee)',
  'function sharedDecimals() view returns (uint8)',
  'function token() view returns (address)',
])

/** LzApp + OFTCore: everything about routing and adapter params that is readable. */
export const lzAppAbi = parseAbi([
  'function lzEndpoint() view returns (address)',
  'function trustedRemoteLookup(uint16 _remoteChainId) view returns (bytes)',
  'function getTrustedRemoteAddress(uint16 _remoteChainId) view returns (bytes)',
  'function minDstGasLookup(uint16 _dstChainId, uint16 _type) view returns (uint256)',
  'function payloadSizeLimitLookup(uint16 _dstChainId) view returns (uint256)',
  'function useCustomAdapterParams() view returns (bool)',
  'function owner() view returns (address)',
])

/** ILayerZeroEndpoint (v1). Only the reads this app needs; nothing here is ever submitted. */
export const endpointV1Abi = parseAbi([
  'function getChainId() view returns (uint16)',
  'function hasStoredPayload(uint16 _srcChainId, bytes _srcAddress) view returns (bool)',
  'function estimateFees(uint16 _dstChainId, address _userApplication, bytes _payload, bool _payInZRO, bytes _adapterParam) view returns (uint256 nativeFee, uint256 zroFee)',
  'function getInboundNonce(uint16 _srcChainId, bytes _srcAddress) view returns (uint64)',
  'function getOutboundNonce(uint16 _dstChainId, address _srcAddress) view returns (uint64)',
  'function getSendVersion(address _userApplication) view returns (uint16)',
  'function getReceiveVersion(address _userApplication) view returns (uint16)',
  'function getConfig(uint16 _version, uint16 _chainId, address _userApplication, uint256 _configType) view returns (bytes)',
])

/**
 * UltraLightNodeV2 (LayerZero-Labs/LayerZero, contracts/UltraLightNodeV2.sol).
 *
 * `localChainId` is the only authority on a chain's v1 id: `send` builds the packet as
 * `abi.encodePacked(nonce, localChainId, ua, dstChainId, dstAddress, payload)`, so this is the
 * number every destination sees as the source. Read-only, and used only to verify the committed
 * table against the chain.
 */
export const ulnV2Abi = parseAbi(['function localChainId() view returns (uint16)'])

/** NativeOFT's two extra functions. Used only to recognise it, never to call it. */
export const nativeOftAbi = parseAbi(['function deposit() payable', 'function withdraw(uint256 _amount)'])

/** `_type` in `minDstGasLookup(dstChainId, type)`: PT_SEND is 0 in both OFTCore and OFTCoreV2. */
export const PT_SEND = 0

/** The one function this module may ever submit. Held to it by scripts/check-whitelist.mjs. */
export const V1_WRITE = 'sendFrom' as const

/** The selector of a parsed ABI's `sendFrom`, computed from the entry parseAbi produced. */
function sendFromSelector(abi: readonly unknown[]): Hex {
  const item = abi.find((f): f is AbiFunction => {
    const x = f as AbiFunction
    return x?.type === 'function' && x.name === 'sendFrom'
  })
  if (!item) throw new Error('lz-v1: abi has no sendFrom')
  return toFunctionSelector(item)
}

/**
 * selector → wire shape, computed from the signatures above.
 *
 * The self-check refuses calldata whose selector is not the one its detected standard owns. Two
 * of these differ by a single `uint256` in the middle of the argument list, so a mix-up would
 * read `_minAmount` as part of the recipient — hence a table, and hence a table that is derived
 * rather than typed.
 */
export const SEND_FROM_SELECTOR: Readonly<Record<V1Wire, Hex>> = Object.freeze({
  bytes: sendFromSelector(oftV1Abi),
  bytes32: sendFromSelector(oftV2OnV1Abi),
  bytes32_fee: sendFromSelector(oftWithFeeAbi),
})

/** The reverse lookup, for saying what a foreign selector actually is. */
export const WIRE_OF_SELECTOR: ReadonlyMap<Hex, V1Wire> = new Map(
  (Object.entries(SEND_FROM_SELECTOR) as [V1Wire, Hex][]).map(([w, s]) => [s.toLowerCase() as Hex, w]),
)

/** The ABI that describes a given wire shape's `sendFrom`. */
export function abiOfWire(wire: V1Wire) {
  return wire === 'bytes' ? oftV1Abi : wire === 'bytes32' ? oftV2OnV1Abi : oftWithFeeAbi
}

/** "LayerZero v1 · OFTV2 · Proxy" — what the review screen prints. */
export function standardLabel(s: V1Standard): string {
  const wire = s.wire === 'bytes' ? 'OFT' : s.wire === 'bytes32' ? 'OFTV2' : 'OFTWithFee'
  return s.kind === 'Proxy' ? `LayerZero v1 · ${wire} · Proxy` : `LayerZero v1 · ${wire}`
}
