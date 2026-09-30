/**
 * The approve flow: Approve → Send, a cancelled wallet, a token that wants the allowance cleared
 * first, and the allowance read back until it shows the amount. Walked without a wallet or a node.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { allowanceCovers, approveBusy, approveSequence, REREAD_ATTEMPTS, runApproveFlow, type ApproveDeps, type ApprovePhase } from '@/core/approveFlow'
import { approvePlan } from '@/core/guards'
import { treadOftInfo, treadPlan } from './fixtures'

const HASH = `0x${'ab'.repeat(32)}` as const
const AMOUNT = 25n * 10n ** 18n

/** Deps that behave: no revert, every signature lands, the allowance shows up on the first read. */
function deps(over: Partial<ApproveDeps> = {}, log: string[] = []): ApproveDeps {
  return {
    plainApproveReverts: async () => false,
    signApprove: async (amount) => {
      log.push(`approve(${amount})`)
      return HASH
    },
    waitForReceipt: async () => 'success',
    refetchAllowance: async () => AMOUNT,
    isRejection: (e) => e instanceof Error && e.message === 'rejected',
    describeError: (e) => (e instanceof Error ? e.message : String(e)),
    sleep: async () => {},
    ...over,
  }
}

async function run(p: { amount: bigint; allowance: bigint | undefined }, d: ApproveDeps): Promise<{ phases: ApprovePhase[]; final: ApprovePhase }> {
  const phases: ApprovePhase[] = []
  const final = await runApproveFlow(p, d, (ph) => phases.push(ph))
  return { phases, final }
}

describe('how many approves', () => {
  it('one, for exactly the amount, in the ordinary case', () => {
    expect(approveSequence({ allowance: 0n, amount: AMOUNT, plainApproveReverts: false })).toEqual([AMOUNT])
    expect(approveSequence({ allowance: 10n, amount: AMOUNT, plainApproveReverts: false })).toEqual([AMOUNT])
    expect(approveSequence({ allowance: undefined, amount: AMOUNT, plainApproveReverts: false })).toEqual([AMOUNT])
  })

  it('approve(0) then approve(amount) for a USDT-like token: non-zero short allowance and a reverting plain approve', () => {
    expect(approveSequence({ allowance: 10n, amount: AMOUNT, plainApproveReverts: true })).toEqual([0n, AMOUNT])
  })

  it('never adds the clearing step when nothing was granted yet — clearing zero changes nothing', () => {
    expect(approveSequence({ allowance: 0n, amount: AMOUNT, plainApproveReverts: true })).toEqual([AMOUNT])
    expect(approveSequence({ allowance: undefined, amount: AMOUNT, plainApproveReverts: true })).toEqual([AMOUNT])
  })
})

