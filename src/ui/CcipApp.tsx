'use client'
/**
 * The Chainlink CCIP tab. EVM to EVM, one token, no payload.
 *
 * The router is the approve spender and it comes from src/protocols/ccip/chains.ts — never from
 * the pool, never from the token, never from anything typed here. The pool is only used to learn
 * where the token can go and what the rate limits are.
 */
import { isStepCode, isWarningCode, shownFailures, waitsOnlyForApprove } from '@/core/severity'
import { RiskWarnings } from './components/RiskWarnings'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEffect, useMemo, useState } from 'react'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi } from '@/core/abi'
import { riskTickScope } from '@/core/riskTick'
import { useRiskTick } from './useRiskTick'
import { AmountError, formatAmount, parseAmount } from '@/core/amounts'
import { byChainId, byKey, evmChains, isEvm, type ChainKey } from '@/core/chains'
import { parseAnalysisInput, type AnalysisInput } from '@/core/analysis/input'
import type { AnalysisAction, AnalysisTarget } from '@/core/analysis/result'
import type { ProtocolId } from '@/core/protocols'
import { confirmsTail, tryRecipient, type Recipient } from '@/core/recipient'
import { familyOfVm } from '@/core/addressBook'
import { BookPicker, bookConfirms, BookVerdictNote, bookRefuses, RecipientBookAfterSend, useBookVerdict } from './components/RecipientBook'
import { formatRevert, revertMeaning } from '@/core/sim/revert'
import { ccipRouterAbi } from '@/protocols/ccip/abi'
import { ccipConfig } from '@/protocols/ccip/chains'
import { ccipApprovePlan, isCcipPending, runCcipGuards, type CcipGuardInput } from '@/protocols/ccip/guards'
import { assembleCcipSendArgs } from '@/protocols/ccip/plan'
import { ccipTxUrl } from '@/protocols/ccip/track'
import { fmt, useDict } from '@/i18n'
import { Address as AddressView } from './components/Address'
import { ChainIcon } from './components/ChainIcon'
import { ProtocolBadge } from './components/History'
import { Panel, TwoColumn } from './components/Layout'
import { VerdictCard } from './components/Verdict'
import { Alert, AmountInput, Box, BoxLabel, Button, Input, PillSelect, Row, Spinner } from './components/ui'
import { RiskNotAssessed } from './components/RiskPanel'
import { useAnalysis } from './useAnalysis'
import { useCcipCheck, useCcipPlan, useCcipRemote, useCcipToken, useTokenMeta } from './ccipHooks'
import { isUserRejection, shortError, useAllowance, useNativeBalance, useTokenBalance } from './hooks'
import { pushHistory, type Stored } from './storage'

