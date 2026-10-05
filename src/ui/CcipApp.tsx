'use client'
/**
 * The Chainlink CCIP tab. EVM to EVM, one token, no payload.
 *
 * The router is the approve spender and it comes from src/protocols/ccip/chains.ts — never from
 * the pool, never from the token, never from anything typed here. The pool is only used to learn
 * where the token can go and what the rate limits are.
 */
import { isNoteCode, isStepCode, shownFailures, waitsOnlyForApprove } from '@/core/severity'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { encodeFunctionData } from 'viem'
import { assessIndicator } from '@/core/indicator'
import { useApproveFlow } from './useApproveFlow'
import { useLinkSync } from './useLink'
import { AmountError, formatAmount, parseAmount } from '@/core/amounts'
import { byChainId, byKey, evmChains, isEvm, type ChainKey } from '@/core/chains'
import { parseAnalysisInput, type AnalysisInput } from '@/core/analysis/input'
import type { AnalysisAction, AnalysisTarget } from '@/core/analysis/result'
import type { ProtocolId } from '@/core/protocols'
import { confirmsTail, tryRecipient, type Recipient } from '@/core/recipient'
import { familyOfVm } from '@/core/addressBook'
import { bookConfirms, bookRefuses, RecipientBookAfterSend, useBookVerdict } from './components/RecipientBook'
import { formatRevert, revertMeaning } from '@/core/sim/revert'
import { ccipRouterAbi } from '@/protocols/ccip/abi'
import { ccipConfig } from '@/protocols/ccip/chains'
import { ccipApprovePlan, isCcipPending, runCcipGuards, type CcipGuardInput } from '@/protocols/ccip/guards'
import { assembleCcipSendArgs } from '@/protocols/ccip/plan'
import { ccipSelfCheck } from '@/protocols/ccip/preview'
import { ccipTxUrl } from '@/protocols/ccip/track'
import { fmt, useDict } from '@/i18n'
import { Address as AddressView } from './components/Address'
import { ProtocolBadge } from './components/History'
import { Panel, PanelFold, PanelSection, TwoColumn } from './components/Layout'
import { VerdictCard } from './components/Verdict'
import { Alert, BoxLabel, Button, ChainDot, Row, Shell, Spinner } from './components/ui'
import { RiskNotAssessed } from './components/RiskPanel'
import { IndicatorReasons, RouteIndicator } from './components/RouteIndicator'
import { AmountPanel, FromToRow, RecipientPanel } from './components/FromTo'
import { approveBusy } from '@/core/approveFlow'
import { reverseCcip } from '@/core/reverse'
import { Cta, type CtaState } from './components/Review'
import { useAnalysis } from './useAnalysis'
import { useCcipCheck, useCcipPlan, useCcipRemote, useCcipToken, useTokenMeta } from './ccipHooks'
import { isUserRejection, shortError, useAllowance, useNativeBalance, useTokenBalance } from './hooks'
import { pushHistory, type HistoryEntry, type SetStored, type Stored } from './storage'

import { PREVIEW_ADDRESS, PREVIEW_RECIPIENT, previewAmountRaw, previewCaption } from './preview'

