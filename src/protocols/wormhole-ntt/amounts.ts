/**
 * NTT amount trimming. Unlike an OFT, which silently drops dust, an NttManager REVERTS:
 *
 *   TrimmedAmount trimmedAmount = amount.trim(fromDecimals, toDecimals);
 *   uint256 newAmount = trimmedAmount.untrim(fromDecimals);
 *   if (amount != newAmount) revert TransferAmountHasDust(amount, amount - newAmount);
 *       — evm/src/NttManager/NttManager.sol, _trimTransferAmount
 *
 * and trim() itself is
 *
 *   uint8 actualToDecimals = min(min(TRIMMED_DECIMALS, fromDecimals), toDecimals);  // TRIMMED_DECIMALS = 8
 *   SafeCast.toUint64(scale(amt, fromDecimals, actualToDecimals))
 *       — evm/src/libraries/TrimmedAmount.sol
 *
 * So the amount must be rounded down here, before it is ever sent, and it must still fit in a
 * uint64 after scaling. Everything is bigint; the only division is exact by construction.
 */

/** TRIMMED_DECIMALS in TrimmedAmount.sol. */
export const TRIMMED_DECIMALS = 8

const MAX_UINT64 = (1n << 64n) - 1n

export type TrimPlan = {
  /** min(8, fromDecimals, toDecimals) — the precision that survives the hop. */
  trimmedDecimals: number
  /** Amounts must be whole multiples of this, in the source token's smallest unit. */
  step: bigint
  /** The largest amount that still fits a uint64 after scaling. */
  maxAmount: bigint
}

export function trimPlan(fromDecimals: number, toDecimals: number): TrimPlan {
  if (!Number.isInteger(fromDecimals) || fromDecimals < 0 || fromDecimals > 77) throw new Error(`bad fromDecimals: ${fromDecimals}`)
  if (!Number.isInteger(toDecimals) || toDecimals <= 0 || toDecimals > 77) throw new Error(`bad toDecimals: ${toDecimals}`)
  const trimmedDecimals = Math.min(TRIMMED_DECIMALS, fromDecimals, toDecimals)
  const step = 10n ** BigInt(fromDecimals - trimmedDecimals)
  return { trimmedDecimals, step, maxAmount: MAX_UINT64 * step }
}

/** Rounds DOWN to something the manager will accept. */
export function trimAmount(amount: bigint, plan: TrimPlan): bigint {
  if (amount < 0n) throw new Error('amount must be >= 0')
  return amount - (amount % plan.step)
}

/** What the manager would put on the wire: the amount scaled to `trimmedDecimals`. */
export function trimmedUnits(amount: bigint, plan: TrimPlan): bigint {
  return trimAmount(amount, plan) / plan.step
}

/**
 * What lands on the other side, in the DESTINATION token's smallest unit. The wire amount is
 * scaled back up by the destination's own decimals, so a token with fewer decimals there
 * receives a correspondingly smaller number — the value is the same.
 */
export function receivedAmount(amount: bigint, plan: TrimPlan, toDecimals: number): bigint {
  return trimmedUnits(amount, plan) * 10n ** BigInt(toDecimals - plan.trimmedDecimals)
}

export type AmountCheck =
  | { ok: true; amount: bigint; dust: bigint }
  | { ok: false; reason: 'zero' | 'too_large'; amount: bigint; dust: bigint; max: bigint }

/** The amount to actually send, or why it cannot be sent at all. */
export function checkAmount(raw: bigint, plan: TrimPlan): AmountCheck {
  const amount = trimAmount(raw, plan)
  const dust = raw - amount
  if (amount <= 0n) return { ok: false, reason: 'zero', amount, dust, max: plan.maxAmount }
  if (amount > plan.maxAmount) return { ok: false, reason: 'too_large', amount, dust, max: plan.maxAmount }
  return { ok: true, amount, dust }
}
