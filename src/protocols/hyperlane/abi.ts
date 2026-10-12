/**
 * Hyperlane, verbatim from hyperlane-xyz/hyperlane-monorepo (solidity/contracts).
 *
 * Three generations of warp route are live on the chains served here, and they do not answer the
 * same questions — every optional read below is tried and a refusal is an answer, never a failure:
 *
 *   core 5.x   TokenRouter has `transferRemote(uint32,bytes32,uint256)`, `quoteGasPayment(uint32)`
 *              (GasRouter.sol), `routers(uint32)`, `domains()`, `mailbox()`; a collateral route
 *              answers `wrappedToken()`, a synthetic one is the ERC-20 itself, a native one is
 *              neither. No scaling, no fee recipient.
 *   core 7.x   FungibleTokenRouter adds `scale()`: the amount is multiplied by it on the way out
 *              and divided by it on the way in (token/libs/FungibleTokenRouter.sol, tag
 *              @hyperlane-xyz/core@7.1.0).
 *   core 10+   TokenRouter adds `token()` (the ERC-20, address(this) for synthetic, address(0)
 *              for native), `quoteTransferRemote(uint32,bytes32,uint256)` returning three
 *              Quotes — [0] the mailbox dispatch fee, [1] the amount plus the route's own fee,
 *              [2] an external fee — and `feeRecipient()`; 12+ replaces `scale()` with
 *              `scaleNumerator()` / `scaleDenominator()` and adds `feeToken()` / `feeHook()`
 *              (token/libs/TokenRouter.sol on main).
 *
 * The one state-changing call, `transferRemote(uint32 destination, bytes32 recipient, uint256
 * amount)`, has the same signature in all three (selector 0x81b4e8b4, computed from the signature,
 * not copied). The five-argument overload with hook metadata is never used here.
 *
 * Message layout (libs/Message.sol):  version u8 | nonce u32 | origin u32 | sender b32 |
 * destination u32 | recipient b32 | body — the id is keccak256 of the whole thing. A warp route's
 * body (token/libs/TokenMessage.sol) is  recipient b32 | amount u256 | metadata.
 */
import { encodeEventTopics, getAddress, keccak256, parseAbi, size, slice, type Address, type Hex } from 'viem'

export const mailboxAbi = parseAbi([
  'function localDomain() view returns (uint32)',
  'function VERSION() view returns (uint8)',
  'function nonce() view returns (uint32)',
  'function delivered(bytes32 messageId) view returns (bool)',
  'function processedAt(bytes32 messageId) view returns (uint48)',
])

export const mailboxEventsAbi = parseAbi([
  'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
  'event DispatchId(bytes32 indexed messageId)',
  'event Process(uint32 indexed origin, bytes32 indexed sender, address indexed recipient)',
  'event ProcessId(bytes32 indexed messageId)',
])

/** Every read a warp route may answer, across the three generations, plus the one write. */
export const warpRouteAbi = parseAbi([
  'struct Quote { address token; uint256 amount; }',
  // MailboxClient / Router / GasRouter — every generation.
  'function mailbox() view returns (address)',
  'function localDomain() view returns (uint32)',
  'function domains() view returns (uint32[])',
  'function routers(uint32 domain) view returns (bytes32)',
  'function destinationGas(uint32 domain) view returns (uint256)',
  'function hook() view returns (address)',
  'function interchainSecurityModule() view returns (address)',
  'function owner() view returns (address)',
  'function quoteGasPayment(uint32 destinationDomain) view returns (uint256)',
  // HypERC20Collateral and its relatives.
  'function wrappedToken() view returns (address)',
  // core 7.x
  'function scale() view returns (uint256)',
  // core 10+
  'function token() view returns (address)',
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) view returns (Quote[])',
  'function feeRecipient() view returns (address)',
  'function PACKAGE_VERSION() view returns (string)',
  // core 12+
  'function scaleNumerator() view returns (uint256)',
  'function scaleDenominator() view returns (uint256)',
  'function feeToken() view returns (address)',
  // The only state-changing call this module makes.
  'function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32 messageId)',
])

