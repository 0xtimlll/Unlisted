'use client'
import { useState } from 'react'
import { formatAmount } from '@/core/amounts'
import { byEid, type ChainDef } from '@/core/chains'
import type { ApproveIntent, GuardReport } from '@/core/guards'
import type { SendPlan } from '@/core/plan'
import type { OftInfo } from '@/core/types'
import { fmt, useDict } from '@/i18n'
import { Address } from './Address'
import type { DestinationState } from './FromTo'
import { Alert, Button, Disclosure, Input, Row, Spinner } from './ui'

/** Quote breakdown + advanced settings. Collapsed by default, like Relay's fee row. */
export function Details(p: { src: ChainDef; info: OftInfo; plan: SendPlan | undefined; state: DestinationState; onChange: (s: DestinationState) => void }) {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const [adv, setAdv] = useState(false)
  const plan = p.plan
  const dec = p.info.decimals
  const sym = p.info.symbol
  const native = p.src.nativeSymbol
  const dst = plan ? byEid(plan.dstEid) : undefined
  const set = (patch: Partial<DestinationState>) => p.onChange({ ...p.state, ...patch })

  const summary = plan ? (
    <span className="tnum text-ink">
      {d.step3.lzFee}: {formatAmount(plan.quote.nativeFee, 18, { maxFraction: 6 })} {native}
    </span>
  ) : (
    d.ui.details
  )

  return (
    <div className="px-1">
      <Disclosure title={summary} open={open} onToggle={() => setOpen(!open)}>
        <div className="rounded-xl bg-surface-2 px-3 py-1">
          {plan ? (
            <>
              <Row label={d.step3.sending}>
                <b className="tnum">{formatAmount(plan.amounts.amountLD, dec)} {sym}</b>
                <div className="mono text-[11px] text-muted">amountLD {plan.amounts.amountLD.toString()}</div>
              </Row>
              <Row label={d.step3.receiveMin}>
                <b className="tnum">{formatAmount(plan.amounts.minAmountLD, dec)} {sym}</b>
                <div className="mono text-[11px] text-muted">minAmountLD {plan.amounts.minAmountLD.toString()}</div>
              </Row>
              {plan.quote.amountReceivedLD !== plan.amounts.amountLD ? (
                <Row label={d.step3.receiveQuoted}>
                  <span className="tnum">{formatAmount(plan.quote.amountReceivedLD, dec)} {sym}</span>
                </Row>
              ) : null}
              <Row label={d.step3.lzFee}>
                <b className="tnum">{formatAmount(plan.quote.nativeFee, 18, { maxFraction: 6 })} {native}</b>
                <div className="text-[11px] text-muted">
                  {fmt(d.step3.feeDetail, {
                    value: `${formatAmount(plan.value, 18, { maxFraction: 6 })} ${native}`,
                    refund: `${formatAmount(plan.value - plan.quote.nativeFee, 18, { maxFraction: 6 })} ${native}`,
                  })}
                </div>
              </Row>
              <Row label={d.step3.contract} mono>
                <Address value={plan.oft} href={p.src.explorerAddrUrl + plan.oft} short />
              </Row>
              <Row label={d.step3.destination}>
                {dst?.name ?? '?'} <span className="text-xs text-muted">(eid {plan.dstEid})</span>
              </Row>
              <Row label={d.step3.recipient} mono>
                <Address value={plan.recipient} href={dst ? dst.explorerAddrUrl + plan.recipient : undefined} short />
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
            </>
          ) : null}
          <Disclosure title={d.step2.advanced} open={adv} onToggle={() => setAdv(!adv)}>
            <div className="grid grid-cols-2 gap-3 pb-2">
              <label className="block text-xs">
                <span className="text-muted">{d.step2.slippage}</span>
                <Input type="number" min={0} max={10000} step={1} value={p.state.slippageBps} onChange={(e) => set({ slippageBps: clampInt(e.target.value, 0, 10000) })} className="mono mt-1 h-9" />
              </label>
              <label className="block text-xs">
                <span className="text-muted">{d.step2.feeBuffer}</span>
                <Input type="number" min={0} max={500} step={1} value={p.state.feeBufferBps / 100} onChange={(e) => set({ feeBufferBps: clampInt(e.target.value, 0, 500) * 100 })} className="mono mt-1 h-9" />
              </label>
              {p.state.extraOptions !== '0x' ? (
                <div className="col-span-2 text-xs">
                  <span className="text-muted">{d.step2.extraOptions}</span>
                  <div className="mono break-all text-ink">{p.state.extraOptions}</div>
                </div>
              ) : null}
            </div>
          </Disclosure>
        </div>
      </Disclosure>
    </div>
  )
}

