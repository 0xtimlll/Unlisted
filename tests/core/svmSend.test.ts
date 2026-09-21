/** send.ts pure parts: resolving a compiled v0 message (static keys + lookup-table loads) back to keys and flags. */
import { publicKey, type Transaction } from '@metaplex-foundation/umi'
import { describe, expect, it } from 'vitest'
import { svmTxFeeLamports, viewOf } from '@/core/svm/send'
import { penguPlan } from './svmFixtures'

const K = (n: number) => publicKey(new Uint8Array(32).fill(n))

describe('viewOf', () => {
  const table = { publicKey: K(200), addresses: Array.from({ length: 10 }, (_, i) => K(100 + i)) }
  const tx = {
    message: {
      version: 0,
      // 4 static accounts: [0] signer+writable, [1] writable, [2] readonly, [3] readonly (program)
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
      accounts: [K(1), K(2), K(3), K(4)],
      blockhash: '11111111111111111111111111111111',
      instructions: [{ programIndex: 3, accountIndexes: [0, 1, 2, 4, 5], data: new Uint8Array([9]) }],
      addressLookupTables: [{ publicKey: K(200), writableIndexes: [7], readonlyIndexes: [3] }],
    },
    serializedMessage: new Uint8Array(),
    signatures: [],
  } as unknown as Transaction

  it('orders accounts as static ‖ loaded-writable ‖ loaded-readonly and derives flags from the header', () => {
    const v = viewOf(tx, [table])
    expect(v.signers).toEqual([String(K(1))])
    expect(v.lookupTables).toEqual([String(K(200))])
    expect(v.instructions[0]!.programId).toBe(String(K(4)))
    expect(v.instructions[0]!.accounts).toEqual([
      { pubkey: String(K(1)), isSigner: true, isWritable: true },
      { pubkey: String(K(2)), isSigner: false, isWritable: true },
      { pubkey: String(K(3)), isSigner: false, isWritable: false },
      { pubkey: String(K(107)), isSigner: false, isWritable: true },
      { pubkey: String(K(103)), isSigner: false, isWritable: false },
    ])
    expect(v.instructions[0]!.data).toEqual(new Uint8Array([9]))
  })

  it('refuses a table it was not given', () => {
    expect(() => viewOf(tx, [])).toThrow(/unknown lookup table/)
  })

  it('a readonly signer is not writable', () => {
    const t2 = { ...tx, message: { ...tx.message, header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 1 } } } as unknown as Transaction
    const v = viewOf(t2, [table])
    expect(v.signers).toEqual([String(K(1)), String(K(2))])
    expect(v.instructions[0]!.accounts[1]).toEqual({ pubkey: String(K(2)), isSigner: true, isWritable: false })
  })
})

describe('svmTxFeeLamports', () => {
  it('base fee + priority fee for the plan budget', () => {
    expect(svmTxFeeLamports(penguPlan())).toBe(5_000n + 6_000n)
    expect(svmTxFeeLamports(penguPlan({ computeUnitLimit: 1_400_000, computeUnitPrice: 1_000_000n }))).toBe(5_000n + 1_400_000n)
  })
})
