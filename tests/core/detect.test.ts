/**
 * The log scanner. Logs are built with viem from the same ABIs the scanner matches against, so a
 * passing test proves the signature, the topic and the decoder agree — the thing that actually
 * breaks when a signature is mistyped.
 */
import { describe, expect, it } from 'vitest'
import { getAddress, pad, type Abi, type Address, type Hex } from 'viem'
import { detectFindings, logEmitters, topSelector, type LogLike, type TxLike } from '@/core/analysis/detect'
import { foreignEventsAbi } from '@/core/analysis/foreign'
import { lzEventsAbi, LZ_TOPICS } from '@/core/lz/events'
import { decodePacket, encodePacket, PacketError, type LzPacket } from '@/core/lz/packet'
import { ccipEventsAbi, CCIP_TOPICS } from '@/protocols/ccip/abi'
import { nttTransferSentDigestAbi, nttTransferSentV1Abi, nttTransferSentV2Abi, NTT_TOPICS } from '@/protocols/wormhole-ntt/abi'
import { WORMHOLE_CHAINS } from '@/protocols/wormhole-ntt/chains'
import { makeLog } from './logs'

// Checksummed by viem, never by hand: a wrong checksum is rejected when a log is encoded.
const OFT: Address = getAddress('0xfa44c2634ff17cbe26dc3007d36bd61c79068c14')
const ENDPOINT: Address = getAddress('0x1a44076050125825900e736c501f859c50fe728c')
const WALLET: Address = getAddress('0xb264e4c4a5f1b0e9ac7b2b7b8b7b8b7b8b7be0a9')
const ROUTER: Address = getAddress('0x1111111111111111111111111111111111111111')
const GUID: Hex = `0x${'11'.repeat(32)}`
const HYPER_EID = 30367
const ETH_EID = 30101

const ev = (address: Address, abi: Abi, name: string, args: Record<string, unknown>): LogLike => makeLog(address, abi, name, args)
const tx = (logs: LogLike[], over: Partial<TxLike> = {}): TxLike => ({ from: WALLET, to: OFT, logs, ...over })

function packet(over: Partial<LzPacket> = {}): LzPacket {
  return {
    version: 1,
    nonce: 42n,
    srcEid: HYPER_EID,
    sender: pad(OFT.toLowerCase() as Address, { size: 32 }),
    dstEid: ETH_EID,
    receiver: pad('0x2222222222222222222222222222222222222222', { size: 32 }),
    guid: GUID,
    message: '0xdeadbeef',
    ...over,
  }
}

const oftSent = (at: Address = OFT) =>
  ev(at, lzEventsAbi as Abi, 'OFTSent', { guid: GUID, dstEid: ETH_EID, fromAddress: WALLET, amountSentLD: 1_000000000000000000n, amountReceivedLD: 999_000000000000000n })

const packetSent = (p: LzPacket = packet()) =>
  ev(ENDPOINT, lzEventsAbi as Abi, 'PacketSent', { encodedPayload: encodePacket(p), options: '0x', sendLibrary: ENDPOINT })

describe('PacketV1 codec', () => {
  it('round-trips every field', () => {
    const p = packet()
    expect(decodePacket(encodePacket(p))).toEqual(p)
  })

  it('round-trips a Solana-shaped sender (all 32 bytes matter)', () => {
    const p = packet({ sender: `0x${'ab'.repeat(32)}`, srcEid: 30168, message: '0x' })
    expect(decodePacket(encodePacket(p))).toEqual(p)
  })

  it('refuses anything that is not a V1 packet', () => {
    const code = (fn: () => unknown): string => {
      try {
        fn()
      } catch (e) {
        return e instanceof PacketError ? e.code : `not a PacketError: ${String(e)}`
      }
      return 'no throw'
    }
    expect(code(() => decodePacket('0xzz' as Hex))).toBe('not_hex')
    expect(code(() => decodePacket('0x1234'))).toBe('too_short')
    expect(code(() => decodePacket(`0x02${encodePacket(packet()).slice(4)}` as Hex))).toBe('bad_version')
  })
})

