/**
 * Where a sent CCIP transfer can be watched.
 *
 * The explorer route is `"/msg/:messageId"`, read from the CCIP Explorer's own route table (its
 * published bundle at ccip.chain.link) — the same standard of evidence used for the other
 * explorers, rather than a URL copied from memory. Chainlink's tutorial points at the explorer
 * itself (docs.chain.link/ccip/tutorials/evm/transfer-tokens-from-contract).
 *
 * The messageId is decoded from the transaction's own logs (core/analysis/detect.ts), so before it
 * is known the source transaction is linked instead.
 */
const isHex32 = (v: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(v)

export const CCIP_EXPLORER = 'https://ccip.chain.link'

export function ccipMessageUrl(messageId: string): string {
  if (!isHex32(messageId)) throw new Error('not a messageId')
  return `${CCIP_EXPLORER}/msg/${messageId}`
}

export function ccipTxUrl(txHash: string): string {
  if (!isHex32(txHash)) throw new Error('not a transaction hash')
  return `${CCIP_EXPLORER}/tx/${txHash}`
}