export function CcipApp({
  stored,
  setStored,
  srcKey,
  setSrcKey,
  handoff,
  onHandoffConsumed,
  onOpenTab,
}: {
  stored: Stored
  setStored: (s: Stored) => void
  srcKey: ChainKey
  setSrcKey: (k: ChainKey) => void
  /** What another tab's analysis found for CCIP, carried across when this tab opened. */
  handoff: AnalysisTarget | null
  onHandoffConsumed: () => void
  /** The other direction: this tab recognised a transfer that belongs to another protocol. */
  onOpenTab: (protocol: ProtocolId, target: AnalysisTarget | undefined) => void
}) {
  const d = useDict()
  const { address: wallet, chainId: walletChainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { openConnectModal } = useConnectModal()

  const src = byKey(srcKey)
  const evmSrc = isEvm(src) ? src : undefined
  const cfg = ccipConfig(srcKey)
  const [input, setInput] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [dstChain, setDstChain] = useState<ChainKey | undefined>(undefined)
  const [amountInput, setAmountInput] = useState('')
  const [recipientCustom, setRecipientCustom] = useState(false)
  const [recipientInput, setRecipientInput] = useState('')
  const [confirmLast6, setConfirmLast6] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [txError, setTxError] = useState('')
  const [highFeeAccepted, setHighFeeAccepted] = useState(false)

  useEffect(() => {
    if (walletChainId === undefined) return
    const c = byChainId(walletChainId)
    if (c) setSrcKey(c.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletChainId])

  // Arriving from another tab's analysis with a CCIP transfer it recognised.
  useEffect(() => {
    if (!handoff) return
    if (handoff.kind === 'ccip-token') {
      setSrcKey(handoff.chain)
      if (handoff.token) {
        setInput(handoff.token)
        setTarget(handoff.token)
      }
      if (handoff.dstChain) setDstChain(handoff.dstChain)
    }
    // Consumed either way: a target this tab cannot use must not sit there and re-apply itself
    // over something the user types next.
    onHandoffConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.address, handoff?.chain])


  // ---- whatever was pasted ----------------------------------------------------
  const [analysisInput, setAnalysisInput] = useState<AnalysisInput | null>(null)
  const [inputError, setInputError] = useState('')
  const analysis = useAnalysis(analysisInput, 'ccip', srcKey, stored.customRpc)
  const verdict = analysis.data?.results[0]

  /**
   * One field, two kinds of answer. An address is this tab's own business and goes straight to the
   * lookup below. A transaction hash or a LayerZero Scan link goes to the shared analysis, which
   * reads the same logs here as anywhere else — and when it turns out to be another protocol, the
   * verdict card is the way across, instead of a dead button that teaches the user nothing.
   */
  const go = () => {
    const v = input.trim()
    if (v === '') return
    const r = parseAnalysisInput(v)
    if (!r.ok) {
      setInputError(d.analysis[`input_${r.code}`])
      return
    }
    setInputError('')
    if (r.input.kind === 'evm_address') {
      setAnalysisInput(null)
      setTarget(r.input.address)
      return
    }
    if (r.input.kind === 'evm_tx' || r.input.kind === 'lz_guid') {
      setTarget(null)
      setAnalysisInput(r.input)
      return
    }
    // A Solana address or signature: this tab bridges EVM to EVM only.
    setInputError(d.analysis.input_unrecognised)
  }

  const onAnalysisAction = (a: AnalysisAction) => {
    switch (a.kind) {
      case 'open_tab':
        onOpenTab(a.protocol, verdict?.target)
        return
      case 'switch_chain':
        setSrcKey(a.chain)
        return
      case 'use_address':
        setInput(a.address)
        setTarget(a.address)
        if (verdict?.target?.dstChain) setDstChain(verdict.target.dstChain)
        return
      default:
        return
    }
  }

  const discovery = useCcipToken(srcKey, target, stored.customRpc)
  const token = discovery.data?.kind === 'token' ? discovery.data.token : undefined
  const pool = discovery.data?.kind === 'token' ? discovery.data.pool : undefined
  const meta = useTokenMeta(srcKey, token, stored.customRpc)
  const remote = useCcipRemote(srcKey, dstChain, pool, stored.customRpc)

  const destinations = useMemo(
    () => (discovery.data?.kind === 'token' ? discovery.data.routes.map((r) => r.chain) : []),
    [discovery.data],
  )

  let amountError = ''
  let amount: bigint | undefined
  if (meta.data && amountInput.trim() !== '') {
    try {
      amount = parseAmount(amountInput, meta.data.decimals)
    } catch (e) {
      amountError = e instanceof AmountError ? d.errors[`amount_${e.code}`] : d.errors.generic
    }
  }

  const recipientResult = recipientCustom
    ? recipientInput.trim() !== ''
      ? tryRecipient('evm', recipientInput)
      : undefined
    : wallet
      ? tryRecipient('evm', wallet)
      : undefined
  const recipient: Recipient | undefined = recipientResult?.ok ? recipientResult.recipient : undefined
  const recipientError = recipientResult && !recipientResult.ok ? d.errors[`recipient_${recipientResult.code}`] : ''
  // §Address book. CCIP bridges EVM to EVM; derived rather than hard-coded, as in the NTT tab.
  const bookFamily = familyOfVm('evm')
  const bookVerdict = useBookVerdict(bookFamily, recipientCustom ? recipient?.display : undefined)

  const recipientConfirmed =
    recipientCustom && recipient !== undefined && (bookConfirms(bookVerdict) || confirmsTail(recipient, confirmLast6))

  const plan = useCcipPlan({
    chain: srcKey,
    dstChain,
    token,
    meta: meta.data,
    pool,
    remote: remote.data,
    sender: wallet,
    recipient,
    amount,
    customRpc: stored.customRpc,
  })
  const planData = plan.data
  // The tick covers what was on screen when it was ticked: chain, token, route, amount, recipient
  // and wallet — and the warnings shown then (ui/useRiskTick.ts). Any of them changing is a
  // different scope.
  const tickScope = riskTickScope({
    chain: src.key,
    contract: planData?.token,
    destination: planData?.dst.chain,
    amount: planData?.amount,
    recipient: planData?.recipient,
    sender: wallet,
  })

  // A fee the user accepted was a specific number; the moment it changes they have not read it.
  const planValue = plan.data?.value
  useEffect(() => {
    setHighFeeAccepted(false)
  }, [planValue])

  const tokenBalance = useTokenBalance(evmSrc, token, wallet)
  const nativeBalance = useNativeBalance(evmSrc, wallet)
  const allowance = useAllowance(evmSrc, token, wallet, cfg ? (cfg.router as `0x${string}`) : undefined)

  const approveIntent = ccipApprovePlan(srcKey, planData, allowance.data)
  const baseInput: CcipGuardInput = {
    walletAddress: wallet,
    walletChainId,
    srcChainId: evmSrc?.chainId ?? 0,
    srcChain: srcKey,
    plan: planData,
    recipientIsCustom: recipientCustom,
    customRecipientConfirmed: recipientConfirmed,
    recipientLookalike: bookRefuses(bookVerdict),
    tokenBalance: tokenBalance.data,
    nativeBalance: nativeBalance.data?.value,
    allowance: allowance.data,
    gasCostWei: undefined,
    ...(approveIntent ? { approveIntent } : {}),
    simulation: undefined,
    selfCheck: undefined,
    highFeeAccepted,
  }
  const pre = runCcipGuards(baseInput)
  // 14 is excluded like the others: the fee confirmation must not gate the simulation, or the
  // user would be asked to accept a number before anything could tell them whether it works.
  const preOk = pre.results.filter((r) => r.id !== 8 && r.id !== 9 && r.id !== 12 && r.id !== 13 && r.id !== 14).every((r) => r.ok)
  const check = useCcipCheck(planData, preOk, stored.customRpc)
  // Two passes on purpose: the warnings do not depend on the tick, so the first pass finds what is
  // on screen, the tick is judged against that list (and its scope), and the second pass is the
  // verdict with the tick applied. `guardInput` is what the click re-runs, so it carries it.
  const draftInput: CcipGuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation: check.data?.simulation,
    selfCheck: check.data?.selfCheck,
  }
  const draft = runCcipGuards(draftInput)
  const tick = useRiskTick(tickScope, planData ? shownFailures(draft.riskWarnings) : [])
  const guardInput: CcipGuardInput = { ...draftInput, risksAccepted: tick.accepted }
  const report = runCcipGuards(guardInput)

  // ---- writes -------------------------------------------------------------------
  const approveWrite = useWriteContract()
  const approveReceipt = useWaitForTransactionReceipt({ hash: approveWrite.data, chainId: evmSrc?.chainId })
  useEffect(() => {
    if (approveReceipt.isSuccess) {
      void allowance.refetch()
      approveWrite.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt.isSuccess])

  const onApprove = () => {
    setTxError('')
    // Re-derived from the config at click time, never from the plan or from render state.
    const intent = ccipApprovePlan(srcKey, planData, allowance.data)
    if (!intent || !evmSrc || !cfg) return
    if (intent.spender.toLowerCase() !== cfg.router.toLowerCase()) return
    approveWrite.writeContract(
      { address: intent.token, abi: erc20Abi, functionName: 'approve', args: [intent.spender, intent.amount], chainId: evmSrc.chainId },
      { onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)) },
    )
  }

  const sendWrite = useWriteContract()
  const onSend = () => {
    setTxError('')
    const p = planData
    if (!p || !evmSrc || !cfg) return
    if (!runCcipGuards(guardInput).canSend) return
    if (p.router.toLowerCase() !== cfg.router.toLowerCase()) return
    const [selector, message] = assembleCcipSendArgs(p)
    sendWrite.writeContract(
      {
        address: p.router,
        abi: ccipRouterAbi,
        functionName: 'ccipSend',
        args: [selector, message],
        value: p.value,
        chainId: evmSrc.chainId,
      },
      {
        onSuccess: (hash) => {
          setSent(hash)
          setStored(
            pushHistory(stored, {
              srcChain: srcKey,
              protocol: 'ccip',
              dstEid: 0,
              dstChain: p.dst.chain,
              oft: p.token,
              txHash: hash,
              at: Date.now(),
            }),
          )
        },
        onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)),
      },
    )
  }

  // ---- CTA ----------------------------------------------------------------------
  const chainMismatch = wallet !== undefined && walletChainId !== undefined && evmSrc !== undefined && walletChainId !== evmSrc.chainId
  const busy = switching || approveWrite.isPending || (!!approveWrite.data && approveReceipt.isLoading) || sendWrite.isPending
  const firstFailing = report.results.find((r) => !r.ok && !isCcipPending(r)) ?? report.results.find((r) => !r.ok)
  // Reads in flight are "checking", not problems to accept.
  const shownBlocks = planData ? shownFailures(report.blocks, { dropPending: true, dropSteps: true }) : []
  const shownWarnings = planData ? shownFailures(report.riskWarnings) : []
  const ctaLabel = !wallet
    ? d.ui.cta_connect
    : chainMismatch
      ? fmt(d.ui.cta_switch, { chain: src.name })
      : !token
        ? d.ccip.cta_find
        : !dstChain
          ? d.ui.cta_destination
          : amountInput.trim() === ''
            ? d.ui.cta_amount
            : approveIntent && meta.data
              ? fmt(d.step3.approveBtn, { amount: formatAmount(approveIntent.amount, meta.data.decimals), symbol: meta.data.symbol })
              : d.ui.cta_send
  // The approve grants an allowance, so it waits for the same tick the send does: an allowance
  // given to a contract whose risk has not been accepted is the exploitable half of this app.
  const ctaEnabled = !busy && (!wallet || chainMismatch || (!!approveIntent && report.approveReady) || report.canSend)
  const onCta = () => {
    if (!wallet) return openConnectModal?.()
    if (chainMismatch && evmSrc) return switchChain({ chainId: evmSrc.chainId })
    if (approveIntent) return onApprove()
    onSend()
  }

  const dec = meta.data?.decimals ?? 18
  const sym = meta.data?.symbol ?? ''

  // ---- render ---------------------------------------------------------------------
  const left = sent ? (
    <Box>
      <BoxLabel>{d.tracker.title}</BoxLabel>
      <p className="text-sm text-muted">{d.ccip.sentHint}</p>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <a href={src.explorerTxUrl + sent} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">
          {d.tracker.sourceTx} ↗
        </a>
        <a href={ccipTxUrl(sent)} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">
          CCIP Explorer ↗
        </a>
      </div>
      <RecipientBookAfterSend family={bookFamily} address={recipientCustom ? recipient?.display : undefined} />
      <div className="mt-4">
        <Button
          onClick={() => {
            setSent(null)
            setAmountInput('')
          }}
        >
          {d.tracker.newTransfer}
        </Button>
      </div>
    </Box>
  ) : (
    <>
      <Box>
        <BoxLabel>{d.ccip.inputLabel}</BoxLabel>
        <div className="flex h-[50px] items-center rounded-full bg-surface-2 pl-4 pr-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go()
            }}
            placeholder={d.ccip.placeholder}
            spellCheck={false}
            autoComplete="off"
            className="mono min-w-0 flex-1 bg-transparent pr-2 text-sm text-ink outline-none placeholder:text-faint"
            aria-label={d.ccip.inputLabel}
          />
          <Button
            variant="primary"
            className="h-9 rounded-full px-4"
            disabled={input.trim() === '' || discovery.isFetching || analysis.isFetching}
            onClick={go}
          >
            {discovery.isFetching || analysis.isFetching ? <Spinner /> : d.analysis.button}
          </Button>
        </div>
        {inputError ? (
          <div className="mt-2 text-xs">
            <span className="text-danger">{inputError}</span> <span className="text-muted">{d.analysis.examples}</span>
          </div>
        ) : null}
        {discovery.data?.kind === 'no_pool' ? (
          <div className="mt-2">
            <Alert kind="error">{d.ccip.noPool}</Alert>
          </div>
        ) : null}
        {discovery.data?.kind === 'unknown' ? (
          <div className="mt-2">
            <Alert kind="error">{d.ccipReject[discovery.data.reason]}</Alert>
          </div>
        ) : null}
        {token && pool ? (
          <p className="mt-2 text-xs text-muted">
            {d.ccip.foundPool} <AddressView value={pool} href={src.explorerAddrUrl + pool} short />
          </p>
        ) : null}
        {/* The pool was found, but only one provider answered — say so rather than imply two agreed. */}
        {token && pool && discovery.data?.crossChecked === false ? (
          <p className="mt-1 text-xs text-warn">⚠ {d.card.flag_not_cross_checked}</p>
        ) : null}
      </Box>

      <Box>
        <BoxLabel
          right={
            token && tokenBalance.data !== undefined ? (
              <button type="button" className="tnum text-accent-ink hover:underline" onClick={() => setAmountInput(formatAmount(tokenBalance.data ?? 0n, dec))}>
                {d.step2.balance}: {formatAmount(tokenBalance.data, dec, { maxFraction: 6 })} {sym} · {d.step2.max}
              </button>
            ) : null
          }
        >
          {d.ui.from}
        </BoxLabel>
        <div className="flex items-center gap-3">
          <AmountInput value={amountInput} onChange={(e) => setAmountInput(e.target.value)} placeholder="0" disabled={!token} aria-label={d.step2.amount} aria-invalid={!!amountError} />
          <PillSelect
            label={src.name}
            sub={sym || src.nativeSymbol}
            icon={<ChainIcon chain={src.key} />}
            value={src.key}
            onSelect={(v) => {
              setSrcKey(v as ChainKey)
              setTarget(null)
              setDstChain(undefined)
            }}
            options={evmChains()
              .filter((c) => !!ccipConfig(c.key))
              .map((c) => ({ value: c.key, label: c.name, sub: c.nativeSymbol, icon: <ChainIcon chain={c.key} size={28} /> }))}
            aria-label={d.header.sourceChain}
          />
        </div>
        <div className="mt-2 min-h-4 text-xs">{amountError ? <span className="text-danger">{amountError}</span> : null}</div>
      </Box>

      <Box>
        <BoxLabel
          right={
            recipientCustom ? (
              <button type="button" className="text-accent-ink hover:underline" onClick={() => { setRecipientCustom(false); setRecipientInput(''); setConfirmLast6('') }}>
                {d.ui.useWallet}
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
                {wallet ? <AddressView value={wallet} short /> : <span className="text-faint">—</span>}
                <button type="button" className="text-accent-ink hover:underline" onClick={() => setRecipientCustom(true)}>
                  {d.ui.edit}
                </button>
              </span>
            )
          }
        >
          {d.ui.to}
        </BoxLabel>
        <div className="flex items-center gap-3">
          <div className="tnum min-w-0 flex-1 truncate text-[32px] font-bold leading-none text-faint">
            {planData ? <span className="text-ink">{formatAmount(planData.received, planData.dst.decimals ?? dec, { maxFraction: 6 })}</span> : '0'}
          </div>
          <PillSelect
            label={dstChain ? byKey(dstChain).name : d.step2.destination}
            {...(dstChain ? { icon: <ChainIcon chain={dstChain} /> } : {})}
            value={dstChain ?? ''}
            onSelect={(v) => setDstChain(v ? (v as ChainKey) : undefined)}
            options={destinations.map((c) => ({ value: c, label: byKey(c).name, icon: <ChainIcon chain={c} size={28} /> }))}
            aria-label={d.step2.destination}
          />
        </div>
        {token && destinations.length === 0 ? <p className="mt-2 text-xs text-muted">{d.ccip.noDestinations}</p> : null}
        {recipientCustom ? (
          <div className="mt-3 space-y-2 rounded-xl bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted">{d.step2.otherAddress}</div>
              <BookPicker family={bookFamily} onPick={(a) => { setRecipientInput(a); setConfirmLast6('') }} />
            </div>
            <Input value={recipientInput} onChange={(e) => { setRecipientInput(e.target.value); setConfirmLast6('') }} placeholder="0x…" className="mono" aria-label={d.step2.recipient} />
            {recipientError && recipientInput.trim() !== '' ? <div className="text-xs text-danger">{recipientError}</div> : null}
            {recipient ? <BookVerdictNote verdict={bookVerdict} /> : null}
            {recipient && !bookConfirms(bookVerdict) ? (
              <label className="block text-xs">
                <span className="text-muted">{d.step2.confirmLast6}</span>
                <Input value={confirmLast6} onChange={(e) => setConfirmLast6(e.target.value)} maxLength={6} className={`mono mt-1 max-w-36 ${recipientConfirmed ? 'border-ok' : ''}`} />
              </label>
            ) : null}
          </div>
        ) : null}
      </Box>

      <div className="space-y-2 pt-1">
        {txError ? <Alert kind="error">{txError}</Alert> : null}
        <Button variant="cta" disabled={!ctaEnabled} onClick={onCta}>
          {busy ? <Spinner /> : ctaLabel}
        </Button>
        <RiskWarnings
          blocks={shownBlocks}
          warnings={shownWarnings}
          label={(c) => d.ccipGuard[c as keyof typeof d.ccipGuard] ?? c}
          accepted={tick.accepted}
          onAccepted={tick.setAccepted}
          added={tick.added}
        />
        {approveIntent && !report.approveReady && waitsOnlyForApprove(report.blocks) ? (
          <div className="text-center text-xs text-muted">{d.step3.approveAfterTick}</div>
        ) : !report.canSend && firstFailing && !firstFailing.ok && !(approveIntent && isStepCode(firstFailing.code)) ? (
          <div className="text-center text-xs text-muted">{d.ccipGuard[firstFailing.code]}</div>
        ) : null}
      </div>
    </>
  )

  const right = (
    <Panel title={d.ui.preview} badge={<ProtocolBadge id="ccip" />}>
      <div className="space-y-4">
        {verdict ? <VerdictCard result={verdict} onAction={onAnalysisAction} /> : null}
        {!token ? (
          verdict ? null : <p className="text-sm text-muted">{d.ccip.previewEmpty}</p>
        ) : (
          <>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{d.ui.section_contract}</div>
              <div className="rounded-xl bg-surface-2 px-3 py-1">
                <Row label={d.card.token} mono>
                  <AddressView value={token} href={src.explorerAddrUrl + token} short />
                </Row>
                <Row label={d.ccip.pool} mono>
                  {pool ? <AddressView value={pool} href={src.explorerAddrUrl + pool} short /> : '—'}
                </Row>
                <Row label={d.ccip.router} mono>
                  {cfg ? <AddressView value={cfg.router} href={src.explorerAddrUrl + cfg.router} short /> : '—'}
                </Row>
                <Row label={d.ccip.routerNote}>{d.ccip.routerFromConfig}</Row>
                {planData?.dst.token ? (
                  <Row label={d.ccip.remoteToken} mono>
                    <AddressView value={planData.dst.token} href={byKey(planData.dst.chain).explorerAddrUrl + planData.dst.token} short />
                  </Row>
                ) : null}
              </div>
            </div>

            {planData ? (
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{d.ui.section_quote}</div>
                <div className="rounded-xl bg-surface-2 px-3 py-1">
                  <Row label={d.step3.sending}>
                    <b className="tnum">{formatAmount(planData.amount, planData.decimals)} {sym}</b>
                  </Row>
                  <Row label={d.ccip.arrives}>
                    <b className="tnum">{formatAmount(planData.received, planData.dst.decimals ?? planData.decimals)} {sym}</b>
                    {planData.dst.decimals !== undefined && planData.dst.decimals !== planData.decimals ? (
                      <div className="text-xs text-muted">{fmt(d.ccip.decimalsNote, { here: String(planData.decimals), there: String(planData.dst.decimals) })}</div>
                    ) : null}
                  </Row>
                  <Row label={d.ccip.fee}>
                    <b className="tnum">{formatAmount(planData.fee, 18, { maxFraction: 8 })} {src.nativeSymbol}</b>
                    <div className="text-xs text-muted">{d.ccip.feeExact}</div>
                  </Row>
                  <Row label={d.ccip.outbound}>
                    <span className="tnum">
                      {planData.outbound === undefined ? '—' : !planData.outbound.isEnabled ? d.ccip.noLimit : formatAmount(planData.outbound.tokens, planData.decimals, { maxFraction: 4 })}
                    </span>
                  </Row>
                  <Row label={d.ccip.inbound}>
                    <span className="tnum">
                      {planData.inbound === undefined ? '—' : !planData.inbound.isEnabled ? d.ccip.noLimit : formatAmount(planData.inbound.tokens, planData.dst.decimals ?? planData.decimals, { maxFraction: 4 })}
                    </span>
                  </Row>
                  <Row label={d.step3.recipient} mono>
                    <AddressView value={planData.recipient} href={byKey(planData.dst.chain).explorerAddrUrl + planData.recipient} short />
                  </Row>
                  <Row label={d.ccip.messageShape}>{d.ccip.messagePlain}</Row>
                </div>
              </div>
            ) : null}

            {report.needsHighFeeConfirmation && planData ? (
              <div className="space-y-2">
                <Alert kind="warn">{fmt(d.ccip.warnHighFee, { fee: `${formatAmount(planData.value, 18, { maxFraction: 6 })} ${src.nativeSymbol}`, chain: src.name })}</Alert>
                <label className="flex items-start gap-2 text-xs text-ink">
                  <input type="checkbox" className="mt-0.5" checked={highFeeAccepted} onChange={(e) => setHighFeeAccepted(e.target.checked)} />
                  {d.ccip.confirmHighFee}
                </label>
              </div>
            ) : null}

            {/* §4 The route indicator has no CCIP runner yet — see the NTT tab's note. */}
            <RiskNotAssessed why={d.risk.notCoveredCcip} />

            <ul className="grid gap-x-3 gap-y-0.5 text-xs">
              {report.results.map((r) => (
                // Four tones: passed, in flight, the approve step (neutral), a warning (amber), a block (red).
                <li
                  key={r.id}
                  className={r.ok ? 'text-ok' : isCcipPending(r) ? 'text-muted' : isStepCode(r.code) ? 'text-ink' : isWarningCode(r.code) ? 'text-warn' : 'text-danger'}
                >
                  {r.ok ? '✓' : isCcipPending(r) ? '○' : isStepCode(r.code) ? '→' : isWarningCode(r.code) ? '⚠' : '✗'}{' '}
                  {r.ok ? (d.ccipGuard[`ok_${r.id}` as keyof typeof d.ccipGuard] ?? '') : d.ccipGuard[r.code]}
                </li>
              ))}
            </ul>

            {check.data?.revert ? (
              <Alert kind="error">
                <div className="font-semibold">{d.revert[revertMeaning(check.data.revert) ?? 'generic']}</div>
                <div className="mono mt-1 text-xs opacity-80">{formatRevert(check.data.revert)}</div>
                {check.data.revert.kind === 'error' && check.data.revert.source === 'contract' ? (
                  <div className="mt-1 text-xs opacity-80">{d.revert.fromContractAbi}</div>
                ) : null}
              </Alert>
            ) : check.data?.rpcUnavailable ? (
              <Alert kind="warn">{d.revert.rpcUnavailable}</Alert>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  )

  return <TwoColumn left={left} right={right} />
}