describe('LayerZero findings', () => {
  it('an OFT send: the emitter is the OFT, with the destination and the amounts', () => {
    const f = detectFindings(tx([oftSent(), packetSent()]), 'hyperevm')
    expect(f.map((x) => x.kind)).toEqual(['lz_oft_sent', 'lz_packet_sent'])
    expect(f[0]).toMatchObject({ kind: 'lz_oft_sent', emitter: OFT, dstEid: ETH_EID, guid: GUID, amountSentLD: 1_000000000000000000n })
  })

  it('a packet with no OFTSent still names the OApp and the route', () => {
    const f = detectFindings(tx([packetSent()], { to: ROUTER }), 'hyperevm')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ kind: 'lz_packet_sent' })
    if (f[0]?.kind !== 'lz_packet_sent') throw new Error('unreachable')
    expect(f[0].packet.srcEid).toBe(HYPER_EID)
    expect(f[0].packet.dstEid).toBe(ETH_EID)
    expect(f[0].packet.sender.toLowerCase()).toBe(pad(OFT.toLowerCase() as Address, { size: 32 }))
  })

  it('a bridge through a router is found in the logs, not in tx.to', () => {
    const f = detectFindings(tx([oftSent()], { to: ROUTER }), 'hyperevm')
    expect(f[0]).toMatchObject({ kind: 'lz_oft_sent', emitter: OFT })
  })

  it('the receiving side names the OFT on this chain and where it came from', () => {
    const received = ev(OFT, lzEventsAbi as Abi, 'OFTReceived', { guid: GUID, srcEid: HYPER_EID, toAddress: WALLET, amountReceivedLD: 5n })
    const f = detectFindings(tx([received]), 'ethereum')
    expect(f[0]).toMatchObject({ kind: 'lz_oft_received', emitter: OFT, srcEid: HYPER_EID, toAddress: WALLET })
  })

  it('two OFT sends in one transaction are both reported', () => {
    const f = detectFindings(tx([oftSent(), oftSent(ROUTER)]), 'hyperevm')
    expect(f.filter((x) => x.kind === 'lz_oft_sent')).toHaveLength(2)
  })
})

describe('other protocols', () => {
  it('tells Portal from the rest of Wormhole by the publisher', () => {
    const tokenBridge = getAddress(WORMHOLE_CHAINS.ethereum!.tokenBridge!)
    const core = getAddress(WORMHOLE_CHAINS.ethereum!.coreBridge)
    const published = (sender: Address) =>
      ev(core, foreignEventsAbi as Abi, 'LogMessagePublished', { sender, sequence: 1n, nonce: 0, payload: '0x00', consistencyLevel: 1 })

    expect(detectFindings(tx([published(tokenBridge)]), 'ethereum')[0]).toMatchObject({ kind: 'foreign', protocol: 'wormhole-portal' })
    expect(detectFindings(tx([published(ROUTER)]), 'ethereum')[0]).toMatchObject({ kind: 'foreign', protocol: 'wormhole-other' })
  })

  // Both shapes are live on mainnet and share topic0; only the topic count separates them.
  const nttArgs = { recipient: pad(WALLET, { size: 32 }), refundAddress: pad(WALLET, { size: 32 }), amount: 7n, fee: 1n, recipientChain: 30, msgSequence: 3n }

  it('an NTT transfer carries the Wormhole destination chain (v2, indexed)', () => {
    const sent = ev(ROUTER, nttTransferSentV2Abi as Abi, 'TransferSent', nttArgs)
    expect(sent.topics).toHaveLength(3)
    const f = detectFindings(tx([sent]), 'ethereum')
    expect(f[0]).toMatchObject({ kind: 'ntt_transfer', emitter: ROUTER, recipientChain: 30, destChain: 'base', amount: 7n })
  })

  it('and the v1 shape, where nothing is indexed', () => {
    const sent = ev(ROUTER, nttTransferSentV1Abi as Abi, 'TransferSent', nttArgs)
    expect(sent.topics).toHaveLength(1)
    expect(sent.topics[0]).toBe(NTT_TOPICS.TransferSentDetailed)
    const f = detectFindings(tx([sent]), 'ethereum')
    expect(f[0]).toMatchObject({ kind: 'ntt_transfer', emitter: ROUTER, recipientChain: 30, destChain: 'base', amount: 7n })
  })

  it('the digest-only NTT event is still recognised', () => {
    const sent = ev(ROUTER, nttTransferSentDigestAbi as Abi, 'TransferSent', { digest: GUID })
    expect(detectFindings(tx([sent]), 'ethereum')[0]).toMatchObject({ kind: 'ntt_transfer', digest: GUID })
  })

  it('a CCIP v1.6 send carries messageId, destination and the tokens', () => {
    const sent = ev(ROUTER, ccipEventsAbi as Abi, 'CCIPMessageSent', {
        destChainSelector: 15971525489660198786n, // Base, from selectors.yml
        sequenceNumber: 1n,
        message: {
          header: { messageId: GUID, sourceChainSelector: 5009297550715157269n, destChainSelector: 15971525489660198786n, sequenceNumber: 1n, nonce: 0n },
          sender: WALLET,
          data: '0x',
          receiver: pad(WALLET, { size: 32 }),
          extraArgs: '0x',
          feeToken: '0x0000000000000000000000000000000000000000',
          feeTokenAmount: 1n,
          feeValueJuels: 1n,
          tokenAmounts: [{ sourcePoolAddress: OFT, destTokenAddress: '0x', extraData: '0x', amount: 500n, destExecData: '0x' }],
        },
    })
    const f = detectFindings(tx([sent]), 'ethereum')
    expect(f[0]).toMatchObject({ kind: 'ccip_sent', version: '1.6', messageId: GUID, destChain: 'base' })
    if (f[0]?.kind !== 'ccip_sent') throw new Error('unreachable')
    expect(f[0].tokens).toEqual([{ token: OFT, amount: 500n }])
  })

  it('Axelar, CCTP and Hyperlane are each named', () => {
    const axelar = ev(ROUTER, foreignEventsAbi as Abi, 'ContractCallWithToken', {
      sender: WALLET, destinationChain: 'base', destinationContractAddress: '0x', payloadHash: GUID, payload: '0x', symbol: 'USDC', amount: 1n,
    })
    const cctp = ev(ROUTER, foreignEventsAbi as Abi, 'DepositForBurn', {
      nonce: 1n, burnToken: OFT, amount: 1n, depositor: WALLET, mintRecipient: pad(WALLET, { size: 32 }),
      destinationDomain: 6, destinationTokenMessenger: pad(ROUTER, { size: 32 }), destinationCaller: pad('0x0000000000000000000000000000000000000000', { size: 32 }),
    })
    const hyperlane = ev(ROUTER, foreignEventsAbi as Abi, 'Dispatch', { sender: WALLET, destination: 8453, recipient: pad(WALLET, { size: 32 }), message: '0x' })

    expect(detectFindings(tx([axelar]), 'ethereum')[0]).toMatchObject({ protocol: 'axelar' })
    expect(detectFindings(tx([cctp]), 'ethereum')[0]).toMatchObject({ protocol: 'cctp' })
    expect(detectFindings(tx([hyperlane]), 'ethereum')[0]).toMatchObject({ protocol: 'hyperlane' })
  })

  it("the network's own bridge is recognised by its documented address", () => {
    const l: LogLike = { address: '0x4200000000000000000000000000000000000010', topics: [`0x${'99'.repeat(32)}`], data: '0x' }
    expect(detectFindings(tx([l]), 'base')[0]).toMatchObject({ kind: 'foreign', protocol: 'native-bridge', label: 'L2StandardBridge' })
    // The same address on a chain that does not have that predeploy is not a bridge.
    expect(detectFindings(tx([l]), 'ethereum')).toEqual([])
  })
})