export const warpRouteEventsAbi = parseAbi([
  'event SentTransferRemote(uint32 indexed destination, bytes32 indexed recipient, uint256 amount)',
  'event ReceivedTransferRemote(uint32 indexed origin, bytes32 indexed recipient, uint256 amount)',
])

export type HyperlaneEventName = 'Dispatch' | 'DispatchId' | 'Process' | 'ProcessId' | 'SentTransferRemote'

function topicOf(abi: readonly unknown[], eventName: string): Hex {
  const [topic] = encodeEventTopics({ abi: abi as Parameters<typeof encodeEventTopics>[0]['abi'], eventName } as Parameters<typeof encodeEventTopics>[0])
  if (!topic) throw new Error(`no topic0 for ${eventName}`)
  return topic
}

export const HYPERLANE_TOPICS: Readonly<Record<HyperlaneEventName, Hex>> = Object.freeze({
  Dispatch: topicOf(mailboxEventsAbi, 'Dispatch'),
  DispatchId: topicOf(mailboxEventsAbi, 'DispatchId'),
  Process: topicOf(mailboxEventsAbi, 'Process'),
  ProcessId: topicOf(mailboxEventsAbi, 'ProcessId'),
  SentTransferRemote: topicOf(warpRouteEventsAbi, 'SentTransferRemote'),
})

// ---------------------------------------------------------------- messages ----

/** The header every Mailbox message carries (libs/Message.sol), 77 bytes before the body. */
export const MESSAGE_HEADER_BYTES = 77
/** The Mailbox version this app knows how to read; every mailbox in chains.ts answers it. */
export const MAILBOX_VERSION = 3

export type HyperlaneMessage = {
  version: number
  nonce: number
  origin: number
  /** bytes32, as written: an EVM sender is left-padded. */
  sender: Hex
  destination: number
  recipient: Hex
  body: Hex
  /** keccak256 of the whole message — what the Mailbox calls the message id. */
  id: Hex
}

const u32 = (bytes: Hex, offset: number): number => Number(BigInt(slice(bytes, offset, offset + 4)))

/**
 * Reads a raw Mailbox message. Throws on anything shorter than the header: the fields would be
 * read off the wrong offsets, and a wrong destination is worse than no destination.
 */
export function parseHyperlaneMessage(raw: Hex): HyperlaneMessage {
  if (size(raw) < MESSAGE_HEADER_BYTES) throw new Error(`Hyperlane message is ${size(raw)} bytes, shorter than its ${MESSAGE_HEADER_BYTES}-byte header`)
  return {
    version: Number(BigInt(slice(raw, 0, 1))),
    nonce: u32(raw, 1),
    origin: u32(raw, 5),
    sender: slice(raw, 9, 41),
    destination: u32(raw, 41),
    recipient: slice(raw, 45, 77),
    body: size(raw) === MESSAGE_HEADER_BYTES ? '0x' : slice(raw, 77),
    id: keccak256(raw),
  }
}

export type TokenMessage = { recipient: Hex; amount: bigint; metadata: Hex }

/** A warp route's body: recipient (bytes32), amount (uint256), then whatever metadata follows. */
export function parseTokenMessage(body: Hex): TokenMessage | undefined {
  if (size(body) < 64) return undefined
  return {
    recipient: slice(body, 0, 32),
    amount: BigInt(slice(body, 32, 64)),
    metadata: size(body) === 64 ? '0x' : slice(body, 64),
  }
}

/** A left-padded EVM address, or undefined when the upper 12 bytes are not zero (TypeCasts.sol). */
export function bytes32ToEvmAddress(b: Hex): Address | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(b)) return undefined
  if (!/^0x0{24}/.test(b)) return undefined
  return getAddress(`0x${b.slice(26)}`)
}

/** The bytes32 a warp route expects for an EVM recipient: the address, left-padded (TypeCasts.sol). */
export function evmAddressToBytes32(address: Address): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as Hex
}
