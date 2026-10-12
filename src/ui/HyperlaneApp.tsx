'use client'
/**
 * The Hyperlane tab. EVM to EVM, one token, one warp route.
 *
 * The approve spender is the ROUTER the discovery held against the registry Mailbox
 * (src/protocols/hyperlane/chains.ts) — and only on a collateral route; a synthetic route burns from
 * the sender and a native route takes the coin as value, so neither gets an approve. The pasted
 * address can be the route itself (every HypERC20 is), or a plain ERC-20, which the committed
 * registry hint table matches to the collateral routes listed for it; each candidate is then
 * probed like any pasted contract, and the one that holds exactly this token is the route.
 */
import { isNoteCode, isStepCode, shownFailures, waitsOnlyForApprove } from '@/core/severity'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { encodeFunctionData, isAddressEqual, type Address } from 'viem'
import { assessIndicator } from '@/core/indicator'
import { useApproveFlow } from './useApproveFlow'
import { useLinkSync } from './useLink'
import { AmountError, formatAmount, parseAmount } from '@/core/amounts'
import { byChainId, byKey, evmChains, isEvm, type ChainKey } from '@/core/chains'
import { parseAnalysisInput, type AnalysisInput } from '@/core/analysis/input'
import type { AnalysisAction, AnalysisTarget } from '@/core/analysis/result'
import type { ProtocolId } from '@/core/protocols'
import { formatBps } from '@/core/oftFee'
import { confirmsTail, tryRecipient, type Recipient } from '@/core/recipient'
import { familyOfVm } from '@/core/addressBook'
import { bookConfirms, bookRefuses, RecipientBookAfterSend, useBookVerdict } from './components/RecipientBook'
import { formatRevert, revertMeaning } from '@/core/sim/revert'
import { warpRouteAbi } from '@/protocols/hyperlane/abi'
import { hyperlaneConfig } from '@/protocols/hyperlane/chains'
import { warpStandingOk, type WarpRouter } from '@/protocols/hyperlane/discover'
import { hyperlaneApprovePlan, isHyperlanePending, runHyperlaneGuards, type HyperlaneGuardInput } from '@/protocols/hyperlane/guards'
import { assembleTransferRemoteArgs, HyperlanePlanError, routeFeeBps } from '@/protocols/hyperlane/plan'
import { hyperlaneSelfCheck } from '@/protocols/hyperlane/preview'
import { hyperlaneMessageUrl, hyperlaneTxUrl } from '@/protocols/hyperlane/track'
import { warpRouteHints } from '@/protocols/hyperlane/warpRoutes'
import { ADAPTER_MIN_LOCKED_BPS, ADAPTER_MIN_OUTBOUND_NONCE } from '@/protocols/lz-risk/adapters'
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
import { reverseHyperlane } from '@/core/reverse'
import { Cta, type CtaState } from './components/Review'
import { useAnalysis } from './useAnalysis'
import { useHyperlaneCheck, useHyperlaneDelivery, useHyperlanePlan, useWarpRemote, useWarpRoute, useWarpRouteCandidates, useWarpStanding } from './hyperlaneHooks'
import { isUserRejection, shortError, useAllowance, useNativeBalance, useTokenBalance } from './hooks'
import { pushHistory, setHistoryStatus, type HistoryEntry, type SetStored, type Stored } from './storage'

import { PREVIEW_ADDRESS, PREVIEW_RECIPIENT, previewAmountRaw, previewCaption } from './preview'

