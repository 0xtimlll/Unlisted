'use client'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { encodeFunctionData, type Address, type Hash } from 'viem'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { oftAbi } from '@/core/abi'
import { assessIndicator } from '@/core/indicator'
import { useApproveFlow } from './useApproveFlow'
import { useLinkSync } from './useLink'
import { AmountError, formatAmount, parseAmount } from '@/core/amounts'
import { byChainId, byEid, byKey, CHAINS, evmChains, isEvm, type ChainKey } from '@/core/chains'
import type { AnalysisInput } from '@/core/analysis/input'
import { analyzeSvmPrefill } from '@/core/analysis/svm'
import type { AnalysisAction, AnalysisTarget } from '@/core/analysis/result'
import type { ProtocolId } from '@/core/protocols'
import { DecodeTxError } from '@/core/decodeTx'
import { approvePlan, isPending, runGuards, selfCheck, type GuardInput } from '@/core/guards'
import { confirmsTail, tryRecipient, type Recipient } from '@/core/recipient'
import { familyOfVm } from '@/core/addressBook'
import { bookConfirms, bookRefuses, RecipientBookAfterSend, useBookVerdict } from './components/RecipientBook'
import { SvmDiscoverError } from '@/core/svm/errors'
import type { SourceInfo, SuspiciousFlag } from '@/core/types'
import { planSvmOptions } from '@/core/options'
import { assembleSendArgs, DEFAULT_FEE_BUFFER_BPS, DEFAULT_SLIPPAGE_BPS, PlanError } from '@/core/plan'
import { ProbeError } from '@/core/probe'
import type { DvnConfig } from '@/core/lz/dvn'
import { formatRevert, revertMeaning } from '@/core/sim/revert'
import { sanitizeText } from '@/core/text'
import { fmt, useDict, type Dict } from '@/i18n'
import { AmountPanel, FromToRow, RecipientPanel, type DestinationState } from './components/FromTo'
import { reverseOft, type Reversal } from '@/core/reverse'
import { approveBusy } from '@/core/approveFlow'
import { ProtocolBadge } from './components/History'
import { Panel, PanelFold, PanelSection, TwoColumn } from './components/Layout'
import { Checks, Cta, Details, type CtaState } from './components/Review'
import { Alert, ChainDot, Shell } from './components/ui'
import { ContractFacts, TOKEN_INPUT_ID, TokenStep } from './components/TokenStep'
import { VerdictCard } from './components/Verdict'
import { Tracker } from './components/Tracker'
import { isUserRejection, shortError, useAllowance, useCheck, useDvn, useScanDelivered, useAdapterSearch, type CheckResult, useDecode, useNativeBalance, usePeerBack, usePlan, useProbe, useSvmDestination, useSvmRecipient, useTokenBalance } from './hooks'
import { activeTransfer, pushHistory, setHistoryStatus, type HistoryEntry, type SetStored, type Stored } from './storage'
import { useSvmWallet } from './svm/context'
import { SvmWalletPicker } from './svm/SvmWalletButton'
import { useSvmCheck, useSvmContext, useSvmDecode, useSvmNativeBalance, useSvmPlan, useSvmProbe, useSvmSend, useSvmTokenBalance } from './svmHooks'
import { useAnalysis } from './useAnalysis'
import { BridgeV1 } from './BridgeV1'
import { useProbeV1 } from './v1Hooks'
import { ProbeV1Error } from '@/protocols/lz-v1/detect'
import { useV2RouteRisk } from './riskHooks'
import { RiskChecks, RiskNotAssessed } from './components/RiskPanel'
import { IndicatorReasons, RouteIndicator } from './components/RouteIndicator'
import { isNoteCode, shownFailures, waitsOnlyForApprove } from '@/core/severity'

const EMPTY_DEST: DestinationState = {
  dstEid: undefined,
  amountInput: '',
  recipientCustom: false,
  recipientInput: '',
  confirmLast6: '',
  slippageBps: DEFAULT_SLIPPAGE_BPS,
  feeBufferBps: DEFAULT_FEE_BUFFER_BPS,
  extraOptions: '0x',
}

/**
 * Guards that do not depend on simulation/gas; the check query waits for these.
 * Guard 10 (allowance) is deliberately NOT here: where the RPC supports eth_simulateV1 the send is
 * simulated on top of the pending approve, so a real problem shows up before anything is signed.
 */
const PRE_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 15, 17, 18, 19, 20])

type Sent = { txHash: string; dstEid: number; startedAt: number; srcChain: ChainKey; restored: boolean }

