/**
 * Fork tests (§9): real contracts, real state, local anvil. Skipped when anvil is missing.
 *   npm run test:integration
 */
import { execSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { erc20Abi, oftAbi } from '@/core/abi'
import { evmByKey } from '@/core/chains'
import { approvePlan, runGuards, selfCheck, type GuardInput } from '@/core/guards'
import { assembleSendArgs, buildSendPlan, type SendPlan } from '@/core/plan'
import { probeOft } from '@/core/probe'
import type { OftInfo } from '@/core/types'
import { fundFromHolder, impersonate, setNativeBalance, setTokenBalance, startFork, USER, type Fork } from './fork'

const hasAnvil = (() => {
  try {
    execSync('anvil --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const TREAD_OFT: Address = '0xd5EE1c81fE161e985dce6b90713c965f9979cf80'
const TREAD_ADAPTER: Address = '0xe68AD53cf0D5E49CF83FBC003672f6D0eBcAe311'
const USDT0_OFT: Address = '0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98'

const oftSentEvent = parseAbi([
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
])

/** Runs the whole app-side pipeline against the fork: simulate + gas + self-check + guards. */
async function fullCheck(f: Fork, info: OftInfo, plan: SendPlan, allowance: bigint | undefined) {
  const args = assembleSendArgs(plan)
  const calldata = encodeFunctionData({ abi: oftAbi, functionName: 'send', args: [args[0], args[1], args[2]] })
  const sc = selfCheck(plan, calldata)
  let simulation: GuardInput['simulation']
  let gasCostWei: bigint | undefined
  try {
    await f.client.simulateContract({ address: plan.oft, abi: oftAbi, functionName: 'send', args: [args[0], args[1], args[2]], value: plan.value, account: plan.sender })
    const gas = await f.client.estimateContractGas({ address: plan.oft, abi: oftAbi, functionName: 'send', args: [args[0], args[1], args[2]], value: plan.value, account: plan.sender })
    gasCostWei = gas * (await f.client.getGasPrice()) * 2n
    simulation = { ok: true }
  } catch (e) {
    simulation = { ok: false, reason: (e as Error).message.split('\n')[0] ?? '' }
  }
  const [tokenBalance, nativeBalance] = await Promise.all([
    f.client.readContract({ address: info.token, abi: erc20Abi, functionName: 'balanceOf', args: [USER] }),
    f.client.getBalance({ address: USER }),
  ])
  const input: GuardInput = {
    walletAddress: USER, walletChainId: f.chain.chainId, srcChainId: f.chain.chainId, info, plan,
    recipientIsCustom: false, customRecipientConfirmed: false,
    tokenBalance, nativeBalance, allowance, gasCostWei,
    simulation, selfCheck: sc, noExecutorGasAccepted: true, flags: [], peerBack: { status: 'ok' }, peerBackUnavailableAccepted: false,
  }
  return { report: runGuards(input), simulation, calldata, args }
}

async function sendOnFork(f: Fork, plan: SendPlan) {
  const wallet = await impersonate(f, USER)
  const args = assembleSendArgs(plan)
  const hash = await wallet.writeContract({ address: plan.oft, abi: oftAbi, functionName: 'send', args: [args[0], args[1], args[2]], value: plan.value })
  const receipt = await f.client.waitForTransactionReceipt({ hash })
  const sent = receipt.logs
    .map((l) => {
      try {
        return decodeEventLog({ abi: oftSentEvent, data: l.data, topics: l.topics })
      } catch {
        return null
      }
    })
    .find((x) => x?.eventName === 'OFTSent')
  return { receipt, sent }
}

describe.skipIf(!hasAnvil)('HyperEVM fork', () => {
  let f: Fork
  beforeAll(async () => {
    f = await startFork(evmByKey('hyperevm'))
    await setNativeBalance(f, USER, 10n * 10n ** 18n)
  }, 90_000)
  afterAll(() => f?.stop())

  it('TREAD: plan → simulate → guards → send succeeds on chain, OFTSent matches the plan', async () => {
    const { info } = await probeOft(f.client, TREAD_OFT)
    await setTokenBalance(f, info.token, USER, 100n * 10n ** 18n)
    const plan = await buildSendPlan(f.client, { info, src: f.chain, dstEid: 30101, amountInput: '1.5', sender: USER, recipient: USER })
    const { report, simulation } = await fullCheck(f, info, plan, undefined)
    expect(simulation).toEqual({ ok: true })
    expect(report.results.filter((r) => !r.ok)).toEqual([])
    expect(report.canSend).toBe(true)
    expect(approvePlan(info, plan, 0n)).toBeNull() // §6.11: no approve for approvalRequired=false

    const { receipt, sent } = await sendOnFork(f, plan)
    expect(receipt.status).toBe('success')
    expect(sent?.args.dstEid).toBe(30101)
    expect(sent?.args.fromAddress.toLowerCase()).toBe(USER)
    expect(sent?.args.amountSentLD).toBe(plan.amounts.amountLD)
    expect(sent?.args.amountReceivedLD).toBe(plan.quote.amountReceivedLD)
    const after = await f.client.readContract({ address: info.token, abi: erc20Abi, functionName: 'balanceOf', args: [USER] })
    expect(after).toBe(100n * 10n ** 18n - plan.amounts.amountLD)
  }, 120_000)

  it('TREAD: without token balance the simulation reverts and Send is blocked', async () => {
    const { info } = await probeOft(f.client, TREAD_OFT)
    await setTokenBalance(f, info.token, USER, 0n)
    const plan = await buildSendPlan(f.client, { info, src: f.chain, dstEid: 30101, amountInput: '1', sender: USER, recipient: USER })
    const { report, simulation } = await fullCheck(f, info, plan, undefined)
    expect(simulation.ok).toBe(false)
    expect(report.canSend).toBe(false)
    expect(report.results.find((r) => r.id === 5)).toMatchObject({ ok: false, code: 'insufficient_balance' })
    expect(report.results.find((r) => r.id === 13)).toMatchObject({ ok: false, code: 'simulation_failed' })
  }, 120_000)

  it('TREAD: value below quoted fee is rejected by the contract (fee/value invariant is real)', async () => {
    const { info } = await probeOft(f.client, TREAD_OFT)
    await setTokenBalance(f, info.token, USER, 10n * 10n ** 18n)
    const plan = await buildSendPlan(f.client, { info, src: f.chain, dstEid: 30101, amountInput: '1', sender: USER, recipient: USER })
    const bad: SendPlan = { ...plan, value: plan.quote.nativeFee - 1n }
    const { simulation, report } = await fullCheck(f, info, bad, undefined)
    expect(simulation.ok).toBe(false)
    expect(report.results.find((r) => r.id === 7)).toMatchObject({ ok: false, code: 'fee_mismatch' })
  }, 120_000)

  it('USDT0 adapter: approvalRequired=false → no approve, send succeeds', async () => {
    const { info } = await probeOft(f.client, USDT0_OFT)
    expect(info.kind).toBe('OFTAdapter')
    expect(info.approvalRequired).toBe(false)
    await setTokenBalance(f, info.token, USER, 50n * 10n ** 6n)
    const plan = await buildSendPlan(f.client, { info, src: f.chain, dstEid: 30110, amountInput: '2.5', sender: USER, recipient: USER })
    expect(approvePlan(info, plan, 0n)).toBeNull()
    const { report, simulation } = await fullCheck(f, info, plan, 0n)
    expect(simulation).toEqual({ ok: true })
    expect(report.canSend).toBe(true)
    const { receipt, sent } = await sendOnFork(f, plan)
    expect(receipt.status).toBe('success')
    expect(sent?.args.dstEid).toBe(30110)
    expect(sent?.args.amountSentLD).toBe(2_500000n)
  }, 120_000)
})

describe.skipIf(!hasAnvil)('Ethereum fork', () => {
  let f: Fork
  beforeAll(async () => {
    f = await startFork(evmByKey('ethereum'))
    await setNativeBalance(f, USER, 10n * 10n ** 18n)
  }, 90_000)
  afterAll(() => f?.stop())

  it('TREAD adapter: blocked until approve of EXACTLY amountLD to the adapter, then send succeeds', async () => {
    const { info } = await probeOft(f.client, TREAD_ADAPTER)
    expect(info.approvalRequired).toBe(true)
    // The token is a proxy with non-trivial balance storage; the adapter holds the locked supply.
    await fundFromHolder(f, info.token, TREAD_ADAPTER, USER, 100n * 10n ** 18n)
    const plan = await buildSendPlan(f.client, { info, src: f.chain, dstEid: 30367, amountInput: '3', sender: USER, recipient: USER })

    const allowance0 = await f.client.readContract({ address: info.token, abi: erc20Abi, functionName: 'allowance', args: [USER, info.oft] })
    expect(allowance0).toBe(0n)
    const before = await fullCheck(f, info, plan, allowance0)
    expect(before.report.canSend).toBe(false)
    expect(before.report.results.find((r) => r.id === 10)).toMatchObject({ ok: false, code: 'needs_approve' })

    const intent = approvePlan(info, plan, allowance0)
    expect(intent).toEqual({ spender: TREAD_ADAPTER, amount: plan.amounts.amountLD })
    const wallet = await impersonate(f, USER)
    const approveHash = await wallet.writeContract({ address: info.token, abi: erc20Abi, functionName: 'approve', args: [intent!.spender, intent!.amount] })
    expect((await f.client.waitForTransactionReceipt({ hash: approveHash })).status).toBe('success')

    const allowance1 = await f.client.readContract({ address: info.token, abi: erc20Abi, functionName: 'allowance', args: [USER, info.oft] })
    expect(allowance1).toBe(plan.amounts.amountLD)
    expect(approvePlan(info, plan, allowance1)).toBeNull()
    const after = await fullCheck(f, info, plan, allowance1)
    expect(after.simulation).toEqual({ ok: true })
    expect(after.report.canSend).toBe(true)

    const { receipt, sent } = await sendOnFork(f, plan)
    expect(receipt.status).toBe('success')
    expect(sent?.args.dstEid).toBe(30367)
    expect(sent?.args.amountSentLD).toBe(3n * 10n ** 18n)
    // Exact approve: nothing left over.
    const allowance2 = await f.client.readContract({ address: info.token, abi: erc20Abi, functionName: 'allowance', args: [USER, info.oft] })
    expect(allowance2).toBe(0n)
  }, 180_000)
})

// keep the type import used even when anvil is absent
void (0 as unknown as Hex)
