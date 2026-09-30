/**
 * The approve, as a sequence of states a screen can render and a test can walk.
 *
 * One rule decides how many approves there are: EXACTLY one, for exactly the amount, to the
 * verified spender — unless the token refuses to move an allowance from one non-zero value to
 * another (USDT and its imitators revert in `approve` when the current allowance is non-zero). That
 * case is detected by simulating the plain approve first, and only then does the flow become two
 * steps: approve(0) to clear, then approve(amount). The allowance that ends up granted is still
 * exactly the amount, and the spender never changes between the two.
 *
 * `runApproveFlow` is the whole flow with the wallet and the node abstracted away (`ApproveDeps`),
 * so ui/useApproveFlow.ts only wires wagmi to it and the transitions can be tested without either.
 */

/** One approve the flow will ask the wallet to sign. `amount` is 0n only for the clearing step. */
export type ApproveStep = { n: number; of: number; amount: bigint }

export type ApprovePhase =
  | { kind: 'idle' }
  /** Simulating the plain approve to learn whether the token needs the clearing step first. */
  | { kind: 'simulating' }
  /** The wallet has been asked to sign this step. */
  | { kind: 'signing'; step: ApproveStep }
  /** Signed; waiting for the receipt. `hash` is what the explorer link points at. */
  | { kind: 'mining'; step: ApproveStep; hash: `0x${string}` }
  /** Every step landed; the allowance is being read back until it shows the amount. */
  | { kind: 'rereading'; attempt: number; hash: `0x${string}` }
  | { kind: 'done'; hash: `0x${string}` }
  /** Declined in the wallet. Not an error: the button goes back to Approve. */
  | { kind: 'cancelled' }
  /** The transaction, the node or the wallet failed. The button offers to try again. */
  | { kind: 'error'; message: string; hash?: `0x${string}` }

/**
 * The amounts to approve, in order.
 *
 *   [amount]      the ordinary case, and the case where nothing was granted yet: the plain approve
 *                 goes straight to the exact amount.
 *   [0, amount]   the current allowance is non-zero and short, AND the plain approve reverts in
 *                 simulation — the token wants the allowance cleared first.
 *
 * A plain approve that reverts with a ZERO current allowance is not this case: clearing an
 * allowance that is already zero changes nothing, so the sequence stays one step and the wallet
 * reports whatever the real reason is.
 */
export function approveSequence(p: { allowance: bigint | undefined; amount: bigint; plainApproveReverts: boolean }): bigint[] {
  if (p.plainApproveReverts && p.allowance !== undefined && p.allowance > 0n && p.allowance < p.amount) return [0n, p.amount]
  return [p.amount]
}

/** How many times the allowance is read back after the receipt, and how far apart. */
export const REREAD_ATTEMPTS = 8
export const REREAD_INTERVAL_MS = 1500

/** True once a re-read allowance covers the amount: the flow is done and the button is Send. */
export function allowanceCovers(allowance: bigint | undefined, amount: bigint): boolean {
  return allowance !== undefined && allowance >= amount
}

/** Is the flow busy — a state in which the button must not take a second click? */
export function approveBusy(phase: ApprovePhase): boolean {
  return phase.kind === 'simulating' || phase.kind === 'signing' || phase.kind === 'mining' || phase.kind === 'rereading'
}

/** What the flow needs from the outside world. Every function may throw; a throw ends the flow. */
export type ApproveDeps = {
  /** Does approve(spender, amount) revert against the chain right now? An RPC failure is `false`. */
  plainApproveReverts: () => Promise<boolean>
  /** Asks the wallet to sign approve(spender, amount) and returns the hash. */
  signApprove: (amount: bigint) => Promise<`0x${string}`>
  /** Waits for the receipt and says whether the transaction succeeded. */
  waitForReceipt: (hash: `0x${string}`) => Promise<'success' | 'reverted'>
  /** Re-reads the allowance; undefined when the read failed. */
  refetchAllowance: () => Promise<bigint | undefined>
  /** True when the wallet declined (not an error, a cancellation). */
  isRejection: (e: unknown) => boolean
  /** How an unknown error is worded. */
  describeError: (e: unknown) => string
  sleep: (ms: number) => Promise<void>
}

/**
 * Runs the whole flow, reporting each phase through `emit`. Resolves with the final phase; it never
 * throws — every failure is a phase the screen can show.
 */
export async function runApproveFlow(
  p: { amount: bigint; allowance: bigint | undefined },
  deps: ApproveDeps,
  emit: (phase: ApprovePhase) => void,
): Promise<ApprovePhase> {
  const finish = (phase: ApprovePhase): ApprovePhase => {
    emit(phase)
    return phase
  }
  try {
    // 1. Would the plain approve go through? Only a revert with a non-zero allowance means the
    //    token wants a clearing step; an RPC that cannot answer is not a reason to add one.
    emit({ kind: 'simulating' })
    const amounts = approveSequence({ allowance: p.allowance, amount: p.amount, plainApproveReverts: await deps.plainApproveReverts() })

    // 2. Each step: sign, then wait for the receipt.
    let lastHash: `0x${string}` | undefined
    for (let n = 0; n < amounts.length; n++) {
      const step: ApproveStep = { n: n + 1, of: amounts.length, amount: amounts[n]! }
      emit({ kind: 'signing', step })
      const hash = await deps.signApprove(step.amount)
      lastHash = hash
      emit({ kind: 'mining', step, hash })
      if ((await deps.waitForReceipt(hash)) !== 'success') {
        return finish({ kind: 'error', message: 'The approve transaction reverted on chain.', hash })
      }
    }

    // 3. Read the allowance back until it shows the amount — RPCs lag behind the receipt.
    const hash = lastHash!
    for (let attempt = 1; attempt <= REREAD_ATTEMPTS; attempt++) {
      emit({ kind: 'rereading', attempt, hash })
      if (allowanceCovers(await deps.refetchAllowance(), p.amount)) return finish({ kind: 'done', hash })
      if (attempt < REREAD_ATTEMPTS) await deps.sleep(REREAD_INTERVAL_MS)
    }
    return finish({ kind: 'error', message: 'The approve was mined, but the allowance still reads short. Reload the allowance or try again.', hash })
  } catch (e) {
    return finish(deps.isRejection(e) ? { kind: 'cancelled' } : { kind: 'error', message: deps.describeError(e) })
  }
}
