'use client'
import { useState } from 'react'
import { formatAmount } from '@/core/amounts'
import { classifyFee, formatBps, issuerFee } from '@/core/oftFee'
import { describeOptions, receiveTotals, type OptionItem } from '@/core/options'
import { byEid, type ChainDef } from '@/core/chains'
import { isPending, type ApproveIntent, type GuardReport } from '@/core/guards'
import { approveBusy, type ApprovePhase } from '@/core/approveFlow'
import { isNoteCode, isStepCode } from '@/core/severity'
import type { SendPlan } from '@/core/plan'
import type { SvmOptionsPlan } from '@/core/options'
import type { SvmOftInfo } from '@/core/svm/discover'
import { BASE_FEE_LAMPORTS, svmTxFee } from '@/core/svm/fees'
import type { SourceInfo } from '@/core/types'
import { fmt, useDict } from '@/i18n'
import { Address } from './Address'
import type { DestinationState } from './FromTo'
import { guardLabel, type FeeContext } from '../guardLabel'
import { WalletIcon } from './icons'
import { Button, Disclosure, Input, Row, Spinner } from './ui'

/** Quote breakdown + advanced settings. Collapsed by default, like Relay's fee row. */
export function Details(p: {
  src: ChainDef
  info: SourceInfo
  plan: SendPlan | undefined
  state: DestinationState
  onChange: (s: DestinationState) => void
  svmOptions?: SvmOptionsPlan | undefined
  svmInfo?: SvmOftInfo | undefined
  /** Right-hand panel: show the breakdown expanded, without the summary toggle. */
  flat?: boolean
}) {
  const d = useDict()
  const [open, setOpen] = useState(false)
  const [adv, setAdv] = useState(false)
  const plan = p.plan
  const dec = p.info.decimals
  const sym = p.info.symbol
  const native = p.src.nativeSymbol
  // Native decimals: wei on EVM, lamports on Solana.
  const nd = p.src.vm === 'svm' ? 9 : 18
  const fmtNative = (v: bigint) => `${formatAmount(v, nd, { maxFraction: 6 })} ${native}`
  const dst = plan ? byEid(plan.dstEid) : undefined
  const set = (patch: Partial<DestinationState>) => p.onChange({ ...p.state, ...patch })

  const summary = plan ? (
    <span className="tnum text-ink">
      {d.step3.lzFee}: {fmtNative(plan.quote.nativeFee)}
    </span>
  ) : (
    d.ui.details
  )

  const body = (
    <div>
          {plan ? (
            <>
              <Row label={d.step3.sending}>
                <b className="tnum">{formatAmount(plan.amounts.amountLD, dec)} {sym}</b>
                <div className="mono text-xs text-muted">amountLD {plan.amounts.amountLD.toString()}</div>
              </Row>
              <IssuerFeeRow plan={plan} dec={dec} sym={sym} />
              <Row label={d.step3.youReceive}>
                {plan.quote.unavailable ? (
                  <span className="text-warn">{d.step3.receiveUnknown}</span>
                ) : (
                  <b className="tnum">{formatAmount(plan.quote.amountReceivedLD, dec)} {sym}</b>
                )}
              </Row>
              <Row label={`${d.step3.minAfterSlippage} (${formatBps(BigInt(plan.slippageBps))})`}>
                <span className="tnum">{formatAmount(plan.amounts.minAmountLD, dec)} {sym}</span>
                <div className="mono text-xs text-muted">minAmountLD {plan.amounts.minAmountLD.toString()}</div>
              </Row>
              <Row label={d.step3.lzFee}>
                <b className="tnum">{fmtNative(plan.quote.nativeFee)}</b>
                <div className="text-xs text-muted">
                  {plan.vm === 'evm'
                    ? fmt(d.step3.feeDetail, { value: fmtNative(plan.value), refund: fmtNative(plan.value - plan.quote.nativeFee) })
                    : fmt(d.step3.feeDetailSvm, { value: fmtNative(plan.value) })}
                </div>
              </Row>
              {plan.vm === 'svm' ? (
                <Row label={d.step3.computeBudget}>
                  <div className="text-xs">
                    {fmt(d.step3.computeBudgetDetail, {
                      cu: plan.computeUnitLimit.toLocaleString('en-US'),
                      price: plan.computeUnitPrice.toString(),
                      priority: formatAmount(svmTxFee(plan.computeUnitLimit, plan.computeUnitPrice) - BASE_FEE_LAMPORTS, 9, { maxFraction: 9 }),
                      base: formatAmount(BASE_FEE_LAMPORTS, 9, { maxFraction: 9 }),
                    })}
                  </div>
                </Row>
              ) : null}
              <Row label={d.step3.contract} mono>
                {plan.vm === 'evm' ? (
                  <Address value={plan.oft} href={p.src.explorerAddrUrl + plan.oft} short />
                ) : (
                  <Address value={plan.oftStore} href={p.src.explorerAddrUrl + plan.oftStore} short />
                )}
              </Row>
              <Row label={d.step3.destination}>
                {dst?.name ?? '?'} <span className="text-xs text-muted">(eid {plan.dstEid})</span>
              </Row>
              <Row label={d.step3.recipient} mono>
                {plan.recipientVm === 'evm' ? (
                  <Address value={plan.recipientDisplay} href={dst ? dst.explorerAddrUrl + plan.recipientDisplay : undefined} short />
                ) : (
                  <a href={dst ? dst.explorerAddrUrl + plan.recipientDisplay : undefined} target="_blank" rel="noopener noreferrer" className="mono break-all underline decoration-dotted underline-offset-2">
                    {plan.recipientDisplay.slice(0, 6)}
                    <span className="opacity-60">{plan.recipientDisplay.slice(6, -6)}</span>
                    <b>{plan.recipientDisplay.slice(-6)}</b>
                  </a>
                )}
              </Row>
              <Row label={plan.vm === 'evm' ? d.step3.refund : d.step3.feePayer} mono>
                <Address value={plan.sender} short />
              </Row>
              {/*
                * What the CONTRACT adds to every send, decoded. The Solana block below covers
                * compute units for that destination; this row is the same thing for all of them,
                * and it is the field guard 16 now warns about — a warning is only useful next to
                * the thing it is about.
                */}
              <Row label={d.step3.enforcedOptions}>
                <ul className="mono text-xs">
                  {describeOptions(p.info.enforced[plan.dstEid] ?? '0x').map((o, i) => (
                    <li key={i} className={o.kind === 'nativeDrop' || o.kind === 'lzCompose' ? 'text-danger' : undefined}>
                      {optionLine(o, d)}
                    </li>
                  ))}
                  {describeOptions(p.info.enforced[plan.dstEid] ?? '0x').length === 0 ? <li className="text-muted">{d.step3.enforcedNone}</li> : null}
                </ul>
              </Row>
              {plan.recipientVm === 'svm' && p.svmOptions ? (
                <Row label={d.step3.executorOptions}>
                  <div className="text-xs">
                    {fmt(d.step3.svmCuNote, { cu: (p.svmOptions.total.gas - receiveTotals(plan.extraOptions).gas).toString(), extra: receiveTotals(plan.extraOptions).gas > 0n ? fmt(d.step3.svmCuExtra, { cu: receiveTotals(plan.extraOptions).gas.toString() }) : '' })}
                  </div>
                  {p.svmOptions.addedLamports > 0n ? (
                    <div className="text-xs text-warn">{fmt(d.step3.svmAtaLamports, { sol: formatAmount(p.svmOptions.addedLamports, 9, { maxFraction: 6 }) })}</div>
                  ) : p.svmInfo && p.svmOptions.total.value > 0n ? (
                    <div className="text-xs text-muted">{d.step3.svmAtaCovered}</div>
                  ) : null}
                  {p.svmOptions.dropped.length > 0 ? <div className="text-xs text-danger">{d.step3.droppedOptions} {p.svmOptions.dropped.map((o) => o.kind).join(', ')}</div> : null}
                </Row>
              ) : null}
              {plan.quote.limitMaxLD < (plan.vm === 'svm' ? 2n ** 64n - 1n : 2n ** 128n) ? (
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
                <Input type="number" min={0} max={500} step={1} value={p.state.slippageBps} onChange={(e) => set({ slippageBps: clampInt(e.target.value, 0, 500) })} className="mono mt-1 h-9" />
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
  )

  if (p.flat) return body
  return (
    <div className="px-1">
      <Disclosure title={summary} open={open} onToggle={() => setOpen(!open)}>
        {body}
      </Disclosure>
    </div>
  )
}

/** One decoded executor option as text. Amounts stay raw — this row is for reading, not maths. */
function optionLine(o: OptionItem, d: ReturnType<typeof useDict>): string {
  switch (o.kind) {
    case 'lzReceive':
      return o.value > 0n ? `lzReceive(gas ${o.gas}, value ${o.value})` : `lzReceive(gas ${o.gas})`
    case 'nativeDrop':
      return fmt(d.step3.opt_nativeDrop, { amount: o.amount.toString(), receiver: `0x${o.receiver.slice(-40)}` })
    case 'lzCompose':
      return `lzCompose(#${o.index}, gas ${o.gas}${o.value > 0n ? `, value ${o.value}` : ''})`
    case 'ordered':
      return 'orderedExecution'
    case 'dvn':
      return `dvn(#${o.dvnIdx}, type ${o.optionType})`
    default:
      return `unknown(worker ${o.workerId}, type ${o.optionType})`
  }
}


/**
 * The issuer's fee, read from the contract's quote: what it keeps, as a share of what is sent, in
 * the colour of its size (core/oftFee.ts), with the contract's own labels for it underneath. The
 * fee is the owner's setting, not a market rate — said right here, every time.
 */
function IssuerFeeRow({ plan, dec, sym }: { plan: SendPlan; dec: number; sym: string }) {
  const d = useDict()
  if (plan.quote.unavailable) {
    return (
      <Row label={d.step3.issuerFee}>
        <span className="text-warn">{d.step3.issuerFeeUnknown}</span>
        <div className="mono text-xs text-muted">{plan.quote.unavailable}</div>
      </Row>
    )
  }
  const fee = issuerFee(plan.quote)
  const cls = classifyFee(fee.feeBps)
  const tone = cls === 'high' || cls === 'extreme' ? 'text-danger' : cls === 'notice' ? 'text-warn' : 'text-ink'
  const labels = plan.quote.feeDetails.filter((f) => f.amountLD !== 0n)
  return (
    <Row label={d.step3.issuerFee}>
      {fee.feeLD === 0n ? (
        <span className="tnum">{d.step3.issuerFeeNone}</span>
      ) : (
        <b className={`tnum ${tone}`}>
          {fee.feeLD < 0n ? `${d.step3.issuerFeeBonus} ` : ''}
          {formatAmount(fee.feeLD < 0n ? -fee.feeLD : fee.feeLD, dec)} {sym} ({formatBps(fee.feeBps < 0n ? -fee.feeBps : fee.feeBps)})
        </b>
      )}
      {labels.length > 0 ? (
        <ul className="mono text-xs text-muted">
          {labels.map((f, i) => (
            <li key={i}>
              {f.amountLD < 0n ? '−' : '+'}{formatAmount(f.amountLD < 0n ? -f.amountLD : f.amountLD, dec)} {sym} — {f.description}
            </li>
          ))}
        </ul>
      ) : null}
      {fee.feeLD !== 0n ? <div className="text-xs text-muted">{d.step3.issuerFeeHint}</div> : null}
    </Row>
  )
}

/**
 * The guard list, for the details fold: passes in green, reads in flight in grey, the approve step
 * neutral, notes in amber, blocks in red. Nothing here is a control — there is nothing to tick.
 */
export function Checks(p: { report: GuardReport; show: boolean; feeCtx?: FeeContext | undefined }) {
  const d = useDict()
  const results = p.report.results
  const pending = results.filter((r) => isPending(r))
  const shown = results.filter((r) => (r.ok ? okLabel(r.id, d) : true))
  const passingShown = shown.filter((r) => r.ok).length
  if (!p.show) return null

  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted">
        {pending.length ? (
          <span className="inline-flex items-center gap-2">
            <Spinner /> {fmt(d.ui.checksPending, { done: passingShown, total: shown.length })}
          </span>
        ) : (
          `${d.ui.checks}: ${passingShown}/${shown.length}`
        )}
      </div>
      <ul className="grid gap-x-3 gap-y-0.5 text-xs">
        {results.map((r) => {
          const label = r.ok ? okLabel(r.id, d) : guardLabel(d.guard, r.code, p.feeCtx)
          if (!label) return null
          const pend = isPending(r)
          const tone = r.ok ? 'text-ok' : pend ? 'text-muted' : isStepCode(r.code) ? 'text-ink' : isNoteCode(r.code) ? 'text-warn' : 'text-danger'
          const glyph = r.ok ? '✓' : pend ? '○' : isStepCode(r.code) ? '→' : isNoteCode(r.code) ? '●' : '✗'
          return (
            <li key={r.id} className={tone}>
              {glyph} {label}
              {!r.ok && r.detail && (r.code === 'simulation_failed' || r.code === 'selfcheck_failed' || r.code === 'peer_back_mismatch') ? (
                <span className="mono block pl-4 text-xs opacity-80">{r.detail}</span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export type CtaState =
  | { kind: 'connect' }
  | { kind: 'switch'; chain: ChainDef }
  | { kind: 'check' }
  | { kind: 'destination' }
  | { kind: 'amount' }
  | { kind: 'recipient' }
  | { kind: 'quote' }
  /** A tab-specific wait: "find the manager", "checking the manager…". Disabled, with its own words. */
  | { kind: 'hold'; label: string; spinner?: boolean }
  /** The allowance is the next step. `reason` is the impossibility that holds it, if any. */
  | { kind: 'approve'; intent: ApproveIntent; enabled: boolean; reason?: string }
  | { kind: 'checking' }
  | { kind: 'send'; enabled: boolean; reason?: string }

/** What the approve flow is doing, for the button's label and the line under it. */
export type CtaApprove = { phase: ApprovePhase; explorerTxUrl: string }

/**
 * One big Relay-style button whose label is the next thing the user must do:
 * Connect wallet → Switch to <chain> → Approve <amount> <token> → Send.
 *
 * Under it, one neutral line at most: the impossibility that holds the button, the approve's
 * progress with a link to its transaction, "cancelled in the wallet", or an error and the offer
 * to try again. Never a red block.
 */
export function Cta(p: {
  state: CtaState
  /** The token the approve names, for the button's label. */
  info: { decimals: number; symbol: string } | undefined
  /** The send is being signed or has been submitted. */
  sending: boolean
  /** The approve flow, when this tab has one. */
  approve?: CtaApprove | undefined
  onClick: () => void
  error: string
}) {
  const d = useDict()
  const s = p.state
  const phase = p.approve?.phase ?? { kind: 'idle' }
  const approving = approveBusy(phase)
  const dec = p.info?.decimals ?? 18
  const sym = p.info?.symbol ?? ''

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
              : s.kind === 'recipient'
                ? d.ui.cta_recipient
                : s.kind === 'quote'
                  ? d.ui.cta_quote
                  : s.kind === 'hold'
                    ? s.label
                  : s.kind === 'checking'
                    ? d.ui.cta_checking
                    : s.kind === 'approve'
                      ? phase.kind === 'error'
                        ? d.approve.retry
                        : fmt(d.step3.approveBtn, { amount: formatAmount(s.intent.amount, dec), symbol: sym })
                      : d.ui.cta_send

  // What the button says while busy. The step counter appears only when there are two approves.
  const busyLabel = p.sending
    ? d.step3.sending_
    : phase.kind === 'simulating'
      ? d.approve.simulating
      : phase.kind === 'signing'
        ? `${phase.step.of > 1 ? `${fmt(d.approve.step, { n: phase.step.n, of: phase.step.of })} · ` : ''}${d.approve.signing}`
        : phase.kind === 'mining'
          ? `${phase.step.of > 1 ? `${fmt(d.approve.step, { n: phase.step.n, of: phase.step.of })} · ` : ''}${d.approve.mining}`
          : phase.kind === 'rereading'
            ? d.approve.rereading
            : ''
  const busy = p.sending || approving

  const disabled =
    busy ||
    s.kind === 'check' ||
    s.kind === 'destination' ||
    s.kind === 'amount' ||
    s.kind === 'recipient' ||
    s.kind === 'quote' ||
    s.kind === 'hold' ||
    s.kind === 'checking' ||
    (s.kind === 'send' && !s.enabled) ||
    (s.kind === 'approve' && !s.enabled)

  // The one line under the button.
  const txHash = phase.kind === 'mining' || phase.kind === 'rereading' || phase.kind === 'done' || phase.kind === 'error' ? phase.hash : undefined
  const clearing = (phase.kind === 'signing' || phase.kind === 'mining') && phase.step.amount === 0n
  const line: { text: string; tone: 'muted' | 'danger' } | undefined = p.error
    ? { text: p.error, tone: 'danger' }
    : phase.kind === 'error'
      ? { text: phase.message, tone: 'danger' }
      : phase.kind === 'cancelled'
        ? { text: d.approve.cancelled, tone: 'muted' }
        : clearing
          ? { text: d.approve.clearing, tone: 'muted' }
          : (s.kind === 'send' || s.kind === 'approve') && !s.enabled && s.reason
            ? { text: s.reason, tone: 'muted' }
            : undefined

  // The filled pill is for the moment the transfer can go: Approve or Send, enabled. Everything
  // else — connect, switch, a wait, a block — is the quiet card-coloured pill.
  const tone = !busy && ((s.kind === 'approve' && s.enabled) || (s.kind === 'send' && s.enabled)) ? 'primary' : 'default'
  return (
    <div className="space-y-2">
      <Button variant="cta" data-tone={tone} disabled={disabled} onClick={p.onClick}>
        {busy ? (
          <>
            <Spinner /> {busyLabel}
          </>
        ) : s.kind === 'checking' || s.kind === 'quote' || (s.kind === 'hold' && s.spinner) ? (
          <>
            <Spinner /> {label}
          </>
        ) : s.kind === 'connect' ? (
          <>
            <WalletIcon className="h-6 w-6 p-0.5" /> {label}
          </>
        ) : (
          label
        )}
      </Button>
      {line ? <div className={`px-4 text-center text-xs ${line.tone === 'danger' ? 'text-danger' : 'text-muted'}`}>{line.text}</div> : null}
      {txHash && p.approve ? (
        <div className="text-center text-xs">
          <a href={p.approve.explorerTxUrl + txHash} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-dotted underline-offset-2">
            {d.approve.viewTx} ↗
          </a>
        </div>
      ) : null}
      <div className="text-center text-xs text-muted">{d.step3.simulationHint}</div>
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
    case 17:
      return d.guard.ok_peer_back
    case 18:
      return d.guard.ok_options
    case 19:
      return d.guard.ok_recipient_class
    case 21:
      return d.guard.ok_fee_ceiling
    case 22:
      return d.guard.ok_risk
    default:
      return null
  }
}

function clampInt(v: string, lo: number, hi: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}
