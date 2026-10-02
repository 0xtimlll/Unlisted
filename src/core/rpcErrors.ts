/**
 * What a failed `eth_call` means. Two things look alike from a `catch` and mean the opposite:
 *
 * - the CONTRACT answered "no": it reverted, or there is no such function (no return data) — a
 *   fact about the contract, and a reason to say "not this standard" / "no anchor";
 * - the PROVIDER did not answer: a timeout, a 429, a dropped socket — a fact about the network,
 *   and never a reason to say anything about the contract (CLAUDE.md: a failed read is not a
 *   missing function).
 *
 * Gates that ask optional questions ("does the token have minter()?") must only take the first
 * for an answer; the second has to surface as "could not verify", never as a verdict.
 */
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, ExecutionRevertedError, RawContractError } from 'viem'

/** True when the contract itself refused: a revert, or a call that returned no data. */
export function isContractRefusal(e: unknown): boolean {
  if (e instanceof BaseError) {
    const hit = e.walk(
      (err) =>
        err instanceof ContractFunctionRevertedError ||
        err instanceof ContractFunctionZeroDataError ||
        err instanceof ExecutionRevertedError ||
        err instanceof RawContractError,
    )
    if (hit) return true
  }
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return /revert|returned no data|no data|is not a contract|does not exist/i.test(message)
}

/** Thrown by gates when a read they needed never got an answer from the provider. */
export class UnreadableError extends Error {
  constructor(public readonly what: string, cause?: unknown) {
    super(`${what}: the RPC provider did not answer`, cause instanceof Error ? { cause } : undefined)
    this.name = 'UnreadableError'
  }
}

/**
 * Runs a read whose refusal by the contract is an answer. Returns `undefined` for that refusal;
 * a provider failure is thrown as `UnreadableError`, for the gate to turn into "unverified".
 */
export async function readOptional<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    if (isContractRefusal(e)) return undefined
    throw new UnreadableError(what, e)
  }
}