/** The 16 guards, compact. Only failing ones and the six "meaningful" passes are shown. */
export function Checks(p: { report: GuardReport; noGasAccepted: boolean; onNoGasAccepted: (v: boolean) => void; show: boolean }) {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const failing = p.report.results.filter((r) => !r.ok)
  const passing = p.report.results.filter((r) => r.ok && okLabel(r.id, d))
  if (!p.show) return null
  return (
    <div className="px-1">
      {p.report.needsNoGasConfirmation ? (
        <div className="mb-2 space-y-2">
          <Alert kind="warn">{d.step3.warnNoGas}</Alert>
          <label className="flex items-start gap-2 text-xs text-ink">
            <input type="checkbox" className="mt-0.5" checked={p.noGasAccepted} onChange={(e) => p.onNoGasAccepted(e.target.checked)} />
            {d.step3.confirmNoGas}
          </label>
        </div>
      ) : null}
      {p.report.warnings.length > 0 ? (
        <div className="mb-2">
          <Alert kind="warn">
            {p.report.warnings.map((w) => (
              <div key={w}>⚠ {d.card[`flag_${w}`]}</div>
            ))}
          </Alert>
        </div>
      ) : null}
      <Disclosure
        title={
          <span className={failing.length ? 'text-danger' : 'text-ok'}>
            {failing.length ? `✗ ${d.ui.checks}: ${failing.length}` : `✓ ${d.ui.checks}: ${passing.length}/${passing.length}`}
          </span>
        }
        open={open || failing.length > 0}
        onToggle={() => setOpen(!open)}
      >
        <ul className="grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-2">
          {p.report.results.map((r) => {
            const label = r.ok ? okLabel(r.id, d) : d.guard[r.code]
            if (!label) return null
            return (
              <li key={r.id} className={r.ok ? 'text-ok' : 'text-danger'}>
                {r.ok ? '✓' : '✗'} {label}
                {!r.ok && r.detail && (r.code === 'simulation_failed' || r.code === 'selfcheck_failed') ? (
                  <span className="mono block pl-4 text-[11px] opacity-80">{r.detail}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
      </Disclosure>
    </div>
  )
}

export type CtaState =
  | { kind: 'connect' }
  | { kind: 'switch'; chain: ChainDef }
  | { kind: 'check' }
  | { kind: 'destination' }
  | { kind: 'amount' }
  | { kind: 'quote' }
  | { kind: 'approve'; intent: ApproveIntent }
  | { kind: 'send'; enabled: boolean; reason?: string }

/** One big Relay-style button whose label is the next thing the user must do. */
export function Cta(p: { state: CtaState; info: OftInfo | undefined; busy: boolean; busyLabel: string; onClick: () => void; error: string }) {
  const d = useDict()
  const s = p.state
  const label =
    s.kind === 'connect'
      ? d.ui.cta_connect
      : s.kind === 'switch'
        ? fmt(d.ui.cta_switch, { chain: s.chain.name })
        : s.kind === 'check'
          ? d.ui.cta_check
          : s.kind === 'destination'
            ? d.ui.cta_destination
            : s.kind === 'amount'
              ? d.ui.cta_amount
              : s.kind === 'quote'
                ? d.ui.cta_quote
                : s.kind === 'approve'
                  ? fmt(d.step3.approveBtn, { amount: formatAmount(s.intent.amount, p.info?.decimals ?? 18), symbol: p.info?.symbol ?? '' })
                  : d.ui.cta_send
  const disabled = p.busy || s.kind === 'check' || s.kind === 'destination' || s.kind === 'amount' || s.kind === 'quote' || (s.kind === 'send' && !s.enabled)
  return (
    <div className="space-y-2">
      {p.error ? <Alert kind="error">{p.error}</Alert> : null}
      <Button variant="cta" disabled={disabled} onClick={p.onClick}>
        {p.busy ? (
          <>
            <Spinner /> {p.busyLabel}
          </>
        ) : (
          label
        )}
      </Button>
      {s.kind === 'send' && !s.enabled && s.reason ? <div className="text-center text-xs text-muted">{s.reason}</div> : null}
      <div className="text-center text-[11px] text-faint">{d.step3.simulationHint}</div>
    </div>
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

function clampInt(v: string, lo: number, hi: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}
