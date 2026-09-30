'use client'
/**
 * The LayerZero **v1** form, inside the OFT tab.
 *
 * A separate component rather than a branch inside BridgeApp, for one reason: the V2 path is what
 * people already use, and it does not change shape because v1 exists. Everything v1 needs that V2
 * does not — a `bytes` recipient, adapter params, a stuck-payload check on the destination — lives
 * here, and the V2 screen is left exactly as it was.
 */
import { isNoteCode, isStepCode, shownFailures, waitsOnlyForApprove } from '@/core/severity'
import { useEffect, useMemo, useState } from 'react'
import { useAccount, useGasPrice, useSwitchChain, useWriteContract } from 'wagmi'
import { byKey, type ChainKey, type EvmChainDef } from '@/core/chains'
import { formatAmount } from '@/core/amounts'
import { assessIndicator } from '@/core/indicator'
import { useApproveFlow } from './useApproveFlow'
import { sameAddress } from '@/core/encoding'
import { confirmsTail, tryRecipient, type Recipient } from '@/core/recipient'
import { familyOfVm } from '@/core/addressBook'
import { BookPicker, bookConfirms, BookVerdictNote, bookRefuses, RecipientBookAfterSend, useBookVerdict } from './components/RecipientBook'
import type { SuspiciousFlag } from '@/core/types'
import { standardLabel } from '@/protocols/lz-v1/abi'
import type { OftV1Info } from '@/protocols/lz-v1/detect'
import { isV1Pending, runV1Guards, v1AdapterParamsSummary, type V1GuardInput, type V1GuardResult } from '@/protocols/lz-v1/guards'
import { encodeV1SendCalldata } from '@/protocols/lz-v1/plan'
import { v1ApprovePlan } from '@/protocols/lz-v1/simulate'
import { submitV1Send, V1SendRefused } from '@/protocols/lz-v1/send'
import { v1SelfCheck } from '@/protocols/lz-v1/selfcheck'
import { formatRevert } from '@/core/sim/revert'
import { fmt, useDict, type Dict } from '@/i18n'
import { Address as AddressView } from './components/Address'
import { Panel, TwoColumn } from './components/Layout'
import { Tracker } from './components/Tracker'
import { Alert, AmountInput, Box, BoxLabel, Input, Row, Select, Spinner } from './components/ui'
import { isUserRejection, shortError, useAllowance, useNativeBalance, useTokenBalance } from './hooks'
import { pushHistory, setHistoryStatus, type Stored } from './storage'
import { useV1PeerBack, useV1Plan, useV1Simulation, useV1StoredPayload } from './v1Hooks'
import { useV1RouteRisk } from './riskHooks'
import { RiskChecks } from './components/RiskPanel'
import { RouteIndicator } from './components/RouteIndicator'
import { Cta, type CtaState } from './components/Review'

const GUARD_LABEL = (d: Dict, code: string): string => (d.v1Guard as Record<string, string>)[code] ?? code

/** The guard list for the details fold: blocks in red, the approve step neutral, notes in amber, reads in flight in grey. */
function V1Checks({ results }: { results: V1GuardResult[] }) {
  const d = useDict()
  const failing = results.filter((r) => !r.ok && !isV1Pending(r) && !isStepCode(r.code) && !isNoteCode(r.code))
  const noted = results.filter((r) => !r.ok && isNoteCode(r.code))
  const stepping = results.filter((r) => !r.ok && isStepCode(r.code))
  const pending = results.filter((r) => isV1Pending(r))
  const passing = results.filter((r) => r.ok).length
  const tone = (r: V1GuardResult) => (isV1Pending(r) ? 'text-muted' : r.ok ? 'text-ok' : isStepCode(r.code) ? 'text-ink' : isNoteCode(r.code) ? 'text-warn' : 'text-danger')
  const glyph = (r: V1GuardResult) => (isV1Pending(r) ? '○' : r.ok ? '✓' : isStepCode(r.code) ? '→' : isNoteCode(r.code) ? '●' : '✗')
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold text-muted">
        {pending.length ? (
          <span className="inline-flex items-center gap-2">
            <Spinner /> {fmt(d.ui.checksPending, { done: passing, total: results.length })}
          </span>
        ) : (
          `${d.ui.checks}: ${passing}/${results.length}`
        )}
      </div>
      {[...failing, ...stepping, ...noted, ...pending].map((r) => (
        <div key={r.id} className={`text-xs ${tone(r)}`}>
          {glyph(r)} {!r.ok ? GUARD_LABEL(d, r.code) : null}
          {!r.ok && r.detail ? <span className="mono ml-1 opacity-70">{r.detail}</span> : null}
        </div>
      ))}
    </div>
  )
}

