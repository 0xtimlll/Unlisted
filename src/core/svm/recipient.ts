/**
 * §4.4 What is the account the user pasted? One getAccountInfo answers four cases:
 *   System-owned      → an ordinary wallet, fine
 *   Token program     → they pasted a TOKEN ACCOUNT, not a wallet: must block
 *   does not exist    → wallet never used; allowed, but the ATA will need creating
 *   any other program → a PDA / program account: hard warning
 * Plus: does the recipient's associated token account for this mint exist yet?
 */
import { decodeTokenAccount } from './layouts'
import { findAta, PROGRAM, pubkeyFromBase58, pubkeyToBase58 } from './pubkey'
import type { SvmRpc } from './rpc'
import type { TokenProgram } from './discover'

export type SvmRecipientClass = 'wallet' | 'token_account' | 'missing' | 'program_owned'

export type SvmRecipientCheck = {
  class: SvmRecipientClass
  /** Owner program of the recipient account, when it exists. */
  owner?: string
  /** For token_account: what it holds — helps the error message. */
  tokenAccountMint?: string
  ata: string
  ataExists: boolean
}

export function ataFor(ownerBase58: string, mintBase58: string, tokenProgram: TokenProgram): string {
  const program = pubkeyFromBase58(tokenProgram === 'token' ? PROGRAM.token : PROGRAM.token2022)
  return pubkeyToBase58(findAta(pubkeyFromBase58(ownerBase58), pubkeyFromBase58(mintBase58), program))
}

export async function checkSvmRecipient(rpc: SvmRpc, recipientBase58: string, mintBase58: string, tokenProgram: TokenProgram): Promise<SvmRecipientCheck> {
  const ata = ataFor(recipientBase58, mintBase58, tokenProgram)
  const [acc, ataAcc] = await rpc.getMultipleAccounts([recipientBase58, ata])
  const ataExists = !!ataAcc && (ataAcc.owner === PROGRAM.token || ataAcc.owner === PROGRAM.token2022)
  if (!acc) return { class: 'missing', ata, ataExists }
  if (acc.owner === PROGRAM.system) return { class: 'wallet', owner: acc.owner, ata, ataExists }
  if (acc.owner === PROGRAM.token || acc.owner === PROGRAM.token2022) {
    let tokenAccountMint: string | undefined
    try {
      tokenAccountMint = decodeTokenAccount(acc.data).mint
    } catch {
      /* not a token account layout; still owned by the token program */
    }
    return { class: 'token_account', owner: acc.owner, ata, ataExists, ...(tokenAccountMint ? { tokenAccountMint } : {}) }
  }
  return { class: 'program_owned', owner: acc.owner, ata, ataExists }
}