describe('the flow', () => {
  it('signs once, waits, reads the allowance back and ends done', async () => {
    const log: string[] = []
    const { phases, final } = await run({ amount: AMOUNT, allowance: 0n }, deps({}, log))
    expect(log).toEqual([`approve(${AMOUNT})`])
    expect(phases.map((p) => p.kind)).toEqual(['simulating', 'signing', 'mining', 'rereading', 'done'])
    expect(final).toEqual({ kind: 'done', hash: HASH })
    // One step: no "1/2" counter.
    const signing = phases.find((p) => p.kind === 'signing')
    expect(signing).toMatchObject({ step: { n: 1, of: 1, amount: AMOUNT } })
  })

  it('a USDT-like token gets approve(0) as step 1/2 and approve(amount) as step 2/2', async () => {
    const log: string[] = []
    const { phases, final } = await run({ amount: AMOUNT, allowance: 10n }, deps({ plainApproveReverts: async () => true }, log))
    expect(log).toEqual(['approve(0)', `approve(${AMOUNT})`])
    const steps = phases.filter((p) => p.kind === 'signing').map((p) => (p.kind === 'signing' ? p.step : undefined))
    expect(steps).toEqual([
      { n: 1, of: 2, amount: 0n },
      { n: 2, of: 2, amount: AMOUNT },
    ])
    expect(final.kind).toBe('done')
  })

  it('declined in the wallet → cancelled, not an error; nothing else was signed', async () => {
    const log: string[] = []
    const { final } = await run(
      { amount: AMOUNT, allowance: 0n },
      deps(
        {
          signApprove: async () => {
            throw new Error('rejected')
          },
        },
        log,
      ),
    )
    expect(final).toEqual({ kind: 'cancelled' })
    expect(log).toEqual([])
  })

  it('a receipt that reverted → error with the hash, and the flow stops there', async () => {
    const log: string[] = []
    const { final } = await run({ amount: AMOUNT, allowance: 10n }, deps({ plainApproveReverts: async () => true, waitForReceipt: async () => 'reverted' }, log))
    expect(final).toMatchObject({ kind: 'error', hash: HASH })
    // The clearing step reverted, so the second approve was never asked for.
    expect(log).toEqual(['approve(0)'])
  })

  it('keeps reading the allowance while the RPC lags, and ends done once it shows the amount', async () => {
    let reads = 0
    const { phases, final } = await run(
      { amount: AMOUNT, allowance: 0n },
      deps({ refetchAllowance: async () => (++reads >= 3 ? AMOUNT : 0n) }),
    )
    expect(reads).toBe(3)
    expect(phases.filter((p) => p.kind === 'rereading').map((p) => (p.kind === 'rereading' ? p.attempt : 0))).toEqual([1, 2, 3])
    expect(final.kind).toBe('done')
  })

  it('gives up after the last re-read with an error that keeps the hash', async () => {
    const { final } = await run({ amount: AMOUNT, allowance: 0n }, deps({ refetchAllowance: async () => 0n }))
    expect(final).toMatchObject({ kind: 'error', hash: HASH })
    expect(final.kind === 'error' && /allowance/.test(final.message)).toBe(true)
  })

  it('an RPC that cannot simulate is not a reason to add the clearing step', async () => {
    const log: string[] = []
    // The hook maps a non-revert failure to `false`; the flow then signs exactly one approve.
    await run({ amount: AMOUNT, allowance: 10n }, deps({ plainApproveReverts: async () => false }, log))
    expect(log).toEqual([`approve(${AMOUNT})`])
  })

  it('busy phases are exactly the ones a second click must not interrupt', () => {
    expect(approveBusy({ kind: 'simulating' })).toBe(true)
    expect(approveBusy({ kind: 'signing', step: { n: 1, of: 1, amount: 1n } })).toBe(true)
    expect(approveBusy({ kind: 'mining', step: { n: 1, of: 1, amount: 1n }, hash: HASH })).toBe(true)
    expect(approveBusy({ kind: 'rereading', attempt: 1, hash: HASH })).toBe(true)
    for (const p of [{ kind: 'idle' }, { kind: 'done', hash: HASH }, { kind: 'cancelled' }, { kind: 'error', message: 'x' }] as ApprovePhase[]) {
      expect(approveBusy(p), p.kind).toBe(false)
    }
    expect(REREAD_ATTEMPTS).toBeGreaterThan(1)
    expect(allowanceCovers(AMOUNT, AMOUNT)).toBe(true)
    expect(allowanceCovers(AMOUNT - 1n, AMOUNT)).toBe(false)
    expect(allowanceCovers(undefined, AMOUNT)).toBe(false)
  })
})

describe('Approve → Send on the screen: the intent is derived from the allowance', () => {
  const info = treadOftInfo({ approvalRequired: true })
  const plan = treadPlan()
  const amount = plan.amounts.amountLD

  it('allowance short → an approve for exactly the amount to the verified contract', () => {
    expect(approvePlan(info, plan, 0n)).toEqual({ spender: info.oft, amount })
    expect(approvePlan(info, plan, amount - 1n)).toEqual({ spender: info.oft, amount })
  })

  it('allowance covers the amount → no approve: the button is Send', () => {
    expect(approvePlan(info, plan, amount)).toBeNull()
    expect(approvePlan(info, plan, amount * 2n)).toBeNull()
  })

  it('the user raises the amount past the allowance → Approve again, for the new exact amount', () => {
    const bigger = treadPlan({ amounts: { ...plan.amounts, amountLD: amount * 2n } })
    expect(approvePlan(info, bigger, amount)).toEqual({ spender: info.oft, amount: amount * 2n })
  })

  it('a contract that needs no approve never gets one', () => {
    expect(approvePlan(treadOftInfo({ approvalRequired: false }), plan, 0n)).toBeNull()
  })

  it('the spender is the contract that was probed, never anything else', () => {
    const intent = approvePlan(info, plan, 0n)!
    expect(getAddress(intent.spender)).toBe(getAddress(info.oft))
  })
})
