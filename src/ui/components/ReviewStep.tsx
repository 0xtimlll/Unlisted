'use client'
import { formatAmount } from '@/core/amounts'
import { byEid, type ChainDef } from '@/core/chains'
import type { ApproveIntent, GuardReport } from '@/core/guards'
import type { SendPlan } from '@/core/plan'
import type { OftInfo } from '@/core/types'
import { fmt, useDict } from '@/i18n'
import { Address } from './Address'
import { Alert, Button, Card, H2, Row, Spinner } from './ui'

export function ReviewStep(p: {
  src: ChainDef
  info: OftInfo
  plan: SendPlan | undefined
  planError: string
  report: GuardReport
  approve: ApproveIntent | null
  noGasAccepted: boolean
  onNoGasAccepted: (v: boolean) => void
  onApprove: () => void
  onSend: () => void
  approving: boolean
  sending: boolean
  txError: string
}) {
  const d = useDict()
  const plan = p.plan
  const dst = plan ? byEid(plan.dstEid) : undefined
  const failing = p.report.results.filter((r) => !r.ok)
  const sym = p.info.symbol
  const dec = p.info.decimals
  const native = p.src.nativeSymbol

  return (
    <Card>
      <H2>{d.step3.title}</H2>
      {p.planError ? <Alert kind="error">{p.planError}</Alert> : null}
      {plan ? (
        <div className="space-y-0.5">
          <Row label={d.step3.sending}>
            <b className="mono">{formatAmount(plan.amounts.amountLD, dec)} {sym}</b>
            <span className="mono ml-2 text-xs opacity-60">amountLD {plan.amounts.amountLD.toString()}</span>
          </Row>
          <Row label={d.step3.receiveMin}>
            <b className="mono">{formatAmount(plan.amounts.minAmountLD, dec)} {sym}</b>
            <span className="mono ml-2 text-xs opacity-60">minAmountLD {plan.amounts.minAmountLD.toString()}</span>
          </Row>
          {plan.quote.amountReceivedLD !== plan.amounts.amountLD ? (
            <Row label={d.step3.receiveQuoted}>
              <span className="mono">{formatAmount(plan.quote.amountReceivedLD, dec)} {sym}</span>
            </Row>
          ) : null}
          <Row label={d.step3.lzFee}>
            <b className="mono">{formatAmount(plan.quote.nativeFee, 18, { maxFraction: 6 })} {native}</b>
            <span className="ml-2 text-xs opacity-60">
              (
              {fmt(d.step3.feeDetail, {
                value: `${formatAmount(plan.value, 18, { maxFraction: 6 })} ${native}`,
                refund: `${formatAmount(plan.value - plan.quote.nativeFee, 18, { maxFraction: 6 })} ${native}`,
              })}
              )
            </span>
          </Row>
          <Row label={d.step3.contract} mono>
            <Address value={plan.oft} href={p.src.explorerAddrUrl + plan.oft} short />
          </Row>
          <Row label={d.step3.destination}>
            {dst?.name ?? '?'} <span className="text-xs opacity-60">(eid {plan.dstEid})</span>
          </Row>
          <Row label={d.step3.recipient} mono>
            <Address value={plan.recipient} href={dst ? dst.explorerAddrUrl + plan.recipient : undefined} />
            {plan.recipient.toLowerCase() === plan.sender.toLowerCase() ? <span className="ml-2 text-xs opacity-60">{d.step2.yourWallet}</span> : null}
          </Row>
          <Row label={d.step3.refund} mono>
            <Address value={plan.sender} short />
          </Row>
          {plan.quote.feeDetails.length > 0 ? (
            <Row label={d.step3.feeDetails}>
              <ul className="mono text-xs">
                {plan.quote.feeDetails.map((f, i) => (
                  <li key={i}>
                    {formatAmount(f.amountLD, dec)} {sym} — {f.description}
                  </li>
                ))}
              </ul>
            </Row>
          ) : null}
          {plan.quote.limitMaxLD < 2n ** 128n ? (
            <Row label={d.step3.limits}>
              <span className="mono text-xs">
                {formatAmount(plan.quote.limitMinLD, dec)} … {formatAmount(plan.quote.limitMaxLD, dec)} {sym}
              </span>
            </Row>
          ) : null}
        </div>
      ) : null}

      {p.report.needsNoGasConfirmation ? (
        <div className="mt-3 space-y-2">
          <Alert kind="warn">{d.step3.warnNoGas}</Alert>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={p.noGasAccepted} onChange={(e) => p.onNoGasAccepted(e.target.checked)} />
            {d.step3.confirmNoGas}
          </label>
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-1 text-xs opacity-60">{d.step3.checks}</div>
        <ul className="grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-2">
          {p.report.results.map((r) => {
            const label = r.ok ? okLabel(r.id, d) : d.guard[r.code]
            if (!label) return null
            return (
              <li key={r.id} className={r.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}>
                {r.ok ? '✓' : '✗'} {label}
                {!r.ok && r.detail && (r.code === 'simulation_failed' || r.code === 'selfcheck_failed') ? (
                  <span className="mono block pl-4 text-xs opacity-70">{r.detail}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
        {p.report.warnings.length > 0 ? (
          <div className="mt-2">
            <Alert kind="warn">
              {p.report.warnings.map((w) => (
                <div key={w}>⚠ {d.card[`flag_${w}`]}</div>
              ))}
            </Alert>
          </div>
        ) : null}
      </div>

      {p.txError ? (
        <div className="mt-3">
          <Alert kind="error">{p.txError}</Alert>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {p.approve ? (
          <Button variant="primary" onClick={p.onApprove} disabled={p.approving || p.sending}>
            {p.approving ? (
              <>
                <Spinner /> {d.step3.approving}
              </>
            ) : (
              fmt(d.step3.approveBtn, { amount: formatAmount(p.approve.amount, dec), symbol: sym })
            )}
          </Button>
        ) : null}
        <Button variant="primary" onClick={p.onSend} disabled={!p.report.canSend || p.sending || p.approving || failing.length > 0}>
          {p.sending ? (
            <>
              <Spinner /> {d.step3.sending_}
            </>
          ) : (
            d.step3.sendBtn
          )}
        </Button>
        <span className="self-center text-xs opacity-60">{d.step3.simulationHint}</span>
      </div>
    </Card>
  )
}

function okLabel(id: number, d: ReturnType<typeof useDict>): string | null {
  switch (id) {
    case 2:
      return d.guard.ok_peer
    case 5:
      return d.guard.ok_balance
    case 8:
      return d.guard.ok_native
    case 9:
      return d.guard.ok_quote
    case 13:
      return d.guard.ok_sim
    case 14:
      return d.guard.ok_selfcheck
    default:
      return null
  }
}