export function HyperlaneApp({
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
  /** What another tab's analysis found for Hyperlane, carried across when this tab opened. */
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
  const cfg = hyperlaneConfig(srcKey)
  const [input, setInput] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  /** A router chosen from the registry hints for a pasted token — probed like any pasted address. */
  const [pickedRouter, setPickedRouter] = useState<Address | null>(null)
  const [dstChain, setDstChain] = useState<ChainKey | undefined>(undefined)
  const [amountInput, setAmountInput] = useState('')
  const [recipientOpen, setRecipientOpen] = useState(false)
  const [recipientCustom, setRecipientCustom] = useState(false)
  const [recipientInput, setRecipientInput] = useState('')
  const [confirmLast6, setConfirmLast6] = useState('')
  const [sent, setSent] = useState<{ hash: string; at: number } | null>(null)
  const [txError, setTxError] = useState('')

  // Follow the wallet's chain when the user SWITCHES it to one we support (see CcipApp).
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
    setSent({ hash: trackRequest.txHash, at: trackRequest.at })
    onTrackConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackRequest])

  // Arriving from another tab's analysis, or from a link, with a route it recognised.
  useEffect(() => {
    if (!handoff) return
    if (handoff.kind === 'hyperlane-router') {
      setSrcKey(handoff.chain)
      setInput(handoff.address)
      setTarget(handoff.address)
      setPickedRouter(null)
      if (handoff.dstChain) setDstChain(handoff.dstChain)
    }
    onHandoffConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.address, handoff?.chain])

  // The address bar follows the form: bridge (the path), source, token, destination (core/link.ts).
  useLinkSync(target ? { from: srcKey, token: target, to: dstChain } : undefined)

  // ---- whatever was pasted ----------------------------------------------------
  const [analysisInput, setAnalysisInput] = useState<AnalysisInput | null>(null)
  const [inputError, setInputError] = useState('')
  const analysis = useAnalysis(analysisInput, 'hyperlane', srcKey, stored.customRpc)
  const verdict = analysis.data?.results[0]

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
      setPickedRouter(null)
      setTarget(r.input.address)
      return
    }
    if (r.input.kind === 'evm_tx' || r.input.kind === 'lz_guid') {
      setTarget(null)
      setPickedRouter(null)
      setAnalysisInput(r.input)
      return
    }
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
        setPickedRouter(null)
        setTarget(a.address)
        if (verdict?.target?.dstChain) setDstChain(verdict.target.dstChain)
        return
      default:
        return
    }
  }

  // ---- the route ----------------------------------------------------------------
  const typed = useWarpRoute(srcKey, target, stored.customRpc)
  const typedData = typed.data
  const typedToken = typedData?.kind === 'token' ? typedData : undefined
  // The registry's candidates for a pasted token: a search hint, never a fact. Every one of them
  // is probed; only those that answer as a router holding exactly this token are ever shown.
  const hints = useMemo(() => (typedToken ? warpRouteHints(srcKey, typedToken.token) : []), [srcKey, typedToken])
  const candidateRouters = useMemo(() => hints.map((h) => h.router), [hints])
  const candidates = useWarpRouteCandidates(srcKey, candidateRouters, !!typedToken, stored.customRpc)
  const candidatesSettled = candidates.every((q) => q.data !== undefined || q.isError)
  const passing = useMemo(
    () =>
      typedToken
        ? hints.filter((_, i) => {
            const c = candidates[i]?.data
            return c?.kind === 'router' && !!c.token && isAddressEqual(c.token, typedToken.token)
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typedToken?.token, hints, ...candidates.map((q) => q.data)],
  )
  // The reason the first candidate was turned down, for the one line that says so.
  const refusedReason = (() => {
    const c = candidates.find((q) => q.data !== undefined)?.data
    if (!c) return undefined
    if (c.kind === 'unknown') return d.hyperlaneReject[c.reason]
    if (c.kind === 'router') return d.hyperlane.hintHoldsOther
    return d.hyperlaneReject.not_a_router
  })()
  useEffect(() => {
    if (typedToken && passing.length === 1 && !pickedRouter) setPickedRouter(passing[0]!.router)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedToken?.token, passing.length])
  const picked = useWarpRoute(srcKey, pickedRouter, stored.customRpc)
  const pickedData = picked.data
  // A candidate the registry named must hold exactly the pasted token, or it is not offered.
  const hintMismatch = !!typedToken && pickedData?.kind === 'router' && (!pickedData.token || !isAddressEqual(pickedData.token, typedToken.token))
  const discovery = typedData?.kind === 'router' ? typedData : pickedData?.kind === 'router' && !hintMismatch ? pickedData : undefined
  const router: WarpRouter | undefined = discovery
  const crossChecked = typedData?.kind === 'router' ? typed.data?.crossChecked : pickedData?.kind === 'router' ? picked.data?.crossChecked : undefined
  const token = router?.token
  const remote = useWarpRemote(srcKey, dstChain, router, stored.customRpc)
  const standing = useWarpStanding(srcKey, router, stored.customRpc)

  const destinations = useMemo(() => (router ? router.routes.map((r) => r.chain) : []), [router])
  const remoteRoute = router && dstChain ? router.routes.find((r) => r.chain === dstChain) : undefined

  const dec = router?.decimals ?? 18
  const sym = router?.symbol ?? ''
  const native = router?.warpKind === 'native'

  let amountError = ''
  let amount: bigint | undefined
  if (router && amountInput.trim() !== '') {
    try {
      amount = parseAmount(amountInput, router.decimals)
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
  const bookFamily = familyOfVm('evm')
  const bookVerdict = useBookVerdict(bookFamily, recipientCustom ? recipient?.display : undefined)
  const recipientConfirmed =
    recipientCustom && recipient !== undefined && (bookConfirms(bookVerdict) || confirmsTail(recipient, confirmLast6))

  // The preview (ui/preview.ts): with no amount, no wallet or no recipient yet, the plan is built
  // for one whole token and stand-ins, so the route's colour is known before the token is bought.
  const previewing = !amountError && !!router && !!dstChain && (amountInput.trim() === '' || !wallet || !recipient)
  const plan = useHyperlanePlan({
    chain: srcKey,
    dstChain,
    router,
    remote: remote.data,
    sender: wallet ?? (previewing ? PREVIEW_ADDRESS : undefined),
    recipient: recipient ?? (previewing ? PREVIEW_RECIPIENT : undefined),
    amount: amount ?? (previewing && router ? previewAmountRaw(router.decimals) : undefined),
    customRpc: stored.customRpc,
  })
  const planData = plan.data
  const isPreview = previewing && !!planData
  const planError = plan.error ? (plan.error instanceof HyperlanePlanError ? d.hyperlanePlan[plan.error.code] : shortError(plan.error)) : undefined

  const tokenBalance = useTokenBalance(evmSrc, token, wallet)
  const nativeBalance = useNativeBalance(evmSrc, wallet)
  const allowance = useAllowance(evmSrc, router?.warpKind === 'collateral' ? token : undefined, wallet, router?.router)

  const approveIntent = hyperlaneApprovePlan(router, planData, allowance.data)
  const baseInput: HyperlaneGuardInput = {
    walletAddress: wallet,
    walletChainId,
    srcChainId: evmSrc?.chainId ?? 0,
    srcChain: srcKey,
    plan: planData,
    remote: remote.data,
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
  const pre = runHyperlaneGuards(baseInput)
  // Only a BLOCK holds the simulation back; a note is the indicator's business, and the reads that
  // the simulation itself answers (gas, allowance, the far side) must not gate it.
  const preOk = pre.results.filter((r) => ![6, 8, 9, 12, 13, 14].includes(r.id)).every((r) => r.ok || isNoteCode(r.code))
  const check = useHyperlaneCheck(planData, preOk, approveIntent ?? undefined, stored.customRpc)
  const guardInput: HyperlaneGuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation: check.data?.simulation,
    selfCheck: check.data?.selfCheck,
  }
  const report = runHyperlaneGuards(guardInput)
  const impossible = shownFailures(report.blocks, { dropPending: true, dropSteps: true })[0]

  /** The sentence for a guard code; the route-fee notes name the fee, the symbol and the share. */
  const hlLabel = (c: string): string => {
    const raw = (d.hyperlaneGuard as Record<string, string>)[c] ?? c
    if (!c.startsWith('route_fee_') || !planData) return raw
    return fmt(raw, { fee: formatAmount(planData.routeFee, planData.decimals), symbol: sym, pct: formatBps(routeFeeBps(planData)) })
  }

  // The route's standing (discover.ts): a flag for the indicator, with the numbers in the details.
  const standingFlag: string | undefined =
    !router || router.warpKind === 'synthetic'
      ? undefined
      : standing.data
        ? warpStandingOk(router.warpKind, standing.data)
          ? undefined
          : 'route_fresh'
        : standing.isError
          ? 'route_standing_unknown'
          : undefined
  const flags = [...(router && crossChecked === false ? ['not_cross_checked'] : []), ...(standingFlag ? [standingFlag] : [])]
  const flagLabel = (f: string) => (d.hyperlane as Record<string, string>)[`flag_${f}`] ?? (d.card as Record<string, string>)[`flag_${f}`] ?? f

  const indicator = assessIndicator({
    hasDestination: !!dstChain,
    hasPlan: !!planData,
    planError,
    results: report.results,
    held: impossible !== undefined,
    preview: router && (isPreview || (impossible !== undefined && planData)) ? previewCaption(d, isPreview ? 'probe' : 'held', router.decimals, sym) : undefined,
    label: hlLabel,
    flags,
    flagLabel,
    riskCovered: false,
    riskPending: false,
  })

  // ---- writes -------------------------------------------------------------------
  const approveFlow = useApproveFlow({
    chainId: evmSrc?.chainId,
    owner: wallet,
    token: approveIntent?.token,
    spender: approveIntent?.spender,
    amount: approveIntent?.amount,
    allowance: allowance.data,
    refetchAllowance: async () => (await allowance.refetch()).data,
  })

  const onApprove = () => {
    setTxError('')
    // Re-derived from the verified discovery at click time, never from render state alone.
    const intent = hyperlaneApprovePlan(router, planData, allowance.data)
    if (!intent || !evmSrc || !router) return
    if (!isAddressEqual(intent.spender, router.router)) return
    if (!waitsOnlyForApprove(runHyperlaneGuards(guardInput).blocks)) return
    void approveFlow.start()
  }

  const sendWrite = useWriteContract()
  const sending = useRef(false)
  const onSend = () => {
    setTxError('')
    const p = planData
    if (!p || !evmSrc || !router || !cfg) return
    if (sending.current) return
    if (!runHyperlaneGuards(guardInput).canSend) return
    if (!isAddressEqual(p.router, router.router) || !isAddressEqual(p.mailbox, cfg.mailbox as Address)) return
    const [destination, recipientBytes32, amountArg] = assembleTransferRemoteArgs(p)
    // The same self-check the simulation ran, on the exact args that go to the wallet.
    const sc = hyperlaneSelfCheck(p, encodeFunctionData({ abi: warpRouteAbi, functionName: 'transferRemote', args: [destination, recipientBytes32, amountArg] }))
    if (!sc.ok) {
      setTxError(d.guard.selfcheck_failed)
      return
    }
    sending.current = true
    sendWrite.writeContract(
      {
        address: p.router,
        abi: warpRouteAbi,
        functionName: 'transferRemote',
        args: [destination, recipientBytes32, amountArg],
        value: p.value,
        chainId: evmSrc.chainId,
      },
      {
        onSuccess: (hash) => {
          const at = Date.now()
          setSent({ hash, at })
          setStored((prev) =>
            pushHistory(prev, {
              srcChain: srcKey,
              protocol: 'hyperlane',
              dstEid: 0,
              dstChain: p.dst.chain,
              oft: p.router,
              txHash: hash,
              at,
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

  // ---- delivery of a sent transfer --------------------------------------------------
  const delivery = useHyperlaneDelivery(srcKey, sent?.hash, sent?.at, stored.customRpc)
  const deliveryPhase = delivery.data?.phase
  useEffect(() => {
    if (!sent || (deliveryPhase !== 'delivered' && deliveryPhase !== 'failed')) return
    setStored((prev) => setHistoryStatus(prev, sent.hash, deliveryPhase))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent?.hash, deliveryPhase])

  // ---- CTA ----------------------------------------------------------------------
  const chainMismatch = wallet !== undefined && walletChainId !== undefined && evmSrc !== undefined && walletChainId !== evmSrc.chainId
  const cta: CtaState = !wallet
    ? { kind: 'connect' }
    : chainMismatch
      ? { kind: 'switch', chain: src }
      : !router
        ? { kind: 'hold', label: d.hyperlane.cta_find }
        : !dstChain
          ? { kind: 'destination' }
          : amountInput.trim() === '' || amountError
            ? { kind: 'amount' }
            : !recipient
              ? { kind: 'recipient' }
              : !planData
                ? planError
                  ? { kind: 'send', enabled: false, reason: planError }
                  : { kind: 'quote' }
                : approveIntent
                  ? { kind: 'approve', intent: approveIntent, enabled: waitsOnlyForApprove(report.blocks), ...(impossible ? { reason: hlLabel(impossible.code) } : {}) }
                  : !report.canSend && report.results.every((r) => r.ok || isHyperlanePending(r))
                    ? { kind: 'checking' }
                    : { kind: 'send', enabled: report.canSend, ...(impossible ? { reason: hlLabel(impossible.code) } : {}) }
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
  const reversal = reverseHyperlane(srcKey, dstChain, remoteRoute?.router)
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
    setPickedRouter(null)
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
  const tokenMeta = router ? { symbol: sym, decimals: dec } : undefined
  const recipientShown = recipientCustom || recipientOpen
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
  const balanceShown = router ? (native ? nativeBalance.data?.value : tokenBalance.data) : undefined
  const amountNote = amountError ? (
    <span className="text-danger">{amountError}</span>
  ) : planData && !isPreview ? (
    <span className="tnum">{fmt(d.ui.receives, { amount: formatAmount(planData.received, planData.dst.decimals ?? dec, { maxFraction: 6 }), symbol: planData.dst.symbol ?? sym })}</span>
  ) : undefined
  const analysing = typed.isFetching || picked.isFetching || analysis.isFetching || candidates.some((q) => q.isFetching)

  const dstDef = delivery.data?.dstChain ? byKey(delivery.data.dstChain) : dstChain ? byKey(dstChain) : undefined
  const left = sent ? (
    <Shell>
      <div className="rounded-card bg-surface-2 p-4">
        <BoxLabel>{d.tracker.title}</BoxLabel>
        <p className="text-sm text-muted">{d.hyperlane.sentHint}</p>
        <p className={`mt-2 text-sm ${deliveryPhase === 'delivered' ? 'text-ok' : deliveryPhase === 'failed' ? 'text-danger' : 'text-ink'}`}>
          {deliveryPhase === 'delivered'
            ? fmt(d.hyperlane.delivery_delivered, { chain: dstDef?.name ?? '' })
            : deliveryPhase === 'failed'
              ? d.tracker.sourceFailed
              : deliveryPhase === 'pending'
                ? fmt(d.hyperlane.delivery_pending, { chain: dstDef?.name ?? '' })
                : d.hyperlane.delivery_no_data}
          {delivery.data?.processedAtBlock !== undefined ? <span className="text-muted"> · {fmt(d.hyperlane.deliveryBlock, { block: delivery.data.processedAtBlock.toString() })}</span> : null}
        </p>
        {delivery.data?.messageId ? (
          <p className="mono mt-1 break-all text-xs text-muted">
            {d.hyperlane.messageId}: {delivery.data.messageId}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <a href={src.explorerTxUrl + sent.hash} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-dotted underline-offset-2">
            {d.tracker.sourceTx} ↗
          </a>
          <a
            href={delivery.data?.messageId ? hyperlaneMessageUrl(delivery.data.messageId) : hyperlaneTxUrl(sent.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink underline decoration-dotted underline-offset-2"
          >
            {d.hyperlane.explorer} ↗
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
              placeholder={d.hyperlane.placeholder}
              spellCheck={false}
              autoComplete="off"
              className="mono min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
              aria-label={d.hyperlane.inputLabel}
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
        {typedData?.kind === 'unknown' ? <Alert kind="error">{d.hyperlaneReject[typedData.reason]}</Alert> : null}
        {/* A pasted ERC-20: the registry's candidates are probed, and what is said is about them —
            never about the token itself, which is a perfectly good ERC-20. */}
        {typedToken && hints.length === 0 ? <Alert kind="info">{fmt(d.hyperlane.hintNone, { chain: src.name })}</Alert> : null}
        {typedToken && hints.length > 0 && !candidatesSettled ? (
          <p className="px-1 text-xs text-muted">{fmt(d.hyperlane.hintChecking, { n: hints.length })}</p>
        ) : null}
        {typedToken && candidatesSettled && hints.length > 0 && passing.length === 0 ? (
          <Alert kind="warn">{fmt(d.hyperlane.hintNoneUsable, { n: hints.length, chain: src.name, reason: refusedReason ?? '' })}</Alert>
        ) : null}
        {typedToken && passing.length === 1 && router ? (
          <p className="px-1 text-xs text-muted">
            {d.hyperlane.hintOne} <AddressView value={router.router} href={src.explorerAddrUrl + router.router} short />{' '}
            <span className="opacity-70">({fmt(d.hyperlane.hintRoute, { route: passing[0]!.route })})</span>
          </p>
        ) : null}
        {typedToken && passing.length > 1 ? (
          <div className="space-y-1 px-1 text-xs text-muted">
            <p>{fmt(d.hyperlane.hintSeveral, { n: passing.length, chain: src.name })}</p>
            <ul className="space-y-1">
              {passing.map((h) => (
                <li key={h.router}>
                  <button
                    type="button"
                    onClick={() => setPickedRouter(h.router)}
                    className={`mono rounded-full px-3 py-1 text-xs transition hover:bg-surface-2 hover:text-ink ${pickedRouter === h.router ? 'bg-surface-2 text-ink' : ''}`}
                  >
                    {h.router.slice(0, 8)}…{h.router.slice(-6)} · {h.standard} · {fmt(d.hyperlane.hintRoute, { route: h.route })}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {router && typedData?.kind === 'router' ? (
          <p className="px-1 text-xs text-muted">
            {d.hyperlane.foundRouter} <AddressView value={router.router} href={src.explorerAddrUrl + router.router} short /> · {d.hyperlane[`kind_${router.warpKind}`]}
          </p>
        ) : null}
        {router && crossChecked === false ? <p className="px-1 text-xs text-warn">⚠ {d.card.flag_not_cross_checked}</p> : null}

        <FromToRow
          from={src}
          fromOptions={evmChains()
            .filter((c) => !!hyperlaneConfig(c.key))
            .map((c) => c.key)}
          onFrom={(k) => {
            setSrcKey(k)
            setTarget(null)
            setPickedRouter(null)
            setDstChain(undefined)
          }}
          to={dstChain ? byKey(dstChain) : undefined}
          toOptions={destinations}
          onTo={(k) => setDstChain(k)}
          toDisabled={destinations.length === 0}
          reverse={{ enabled: reverseEnabled, title: reverseTitle, onClick: onReverse }}
        />
        {router && destinations.length === 0 ? <p className="px-1 text-xs text-muted">{d.hyperlane.noDestinations}</p> : null}

        <AmountPanel
          value={amountInput}
          onChange={setAmountInput}
          disabled={!router}
          token={tokenMeta}
          tokenIcon={router ? <ChainDot name={sym || 'T'} size={24} /> : undefined}
          balance={balanceShown}
          onMax={() => {
            if (router) setAmountInput(formatAmount(balanceShown ?? 0n, dec))
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
        info={tokenMeta}
        sending={switching || sendWrite.isPending}
        approve={evmSrc ? { phase: approveFlow.phase, explorerTxUrl: evmSrc.explorerTxUrl } : undefined}
        onClick={onCta}
        error={txError}
      />
    </>
  )

  const st = standing.data
  const standingText = !router
    ? ''
    : router.warpKind === 'synthetic'
      ? d.hyperlane.standingSynthetic
      : !st || (st.dispatches === undefined && st.held === undefined)
        ? d.hyperlane.standingUnknown
        : router.warpKind === 'collateral'
          ? fmt(d.hyperlane.standingCollateral, {
              locked: st.lockedBps === undefined ? '?' : formatBps(BigInt(st.lockedBps)),
              floor: formatBps(BigInt(ADAPTER_MIN_LOCKED_BPS)),
              sends: st.dispatches === undefined ? '?' : String(st.dispatches),
              blocks: st.window ? st.window.blocks.toString() : '?',
              minSends: ADAPTER_MIN_OUTBOUND_NONCE.toString(),
            })
          : fmt(d.hyperlane.standingNative, {
              held: st.held === undefined ? '?' : formatAmount(st.held, 18, { maxFraction: 4 }),
              symbol: src.nativeSymbol,
              sends: st.dispatches === undefined ? '?' : String(st.dispatches),
              blocks: st.window ? st.window.blocks.toString() : '?',
              minSends: ADAPTER_MIN_OUTBOUND_NONCE.toString(),
            })

  const right = (
    <Panel title={d.ui.preview} badge={<ProtocolBadge id="hyperlane" />}>
      {verdict ? <VerdictCard result={verdict} onAction={onAnalysisAction} /> : null}
      {!router ? (
        verdict ? null : <p className="px-1 text-sm text-muted">{d.hyperlane.previewEmpty}</p>
      ) : (
        <>
          <PanelSection title={d.risk.title}>
            <RouteIndicator indicator={indicator} noneText={impossible && planData ? d.indicator.held : dstChain ? d.indicator.enterAmount : d.indicator.chooseDestination} />
          </PanelSection>
          <PanelSection title={d.ui.section_contract}>
            <Row label={d.hyperlane.kind}>{d.hyperlane[`kind_${router.warpKind}`]}</Row>
            <Row label={d.card.token} mono>
              {token ? <AddressView value={token} href={src.explorerAddrUrl + token} short /> : `${src.nativeSymbol} (${d.hyperlane.kind_native.split(' — ')[0]})`}
            </Row>
            <Row label={d.hyperlane.foundRouter.replace(':', '')} mono>
              <AddressView value={router.router} href={src.explorerAddrUrl + router.router} short />
            </Row>
            <Row label={d.hyperlane.mailbox} mono>
              {cfg ? <AddressView value={cfg.mailbox} href={src.explorerAddrUrl + cfg.mailbox} short /> : '—'}
            </Row>
            <Row label={d.hyperlane.mailboxNote}>{d.hyperlane.mailboxFromConfig}</Row>
            {remoteRoute ? (
              <Row label={d.hyperlane.remoteRouter} mono>
                <AddressView value={remoteRoute.router} href={byKey(remoteRoute.chain).explorerAddrUrl + remoteRoute.router} short />
              </Row>
            ) : null}
            {remote.data?.token && dstChain ? (
              <Row label={d.hyperlane.remoteToken} mono>
                <AddressView value={remote.data.token} href={byKey(dstChain).explorerAddrUrl + remote.data.token} short />
              </Row>
            ) : null}
            {router.version ? <Row label={d.hyperlane.version}>{router.version}</Row> : null}
            {router.feeRecipient ? (
              <Row label={d.hyperlane.feeRecipient} mono>
                <AddressView value={router.feeRecipient} href={src.explorerAddrUrl + router.feeRecipient} short />
              </Row>
            ) : null}
          </PanelSection>

          {planData ? (
            <PanelSection title={d.ui.section_quote}>
              {isPreview ? <p className="pb-1 text-xs text-muted">{fmt(d.step3.previewQuote, { amount: `${formatAmount(previewAmountRaw(dec), dec)} ${sym}` })}</p> : null}
              <Row label={d.step3.sending}>
                <b className="tnum">{formatAmount(planData.amount, planData.decimals)} {sym}</b>
              </Row>
              <Row label={d.hyperlane.routeFee}>
                {planData.routeFee === 0n ? (
                  <span className="tnum">{d.hyperlane.routeFeeNone}</span>
                ) : (
                  <>
                    <b className={`tnum ${routeFeeBps(planData) >= 300n ? 'text-danger' : routeFeeBps(planData) >= 50n ? 'text-warn' : 'text-ink'}`}>
                      {formatAmount(planData.routeFee, planData.decimals)} {sym} ({formatBps(routeFeeBps(planData))})
                    </b>
                    <div className="text-xs text-muted">{d.hyperlane.routeFeeHint}</div>
                  </>
                )}
              </Row>
              {planData.charge !== planData.amount ? (
                <Row label={d.hyperlane.charged}>
                  <b className="tnum">{formatAmount(planData.charge, planData.decimals)} {sym}</b>
                </Row>
              ) : null}
              <Row label={d.hyperlane.arrives}>
                <b className="tnum">{formatAmount(planData.received, planData.dst.decimals ?? planData.decimals)} {planData.dst.symbol ?? sym}</b>
                {router.scale.source !== 'none' ? (
                  <div className="text-xs text-muted">{fmt(d.hyperlane.scaleNote, { num: router.scale.numerator.toString(), den: router.scale.denominator.toString() })}</div>
                ) : null}
              </Row>
              <Row label={d.hyperlane.fee}>
                <b className="tnum">{formatAmount(planData.fee, 18, { maxFraction: 8 })} {src.nativeSymbol}</b>
                <div className="text-xs text-muted">{d.hyperlane.feeExact}</div>
                {native ? <div className="text-xs text-muted">{d.hyperlane.feeNative}</div> : null}
              </Row>
              {planData.destinationGas !== undefined ? (
                <Row label={d.hyperlane.destinationGas}>
                  <span className="tnum">{planData.destinationGas.toString()}</span>
                </Row>
              ) : null}
              <Row label={d.step3.recipient} mono>
                <AddressView value={planData.recipient} href={byKey(planData.dst.chain).explorerAddrUrl + planData.recipient} short />
              </Row>
              <Row label={d.hyperlane.quoteSource} mono>
                {planData.quoteSource}
              </Row>
            </PanelSection>
          ) : null}

          <PanelFold title={d.indicator.details}>
            <IndicatorReasons indicator={indicator} />
            <RiskNotAssessed why={d.risk.notCoveredHyperlane} />
            <p className="text-xs text-muted">
              <span className="font-semibold">{d.hyperlane.standing}:</span> {standingText}
            </p>
            <ul className="grid gap-x-3 gap-y-0.5 text-xs">
              {report.results.map((r) => (
                <li key={r.id} className={r.ok ? 'text-ok' : isHyperlanePending(r) ? 'text-muted' : isStepCode(r.code) ? 'text-ink' : isNoteCode(r.code) ? 'text-warn' : 'text-danger'}>
                  {r.ok ? '✓' : isHyperlanePending(r) ? '○' : isStepCode(r.code) ? '→' : isNoteCode(r.code) ? '●' : '✗'}{' '}
                  {r.ok ? ((d.hyperlaneGuard as Record<string, string>)[`ok_${r.id}`] ?? '') : hlLabel(r.code)}
                </li>
              ))}
            </ul>
            {check.data?.revert ? (
              <div className="text-xs text-warn">
                <div className="font-semibold">
                  {check.data.failedStep ? `${d.revert[`failedStep_${check.data.failedStep}`]} ` : ''}
                  {d.revert[revertMeaning(check.data.revert) ?? 'generic']}
                </div>
                <div className="mono mt-1 opacity-80">{formatRevert(check.data.revert)}</div>
                {check.data.batched ? <div className="mt-1 opacity-80">{d.revert.batched}</div> : null}
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