export function CcipApp({
  stored,
  setStored,
  srcKey,
  setSrcKey,
  handoff,
  onHandoffConsumed,
  onOpenTab,
  trackRequest,
  onTrackConsumed,
}: {
  stored: Stored
  setStored: SetStored
  /** A history entry whose "Track" was pressed; shown as the sent transfer, then consumed. */
  trackRequest: HistoryEntry | null
  onTrackConsumed: () => void
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
  // Whether the recipient panel is open — a view state; the recipient itself is the state below.
  const [recipientOpen, setRecipientOpen] = useState(false)
  const [recipientCustom, setRecipientCustom] = useState(false)
  const [recipientInput, setRecipientInput] = useState('')
  const [confirmLast6, setConfirmLast6] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [txError, setTxError] = useState('')

  // Follow the wallet's chain when the user SWITCHES it to one we support. Only a change between
  // two known chains counts: the wallet appearing (connect, reconnect after a reload) must not
  // move a source the user chose — the button says "Switch to <chain>" for that.
  const prevWalletChainId = useRef(walletChainId)
  useEffect(() => {
    const prev = prevWalletChainId.current
    prevWalletChainId.current = walletChainId
    if (walletChainId === undefined || prev === undefined || prev === walletChainId) return
    const c = byChainId(walletChainId)
    if (c) setSrcKey(c.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletChainId])

  // "Track" in Recent transfers: the shell switches to this tab and hands the entry over.
  useEffect(() => {
    if (!trackRequest) return
    setSrcKey(trackRequest.srcChain)
    setSent(trackRequest.txHash)
    onTrackConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackRequest])

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

  // The address bar follows the form: bridge (the path), source, token, destination (core/link.ts).
  useLinkSync(target ? { from: srcKey, token: target, to: dstChain } : undefined)


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

  // The preview (ui/preview.ts): with no amount, no wallet or no recipient yet, the plan is built
  // for one whole token and stand-ins, so the route's colour is known before the token is bought.
  const previewing = !amountError && !!meta.data && !!pool && !!dstChain && (amountInput.trim() === '' || !wallet || !recipient)
  const plan = useCcipPlan({
    chain: srcKey,
    dstChain,
    token,
    meta: meta.data,
    pool,
    remote: remote.data,
    sender: wallet ?? (previewing ? PREVIEW_ADDRESS : undefined),
    recipient: recipient ?? (previewing ? PREVIEW_RECIPIENT : undefined),
    amount: amount ?? (previewing && meta.data ? previewAmountRaw(meta.data.decimals) : undefined),
    customRpc: stored.customRpc,
  })
  const planData = plan.data
  const isPreview = previewing && !!planData

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
  }
  const pre = runCcipGuards(baseInput)
  // 14 (the fee ceiling) is a note, and the notes must not gate the simulation.
  // Only a BLOCK holds the simulation back; a note is the indicator's business.
  const preOk = pre.results.filter((r) => r.id !== 8 && r.id !== 9 && r.id !== 12 && r.id !== 13 && r.id !== 14).every((r) => r.ok || isNoteCode(r.code))
  const check = useCcipCheck(planData, preOk, stored.customRpc)
  // `guardInput` is what the click re-runs, so it carries everything the render judged.
  const guardInput: CcipGuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation: check.data?.simulation,
    selfCheck: check.data?.selfCheck,
  }
  const report = runCcipGuards(guardInput)
  // The line under the button names the impossibility, if there is one. Notes are the indicator's.
  const impossible = shownFailures(report.blocks, { dropPending: true, dropSteps: true })[0]
  const ccipLabel = (c: string) => d.ccipGuard[c as keyof typeof d.ccipGuard] ?? c

  // The route indicator: the tab's own checks, coloured (core/indicator.ts). CCIP with a pool from
  // the TokenAdminRegistry and a passing simulation is green; the eight LayerZero checks do not apply.
  const indicator = assessIndicator({
    hasDestination: !!dstChain,
    hasPlan: !!planData,
    results: report.results,
    held: impossible !== undefined,
    preview: meta.data && (isPreview || (impossible !== undefined && planData)) ? previewCaption(d, isPreview ? 'probe' : 'held', meta.data.decimals, meta.data.symbol) : undefined,
    label: ccipLabel,
    flags: token && pool && discovery.data?.crossChecked === false ? ['not_cross_checked'] : [],
    flagLabel: (f) => (d.card as Record<string, string>)[`flag_${f}`] ?? f,
    riskCovered: false,
    riskPending: false,
  })

  // ---- writes -------------------------------------------------------------------
  // The flow signs approve(router, amount) for exactly the intent the guards checked, waits for
  // the receipt and reads the allowance back; the button becomes Send by itself.
  const approveFlow = useApproveFlow({
    chainId: evmSrc?.chainId,
    owner: wallet,
    token,
    spender: approveIntent?.spender,
    amount: approveIntent?.amount,
    allowance: allowance.data,
    refetchAllowance: async () => (await allowance.refetch()).data,
  })

  const onApprove = () => {
    setTxError('')
    // Re-derived from the config at click time, never from the plan or from render state.
    const intent = ccipApprovePlan(srcKey, planData, allowance.data)
    if (!intent || !evmSrc || !cfg) return
    if (intent.spender.toLowerCase() !== cfg.router.toLowerCase()) return
    // No allowance for a transfer that cannot happen: the approve is a step of THIS transfer.
    if (!waitsOnlyForApprove(runCcipGuards(guardInput).blocks)) return
    void approveFlow.start()
  }

  const sendWrite = useWriteContract()
  // One wallet prompt per click (a ref: isPending flips only on the next render).
  const sending = useRef(false)
  const onSend = () => {
    setTxError('')
    const p = planData
    if (!p || !evmSrc || !cfg) return
    if (sending.current) return
    if (!runCcipGuards(guardInput).canSend) return
    if (p.router.toLowerCase() !== cfg.router.toLowerCase()) return
    const [selector, message] = assembleCcipSendArgs(p)
    // The same self-check the simulation ran, on the exact args that go to the wallet.
    const sc = ccipSelfCheck(p, encodeFunctionData({ abi: ccipRouterAbi, functionName: 'ccipSend', args: [selector, message] }))
    if (!sc.ok) {
      setTxError(d.guard.selfcheck_failed)
      return
    }
    sending.current = true
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
          setStored((prev) =>
            pushHistory(prev, {
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
        onSettled: () => {
          sending.current = false
        },
      },
    )
  }

  // ---- CTA ----------------------------------------------------------------------
  const chainMismatch = wallet !== undefined && walletChainId !== undefined && evmSrc !== undefined && walletChainId !== evmSrc.chainId
  // Connect wallet → Switch to <chain> → Approve <amount> <token> → Send; one impossibility under it.
  const cta: CtaState = !wallet
    ? { kind: 'connect' }
    : chainMismatch
      ? { kind: 'switch', chain: src }
      : !token
        ? { kind: 'hold', label: d.ccip.cta_find }
        : !dstChain
          ? { kind: 'destination' }
          : amountInput.trim() === '' || amountError
            ? { kind: 'amount' }
            : !recipient
              ? { kind: 'recipient' }
              : !planData
                ? plan.error
                  ? { kind: 'send', enabled: false, reason: shortError(plan.error) }
                  : { kind: 'quote' }
                : approveIntent
                  ? { kind: 'approve', intent: approveIntent, enabled: waitsOnlyForApprove(report.blocks), ...(impossible ? { reason: ccipLabel(impossible.code) } : {}) }
                  : !report.canSend && report.results.every((r) => r.ok || isCcipPending(r))
                    ? { kind: 'checking' }
                    : { kind: 'send', enabled: report.canSend, ...(impossible ? { reason: ccipLabel(impossible.code) } : {}) }
  const onCta = () => {
    switch (cta.kind) {
      case 'connect':
        openConnectModal?.()
        return
      case 'switch':
        if (evmSrc) switchChain({ chainId: evmSrc.chainId })
        return
      case 'approve':
        onApprove()
        return
      case 'send':
        onSend()
        return
      default:
        return
    }
  }

  const dec = meta.data?.decimals ?? 18
  const sym = meta.data?.symbol ?? ''


  // ---- reverse: A → B becomes B → A in one click --------------------------------
  // The token on the other side is the pool's remote token; on the new source its pool is looked up
  // again in that chain's TokenAdminRegistry (core/reverse.ts). The amount stays; the recipient goes
  // back to the connected wallet.
  const reversal = reverseCcip(srcKey, dstChain, remote.data?.token)
  const reverseBusy = switching || sendWrite.isPending || approveBusy(approveFlow.phase)
  const reverseEnabled = !reverseBusy && reversal.ok
  const reverseTitle = reverseBusy
    ? d.reverse.busy
    : reversal.ok
      ? fmt(d.reverse.go, { from: byKey(reversal.chain).name, to: src.name })
      : d.reverse[reversal.reason]
  const onReverse = () => {
    if (!reverseEnabled || !reversal.ok) return
    setSrcKey(reversal.chain)
    setDstChain(reversal.dstChain)
    setInput(reversal.contract)
    setTarget(reversal.contract)
    setAnalysisInput(null)
    setInputError('')
    setRecipientCustom(false)
    setRecipientInput('')
    setConfirmLast6('')
    setSent(null)
    setTxError('')
    const next = byKey(reversal.chain)
    if (isEvm(next) && wallet && walletChainId !== next.chainId) switchChain({ chainId: next.chainId })
  }

  // ---- render ---------------------------------------------------------------------
  const tokenMeta = token ? { symbol: sym, decimals: dec } : undefined
  const recipientShown = recipientCustom || recipientOpen
  // Closing the panel means "my wallet": a recipient typed into a hidden panel would be a surprise.
  const toggleRecipient = () => {
    if (recipientShown) {
      setRecipientOpen(false)
      setRecipientCustom(false)
      setRecipientInput('')
      setConfirmLast6('')
    } else {
      setRecipientOpen(true)
    }
  }
  const amountNote = amountError ? (
    <span className="text-danger">{amountError}</span>
  ) : planData ? (
    isPreview ? undefined : <span className="tnum">{fmt(d.ui.receives, { amount: formatAmount(planData.received, planData.dst.decimals ?? dec, { maxFraction: 6 }), symbol: sym })}</span>
  ) : undefined
  const analysing = discovery.isFetching || analysis.isFetching

  const left = sent ? (
    <Shell>
      <div className="rounded-card bg-surface-2 p-4">
        <BoxLabel>{d.tracker.title}</BoxLabel>
        <p className="text-sm text-muted">{d.ccip.sentHint}</p>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <a href={src.explorerTxUrl + sent} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-dotted underline-offset-2">
            {d.tracker.sourceTx} ↗
          </a>
          <a href={ccipTxUrl(sent)} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-dotted underline-offset-2">
            CCIP Explorer ↗
          </a>
        </div>
        <RecipientBookAfterSend family={bookFamily} address={recipientCustom ? recipient?.display : undefined} />
      </div>
      <Button
        variant="cta"
        onClick={() => {
          setSent(null)
          setAmountInput('')
        }}
      >
        {d.tracker.newTransfer}
      </Button>
    </Shell>
  ) : (
    <>
      <Shell>
        <div className="rounded-card bg-surface-2 p-2 pl-4">
          <div className="flex h-10 items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') go()
              }}
              placeholder={d.ccip.placeholder}
              spellCheck={false}
              autoComplete="off"
              className="mono min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              aria-label={d.ccip.inputLabel}
            />
            <Button variant="primary" className="h-9 px-4" disabled={input.trim() === '' || analysing} onClick={go}>
              {analysing ? <Spinner /> : d.analysis.button}
            </Button>
          </div>
          {inputError ? (
            <div className="px-2 pb-2 pt-1 text-xs">
              <span className="text-danger">{inputError}</span> <span className="text-muted">{d.analysis.examples}</span>
            </div>
          ) : null}
        </div>
        {discovery.data?.kind === 'no_pool' ? <Alert kind="error">{d.ccip.noPool}</Alert> : null}
        {discovery.data?.kind === 'unknown' ? <Alert kind="error">{d.ccipReject[discovery.data.reason]}</Alert> : null}
        {token && pool ? (
          <p className="px-1 text-xs text-muted">
            {d.ccip.foundPool} <AddressView value={pool} href={src.explorerAddrUrl + pool} short />
          </p>
        ) : null}
        {/* The pool was found, but only one provider answered — say so rather than imply two agreed. */}
        {token && pool && discovery.data?.crossChecked === false ? <p className="px-1 text-xs text-warn">⚠ {d.card.flag_not_cross_checked}</p> : null}

        <FromToRow
          from={src}
          fromOptions={evmChains()
            .filter((c) => !!ccipConfig(c.key))
            .map((c) => c.key)}
          onFrom={(k) => {
            setSrcKey(k)
            setTarget(null)
            setDstChain(undefined)
          }}
          to={dstChain ? byKey(dstChain) : undefined}
          toOptions={destinations}
          onTo={(k) => setDstChain(k)}
          toDisabled={destinations.length === 0}
          reverse={{ enabled: reverseEnabled, title: reverseTitle, onClick: onReverse }}
        />
        {token && destinations.length === 0 ? <p className="px-1 text-xs text-muted">{d.ccip.noDestinations}</p> : null}

        <AmountPanel
          value={amountInput}
          onChange={setAmountInput}
          disabled={!token}
          token={tokenMeta}
          tokenIcon={token ? <ChainDot name={sym || 'T'} size={24} /> : undefined}
          balance={token ? tokenBalance.data : undefined}
          onMax={() => {
            if (token) setAmountInput(formatAmount(tokenBalance.data ?? 0n, dec))
          }}
          note={amountNote}
          recipientOpen={recipientShown}
          onToggleRecipient={toggleRecipient}
        />

        {recipientShown ? (
          <RecipientPanel
            crossVm={false}
            custom={recipientCustom}
            onCustom={(custom) => {
              setRecipientCustom(custom)
              if (!custom) {
                setRecipientInput('')
                setConfirmLast6('')
              }
            }}
            wallet={wallet}
            value={recipientInput}
            onChange={(v) => {
              setRecipientInput(v)
              setConfirmLast6('')
            }}
            placeholder="0x…"
            error={recipientError}
            bookFamily={bookFamily}
            bookVerdict={bookVerdict}
            onPickAddress={(a) => {
              setRecipientInput(a)
              setConfirmLast6('')
            }}
            bookConfirmed={bookConfirms(bookVerdict)}
            confirm={confirmLast6}
            confirmed={recipientConfirmed}
            onConfirm={setConfirmLast6}
          />
        ) : null}

      </Shell>
      <Cta
        state={cta}
        info={meta.data}
        sending={switching || sendWrite.isPending}
        approve={evmSrc ? { phase: approveFlow.phase, explorerTxUrl: evmSrc.explorerTxUrl } : undefined}
        onClick={onCta}
        error={txError}
      />
    </>
  )

  const right = (
    <Panel title={d.ui.preview} badge={<ProtocolBadge id="ccip" />}>
      {verdict ? <VerdictCard result={verdict} onAction={onAnalysisAction} /> : null}
      {!token ? (
        verdict ? null : <p className="px-1 text-sm text-muted">{d.ccip.previewEmpty}</p>
      ) : (
        <>
          <PanelSection title={d.risk.title}>
            <RouteIndicator indicator={indicator} noneText={impossible && planData ? d.indicator.held : dstChain ? d.indicator.enterAmount : d.indicator.chooseDestination} />
          </PanelSection>
          <PanelSection title={d.ui.section_contract}>
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
          </PanelSection>

          {planData ? (
            <PanelSection title={d.ui.section_quote}>
              {isPreview ? <p className="pb-1 text-xs text-muted">{fmt(d.step3.previewQuote, { amount: `${formatAmount(previewAmountRaw(dec), dec)} ${sym}` })}</p> : null}
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
            </PanelSection>
          ) : null}

          <PanelFold title={d.indicator.details}>
            <IndicatorReasons indicator={indicator} />
            {/* §4 The eight LayerZero checks have no CCIP runner; this tab's own guards are the whole rule. */}
            <RiskNotAssessed why={d.risk.notCoveredCcip} />
            <ul className="grid gap-x-3 gap-y-0.5 text-xs">
              {report.results.map((r) => (
                // Four tones: passed, in flight, the approve step (neutral), a note (amber), a block (red).
                <li key={r.id} className={r.ok ? 'text-ok' : isCcipPending(r) ? 'text-muted' : isStepCode(r.code) ? 'text-ink' : isNoteCode(r.code) ? 'text-warn' : 'text-danger'}>
                  {r.ok ? '✓' : isCcipPending(r) ? '○' : isStepCode(r.code) ? '→' : isNoteCode(r.code) ? '●' : '✗'}{' '}
                  {r.ok ? (d.ccipGuard[`ok_${r.id}` as keyof typeof d.ccipGuard] ?? '') : d.ccipGuard[r.code]}
                </li>
              ))}
            </ul>
            {check.data?.revert ? (
              <div className="text-xs text-warn">
                <div className="font-semibold">{d.revert[revertMeaning(check.data.revert) ?? 'generic']}</div>
                <div className="mono mt-1 opacity-80">{formatRevert(check.data.revert)}</div>
                {check.data.revert.kind === 'error' && check.data.revert.source === 'contract' ? <div className="mt-1 opacity-80">{d.revert.fromContractAbi}</div> : null}
              </div>
            ) : check.data?.rpcUnavailable ? (
              <p className="text-xs text-warn">{d.revert.rpcUnavailable}</p>
            ) : null}
          </PanelFold>
        </>
      )}
    </Panel>
  )

  return <TwoColumn left={left} right={right} />
}
