'use client'
/**
 * The Wormhole NTT tab. EVM to EVM.
 *
 * Nothing here can be signed until verifyNttManager() returns ok: the manager is the approve
 * spender, so the four-part gate is what stands between the user and handing an allowance to a
 * look-alike contract. The gate's verdict is the first thing on the right.
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
import { nttManagerAbi } from '@/protocols/wormhole-ntt/abi'
import { isNttPending, nttApprovePlan, runNttGuards, type NttGuardInput } from '@/protocols/wormhole-ntt/guards'
import { assembleNttTransferArgs, nttSelfCheck } from '@/protocols/wormhole-ntt/plan'
import { wormholescanTxUrl } from '@/protocols/wormhole-ntt/track'
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
import { reverseNtt } from '@/core/reverse'
import { Cta, type CtaState } from './components/Review'
import { isUserRejection, shortError, useAllowance, useNativeBalance, useTokenBalance } from './hooks'
import { useAnalysis } from './useAnalysis'
import { nttDestinations, useNttCheck, useNttDiscovery, useNttPlan, useNttTokenList, useNttVerification } from './nttHooks'
import { pushHistory, type Stored } from './storage'

export function NttApp({
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
  /** What another tab's analysis found for NTT, when the user arrived through the verdict card. */
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

  // Follow the wallet's chain when it is one we support.
  useEffect(() => {
    if (walletChainId === undefined) return
    const c = byChainId(walletChainId)
    if (c) setSrcKey(c.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletChainId])

  // Arriving from the OFT tab's analysis: take the manager and the destination it found.
  useEffect(() => {
    if (!handoff) return
    if (handoff.kind === 'ntt-manager') {
      setSrcKey(handoff.chain)
      setInput(handoff.address)
      setTarget(handoff.address)
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
  const analysis = useAnalysis(analysisInput, 'wormhole-ntt', srcKey, stored.customRpc)
  const verdict = analysis.data?.results[0]

  /**
   * One field, two kinds of answer. An address is this tab's own business and goes straight to the
   * manager lookup below. A transaction hash or a LayerZero Scan link goes to the shared analysis,
   * which reads the same logs here as anywhere else — and when it turns out to be another protocol,
   * the verdict card is the way across, instead of a dead button that teaches the user nothing.
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

  const tokenList = useNttTokenList()
  const discovery = useNttDiscovery(srcKey, dstChain, target, tokenList.data?.tokens, stored.customRpc)
  const manager = discovery.data?.kind === 'manager' ? discovery.data.manager : undefined

  const listedToken = useMemo(() => {
    const t = discovery.data?.kind === 'manager' ? discovery.data.token : discovery.data?.kind === 'token_without_minter' ? discovery.data.token : undefined
    if (!t || !tokenList.data) return undefined
    return tokenList.data.tokens.find((x) => Object.values(x.platforms).some((a) => a.toLowerCase() === t.toLowerCase()))
  }, [discovery.data, tokenList.data])

  const destinations = useMemo(
    () => nttDestinations(listedToken, evmChains().map((c) => c.key), srcKey),
    [listedToken, srcKey],
  )

  const verification = useNttVerification(srcKey, dstChain, manager, tokenList.data?.tokens, stored.customRpc)
  const verified = verification.data?.ok ? verification.data.verified : undefined

  // ---- amount & recipient ------------------------------------------------------
  let amountError = ''
  let amountRaw: bigint | undefined
  if (verified && amountInput.trim() !== '') {
    try {
      amountRaw = parseAmount(amountInput, verified.tokenDecimals)
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
  // §Address book. NTT bridges EVM to EVM, so the family is always 'evm' here; it is derived
  // rather than written out so a future non-EVM destination cannot inherit the wrong one.
  const bookFamily = familyOfVm('evm')
  const bookVerdict = useBookVerdict(bookFamily, recipientCustom ? recipient?.display : undefined)

  const recipientConfirmed =
    recipientCustom && recipient !== undefined && (bookConfirms(bookVerdict) || confirmsTail(recipient, confirmLast6))

  const plan = useNttPlan({ verification: verification.data, sender: wallet, recipient, amountRaw, customRpc: stored.customRpc })
  const planData = plan.data

  const tokenBalance = useTokenBalance(evmSrc, verified?.token, wallet)
  const nativeBalance = useNativeBalance(evmSrc, wallet)
  const allowance = useAllowance(evmSrc, verified?.token, wallet, verified?.manager)

  // ---- guards ------------------------------------------------------------------
  const approveIntent = nttApprovePlan(verification.data, planData, allowance.data)
  const baseInput: NttGuardInput = {
    walletAddress: wallet,
    walletChainId,
    srcChainId: evmSrc?.chainId ?? 0,
    verification: verification.data,
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
  const pre = runNttGuards(baseInput)
  // 14 (the fee ceiling) is a note, and the notes must not gate the simulation.
  // Only a BLOCK holds the simulation back; a note is the indicator's business.
  const preOk = pre.results.filter((r) => r.id !== 8 && r.id !== 9 && r.id !== 12 && r.id !== 13 && r.id !== 14).every((r) => r.ok || isNoteCode(r.code))
  const check = useNttCheck(planData, preOk, stored.customRpc)
  // `guardInput` is what the click re-runs, so it carries everything the render judged.
  const guardInput: NttGuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation: check.data?.simulation,
    selfCheck: check.data?.selfCheck,
  }
  const report = runNttGuards(guardInput)
  // The line under the button names the impossibility, if there is one. Notes are the indicator's.
  const impossible = shownFailures(report.blocks, { dropPending: true, dropSteps: true })[0]
  const nttLabel = (c: string) => d.nttGuard[c as keyof typeof d.nttGuard] ?? c

  // The route indicator: the tab's own checks, coloured (core/indicator.ts). NTT with a source-side
  // anchor and a passing simulation is green; no anchor is red; the eight LayerZero checks do not apply.
  const indicator = assessIndicator({
    hasDestination: !!dstChain,
    hasPlan: !!planData,
    results: report.results,
    held: impossible !== undefined,
    label: nttLabel,
    flags: verification.data?.ok && verification.data.crossChecked === false ? ['not_cross_checked'] : [],
    flagLabel: (f) => (d.card as Record<string, string>)[`flag_${f}`] ?? f,
    riskCovered: false,
    riskPending: false,
  })

  // ---- writes -------------------------------------------------------------------
  // The flow signs approve(manager, amount) for exactly the intent the guards checked, waits for
  // the receipt and reads the allowance back; the button becomes Send by itself.
  const approveFlow = useApproveFlow({
    chainId: evmSrc?.chainId,
    owner: wallet,
    token: verified?.token,
    spender: approveIntent?.spender,
    amount: approveIntent?.amount,
    allowance: allowance.data,
    refetchAllowance: async () => (await allowance.refetch()).data,
  })

  const onApprove = () => {
    setTxError('')
    // Re-derived at click time from the VERIFIED manager; never from render state.
    const intent = nttApprovePlan(verification.data, planData, allowance.data)
    if (!intent || !verified || !evmSrc) return
    if (intent.spender !== verified.manager || intent.token !== verified.token) return
    // No allowance for a transfer that cannot happen: the approve is a step of THIS transfer.
    if (!waitsOnlyForApprove(runNttGuards(guardInput).blocks)) return
    void approveFlow.start()
  }

  const sendWrite = useWriteContract()
  // One wallet prompt per click (a ref: isPending flips only on the next render).
  const sending = useRef(false)
  const onSend = () => {
    setTxError('')
    const p = planData
    if (!p || !evmSrc || !verified) return
    if (sending.current) return
    if (!runNttGuards(guardInput).canSend) return
    if (p.manager !== verified.manager) return
    const a = assembleNttTransferArgs(p)
    // The same self-check the simulation ran, on the exact args that go to the wallet.
    const sc = nttSelfCheck(p, encodeFunctionData({ abi: nttManagerAbi, functionName: 'transfer', args: [a[0], a[1], a[2], a[3], a[4], a[5]] }))
    if (!sc.ok) {
      setTxError(d.guard.selfcheck_failed)
      return
    }
    sending.current = true
    sendWrite.writeContract(
      {
        address: p.manager,
        abi: nttManagerAbi,
        functionName: 'transfer',
        args: [a[0], a[1], a[2], a[3], a[4], a[5]],
        value: p.value,
        chainId: evmSrc.chainId,
      },
      {
        onSuccess: (hash) => {
          setSent(hash)
          setStored(
            pushHistory(stored, {
              srcChain: srcKey,
              protocol: 'wormhole-ntt',
              // NTT does not use LayerZero eids; the destination is recorded as a chain.
              dstEid: 0,
              dstChain: p.dst.chain,
              oft: p.manager,
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
      : !manager
        ? { kind: 'hold', label: d.ntt.cta_find }
        : !dstChain
          ? { kind: 'destination' }
          : !verified
            ? { kind: 'hold', label: d.ntt.cta_verifying, spinner: verification.isFetching }
            : amountInput.trim() === '' || amountError
              ? { kind: 'amount' }
              : !recipient
                ? { kind: 'recipient' }
                : !planData
                  ? plan.error
                    ? { kind: 'send', enabled: false, reason: shortError(plan.error) }
                    : { kind: 'quote' }
                  : approveIntent
                    ? { kind: 'approve', intent: approveIntent, enabled: waitsOnlyForApprove(report.blocks), ...(impossible ? { reason: nttLabel(impossible.code) } : {}) }
                    : !report.canSend && report.results.every((r) => r.ok || isNttPending(r))
                      ? { kind: 'checking' }
                      : { kind: 'send', enabled: report.canSend, ...(impossible ? { reason: nttLabel(impossible.code) } : {}) }
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


  // ---- reverse: A → B becomes B → A in one click --------------------------------
  // The manager on the other side is the peer verification already found; on the new source it is
  // verified again from scratch, anchor included (core/reverse.ts). The amount stays; the recipient
  // goes back to the connected wallet.
  const reversal = reverseNtt(verified)
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
  const tokenMeta = verified ? { symbol: verified.tokenSymbol, decimals: verified.tokenDecimals } : undefined
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
  ) : planData && verified && planData.dust > 0n ? (
    <span className="text-warn">{fmt(d.ntt.dust, { amount: formatAmount(planData.dust, planData.trim.step > 1n ? verified.tokenDecimals : 0), symbol: verified.tokenSymbol })}</span>
  ) : planData && verified ? (
    <span className="tnum">{fmt(d.ui.receives, { amount: formatAmount(planData.received, planData.dst.tokenDecimals, { maxFraction: 6 }), symbol: verified.tokenSymbol })}</span>
  ) : undefined
  const analysing = discovery.isFetching || tokenList.isLoading || analysis.isFetching

  const left = sent ? (
    <Shell>
      <div className="rounded-card bg-surface-2 p-4">
        <BoxLabel>{d.tracker.title}</BoxLabel>
        <p className="text-sm text-muted">{d.ntt.sentHint}</p>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <a href={src.explorerTxUrl + sent} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-dotted underline-offset-2">
            {d.tracker.sourceTx} ↗
          </a>
          <a href={wormholescanTxUrl(sent)} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-dotted underline-offset-2">
            Wormholescan ↗
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
              placeholder={d.ntt.placeholder}
              spellCheck={false}
              autoComplete="off"
              className="mono min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              aria-label={d.ntt.inputLabel}
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
        {tokenList.data?.unavailable ? <Alert kind="warn">{d.ntt.listUnavailable}</Alert> : null}
        {discovery.data?.kind === 'unknown' ? <Alert kind="error">{discovery.data.reason === 'not_listed' ? d.ntt.notListed : d.ntt.unreadable}</Alert> : null}
        {discovery.data?.kind === 'token_without_minter' ? <Alert kind="warn">{dstChain ? d.ntt.noMinter : d.ntt.pickDestinationFirst}</Alert> : null}
        {discovery.data?.kind === 'manager' ? (
          <p className="px-1 text-xs text-muted">
            {discovery.data.via === 'minter' ? d.ntt.foundViaMinter : discovery.data.via === 'peer' ? d.ntt.foundViaPeer : d.ntt.foundGiven}{' '}
            <AddressView value={discovery.data.manager} href={src.explorerAddrUrl + discovery.data.manager} short />
          </p>
        ) : null}

        <FromToRow
          from={src}
          fromOptions={evmChains().map((c) => c.key)}
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
        {destinations.length === 0 && listedToken ? <p className="px-1 text-xs text-muted">{d.ntt.noDestinations}</p> : null}

        <AmountPanel
          value={amountInput}
          onChange={setAmountInput}
          disabled={!verified}
          token={tokenMeta}
          tokenIcon={verified ? <ChainDot name={verified.tokenSymbol || 'T'} size={24} /> : undefined}
          balance={verified ? tokenBalance.data : undefined}
          onMax={() => {
            if (verified) setAmountInput(formatAmount(tokenBalance.data ?? 0n, verified.tokenDecimals))
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
        info={verified ? { decimals: verified.tokenDecimals, symbol: verified.tokenSymbol } : undefined}
        sending={switching || sendWrite.isPending}
        approve={evmSrc ? { phase: approveFlow.phase, explorerTxUrl: evmSrc.explorerTxUrl } : undefined}
        onClick={onCta}
        error={txError}
      />
    </>
  )

  const right = (
    <Panel title={d.ui.preview} badge={<ProtocolBadge id="wormhole-ntt" />}>
      {/* A pasted transaction is answered by the verdict; the manager gate has nothing to say
          about it, and showing "not verified" next to "this is CCIP" would only muddle both. */}
      {verdict ? (
        <VerdictCard result={verdict} onAction={onAnalysisAction} />
      ) : (
        <VerificationCard verification={verification.data} loading={verification.isFetching} hasTarget={!!manager && !!dstChain} />
      )}
      {verified ? (
        <>
          <PanelSection title={d.risk.title}>
            <RouteIndicator indicator={indicator} noneText={impossible && planData ? d.indicator.held : dstChain ? d.indicator.enterAmount : d.indicator.chooseDestination} />
          </PanelSection>
          {planData ? (
            <PanelSection title={d.ui.section_quote}>
              <Row label={d.step3.sending}>
                <b className="tnum">{formatAmount(planData.amount, verified.tokenDecimals)} {verified.tokenSymbol}</b>
              </Row>
              <Row label={d.ntt.received}>
                <b className="tnum">{formatAmount(planData.received, planData.dst.tokenDecimals)} {verified.tokenSymbol}</b>
                <div className="text-xs text-muted">{fmt(d.ntt.trimNote, { decimals: String(planData.trim.trimmedDecimals) })}</div>
              </Row>
              <Row label={d.ntt.deliveryFee}>
                <b className="tnum">{formatAmount(planData.fee, 18, { maxFraction: 6 })} {src.nativeSymbol}</b>
                <div className="text-xs text-muted">{fmt(d.step3.feeDetail, { value: `${formatAmount(planData.value, 18, { maxFraction: 6 })} ${src.nativeSymbol}`, refund: `${formatAmount(planData.value - planData.fee, 18, { maxFraction: 6 })} ${src.nativeSymbol}` })}</div>
              </Row>
              <Row label={d.ntt.mode}>{planData.mode === 'burning' ? d.ntt.mode_burning : d.ntt.mode_locking}</Row>
              <Row label={d.ntt.outbound}>
                <span className="tnum">{formatAmount(planData.outboundCapacity, verified.tokenDecimals, { maxFraction: 4 })}</span>
              </Row>
              <Row label={d.ntt.inbound}>
                <span className="tnum">{planData.inboundCapacity === undefined ? '—' : formatAmount(planData.inboundCapacity, planData.dst.tokenDecimals, { maxFraction: 4 })}</span>
              </Row>
              <Row label={d.step3.recipient} mono>
                <AddressView value={planData.recipientDisplay} href={byKey(planData.dst.chain).explorerAddrUrl + planData.recipientDisplay} short />
              </Row>
            </PanelSection>
          ) : null}
          <PanelFold title={d.indicator.details}>
            <IndicatorReasons indicator={indicator} />
            {/* §4 The eight LayerZero checks have no NTT runner; this tab's own guards are the whole rule. */}
            <RiskNotAssessed why={d.risk.notCoveredNtt} />
            <ul className="grid gap-x-3 gap-y-0.5 text-xs">
              {report.results.map((r) => (
                // Four tones: passed, in flight, the approve step (neutral), a note (amber), a block (red).
                <li key={r.id} className={r.ok ? 'text-ok' : isNttPending(r) ? 'text-muted' : isStepCode(r.code) ? 'text-ink' : isNoteCode(r.code) ? 'text-warn' : 'text-danger'}>
                  {r.ok ? '✓' : isNttPending(r) ? '○' : isStepCode(r.code) ? '→' : isNoteCode(r.code) ? '●' : '✗'}{' '}
                  {r.ok ? d.nttGuard[`ok_${r.id}` as keyof typeof d.nttGuard] ?? '' : d.nttGuard[r.code]}
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
      ) : null}
    </Panel>
  )

  return <TwoColumn left={left} right={right} />
}

/** The four-part gate, in colour. This is what decides whether an approve is possible at all. */
function VerificationCard({ verification, loading, hasTarget }: { verification: ReturnType<typeof useNttVerification>['data']; loading: boolean; hasTarget: boolean }) {
  const d = useDict()
  if (!hasTarget) return <p className="px-1 text-sm text-muted">{d.ntt.previewEmpty}</p>
  if (loading || !verification) {
    return (
      <p className="inline-flex items-center gap-2 px-1 text-sm text-muted">
        <Spinner /> {d.ntt.verifying}
      </p>
    )
  }
  if (!verification.ok) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-card bg-surface-2 px-4 py-3 text-sm font-semibold text-danger">✗ {d.ntt.rejected}</div>
        <p className="text-sm text-muted">{d.nttReject[verification.code]}</p>
        {verification.detail ? <p className="mono text-xs text-faint">{verification.detail.slice(0, 120)}</p> : null}
        <p className="text-xs text-muted">{d.ntt.noApprove}</p>
      </div>
    )
  }
  const v = verification.verified
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-card bg-surface-2 px-4 py-3 text-sm font-semibold text-ok">✓ {d.ntt.verified}</div>
      {/* The gate passed, but only one provider answered — say so rather than imply two agreed. */}
      {verification.crossChecked === false ? <p className="text-xs text-warn">⚠ {d.card.flag_not_cross_checked}</p> : null}
      {/* Context, not a caveat: the catalogue never had a say in the verdict above it. */}
      {v.listed ? null : <p className="text-xs text-muted">{d.ntt.unlistedToken}</p>}
      <div className="rounded-card bg-surface-2 px-4 py-2">
        <Row label={d.ntt.manager} mono>
          <AddressView value={v.manager} href={byKey(v.chain).explorerAddrUrl + v.manager} short />
        </Row>
        <Row label={d.card.token} mono>
          <AddressView value={v.token} href={byKey(v.chain).explorerAddrUrl + v.token} short />
        </Row>
        <Row label={d.ntt.anchor}>
          {v.anchor === null ? d.ntt.anchorNone : fmt(d.ntt.anchorValue, { side: byKey(v.chain).name, kind: v.anchor.kind })}
          {/* The far-side anchor is context, never a reason — see verify.ts. */}
          {v.alsoOnDestination ? <div className="mt-1 text-xs text-muted">{fmt(d.ntt.anchorAlsoDst, { chain: byKey(v.dst.chain).name })}</div> : null}
        </Row>
        <Row label={d.ntt.transceiver} mono>
          <AddressView value={v.transceiver} href={byKey(v.chain).explorerAddrUrl + v.transceiver} short />
        </Row>
        <Row label={d.ntt.peer} mono>
          <AddressView value={v.dst.manager} href={byKey(v.dst.chain).explorerAddrUrl + v.dst.manager} short />
        </Row>
      </div>
    </div>
  )
}