describe('ordinary transactions', () => {
  const erc20Abi = [
    { type: 'event', name: 'Approval', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'spender', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
  ] as const satisfies Abi
  const approval = () => ev(OFT, erc20Abi as Abi, 'Approval', { owner: WALLET, spender: OFT, value: 1n })

  it('an approve with no bridge is reported as an approve', () => {
    expect(detectFindings(tx([approval()]), 'ethereum')[0]).toMatchObject({ kind: 'erc20', what: 'approve' })
  })

  it('but token activity alongside a bridge is not', () => {
    const f = detectFindings(tx([approval(), oftSent()]), 'hyperevm')
    expect(f.map((x) => x.kind)).toEqual(['lz_oft_sent'])
  })

  it('raw material is always available', () => {
    const t = tx([oftSent(), packetSent()], { input: '0xc7c7f5b3deadbeef' })
    expect(logEmitters(t)).toEqual([OFT, ENDPOINT])
    expect(topSelector(t)).toBe('0xc7c7f5b3')
    expect(topSelector(tx([]))).toBeUndefined()
  })
})

describe('golden: event topics', () => {
  /**
   * These are keccak256 of the canonical signatures, cross-checked against @noble/hashes
   * independently of viem's ABI handling — which also proves viem expands the structs the way
   * Solidity does (Origin -> (uint32,bytes32,uint64), the CCIP message -> its nested tuples).
   * A changed signature changes a topic and fails here. That is the point: do not "update" a
   * value without re-reading the protocol's own contract.
   */
  it('LayerZero', () => {
    expect(LZ_TOPICS.OFTSent).toBe('0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a')
    expect(LZ_TOPICS.OFTReceived).toBe('0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c')
    expect(LZ_TOPICS.PacketSent).toBe('0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f')
    expect(LZ_TOPICS.PacketDelivered).toBe('0x3cd5e48f9730b129dc7550f0fcea9c767b7be37837cd10e55eb35f734f4bca04')
  })

  it('Wormhole NTT has two TransferSent topics', () => {
    expect(NTT_TOPICS.TransferSentDigest).toBe('0x3e6ae56314c6da8b461d872f41c6d0bb69317b9d0232805aaccfa45df1a16fa0')
    expect(NTT_TOPICS.TransferSentDetailed).toBe('0xe54e51e42099622516fa3b48e9733581c9dbdcb771cafb093f745a0532a35982')
    expect(NTT_TOPICS.TransferSentDetailed).not.toBe(NTT_TOPICS.TransferSentDigest)
  })

  it('CCIP', () => {
    expect(CCIP_TOPICS.CCIPMessageSent).toBe('0x192442a2b2adb6a7948f097023cb6b57d29d3a7a5dd33e6666d33c39cc456f32')
  })
})