/** The LayerZero OFT tab. The shell around it (header, history, settings, footer) is AppShell. */
export function BridgeApp({
  stored,
  setStored,
  srcKey,
  setSrcKey,
  trackRequest,
  onTrackConsumed,
  handoff,
  onHandoffConsumed,
  onOpenTab,
}: {
  stored: Stored
  setStored: SetStored
  srcKey: ChainKey
  setSrcKey: (k: ChainKey) => void
  /** A past transfer the user asked to track from Recent transfers. */
  trackRequest: HistoryEntry | null
  onTrackConsumed: () => void
  /** A LayerZero contract another tab's analysis found, carried across when this tab opened. */
  handoff: AnalysisTarget | null
  onHandoffConsumed: () => void
  /** The analysis found another protocol: hand the tab and what was found to the shell. */
  onOpenTab: (protocol: ProtocolId, target: AnalysisTarget | undefined) => void
}) {
  const d = useDict()
  const { address: wallet, chainId: walletChainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { openConnectModal } = useConnectModal()
  const svmWallet = useSvmWallet()

  // ONE window, two wallet stacks: the source chain's VM decides which one is live (§6).
  const src = byKey(srcKey)
  const evmSrc = isEvm(src) ? src : undefined
  const svmSource = src.vm === 'svm'
  const sender: string | undefined = svmSource ? svmWallet.address : wallet
  const [svmPickerOpen, setSvmPickerOpen] = useState(false)
  const [probeTarget, setProbeTarget] = useState<string | null>(null)
  const [analysisInput, setAnalysisInput] = useState<AnalysisInput | null>(null)
  const [decodeTarget, setDecodeTarget] = useState<string | null>(null)
  const [dest, setDest] = useState<DestinationState>(EMPTY_DEST)
  /** The destination a reversed v1 route should start on, and the amount it carries over. */
  const [v1Dst, setV1Dst] = useState<ChainKey | undefined>(undefined)
  const [v1Amount, setV1Amount] = useState('')
  // A transfer that was in flight when the page was last closed is re-opened, not forgotten.
  const [sent, setSent] = useState<Sent | null>(() => {
    const a = activeTransfer(stored, 'lz-oft')
    return a ? { txHash: a.txHash, dstEid: a.dstEid, startedAt: a.at, srcChain: a.srcChain, restored: true } : null
  })
  const [txError, setTxError] = useState('')
  // Whether the recipient panel is open — a view state; the recipient itself lives in `dest`.
  const [recipientOpen, setRecipientOpen] = useState(false)
  /** The address another tab or a link handed over (declared early: `reset` clears it). */
  const [handedOver, setHandedOver] = useState<string | undefined>(undefined)

  // "Track" in Recent transfers: the shell switches to this tab and hands the entry over.
  useEffect(() => {
    if (!trackRequest) return
    setSent({ txHash: trackRequest.txHash, dstEid: trackRequest.dstEid, startedAt: trackRequest.at, srcChain: trackRequest.srcChain, restored: true })
    onTrackConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackRequest])

  // Follow the EVM wallet's chain when the user SWITCHES it to one we support and the source is
  // EVM. Only a change between two known chains counts: the wallet appearing (connect, reconnect
  // after a reload) must not move a source the user or a link chose — the button says
  // "Switch to <chain>" for that.
  const prevWalletChainId = useRef(walletChainId)
  useEffect(() => {
    const prev = prevWalletChainId.current
    prevWalletChainId.current = walletChainId
    if (walletChainId === undefined || prev === undefined || prev === walletChainId || svmSource) return
    const c = byChainId(walletChainId)
    if (c) setSrcKey(c.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletChainId])

  const reset = useCallback(() => {
    setProbeTarget(null)
    setAdapterHint(null)
    setDecodeTarget(null)
    setAnalysisInput(null)
    // Otherwise a remounted token field would show the address that was handed over, over an
    // empty form (TokenStep's prefill).
    setHandedOver(undefined)
    setDest(EMPTY_DEST)
    setV1Dst(undefined)
    setV1Amount('')
    setSent(null)
    setTxError('')
  }, [])

  const onSrcChange = (k: ChainKey) => {
    setSrcKey(k)
    reset()
  }

  // ---- step 1: analyse whatever was pasted ------------------------------------
  const analysis = useAnalysis(analysisInput, 'lz-oft', srcKey, stored.customRpc)
  const [chosen, setChosen] = useState(0)

  /** Point the form at a contract the analysis found, on its own chain. */
  const applyTarget = useCallback(
    (t: AnalysisTarget) => {
      if (t.chain !== srcKey) setSrcKey(t.chain)
      setDecodeTarget(null)
      setProbeTarget(t.address)
      setDest(t.dstChain ? { ...EMPTY_DEST, dstEid: byKey(t.dstChain).eid } : EMPTY_DEST)
    },
    [srcKey, setSrcKey],
  )

  /**
   * Arriving from the NTT or CCIP tab, which recognised a LayerZero transfer they cannot build.
   * `oft-store` is deliberately left out: a Solana source is set up by its own decode path.
   */
  useEffect(() => {
    if (!handoff) return
    if (handoff.kind === 'oft' || handoff.kind === 'lz-oapp') {
      applyTarget(handoff)
      setHandedOver(handoff.address)
    } else if (handoff.kind === 'oft-store' && handoff.via === 'link') {
      // A Solana source from a link: the store is probed on Solana, like one pasted there.
      setSrcKey('solana')
      setDecodeTarget(null)
      setProbeTarget(handoff.address)
      setHandedOver(handoff.address)
      setDest(handoff.dstChain ? { ...EMPTY_DEST, dstEid: byKey(handoff.dstChain).eid } : EMPTY_DEST)
    }
    onHandoffConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.address, handoff?.chain])


  const onInput = (i: AnalysisInput) => {
    setTxError('')
    setProbeTarget(null)
    setAdapterHint(null)
    setDecodeTarget(null)
    setAnalysisInput(null)
    setDest(EMPTY_DEST)
    setChosen(0)
    switch (i.kind) {
      case 'evm_address':
        setProbeTarget(i.address)
        return
      case 'svm_address':
        // An OFT Store only means anything with Solana as the source.
        if (srcKey !== 'solana') setSrcKey('solana')
        setProbeTarget(i.address)
        return
      case 'svm_tx':
        if (srcKey !== 'solana') setSrcKey('solana')
        setDecodeTarget(i.signature)
        return
      default:
        setAnalysisInput(i)
    }
  }

  // ---- step 1b: read the contract ---------------------------------------------
  const probe = useProbe(evmSrc, svmSource ? null : probeTarget, stored.customRpc[src.key])
  const decode = useDecode(evmSrc, svmSource ? null : (decodeTarget as Hash | null), stored.customRpc[src.key])
  const svmProbe = useSvmProbe(svmSource, probeTarget, stored.customRpc['solana'])
  const svmDecode = useSvmDecode(svmSource, decodeTarget, stored.customRpc['solana'])
  // The sample's send must have been executed by the program that owns the store we then probed;
  // otherwise the probed info is discarded as if the store had never been checked.
  const decodeProgramMismatch = !!svmDecode.data && !!svmProbe.data && svmProbe.data.info.programId !== svmDecode.data.programId
  const info: SourceInfo | undefined = svmSource ? (decodeProgramMismatch ? undefined : svmProbe.data?.info) : probe.data?.info
  const flags = useMemo(() => (svmSource ? (svmProbe.data?.flags ?? []) : (probe.data?.flags ?? [])), [svmSource, svmProbe.data, probe.data])
  /**
   * §3: LayerZero v1, asked ONLY after the V2 probe has finished declining.
   *
   * `not_oft` is the one V2 verdict that leaves a question open: the contract exists and answers,
   * it is simply not a V2 OFT. Every other outcome — a V2 OFT, no contract, providers disagreeing
   * — is already a complete answer, and v1 is never asked about it. The V2 path's order, cache key
   * and behaviour are untouched.
   */
  const v2SaysNotOft = probe.error instanceof ProbeError && probe.error.code === 'not_oft'
  const probeV1 = useProbeV1(evmSrc, v2SaysNotOft ? probeTarget : null, stored.customRpc[src.key], v2SaysNotOft && !svmSource)
  const v1Info = probeV1.data?.info
  // The address bar follows the form: bridge (the path), source, token, destination (core/link.ts).
  // The v1 form writes its own while it is shown.
  useLinkSync(probeTarget ? { from: src.key, token: probeTarget, to: dest.dstEid !== undefined ? byEid(dest.dstEid)?.key : undefined } : undefined, !v1Info)
  const v1Flags = probeV1.data?.flags ?? []

  /**
   * Paste the token, get the adapter (core/adapterSearch.ts). Asked only once V2 and v1 have both
   * declined the address: the same address on every other EVM chain is asked which contract on
   * this chain it names as its peer, and each answer is probed here like a pasted address. One
   * adapter found is applied at once; several are offered; none is said with what was asked.
   */
  const bothDeclined = v2SaysNotOft && !!probeV1.error && !svmSource
  const adapterSearch = useAdapterSearch(evmSrc, bothDeclined ? (probeTarget as Address) : null, stored.customRpc, bothDeclined)
  const [adapterHint, setAdapterHint] = useState<{ token: string; adapter: string; foundOn: ChainKey[] } | null>(null)
  useEffect(() => {
    const r = adapterSearch.data
    if (!r || !bothDeclined || !probeTarget || r.found.length !== 1) return
    const f = r.found[0]!
    setAdapterHint({ token: probeTarget, adapter: f.adapter, foundOn: f.foundOn })
    // The destination chosen before the search (a link, or by hand) stays chosen.
    applyTarget({ chain: src.key, address: f.adapter, kind: 'oft', ...(dest.dstEid !== undefined && byEid(dest.dstEid) ? { dstChain: byEid(dest.dstEid)!.key } : {}) })
    setHandedOver(f.adapter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterSearch.data])
  const adapterApplied = !!adapterHint && probeTarget?.toLowerCase() === adapterHint.adapter.toLowerCase()
  const otherChains = evmChains().length - 1
  const adapterNote: string = adapterSearch.isFetching
    ? fmt(d.step1.adapterSearching, { chain: src.name, n: otherChains })
    : adapterApplied
      ? fmt(d.step1.adapterFound, { foundOn: adapterHint!.foundOn.map((c) => byKey(c).name).join(', '), chain: src.name })
      : bothDeclined && adapterSearch.data && adapterSearch.data.found.length > 1
        ? fmt(d.step1.adapterSeveral, { chain: src.name })
        : bothDeclined && adapterSearch.data && adapterSearch.data.found.length === 0
          ? fmt(d.step1.adapterNone, { chain: src.name, n: otherChains }) +
            (adapterSearch.data.failed.length ? fmt(d.step1.adapterNoneFailed, { failed: adapterSearch.data.failed.length }) : '') +
            (adapterSearch.data.rejected.length ? fmt(d.step1.adapterRejected, { rejected: adapterSearch.data.rejected.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(', ') }) : '')
          : ''
  const adapterChoices =
    bothDeclined && adapterSearch.data && adapterSearch.data.found.length > 1
      ? adapterSearch.data.found.map((f) => ({ address: f.adapter, note: f.foundOn.map((c) => byKey(c).name).join(', ') }))
      : []

  const probeError = svmSource
    ? svmProbe.error
    : // While v1 or the adapter search is still being asked, or once either has answered with a
      // contract, "not an OFT" is not the verdict to show.
      v2SaysNotOft && (probeV1.isFetching || v1Info || adapterSearch.isFetching || adapterSearch.data?.found.length)
      ? null
      : v2SaysNotOft && probeV1.error
        ? probeV1.error
        : probe.error
  const decodeData = svmSource ? svmDecode.data : decode.data
  const decodeError = svmSource ? svmDecode.error : decode.error

  /**
   * §Task 1.6: a Solana signature goes through the same analysis as everything else. The decoding
   * is NOT repeated — core/svm/decode.ts already produced the prefill above, and this only turns it
   * into the one result shape the panel renders.
   */
  const results = useMemo(() => {
    const fromEvm = analysis.data?.results ?? []
    if (fromEvm.length > 0) return fromEvm
    if (!svmDecode.data) return []
    return [
      analyzeSvmPrefill(svmDecode.data, {
        signature: svmDecode.data.observed.from ? (decodeTarget ?? '') : '',
        selected: srcKey,
        programMismatch: decodeProgramMismatch,
      }),
    ]
  }, [analysis.data, svmDecode.data, decodeProgramMismatch, decodeTarget, srcKey])
  const primary = results[chosen] ?? results[0]

  useEffect(() => {
    if (!decodeData) return
    setProbeTarget('oftStore' in decodeData ? decodeData.oftStore : decodeData.oft)
    setDest((s) => ({ ...s, dstEid: decodeData.dstEid, extraOptions: decodeData.extraOptions }))
  }, [decodeData])

  const onAnalysisAction = (a: AnalysisAction) => {
    switch (a.kind) {
      case 'switch_chain':
        if (primary?.target) applyTarget(primary.target)
        else setSrcKey(a.chain)
        return
      case 'use_address':
        applyTarget(primary?.target ?? { chain: a.chain, address: a.address, kind: 'oft' })
        return
      case 'open_tab':
        onOpenTab(a.protocol, primary?.target)
        return
      default:
        return
    }
  }

  /**
   * can_bridge on the chain already selected: fill the form in without another click.
   *
   * A Solana result is excluded: its prefill (store, destination, options) is applied by the
   * decode effect above, and re-applying it here would clear `decodeTarget` — which is what the
   * verdict itself is derived from, so the card would appear and immediately vanish.
   */
  const autoTarget =
    primary?.verdict === 'can_bridge' && primary.target?.chain === srcKey && primary.target.kind !== 'oft-store' ? primary.target : undefined
  useEffect(() => {
    if (autoTarget) applyTarget(autoTarget)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTarget?.address, autoTarget?.chain, autoTarget?.dstChain])

  // ---- step 2: destination / amount / recipient -------------------------------
  const dstChain = dest.dstEid !== undefined ? byEid(dest.dstEid) : undefined
  const dstVm = dstChain?.vm
  // §4.3: across VMs there is NO default recipient — the wallet address is never offered, and
  // only the constructor for the destination's VM can produce a recipient (core/recipient.ts).
  const crossVm = dstVm !== undefined && dstVm !== src.vm
  const recipientResult =
    dstVm === undefined
      ? undefined
      : crossVm
        ? dest.recipientInput.trim() !== ''
          ? tryRecipient(dstVm, dest.recipientInput)
          : undefined
        : dest.recipientCustom
          ? dest.recipientInput.trim() !== ''
            ? tryRecipient('evm', dest.recipientInput)
            : undefined
          : wallet
            ? tryRecipient('evm', wallet)
            : undefined
  const recipient: Recipient | undefined = recipientResult?.ok ? recipientResult.recipient : undefined
  const recipientError = recipientResult && !recipientResult.ok ? d.errors[`recipient_${recipientResult.code}`] : ''
  const recipientIsCustom = crossVm || dest.recipientCustom
  // §Address book. Only a recipient that came from OUTSIDE is judged: the connected wallet's own
  // address did not arrive through a clipboard, so it cannot be the swap this check is looking for.
  const bookFamily = dstVm ? familyOfVm(dstVm) : undefined
  const bookVerdict = useBookVerdict(bookFamily, recipientIsCustom ? recipient?.display : undefined)
  // A saved address was already checked by hand against its source; it does not need the tail again.
  const recipientConfirmed =
    recipientIsCustom && recipient !== undefined && (bookConfirms(bookVerdict) || confirmsTail(recipient, dest.confirmLast6))

  let amountError = ''
  if (info && dest.amountInput.trim() !== '') {
    try {
      parseAmount(dest.amountInput, info.decimals)
    } catch (e) {
      amountError = e instanceof AmountError ? d.errors[`amount_${e.code}`] : d.errors.generic
    }
  }

  const route = info && dest.dstEid !== undefined ? info.routes.find((r) => r.eid === dest.dstEid) : undefined
  // Guard 17: our side of the back-link is the EVM contract, or the Solana OFT Store as bytes32.
  const ours = info ? (info.vm === 'evm' ? info.oft : info.oftStoreBytes32) : undefined
  const evmPeerBack = usePeerBack(src.eid, ours, dstVm === 'evm' ? dest.dstEid : undefined, route?.peer, stored.customRpc)
  const svmDest = useSvmDestination(dstVm === 'svm', route?.peer, src.eid, info?.vm === 'evm' ? info.oft : undefined, stored.customRpc['solana'])
  // When the input was a transaction, LayerZero Scan can say whether this very path has already
  // delivered. It only changes the wording of a warning.
  const scanDelivered =
    useScanDelivered(analysisInput?.kind === 'evm_tx' ? analysisInput.hash : undefined).data === true

  // Recognised: everything below can be checked. Unrecognised: the store exists but is not one of
  // LayerZero's two official layouts, so the mint is unknown and the UI warns instead of blocking.
  const svmDestInfo = svmDest.data?.recognised ? svmDest.data.info : undefined
  const svmDestUnknown = svmDest.data && !svmDest.data.recognised ? svmDest.data.store : undefined
  const svmRecipient = useSvmRecipient(svmDestInfo, dstVm === 'svm' && recipient?.vm === 'svm' ? recipient.display : undefined, stored.customRpc['solana'])
  const peerBack = dstVm === 'svm' ? svmDest.data?.peerBack : evmPeerBack.data
  const svmFlags = useMemo<SuspiciousFlag[]>(() => {
    if (dstVm !== 'svm') return []
    const f: SuspiciousFlag[] = []
    if (svmDestInfo?.paused) f.push('svm_paused')
    if ((svmDestInfo?.defaultFeeBps ?? 0) > 0) f.push('svm_fee')
    // Not an error: the EVM side's own quote and simulation still have to pass.
    if (svmDestUnknown) f.push(scanDelivered ? 'svm_store_unrecognised_delivered' : 'svm_store_unrecognised')
    if (svmRecipient.data?.class === 'missing') f.push('svm_recipient_not_activated')
    if (!stored.customRpc['solana']) f.push('svm_single_provider')
    // One operator's word about the Solana side (ui/hooks.ts useSvmDestination), said like the EVM probe says it.
    else if (svmDest.data && !svmDest.data.crossChecked) f.push('not_cross_checked')
    return f
  }, [dstVm, svmDestInfo, svmDestUnknown, scanDelivered, svmRecipient.data, stored.customRpc, svmDest.data])

  // §5.1 Solana destination: extraOptions are derived from the contract's enforced options and
  // the recipient's token-account state, never typed by hand (a sample tx only contributes a hint).
  const svmOptions = useMemo(() => {
    if (dstVm !== 'svm' || !info || dest.dstEid === undefined) return undefined
    // With an unrecognised store there is no mint, so whether the recipient already has a token
    // account cannot be read. Assume it does not: that funds the account rather than risking an
    // undeliverable message, and the enforced options usually cover it anyway.
    const ataExists = svmRecipient.data ? svmRecipient.data.ataExists : svmDestUnknown ? false : undefined
    if (ataExists === undefined) return undefined
    return planSvmOptions({ enforced: info.enforced[dest.dstEid] ?? '0x', ataExists, sample: dest.extraOptions })
  }, [dstVm, info, dest.dstEid, dest.extraOptions, svmRecipient.data, svmDestUnknown])

  const planAmount = amountError || (dstVm === 'svm' && !svmOptions) ? '' : dest.amountInput
  const planOptions = dstVm === 'svm' ? (svmOptions?.extraOptions ?? '0x') : dest.extraOptions
  const evmPlan = usePlan({
    info: info?.vm === 'evm' ? info : undefined,
    src: evmSrc,
    dstEid: dest.dstEid,
    // For Solana, wait until the options are known: the quoted SendParam must be the one we send.
    amountInput: planAmount,
    sender: wallet,
    recipient,
    slippageBps: dest.slippageBps,
    feeBufferBps: dest.feeBufferBps,
    extraOptions: planOptions,
  })
  const svmCtx = useSvmContext(svmSource, stored.customRpc['solana'])
  const svmPlan = useSvmPlan({
    ctx: svmCtx.data,
    info: info?.vm === 'svm' ? info : undefined,
    dstEid: dest.dstEid,
    amountInput: planAmount,
    sender: svmWallet.address,
    recipient,
    slippageBps: dest.slippageBps,
    feeBufferBps: dest.feeBufferBps,
    extraOptions: planOptions,
  })
  const planData = svmSource ? svmPlan.data : evmPlan.data
  const planError = svmSource ? (svmPlan.error ?? svmCtx.error) : evmPlan.error

  const evmTokenBalance = useTokenBalance(evmSrc, info?.vm === 'evm' ? info.token : undefined, wallet)
  const svmTokenBalance = useSvmTokenBalance(info?.vm === 'svm' ? info : undefined, svmWallet.address, stored.customRpc['solana'])
  const allowance = useAllowance(evmSrc, info?.vm === 'evm' && info.approvalRequired ? info.token : undefined, wallet, info?.vm === 'evm' ? info.oft : undefined)
  const dvn = useDvn(evmSrc, info?.vm === 'evm' ? info.endpoint : undefined, info?.vm === 'evm' ? info.oft : undefined, dest.dstEid)
  const evmNativeBalance = useNativeBalance(evmSrc, wallet)
  const svmNativeBalance = useSvmNativeBalance(svmSource ? svmWallet.address : undefined, stored.customRpc['solana'])
  const tokenBalance = svmSource ? svmTokenBalance.data : evmTokenBalance.data
  const nativeBalance = svmSource ? svmNativeBalance.data : evmNativeBalance.data?.value

  // ---- guards -------------------------------------------------------------------
  const approveIntent = info && planData ? approvePlan(info, planData, allowance.data) : null

  const baseInput: GuardInput = useMemo(
    () => ({
      walletAddress: svmSource ? undefined : wallet,
      walletChainId: svmSource ? undefined : walletChainId,
      srcChainId: evmSrc?.chainId ?? 0,
      svmWalletAddress: svmSource ? svmWallet.address : undefined,
      info,
      plan: planData,
      recipientIsCustom,
      customRecipientConfirmed: recipientConfirmed,
      recipientLookalike: bookRefuses(bookVerdict),
      tokenBalance,
      nativeBalance,
      allowance: allowance.data,
      gasCostWei: undefined,
      simulation: undefined,
      selfCheck: undefined,
      flags: [...flags, ...svmFlags],
      peerBack,
      svmRecipientClass: svmRecipient.data?.class,
      svmDestinationKnown: dstVm !== 'svm' || !!svmDest.data,
      svmDestinationRecognised: dstVm !== 'svm' || !svmDestUnknown,
    }),
    [svmSource, wallet, walletChainId, evmSrc?.chainId, svmWallet.address, info, planData, recipientIsCustom, recipientConfirmed, tokenBalance, nativeBalance, allowance.data, flags, svmFlags, peerBack, svmRecipient.data?.class, dstVm, svmDest.data, svmDestUnknown, bookVerdict],
  )
  const pre = runGuards(baseInput)
  // Only a BLOCK holds the simulation back. A note (a red recipient, a peer that does not point
  // back) is the indicator's business, and a simulation that never runs would leave Send grey
  // with nothing to say while Approve stayed open.
  const preOk = pre.results.filter((r) => PRE_IDS.has(r.id)).every((r) => r.ok || isNoteCode(r.code))
  const pendingApprove =
    approveIntent && info?.vm === 'evm' ? { token: info.token, spender: approveIntent.spender, amount: approveIntent.amount } : undefined
  const evmCheck = useCheck(evmSrc, evmPlan.data, preOk && !svmSource, pendingApprove, info?.vm === 'evm' ? info.token : undefined)
  const svmCheck = useSvmCheck(svmCtx.data, svmPlan.data, preOk && svmSource)
  const check = svmSource ? svmCheck : evmCheck
  // A send that only fails on the allowance, on a node that cannot batch, is not a failed send:
  // it has not been checked yet. Saying "simulation failed" there would be a lie.
  const evmData = svmSource ? undefined : evmCheck.data
  const blockedOnApprove = !!pendingApprove && !!evmData && !evmData.batched && revertMeaning(evmData.revert) === 'needs_approve'
  const simulation = blockedOnApprove ? undefined : check.data?.simulation
  // §4 The route's own verdict. EVM destinations only: a Solana route has no runner, the hook stays
  // disabled, and guard 22 leaves such a route to guards 1–21 (see riskCovers in core/guards.ts).
  // §4 The verdict rests on reads; if only one operator answered them, it rests on nothing.
  // `not_cross_checked` is exactly that fact, already computed by the probe (ui/hooks.ts).
  const linkCrossChecked = !flags.includes('not_cross_checked')
  const risk = useV2RouteRisk(info?.vm === 'evm' ? info : undefined, evmPlan.data, evmSrc, stored.customRpc, linkCrossChecked)
  /**
   * §4 The indicator has runners for LayerZero EVM-to-EVM routes only. Where it has none the panel
   * says so in grey rather than showing nothing — an absent verdict must not read as a passed one.
   */
  const riskCovered = info?.vm === 'evm' && dstVm === 'evm'
  const riskError = risk.error ? shortError(risk.error) : undefined
  // `fullInput` is what the click re-runs, so it carries everything the render judged.
  const fullInput: GuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation,
    svmDebit: svmSource ? svmCheck.data?.debit : undefined,
    selfCheck: check.data?.selfCheck,
    risk: risk.data?.risk,
    riskError,
  }
  const report = runGuards(fullInput)
  // The line under the button names the impossibility, if there is one: the first block that is
  // neither a read in flight nor the approve step. Notes never appear here — they are the indicator's.
  const impossible = shownFailures(report.blocks, { dropPending: true, dropSteps: true })[0]

  // The route indicator: one colour from everything above. It decides nothing (core/indicator.ts).
  const indicator = assessIndicator({
    hasDestination: dest.dstEid !== undefined,
    hasPlan: !!planData,
    results: report.results,
    held: impossible !== undefined,
    label: (c) => d.guard[c as keyof typeof d.guard] ?? c,
    flags: report.warnings,
    flagLabel: (f) => d.card[`flag_${f}` as keyof typeof d.card] ?? f,
    risk: risk.data?.risk,
    riskCovered,
    riskPending: risk.isFetching,
    riskError,
    dvnWeak: dvn.data?.weak ?? false,
    dvnWeakText: d.indicator.dvnWeak,
  })

  // ---- approve (EVM only: Solana OFTs pull tokens through the program directly) ---
  // The flow signs approve(spender, amount) for exactly the intent the guards checked, waits for
  // the receipt and reads the allowance back; the button becomes Send by itself (ui/useApproveFlow.ts).
  const approveFlow = useApproveFlow({
    chainId: evmSrc?.chainId,
    owner: wallet,
    token: info?.vm === 'evm' ? info.token : undefined,
    spender: approveIntent?.spender,
    amount: approveIntent?.amount,
    allowance: allowance.data,
    refetchAllowance: async () => (await allowance.refetch()).data,
  })

  const onApprove = () => {
    setTxError('')
    // Re-derive at click time; never trust stale render state (§6.10–12).
    if (!info || info.vm !== 'evm' || !evmSrc || !evmPlan.data || !info.approvalRequired) return
    const intent = approvePlan(info, evmPlan.data, allowance.data)
    if (!intent || intent.spender.toLowerCase() !== info.oft.toLowerCase() || intent.amount !== evmPlan.data.amounts.amountLD) return
    // No allowance for a transfer that cannot happen: the approve is a step of THIS transfer.
    if (!waitsOnlyForApprove(runGuards(fullInput).blocks)) return
    void approveFlow.start()
  }

  // ---- send ---------------------------------------------------------------------
  const sendWrite = useWriteContract()
  const svmSend = useSvmSend()
  const recordSent = (txHash: string, dstEid: number, oft: string) => {
    setSent({ txHash, dstEid, startedAt: Date.now(), srcChain: src.key, restored: false })
    // An updater: the wallet may take minutes to sign, and whatever changed meanwhile must survive.
    setStored((prev) => pushHistory(prev, { srcChain: src.key, protocol: 'lz-oft', dstEid, oft, txHash, at: Date.now() }))
  }
  // One wallet prompt per click. A ref rather than the mutation's isPending: that flips on the
  // next render, and a double click lands before it.
  const sendInFlight = useRef(false)
  const onSend = () => {
    setTxError('')
    const p = planData
    if (!p || !info) return
    if (sendInFlight.current) return
    const fresh = runGuards(fullInput)
    if (!fresh.canSend) return
    if (p.vm === 'svm') {
      // The transaction is rebuilt from the plan and decoded back right before signing (core/svm/send.ts).
      if (!svmCtx.data || !svmWallet.signer || svmWallet.address !== p.sender) return
      sendInFlight.current = true
      svmSend.mutate(
        { ctx: svmCtx.data, plan: p, signer: svmWallet.signer },
        {
          onSuccess: (sig) => recordSent(sig, p.dstEid, p.oftStore),
          onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : `${d.errors.svm_send_failed} ${shortError(e)}`),
          onSettled: () => {
            sendInFlight.current = false
          },
        },
      )
      return
    }
    if (!evmSrc) return
    const args = assembleSendArgs(p)
    // §6.14 self-check on the exact args that go to the wallet.
    const calldata = encodeFunctionData({ abi: oftAbi, functionName: 'send', args: [args[0], args[1], args[2]] })
    const sc = selfCheck(p, calldata)
    if (!sc.ok || args[1].nativeFee !== p.value) {
      setTxError(d.guard.selfcheck_failed)
      return
    }
    sendInFlight.current = true
    sendWrite.writeContract(
      {
        address: p.oft,
        abi: oftAbi,
        functionName: 'send',
        args: [args[0], args[1], args[2]],
        value: p.value,
        chainId: evmSrc.chainId,
      },
      {
        onSuccess: (hash) => recordSent(hash, p.dstEid, p.oft),
        onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)),
        onSettled: () => {
          sendInFlight.current = false
        },
      },
    )
  }

  // ---- CTA state: the next thing the user has to do ------------------------------
  const chainMismatch = !svmSource && wallet !== undefined && walletChainId !== undefined && evmSrc !== undefined && walletChainId !== evmSrc.chainId
  const cta: CtaState = !sender
    ? { kind: 'connect' }
    : chainMismatch
      ? { kind: 'switch', chain: src }
      : !info
        ? { kind: 'check' }
        : dest.dstEid === undefined
          ? { kind: 'destination' }
          : dest.amountInput.trim() === '' || amountError
            ? { kind: 'amount' }
            : !recipient
              ? { kind: 'recipient' }
              : !planData
                ? planError
                  ? { kind: 'send', enabled: false, reason: describeError(d, planError) }
                  : { kind: 'quote' }
                : approveIntent
                  ? // The approve is the next step whenever the allowance is short. It is enabled only
                    // when nothing else makes the transfer impossible: no allowance for a transfer
                    // that cannot happen.
                    { kind: 'approve', intent: approveIntent, enabled: waitsOnlyForApprove(report.blocks), ...(impossible ? { reason: d.guard[impossible.code] } : {}) }
                  : !report.canSend && report.results.every((r) => r.ok || isPending(r))
                    ? { kind: 'checking' }
                    : { kind: 'send', enabled: report.canSend, ...(impossible ? { reason: d.guard[impossible.code] } : {}) }

  const sending = switching || sendWrite.isPending || svmSend.isPending

  // ---- reverse: A → B becomes B → A in one click --------------------------------
  // The other side's contract comes from this one's peer and is probed again from scratch, so it is
  // held to every check a pasted address is (core/reverse.ts). The amount and the settings stay;
  // the recipient goes back to the connected wallet, because the old one belonged to the other chain.
  const reverseBusy = sending || approveBusy(approveFlow.phase)
  const reversalV2 = info ? reverseOft(src.key, info, dest.dstEid) : undefined
  const applyReversal = (r: Reversal, keep: { amountInput: string }) => {
    setSrcKey(r.chain)
    setDecodeTarget(null)
    setAnalysisInput(null)
    setChosen(0)
    setProbeTarget(r.contract)
    setHandedOver(r.contract)
    setV1Dst(r.dstChain)
    setDest({ ...EMPTY_DEST, dstEid: r.dstEid, amountInput: keep.amountInput, slippageBps: dest.slippageBps, feeBufferBps: dest.feeBufferBps })
    setSent(null)
    setTxError('')
    // One click, not two: ask the wallet to follow. Declining leaves "Switch to …" on the button.
    const next = byKey(r.chain)
    if (isEvm(next) && wallet && walletChainId !== next.chainId) switchChain({ chainId: next.chainId })
  }
  const onReverse = () => {
    if (reverseBusy || !reversalV2?.ok) return
    applyReversal(reversalV2, { amountInput: dest.amountInput })
  }
  const reverseEnabled = !reverseBusy && !!reversalV2?.ok
  const reverseTitle = reverseBusy
    ? d.reverse.busy
    : reversalV2?.ok
      ? fmt(d.reverse.go, { from: byKey(reversalV2.chain).name, to: src.name })
      : d.reverse[reversalV2?.reason ?? 'no_destination']
  const onCta = () => {
    switch (cta.kind) {
      case 'connect':
        if (svmSource) setSvmPickerOpen(true)
        else openConnectModal?.()
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

  // ---- render -------------------------------------------------------------------
  const routeKeys = info ? info.routes.map((r) => byEid(r.eid)?.key).filter((k): k is ChainKey => k !== undefined) : []
  const tokenMeta = info ? { symbol: info.symbol, decimals: info.decimals } : undefined
  const recipientShown = !!info && (crossVm || dest.recipientCustom || recipientOpen)
  // Closing the panel means "my wallet": a recipient typed into a hidden panel would be a surprise.
  const toggleRecipient = () => {
    if (recipientShown && !crossVm) {
      setRecipientOpen(false)
      if (dest.recipientCustom) setDest({ ...dest, recipientCustom: false, recipientInput: '', confirmLast6: '' })
    } else {
      setRecipientOpen(true)
    }
  }
  const amountNote = amountError ? (
    <span className="text-danger">{amountError}</span>
  ) : planData && info && planData.amounts.dustTrimmed > 0n ? (
    <span className="text-warn">
      {d.step2.dustTrimmed} <span className="mono">{formatAmount(planData.amounts.dustTrimmed, info.decimals)}</span> {info.symbol}
    </span>
  ) : planData && info ? (
    <span className="tnum">{fmt(d.ui.receiveAtLeast, { amount: formatAmount(planData.amounts.minAmountLD, info.decimals, { maxFraction: 6 }), symbol: info.symbol })}</span>
  ) : undefined

  const left = sent ? (
    <Shell>
      <Tracker
        src={byKey(sent.srcChain)}
        dstEid={sent.dstEid}
        txHash={sent.txHash}
        startedAt={sent.startedAt}
        restored={sent.restored}
        customRpc={stored.customRpc['solana']}
        onFinal={(phase) => {
          setStored((prev) => setHistoryStatus(prev, sent.txHash, phase))
        }}
        onNew={reset}
      />
      <RecipientBookAfterSend family={bookFamily} address={recipientIsCustom ? recipient?.display : undefined} />
    </Shell>
  ) : (
    <>
      <Shell>
        <TokenStep
          chain={src}
          onInput={onInput}
          prefill={handedOver}
          busy={analysis.isFetching || probe.isFetching || decode.isFetching || svmProbe.isFetching || svmDecode.isFetching || adapterSearch.isFetching}
          info={info}
          flags={flags}
          error={decodeProgramMismatch ? d.errors.decode_program_mismatch : probeError ? describeError(d, probeError) : decodeError ? describeError(d, decodeError) : ''}
          decodedHint={!!decodeData}
          hint={adapterNote}
          hintBusy={adapterSearch.isFetching}
          choices={adapterChoices}
          onChoose={(address) => {
            const f = adapterSearch.data?.found.find((x) => x.adapter.toLowerCase() === address.toLowerCase())
            if (!f || !probeTarget) return
            setAdapterHint({ token: probeTarget, adapter: f.adapter, foundOn: f.foundOn })
            applyTarget({ chain: src.key, address: f.adapter, kind: 'oft', ...(dest.dstEid !== undefined && byEid(dest.dstEid) ? { dstChain: byEid(dest.dstEid)!.key } : {}) })
            setHandedOver(f.adapter)
          }}
          decodedFailed={svmDecode.data?.observed.failed ?? false}
          droppedOptions={decodeData?.droppedOptions ?? []}
          optionsMalformed={decodeData?.optionsMalformed ?? false}
        />

        <FromToRow
          from={src}
          fromOptions={CHAINS.map((c) => c.key)}
          onFrom={onSrcChange}
          to={dstChain}
          toOptions={routeKeys}
          onTo={(k) => {
            const next = byKey(k)
            const patch = { ...dest, dstEid: next.eid }
            // Switching between an EVM and a Solana destination clears the recipient:
            // an address for one VM must never linger into the other.
            setDest(next.vm !== dstVm ? { ...patch, recipientCustom: false, recipientInput: '', confirmLast6: '' } : patch)
          }}
          toDisabled={!info}
          reverse={{ enabled: reverseEnabled, title: reverseTitle, onClick: onReverse }}
        />
        {svmDest.error ? <p className="px-1 text-xs text-danger">{describeError(d, svmDest.error)}</p> : null}

        <AmountPanel
          value={dest.amountInput}
          onChange={(v) => setDest({ ...dest, amountInput: v })}
          disabled={!info}
          token={tokenMeta}
          tokenIcon={info ? <ChainDot name={info.symbol || info.name || 'T'} size={24} /> : undefined}
          onPickToken={() => document.getElementById(TOKEN_INPUT_ID)?.focus()}
          balance={tokenBalance}
          onMax={() => {
            if (info && tokenBalance !== undefined) setDest({ ...dest, amountInput: formatAmount(tokenBalance, info.decimals) })
          }}
          note={amountNote}
          recipientOpen={recipientShown}
          onToggleRecipient={toggleRecipient}
          recipientForced={crossVm}
        />

        {recipientShown ? (
          <RecipientPanel
            crossVm={crossVm}
            custom={dest.recipientCustom}
            onCustom={(custom) => setDest({ ...dest, recipientCustom: custom, recipientInput: '', confirmLast6: '' })}
            wallet={sender}
            value={dest.recipientInput}
            onChange={(v) => setDest({ ...dest, recipientInput: v, confirmLast6: '' })}
            placeholder={dstVm === 'svm' ? d.step3.svmRecipientPlaceholder : '0x…'}
            error={recipientError}
            hints={[...(dstVm === 'svm' ? [d.step3.svmRecipientHint] : []), ...(crossVm && dstVm === 'evm' ? [d.step3.evmRecipientHint] : [])]}
            bookFamily={bookFamily}
            bookVerdict={bookVerdict}
            onPickAddress={(address) => setDest({ ...dest, recipientCustom: true, recipientInput: address, confirmLast6: '' })}
            bookConfirmed={bookConfirms(bookVerdict)}
            confirm={dest.confirmLast6}
            confirmed={recipientConfirmed}
            onConfirm={(v) => setDest({ ...dest, confirmLast6: v })}
          />
        ) : null}

      </Shell>
      <Cta
        state={cta}
        info={info}
        sending={sending}
        approve={evmSrc ? { phase: approveFlow.phase, explorerTxUrl: evmSrc.explorerTxUrl } : undefined}
        onClick={onCta}
        error={txError || (svmSource && !svmWallet.address ? svmWallet.error : '')}
      />
    </>
  )

  const unreachable = analysis.data?.failed ?? []
  const analysisError = analysis.error ? describeError(d, analysis.error) : ''

  // The panel is the live preview: the route's colour first, then what was read, what it costs,
  // and every check behind a fold.
  const right = (
    <Panel title={d.ui.preview} badge={<ProtocolBadge id="lz-oft" />}>
      {sent ? (
        <p className="px-1 text-sm text-muted">{d.ui.previewTracking}</p>
      ) : (
        <>
          {results.length > 1 ? (
            <div className="px-1">
              <div className="mb-1 text-xs font-semibold text-muted">{fmt(d.analysis.severalTitle, { n: results.length })}</div>
              <p className="mb-2 text-xs text-muted">{d.analysis.severalHint}</p>
              <div className="flex flex-wrap gap-1">
                {results.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setChosen(i)}
                    className={`h-8 rounded-full px-3 text-xs font-semibold transition ${i === chosen ? 'bg-accent text-page' : 'bg-surface-2 text-ink hover:scale-105'}`}
                  >
                    {i + 1}. {r.protocol ? r.protocol : d.analysis.title_unknown}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {primary ? <VerdictCard result={primary} onAction={onAnalysisAction} /> : null}

          {unreachable.length > 0 ? <Alert kind="warn">{fmt(d.analysis.unreachable, { chains: unreachable.map((f) => byKey(f.chain).name).join(', ') })}</Alert> : null}

          {analysisError ? <Alert kind="error">{analysisError}</Alert> : null}

          {info ? (
            <>
              <PanelSection title={d.risk.title}>
                <RouteIndicator indicator={indicator} noneText={impossible && planData ? d.indicator.held : dest.dstEid === undefined ? d.indicator.chooseDestination : d.indicator.enterAmount} />
              </PanelSection>
              <PanelSection title={d.ui.section_contract}>
                <ContractFacts chain={src} info={info} />
              </PanelSection>
              <PanelSection title={d.ui.section_quote}>
                <Details src={src} info={info} plan={planData} state={dest} onChange={setDest} svmOptions={svmOptions} svmInfo={svmDestInfo} flat />
              </PanelSection>
              <PanelFold title={d.indicator.details}>
                <IndicatorReasons indicator={indicator} />
                {riskCovered ? <RiskChecks risk={risk.data?.risk} loading={risk.isFetching} error={riskError ?? ''} /> : <RiskNotAssessed />}
                <Checks report={report} show={!!planData} />
                <SimulationNote check={evmData} />
                <DvnNote config={dvn.data} />
              </PanelFold>
            </>
          ) : primary ? null : (
            <p className="px-1 text-sm text-muted">{d.ui.previewEmpty}</p>
          )}
        </>
      )}
    </Panel>
  )

  // A v1 contract gets its own form. Rendered instead of the V2 one rather than woven into it, so
  // the screen people already use does not change shape because v1 exists.
  if (v1Info && evmSrc && !sent) {
    return (
      <BridgeV1
        key={`${evmSrc.key}:${v1Info.oft}`}
        src={evmSrc}
        info={v1Info}
        flags={v1Flags}
        stored={stored}
        setStored={setStored}
        onReset={reset}
        initialDstKey={v1Dst}
        initialAmount={v1Amount}
        onReverse={(r, amountInput) => {
          setV1Amount(amountInput)
          applyReversal(r, { amountInput })
        }}
      />
    )
  }

  return (
    <>
      <TwoColumn left={left} right={right} />
      {svmPickerOpen ? (
        <SvmWalletPicker
          onClose={() => setSvmPickerOpen(false)}
          onPick={(name) => {
            setSvmPickerOpen(false)
            void svmWallet.connect(name)
          }}
        />
      ) : null}
    </>
  )
}

/** §Task 4, informational: how many parties attest to messages on this route. A line in the details. */
function DvnNote({ config }: { config: DvnConfig | undefined }) {
  const d = useDict()
  if (!config) return null
  const optional = config.optionalThreshold > 0 ? fmt(d.analysis.dvnOptional, { n: config.optionalThreshold, total: config.optionalDVNs.length }) : ''
  return <div className="text-xs text-muted">{fmt(d.analysis.dvn, { required: config.requiredDVNs.length, optional, confirmations: config.confirmations.toString() })}</div>
}

/** §Task 4: the human sentence behind a failed simulation, with the raw line underneath. */
function SimulationNote({ check }: { check: CheckResult | undefined }) {
  const d = useDict()
  if (!check) return null
  if (check.rpcUnavailable) return <p className="text-xs text-warn">{d.revert.rpcUnavailable}</p>
  const r = check.revert
  if (!r) return check.batched ? <p className="text-xs text-muted">{d.revert.batched}</p> : null
  const meaning = revertMeaning(r) ?? 'generic'
  return (
    <div className="text-xs text-warn">
      <div className="font-semibold">{d.revert[meaning]}</div>
      <div className="mono mt-1 opacity-80">{formatRevert(r)}</div>
      {r.kind === 'error' && r.source === 'contract' ? <div className="mt-1 opacity-80">{d.revert.fromContractAbi}</div> : null}
      {r.kind === 'unknown' ? (
        <a href={r.lookupUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block underline">
          {d.analysis.lookupSelector}
        </a>
      ) : null}
    </div>
  )
}

function describeError(d: Dict, e: unknown): string {
  if (e instanceof ProbeV1Error) return d.v1Reject[e.code]
  if (e instanceof ProbeError) return d.errors[`probe_${e.code}`]
  if (e instanceof SvmDiscoverError) return d.errors[`svm_${e.code}`]
  if (e instanceof DecodeTxError) return d.errors[`decode_${e.code}`]
  if (e instanceof PlanError) return `${d.errors[`plan_${e.code}`]}${e.code === 'quote_failed' ? ` (${sanitizeText(e.message, 160)})` : ''}`
  if (e instanceof AmountError) return d.errors[`amount_${e.code}`]
  return `${d.errors.generic} ${shortError(e)}`
}
