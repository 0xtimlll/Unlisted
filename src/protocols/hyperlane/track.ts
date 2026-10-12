/**
 * Where a sent Hyperlane transfer can be watched, and how its delivery is read.
 *
 * The explorer routes are `/message/:messageId` and `/tx/:txHash`, read from the Hyperlane
 * Explorer's own source (hyperlane-xyz/hyperlane-explorer, src/pages/message/[messageId].tsx and
 * src/pages/tx/[txHash].tsx) — the same standard of evidence used for the other explorers.
 *
 * Delivery itself is not asked of the explorer. The destination Mailbox from OUR table answers
 * `delivered(messageId)` (IMailbox.sol), and the message id is keccak256 of the message bytes the
 * source Mailbox logged — so "delivered" here is the destination chain's own word, read with no
 * indexer in between. A network failure means "no data yet", never "failed".
 */
import { getAddress, type Hex } from 'viem'
import type { ChainKey } from '../../core/chains'
import type { ReadClient } from '../../core/client'
import { mailboxAbi } from './abi'
import { hyperlaneConfig } from './chains'

const isHex32 = (v: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(v)

export const HYPERLANE_EXPLORER = 'https://explorer.hyperlane.xyz'

export function hyperlaneMessageUrl(messageId: string): string {
  if (!isHex32(messageId)) throw new Error('not a messageId')
  return `${HYPERLANE_EXPLORER}/message/${messageId}`
}

export function hyperlaneTxUrl(txHash: string): string {
  if (!isHex32(txHash)) throw new Error('not a transaction hash')
  return `${HYPERLANE_EXPLORER}/tx/${txHash}`
}

export type HyperlaneDeliveryPhase = 'no_data' | 'pending' | 'delivered'

export type HyperlaneDelivery = {
  phase: HyperlaneDeliveryPhase
  /** The block the destination Mailbox processed it in, when it says so. */
  processedAtBlock?: bigint
}

/**
 * What the destination Mailbox says about one message id. `no_data` when the provider could not
 * be reached: not delivered is a fact about the chain, unreachable is a fact about the network.
 */
export async function readHyperlaneDelivery(dstClient: ReadClient, dstChain: ChainKey, messageId: Hex): Promise<HyperlaneDelivery> {
  const cfg = hyperlaneConfig(dstChain)
  if (!cfg) return { phase: 'no_data' }
  const mailbox = getAddress(cfg.mailbox)
  try {
    const delivered = await dstClient.readContract({ address: mailbox, abi: mailboxAbi, functionName: 'delivered', args: [messageId] })
    if (!delivered) return { phase: 'pending' }
    let processedAtBlock: bigint | undefined
    try {
      // uint48 on the wire, which viem hands back as a number.
      const at = await dstClient.readContract({ address: mailbox, abi: mailboxAbi, functionName: 'processedAt', args: [messageId] })
      if (at > 0) processedAtBlock = BigInt(at)
    } catch {
      /* an older Mailbox build without processedAt; delivered is the answer that matters */
    }
    return processedAtBlock === undefined ? { phase: 'delivered' } : { phase: 'delivered', processedAtBlock }
  } catch {
    return { phase: 'no_data' }
  }
}