export function BridgeV1({
  src,
  info,
  flags,
  stored,
  setStored,
  onReset,
}: {
  src: EvmChainDef
  info: OftV1Info
  flags: readonly SuspiciousFlag[]
  stored: Stored
  setStored: (s: Stored) => void
  onReset: () => void
}) {
  const d = useDict()
  const { address: wallet, chainId: walletChainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()

  const [dstKey, setDstKey] = useState<ChainKey | undefined>(info.routes[0]?.key)
  const [amountInput, setAmountInput] = useState('')
  const [recipientCustom, setRecipientCustom] = useState(false)
  const [recipientInput, setRecipientInput] = useState('')
  const [confirmLast6, setConfirmLast6] = useState('')
  const [slippageBps, setSlippageBps] = useState(0)
  const [feeBufferBps] = useState(1000) // +10%: v1 refunds the excess to the sender
  const [txError, setTxError] = useState('')
  const [sent, setSent] = useState<{ txHash: string; dstKey: ChainKey; at: number } | null>(null)

  // The contract decided at probe time; a route change never re-opens that question.
  useEffect(() => {
    if (dstKey && !info.routes.some((r) => r.key === dstKey)) setDstKey(info.routes[0]?.key)
  }, [info, dstKey])

  const recipient: Recipient | undefined = useMemo(() => {
    const raw = recipientCustom ? recipientInput : (wallet ?? '')
    const r = tryRecipient('evm', raw)
    return r.ok ? r.recipient : undefined
  }, [recipientCustom, recipientInput, wallet])

  // The plan is built twice on purpose. The first pass buys the gas the contract's own
  // `minDstGasLookup` demands; once §4's destination simulation has measured what the credit really
  // costs, the second pass buys `max(minimum, estimate × 1.3)` instead. There is no loop in that:
  // the simulation does not depend on the adapter params it informs, and the risk query's key is
  // the route and the amount, neither of which this changes.
  const [dstGasEstimate, setDstGasEstimate] = useState<bigint | undefined>(undefined)
  const plan = useV1Plan({
    info,
    dstKey,
    amountInput,
    sender: wallet,
    recipient,
    slippageBps,
    feeBufferBps,
    dstGasEstimate,
  })
  const planData = plan.data

  const tokenBalance = useTokenBalance(src, info.token, wallet)
  const nativeBalance = useNativeBalance(src, wallet)
  const allowance = useAllowance(src, info.approvalRequired ? info.token : undefined, wallet, info.oft)
  const simulation = useV1Simulation(planData, allowance.data, stored.customRpc[src.key])
  // Guard 8 needs the cost of the send in native coin, which is gas × price. The price is read
  // from the chain rather than assumed: a placeholder would make the check pass on a chain where
  // gas actually costs an order of magnitude more, and the transaction would run out of it.
  const gasPrice = useGasPrice({ chainId: src.chainId })
  const peerBack = useV1PeerBack(info, dstKey, stored.customRpc)
  const storedPayload = useV1StoredPayload(info, dstKey, stored.customRpc)
  // §4 Same rule as the V2 tab: one operator's answers are not a cross-check.
  const linkCrossChecked = !flags.includes('not_cross_checked')
  const risk = useV1RouteRisk(info, planData, stored.customRpc, linkCrossChecked)
  useEffect(() => {
    const gas = risk.data?.dstGasEstimate
    if (gas !== undefined && gas !== dstGasEstimate) setDstGasEstimate(gas)
  }, [risk.data?.dstGasEstimate, dstGasEstimate])

  const selfCheck = useMemo(() => (planData ? v1SelfCheck(planData, encodeV1SendCalldata(planData)) : undefined), [planData])
  const approveIntent = useMemo(
    () => (planData ? v1ApprovePlan(planData, info.approvalRequired, allowance.data) : null),
    [planData, info.approvalRequired, allowance.data],
  )

  // §Address book. LayerZero v1 routes in this app are EVM to EVM.
  const bookFamily = familyOfVm('evm')
  const bookVerdict = useBookVerdict(bookFamily, recipientCustom ? recipient?.display : undefined)

  const last6Ok = !recipientCustom || (recipient !== undefined && (bookConfirms(bookVerdict) || confirmsTail(recipient, confirmLast6)))

  const riskError = risk.error ? shortError(risk.error) : undefined
  // `guardInput` is what the click re-runs, so it carries everything the render judged.
  const guardInput: V1GuardInput = {
    walletAddress: wallet,
    walletChainId,
    srcChainId: src.chainId,
    info,
    plan: planData,
    recipientIsCustom: recipientCustom,
    customRecipientConfirmed: last6Ok,
    recipientLookalike: bookRefuses(bookVerdict),
    tokenBalance: tokenBalance.data,
    nativeBalance: nativeBalance.data?.value,
    allowance: info.approvalRequired ? allowance.data : 0n,
    gasCostWei:
      simulation.data?.status === 'ok' && simulation.data.gas !== undefined && gasPrice.data !== undefined
        ? simulation.data.gas * gasPrice.data
        : undefined,
    ...(approveIntent ? { approveIntent } : {}),
    simulation: simulation.data,
    selfCheck,
    flags,
    peerBack: peerBack.data,
    storedPayload: storedPayload.data,
    risk: risk.data?.risk,
    riskError,
  }
  const report = runV1Guards(guardInput)
  // The line under the button names the impossibility, if there is one. Notes are the indicator's.
  const impossible = shownFailures(report.blocks, { dropPending: true, dropSteps: true })[0]

  // The route indicator: one colour from everything above. It decides nothing (core/indicator.ts).
  const indicator = assessIndicator({
    hasDestination: dstKey !== undefined,
    hasPlan: !!planData,
    results: report.results,
    label: (c) => GUARD_LABEL(d, c),
    flags: report.warnings,
    flagLabel: (f) => (d.card as Record<string, string>)[`flag_${f}`] ?? f,
    risk: risk.data?.risk,
    riskCovered: true,
    riskPending: risk.isFetching,
    riskError,
  })

  const sendWrite = useWriteContract()
  // The flow signs approve(spender, amount) for exactly the intent the guards checked, waits for
  // the receipt and reads the allowance back; the button becomes Send by itself.
  const approveFlow = useApproveFlow({
    chainId: src.chainId,
    owner: wallet,
    token: info.approvalRequired ? info.token : undefined,
    spender: approveIntent?.spender,
    amount: approveIntent?.amount,
    allowance: allowance.data,
    refetchAllowance: async () => (await allowance.refetch()).data,
  })

  const onApprove = () => {
    setTxError('')
    // Re-derive at click time and re-check the spender, exactly as the other three tabs do
    // (BridgeApp, NttApp, CcipApp). `approveIntent` above is a render value; this is the one that
    // reaches the wallet, so this is where it has to be true.
    if (!planData) return
    const intent = v1ApprovePlan(planData, info.approvalRequired, allowance.data)
    if (!intent) return
    if (!sameAddress(intent.spender, info.oft) || !sameAddress(intent.token, info.token)) return
    if (intent.amount !== planData.amounts.amountLD) return
    // No allowance for a transfer that cannot happen: the approve is a step of THIS transfer.
    if (!waitsOnlyForApprove(runV1Guards(guardInput).blocks)) return
    void approveFlow.start()
  }

  // Not memoised: it reads `guardInput`, which is new every render. A callback kept across renders
  // would judge the guards of the render it was made in, and "at the moment of the click" would be
  // a comment rather than a fact — the other three tabs define theirs the same way.
  const onSend = async () => {
    setTxError('')
    if (!planData || !dstKey) return
    // Re-run every guard against the state at the moment of the click, not at the last render.
    if (!runV1Guards(guardInput).canSend) return
    try {
      const hash = await submitV1Send(sendWrite, planData, src.chainId)
      setSent({ txHash: hash, dstKey, at: Date.now() })
      setStored(
        pushHistory(stored, {
          srcChain: src.key,
          protocol: 'lz-oft',
          // The destination's registry eid names the chain; it is not a claim that this transfer
          // travelled V2. `dstChain` is written too, so nothing has to infer it from the number.
          dstEid: byKey(dstKey).eid,
          dstChain: dstKey,
          oft: info.oft,
          txHash: hash,
          at: Date.now(),
        }),
      )
    } catch (e) {
      if (e instanceof V1SendRefused) {
        setTxError(`${d.v1Guard.selfcheck_failed}${e.mismatches.length ? `: ${e.mismatches.join(', ')}` : ''}`)
        return
      }
      setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e))
    }
  }

  const chainMismatch = walletChainId !== undefined && walletChainId !== src.chainId
  // Connect wallet → Switch to <chain> → Approve <amount> <token> → Send; one impossibility under it.
  const cta: CtaState = !wallet
    ? { kind: 'connect' }
    : chainMismatch
      ? { kind: 'switch', chain: src }
      : !dstKey
        ? { kind: 'destination' }
        : amountInput.trim() === ''
          ? { kind: 'amount' }
          : !recipient
            ? { kind: 'recipient' }
            : !planData
              ? plan.error
                ? { kind: 'send', enabled: false, reason: shortError(plan.error) }
                : { kind: 'quote' }
              : approveIntent
                ? { kind: 'approve', intent: approveIntent, enabled: waitsOnlyForApprove(report.blocks), ...(impossible ? { reason: GUARD_LABEL(d, impossible.code) } : {}) }
                : !report.canSend && report.results.every((r) => r.ok || isV1Pending(r))
                  ? { kind: 'checking' }
                  : { kind: 'send', enabled: report.canSend, ...(impossible ? { reason: GUARD_LABEL(d, impossible.code) } : {}) }
  const onCta = () => {
    switch (cta.kind) {
      case 'switch':
        switchChain({ chainId: src.chainId })
        return
      case 'approve':
        onApprove()
        return
      case 'send':
        void onSend()
        return
      default:
        return
    }
  }
  const adapter = planData ? v1AdapterParamsSummary(planData.adapterParams) : undefined
  const route = info.routes.find((r) => r.key === dstKey)
  const feeStr = planData ? `${formatAmount(planData.value, 18, { maxFraction: 6 })} ${src.nativeSymbol}` : ''

  if (sent) {
    return (
      <Panel title={d.v1.badge}>
        <Tracker
          src={src}
          dstEid={byKey(sent.dstKey).eid}
          txHash={sent.txHash}
          startedAt={sent.at}
          restored={false}
          customRpc={stored.customRpc[src.key]}
          onFinal={(phase) => {
            setStored(setHistoryStatus(stored, sent.txHash, phase))
          }}
          onNew={() => {
            setSent(null)
            onReset()
          }}
        />
        <RecipientBookAfterSend family={bookFamily} address={recipientCustom ? recipient?.display : undefined} />
        <p className="mt-3 text-xs text-muted">{d.v1.sentHint}</p>
      </Panel>
    )
  }

  const left = (
    <div className="space-y-4">
      <Panel title={d.ui.section_contract} badge={<span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-muted">{standardLabel(info.standard)}</span>}>
        <div className="space-y-2">
          <Row label={d.ui.token}>
            <span className="mono">
              {info.symbol} · {info.decimals} decimals
            </span>
          </Row>
          <Row label="OFT" mono>
            <AddressView value={info.oft} href={src.explorerAddrUrl + info.oft} short />
          </Row>
          {info.token.toLowerCase() !== info.oft.toLowerCase() ? (
            <Row label={d.ui.token} mono>
              <AddressView value={info.token} href={src.explorerAddrUrl + info.token} short />
            </Row>
          ) : null}
          <Row label={d.v1.endpoint} mono>
            <AddressView value={info.endpoint} href={src.explorerAddrUrl + info.endpoint} short />
          </Row>
          <Row label={d.v1.v1ChainId} mono>
            {info.srcV1ChainId}
          </Row>
          {info.sharedDecimals !== undefined ? (
            <Row label="sharedDecimals" mono>
              {info.sharedDecimals}
            </Row>
          ) : null}
          <p className="pt-1 text-xs text-muted">{d.v1.endpointNote}</p>
        </div>
      </Panel>

      <Panel title={d.ui.to}>
        <div className="space-y-3">
          <Box>
            <BoxLabel>{d.v1.destination}</BoxLabel>
            <Select value={dstKey ?? ''} onChange={(e) => setDstKey(e.target.value as ChainKey)}>
              {info.routes.map((r) => (
                <option key={r.key} value={r.key}>
                  {byKey(r.key).name} · v1 {r.v1ChainId}
                </option>
              ))}
            </Select>
          </Box>

          <Box>
            <BoxLabel right={tokenBalance.data !== undefined ? <span className="mono text-xs">{formatAmount(tokenBalance.data, info.decimals, { maxFraction: 6 })}</span> : null}>
              {d.v1.amount}
            </BoxLabel>
            <AmountInput value={amountInput} onChange={(e) => setAmountInput(e.target.value)} placeholder="0.0" inputMode="decimal" />
          </Box>

          <Box>
            <BoxLabel>{d.v1.recipient}</BoxLabel>
            {recipientCustom ? (
              <div className="space-y-2">
                <div className="flex items-center justify-end">
                  <BookPicker family={bookFamily} onPick={(a) => { setRecipientInput(a); setConfirmLast6('') }} />
                </div>
                <Input value={recipientInput} onChange={(e) => { setRecipientInput(e.target.value); setConfirmLast6('') }} placeholder="0x…" spellCheck={false} />
                {recipient ? <BookVerdictNote verdict={bookVerdict} /> : null}
                {recipient && !bookConfirms(bookVerdict) ? (
                  <Input value={confirmLast6} onChange={(e) => setConfirmLast6(e.target.value)} placeholder={d.v1.confirmLast6} spellCheck={false} />
                ) : null}
              </div>
            ) : (
              <div className="mono text-sm">{wallet ?? '—'}</div>
            )}
            <label className="mt-2 flex items-start gap-2 text-xs text-ink">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={recipientCustom}
                onChange={(e) => {
                  setRecipientCustom(e.target.checked)
                  setConfirmLast6('')
                }}
              />
              {d.v1.confirmRecipient}
            </label>
            <p className="mt-1 text-xs text-muted">{d.v1.recipientNote}</p>
          </Box>

          {info.standard.wire === 'bytes32_fee' ? (
            <Box>
              <BoxLabel>{d.v1.slippage}</BoxLabel>
              <Select value={String(slippageBps)} onChange={(e) => setSlippageBps(Number(e.target.value))}>
                <option value="0">0%</option>
                <option value="50">0.5%</option>
                <option value="100">1%</option>
                <option value="300">3%</option>
                <option value="500">5%</option>
              </Select>
            </Box>
          ) : (
            <p className="text-xs text-muted">{d.v1.noMinAmount}</p>
          )}
        </div>
      </Panel>
    </div>
  )

  const right = (
    <Panel title={d.ui.preview}>
      <div className="space-y-3">
        {plan.error ? <Alert kind="error">{shortError(plan.error)}</Alert> : null}
        {planData ? (
          <>
            <Row label={d.v1.sends} mono>
              {formatAmount(planData.amounts.amountLD, info.decimals, { maxFraction: 8 })} {info.symbol}
            </Row>
            {planData.amounts.oftFee > 0n ? (
              <Row label={d.v1.oftFee} mono>
                {formatAmount(planData.amounts.oftFee, info.decimals, { maxFraction: 8 })} {info.symbol}
              </Row>
            ) : null}
            <Row label={d.v1.arrives} mono>
              {formatAmount(planData.amounts.delivered, info.decimals, { maxFraction: 8 })} {info.symbol}
            </Row>
            {planData.amounts.dustTrimmed > 0n ? (
              <Row label={d.v1.dust} mono>
                {formatAmount(planData.amounts.dustTrimmed, info.decimals, { maxFraction: 18 })}
              </Row>
            ) : null}
            {planData.amounts.minAmountLD !== undefined ? (
              <Row label={d.v1.minAmount} mono>
                {formatAmount(planData.amounts.minAmountLD, info.decimals, { maxFraction: 8 })}
              </Row>
            ) : null}
            <Row label={d.v1.fee} mono>
              {feeStr}
            </Row>
            <p className="text-xs text-muted">{d.v1.feeBuffer}</p>
            <Row label={d.v1.toWire} mono>
              <span className="break-all text-xs">{planData.toWire}</span>
            </Row>
            <p className="text-xs text-muted">{info.standard.wire === 'bytes' ? d.v1.wireBytes : d.v1.wireBytes32}</p>
            <Row label={d.v1.adapterParams} mono>
              {adapter?.empty ? d.v1.adapterEmpty : adapter ? fmt(d.v1.adapterGas, { gas: adapter.gas.toString() }) : '—'}
            </Row>
            {route && route.minDstGas > 0n ? <p className="text-xs text-muted">{fmt(d.v1.adapterMin, { gas: route.minDstGas.toString() })}</p> : null}
          </>
        ) : (
          <p className="text-xs text-muted">{d.ui.previewEmpty}</p>
        )}

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{d.risk.title}</div>
          <RouteIndicator indicator={indicator} noneText={dstKey === undefined ? d.indicator.chooseDestination : d.indicator.enterAmount}>
            <RiskChecks risk={risk.data?.risk} loading={risk.isFetching} error={riskError ?? ''} />
            <V1Checks results={report.results} />
            {simulation.data?.status === 'reverted' ? <p className="mono text-xs text-warn">{formatRevert(simulation.data.revert)}</p> : null}
          </RouteIndicator>
        </div>

        <Cta
          state={cta}
          info={info}
          sending={switching || sendWrite.isPending}
          approve={{ phase: approveFlow.phase, explorerTxUrl: src.explorerTxUrl }}
          onClick={onCta}
          error={txError}
        />
      </div>
    </Panel>
  )

  return <TwoColumn left={left} right={right} />
}
