'use client'
/**
 * The LayerZero **v1** form, inside the OFT tab.
 *
 * A separate component rather than a branch inside BridgeApp, for one reason: the V2 path is what
 * people already use, and it does not change shape because v1 exists. Everything v1 needs that V2
 * does not — a `bytes` recipient, adapter params, a stuck-payload check on the destination — lives
 * here, and the V2 screen is left exactly as it was.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { erc20Abi } from 'viem'
import { useAccount, useGasPrice, useSwitchChain, useWriteContract } from 'wagmi'
import { byKey, type ChainKey, type EvmChainDef } from '@/core/chains'
import { formatAmount } from '@/core/amounts'
import { tryRecipient, type Recipient } from '@/core/recipient'
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
import { Alert, AmountInput, Box, BoxLabel, Button, Input, Row, Select, Spinner } from './components/ui'
import { isUserRejection, shortError, useAllowance, useNativeBalance, useTokenBalance } from './hooks'
import { pushHistory, setHistoryStatus, type Stored } from './storage'
import { useV1PeerBack, useV1Plan, useV1Simulation, useV1StoredPayload } from './v1Hooks'

const GUARD_LABEL = (d: Dict, code: string): string => (d.v1Guard as Record<string, string>)[code] ?? code

/** The guard list, compact: real failures in red, reads still in flight in grey, passes in green. */
function V1Checks({ results }: { results: V1GuardResult[] }) {
  const d = useDict()
  const failing = results.filter((r) => !r.ok && !isV1Pending(r))
  const pending = results.filter((r) => isV1Pending(r))
  const passing = results.filter((r) => r.ok).length
  return (
    <div className="space-y-1.5">
      <div className="text-xs">
        {failing.length ? (
          <span className="text-danger">✗ {fmt(d.ui.checksIssues, { n: failing.length })}</span>
        ) : pending.length ? (
          <span className="inline-flex items-center gap-2 text-muted">
            <Spinner /> {fmt(d.ui.checksPending, { done: passing, total: results.length })}
          </span>
        ) : (
          <span className="text-ok">
            ✓ {d.ui.checks}: {passing}/{results.length}
          </span>
        )}
      </div>
      {[...failing, ...pending].map((r) => (
        <div key={r.id} className={`text-xs ${isV1Pending(r) ? 'text-muted' : 'text-danger'}`}>
          {!r.ok ? GUARD_LABEL(d, r.code) : null}
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
  const [peerBackAccepted, setPeerBackAccepted] = useState(false)
  const [storedPayloadAccepted, setStoredPayloadAccepted] = useState(false)
  const [highFeeAccepted, setHighFeeAccepted] = useState(false)
  const [txError, setTxError] = useState('')
  // Empty on a token that has never had a limit set — there is no sensible default for "a small
  // amount of this token", so an unverified route sends nothing until the number is chosen.
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

  const plan = useV1Plan({
    info,
    dstKey,
    amountInput,
    sender: wallet,
    recipient,
    slippageBps,
    feeBufferBps,
    dstGasEstimate: undefined,
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
  const selfCheck = useMemo(() => (planData ? v1SelfCheck(planData, encodeV1SendCalldata(planData)) : undefined), [planData])
  const approveIntent = useMemo(
    () => (planData ? v1ApprovePlan(planData, info.approvalRequired, allowance.data) : null),
    [planData, info.approvalRequired, allowance.data],
  )

  const last6Ok = !recipientCustom || (recipient !== undefined && confirmLast6.toLowerCase() === recipient.display.slice(-6).toLowerCase())

  const guardInput: V1GuardInput = {
    walletAddress: wallet,
    walletChainId,
    srcChainId: src.chainId,
    info,
    plan: planData,
    recipientIsCustom: recipientCustom,
    customRecipientConfirmed: last6Ok,
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
    peerBackUnavailableAccepted: peerBackAccepted,
    storedPayload: storedPayload.data,
    storedPayloadUnavailableAccepted: storedPayloadAccepted,
    highFeeAccepted,
  }
  const report = runV1Guards(guardInput)

  const approveWrite = useWriteContract()
  const sendWrite = useWriteContract()

  const onApprove = () => {
    if (!approveIntent) return
    setTxError('')
    approveWrite.writeContract(
      {
        address: approveIntent.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [approveIntent.spender, approveIntent.amount],
        chainId: src.chainId,
      },
      {
        onSuccess: () => void allowance.refetch(),
        onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)),
      },
    )
  }

  const onSend = useCallback(async () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planData, dstKey, src, info.oft, stored])

  const chainMismatch = walletChainId !== undefined && walletChainId !== src.chainId
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
          onFinal={(phase) => setStored(setHistoryStatus(stored, sent.txHash, phase))}
          onNew={() => {
            setSent(null)
            onReset()
          }}
        />
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
                <Input value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} placeholder="0x…" spellCheck={false} />
                <Input value={confirmLast6} onChange={(e) => setConfirmLast6(e.target.value)} placeholder={d.v1.confirmLast6} spellCheck={false} />
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
            {simulation.data?.status === 'reverted' ? <Alert kind="error">{formatRevert(simulation.data.revert)}</Alert> : null}
          </>
        ) : (
          <p className="text-xs text-muted">{d.ui.previewEmpty}</p>
        )}

        {report.needsHighFeeConfirmation ? (
          <div className="space-y-2">
            <Alert kind="warn">{fmt(d.v1.warnHighFee, { fee: feeStr, chain: src.name })}</Alert>
            <label className="flex items-start gap-2 text-xs text-ink">
              <input type="checkbox" className="mt-0.5" checked={highFeeAccepted} onChange={(e) => setHighFeeAccepted(e.target.checked)} />
              {d.v1.confirmHighFee}
            </label>
          </div>
        ) : null}
        {peerBack.data?.status === 'unavailable' ? (
          <div className="space-y-2">
            <Alert kind="warn">{d.v1.warnPeerBack}</Alert>
            <label className="flex items-start gap-2 text-xs text-ink">
              <input type="checkbox" className="mt-0.5" checked={peerBackAccepted} onChange={(e) => setPeerBackAccepted(e.target.checked)} />
              {d.v1.confirmPeerBack}
            </label>
          </div>
        ) : null}
        {storedPayload.data?.status === 'unavailable' ? (
          <div className="space-y-2">
            <Alert kind="warn">{d.v1.warnStoredPayload}</Alert>
            <label className="flex items-start gap-2 text-xs text-ink">
              <input type="checkbox" className="mt-0.5" checked={storedPayloadAccepted} onChange={(e) => setStoredPayloadAccepted(e.target.checked)} />
              {d.v1.confirmStoredPayload}
            </label>
          </div>
        ) : null}

        <V1Checks results={report.results} />

        {txError ? <Alert kind="error">{txError}</Alert> : null}
        {chainMismatch ? (
          <Button variant="cta" disabled={switching} onClick={() => switchChain({ chainId: src.chainId })}>
            {fmt(d.ui.cta_switch, { chain: src.name })}
          </Button>
        ) : approveIntent ? (
          <Button variant="cta" disabled={approveWrite.isPending} onClick={onApprove}>
            {approveWrite.isPending ? (
              <>
                <Spinner /> {d.ui.cta_checking}
              </>
            ) : (
              fmt(d.step3.approveBtn, { amount: formatAmount(approveIntent.amount, info.decimals), symbol: info.symbol })
            )}
          </Button>
        ) : (
          <Button variant="cta" disabled={!report.canSend || sendWrite.isPending} onClick={() => void onSend()}>
            {sendWrite.isPending ? (
              <>
                <Spinner /> {d.ui.cta_checking}
              </>
            ) : (
              d.ui.cta_send
            )}
          </Button>
        )}
      </div>
    </Panel>
  )

  return <TwoColumn left={left} right={right} />
}
