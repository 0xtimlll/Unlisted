/** Solana-source fixtures: PENGU (real accounts; PDAs derived, nothing fetched). */
import { addressToBytes32 } from '@/core/encoding'
import { computeAmounts, computeValue } from '@/core/plan'
import { LZ_MAINNET_LOOKUP_TABLE, peerConfigPda, type SvmSendPlan } from '@/core/svm/plan'
import { pubkeyFromBase58, pubkeyToHex } from '@/core/svm/pubkey'
import { ataFor } from '@/core/svm/recipient'
import type { SvmSourceInfo } from '@/core/svm/source'
import { quoteFor } from './fixtures'

export const STORE = 'qMNo1RFo11J9ZLGuq7dVmWAssuCZaNsSamk8g2q4UZA'
export const PROGRAM = 'EfRMrTJWU2CYm52kHmRYozQNdF8RH5aTi3xyeSuLAX2Y'
export const MINT = '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv'
export const ESCROW = '8qytKBooPvD4Q7vdrKnjKmiweShS4D5mPzsgQc6HqgvX'
export const SENDER = '2hCc738iscpDVahFvwjNwUq1WZQ7xRTeitebgWtkkp1h'
export const PENGU_HYPER = '0xfa44c2634ff17cbe26dc3007d36bd61c79068c14'
export const HYPER_EID = 30367
export const RECIPIENT = '0x1111111111111111111111111111111111111111'

export function penguSource(over: Partial<SvmSourceInfo> = {}): SvmSourceInfo {
  return {
    vm: 'svm',
    oftStore: STORE,
    oftStoreBytes32: pubkeyToHex(pubkeyFromBase58(STORE)),
    programId: PROGRAM,
    kind: 'OFTAdapter',
    tokenMint: MINT,
    tokenEscrow: ESCROW,
    tokenProgram: 'token',
    endpointProgram: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
    symbol: 'PENGU',
    name: 'Pudgy Penguins',
    decimals: 6,
    sharedDecimals: 6,
    conversionRate: 1n,
    approvalRequired: false,
    paused: false,
    defaultFeeBps: 0,
    tvlLd: 0n,
    routes: [{ eid: HYPER_EID, peer: addressToBytes32(PENGU_HYPER) }],
    enforced: { [HYPER_EID]: '0x000301001101000000000000000000000000000186a0' },
    ...over,
  }
}

export function penguPlan(over: Partial<SvmSendPlan> = {}): SvmSendPlan {
  const amounts = computeAmounts('1', 6, 1n, 0)
  const quote = quoteFor(amounts.amountLD, { nativeFee: 231_803n })
  return {
    vm: 'svm',
    oftStore: STORE,
    programId: PROGRAM,
    tokenMint: MINT,
    tokenEscrow: ESCROW,
    tokenProgram: 'token',
    peerConfig: peerConfigPda(STORE, PROGRAM, HYPER_EID),
    dstPeer: addressToBytes32(PENGU_HYPER),
    srcEid: 30168,
    dstEid: HYPER_EID,
    sender: SENDER,
    senderAta: ataFor(SENDER, MINT, 'token'),
    recipient: addressToBytes32(RECIPIENT),
    recipientDisplay: RECIPIENT,
    recipientVm: 'evm',
    amounts,
    slippageBps: 0,
    feeBufferBps: 4000,
    extraOptions: '0x',
    quote,
    value: computeValue(quote.nativeFee, 4000, 10_000n),
    computeUnitLimit: 600_000,
    computeUnitPrice: 10_000n,
    lookupTable: LZ_MAINNET_LOOKUP_TABLE,
    ...over,
  }
}
