/**
 * §Task 2: bridges we recognise but will never build a transaction for. Knowing them is what lets
 * the app say "this is Axelar, bridge it there" instead of "not an OFT".
 *
 * Detection here is by event topic, derived from signatures quoted from each project's own
 * contracts. A topic can be emitted by anyone, so this is evidence for an explanation, never for
 * an approval: nothing in this file can enable a signature.
 *
 * Event sources:
 *   LogMessagePublished    wormhole-foundation/wormhole, ethereum/contracts/Implementation.sol
 *   ContractCall,
 *   ContractCallWithToken  axelarnetwork/axelar-cgp-solidity, contracts/interfaces/IAxelarGateway.sol
 *   InterchainTransfer     axelarnetwork/interchain-token-service,
 *                          contracts/interfaces/IInterchainTokenService.sol
 *   DepositForBurn         circlefin/evm-cctp-contracts, src/TokenMessenger.sol
 *   Dispatch               hyperlane-xyz/hyperlane-monorepo, solidity/contracts/interfaces/IMailbox.sol
 *
 * Link sources (each names the URL in the project's own documentation):
 *   Portal Bridge      wormhole.com/docs/products/token-transfers/wrapped-token-transfers/overview/
 *   Axelar ITS portal  docs.axelar.dev/dev/send-tokens/interchain-tokens/intro/
 *   CCTP               circle.com/cross-chain-transfer-protocol
 *   Hyperlane Explorer explorer.hyperlane.xyz
 */
import { encodeEventTopics, parseAbi, type Hex } from 'viem'
import type { ChainKey } from '../chains'
import type { ForeignProtocolId } from './result'

export const foreignEventsAbi = parseAbi([
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
  'event ContractCall(address indexed sender, string destinationChain, string destinationContractAddress, bytes32 indexed payloadHash, bytes payload)',
  'event ContractCallWithToken(address indexed sender, string destinationChain, string destinationContractAddress, bytes32 indexed payloadHash, bytes payload, string symbol, uint256 amount)',
  'event InterchainTransfer(bytes32 indexed tokenId, address indexed sourceAddress, string destinationChain, bytes destinationAddress, uint256 amount, bytes32 indexed dataHash)',
  'event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)',
  'event Dispatch(address indexed sender, uint32 indexed destination, bytes32 indexed recipient, bytes message)',
])

export type ForeignEventName = 'LogMessagePublished' | 'ContractCall' | 'ContractCallWithToken' | 'InterchainTransfer' | 'DepositForBurn' | 'Dispatch'

export function foreignTopic(name: ForeignEventName): Hex {
  const [topic] = encodeEventTopics({ abi: foreignEventsAbi, eventName: name })
  if (!topic) throw new Error(`no topic0 for ${name}`)
  return topic
}

export const FOREIGN_TOPICS: Readonly<Record<ForeignEventName, Hex>> = Object.freeze({
  LogMessagePublished: foreignTopic('LogMessagePublished'),
  ContractCall: foreignTopic('ContractCall'),
  ContractCallWithToken: foreignTopic('ContractCallWithToken'),
  InterchainTransfer: foreignTopic('InterchainTransfer'),
  DepositForBurn: foreignTopic('DepositForBurn'),
  Dispatch: foreignTopic('Dispatch'),
})

/** Where the user should go instead. Absent when no official UI could be confirmed. */
export const FOREIGN_LINK: Readonly<Partial<Record<ForeignProtocolId, string>>> = Object.freeze({
  'wormhole-portal': 'https://portalbridge.com/',
  'axelar-its': 'https://interchain.axelar.dev/',
  cctp: 'https://www.circle.com/cross-chain-transfer-protocol',
  hyperlane: 'https://explorer.hyperlane.xyz',
  // 'axelar' (plain gateway calls) and 'wormhole-other' have no single user-facing app: the
  // application that sent the message owns the flow, so we name the protocol and stop there.
})

/**
 * Canonical bridge contracts of the networks we support, as their own documentation lists them.
 * Used to recognise "this went through the network's own bridge" — the app links the address on
 * that chain's explorer rather than to an unverified bridge front-end.
 *
 * Sources:
 *   0x4200…0010 / 0x4200…0007  ethereum-optimism/specs, specs/protocol/predeploys.md
 *                              (identical on every OP Stack chain: Optimism and Base here)
 *   Arbitrum gateways/routers  docs.arbitrum.io/build-decentralized-apps/reference/contract-addresses
 *   Linea message service      docs.linea.build/network/build/contracts
 *   Scroll messenger/routers   docs.scroll.io/en/developers/scroll-contracts/
 *   OP Mainnet L1 bridge       ethereum-optimism/superchain-registry, configs/mainnet/op.toml
 *   Polygon ERC20Predicate     docs.polygon.technology/pos/reference/contracts/genesis-contracts/
 *
 * TODO(stage 2+): Base's L1StandardBridge (its superchain-registry path moved) and Polygon's
 * RootChainManager are not confirmed yet, so no address is claimed for them.
 */
export const NATIVE_BRIDGES: Partial<Record<ChainKey, { address: string; label: string }[]>> = {
  ethereum: [
    { address: '0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1', label: 'OP Mainnet L1StandardBridge' },
    { address: '0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef', label: 'Arbitrum L1GatewayRouter' },
    { address: '0xa3A7B6F88361F48403514059F1F16C8E78d60EeC', label: 'Arbitrum L1ERC20Gateway' },
    { address: '0xd19d4B5d358258f05D7B411E21A1460D11B0876F', label: 'Linea Rollup / L1 Message Service' },
    { address: '0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319', label: 'Linea L1 Token Bridge' },
    { address: '0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367', label: 'Scroll L1 Messenger' },
    { address: '0xF8B1378579659D8F7EE5f3C929c2f3E332E41Fd6', label: 'Scroll L1 Gateway Router' },
    { address: '0x158d5fa3ef8e4dda8a5367decf76b94e7effce95', label: 'Polygon PoS ERC20Predicate' },
  ],
  optimism: [
    { address: '0x4200000000000000000000000000000000000010', label: 'L2StandardBridge' },
    { address: '0x4200000000000000000000000000000000000007', label: 'L2CrossDomainMessenger' },
  ],
  base: [
    { address: '0x4200000000000000000000000000000000000010', label: 'L2StandardBridge' },
    { address: '0x4200000000000000000000000000000000000007', label: 'L2CrossDomainMessenger' },
  ],
  arbitrum: [
    { address: '0x5288c571Fd7aD117beA99bF60FE0846C4E84F933', label: 'L2GatewayRouter' },
    { address: '0x09e9222E96E7B4AE2a407B98d48e330053351EEe', label: 'L2ERC20Gateway' },
  ],
  linea: [
    { address: '0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec', label: 'L2 Message Service' },
    { address: '0x353012dc4a9A6cF55c941bADC267f82004A8ceB9', label: 'L2 Token Bridge' },
  ],
  scroll: [
    { address: '0x781e90f1c8Fc4611c9b7497C3B47F99Ef6969CbC', label: 'L2 Scroll Messenger' },
    { address: '0x4C0926FF5252A435FD19e10ED15e5a249Ba19d79', label: 'L2 Gateway Router' },
  ],
}

/** The canonical bridge at this address on this chain, or undefined. */
export function nativeBridgeAt(chain: ChainKey, address: string): string | undefined {
  const a = address.toLowerCase()
  return NATIVE_BRIDGES[chain]?.find((b) => b.address.toLowerCase() === a)?.label
}
