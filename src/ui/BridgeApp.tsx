'use client'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { encodeFunctionData, type Hash } from 'viem'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi, oftAbi } from '@/core/abi'
import { AmountError, parseAmount } from '@/core/amounts'
import { byChainId, byEid, byKey, isEvm, type ChainKey } from '@/core/chains'
import type { AnalysisInput } from '@/core/analysis/input'
import { analyzeSvmPrefill } from '@/core/analysis/svm'
import type { AnalysisAction, AnalysisTarget } from '@/core/analysis/result'
import type { ProtocolId } from '@/core/protocols'
import { DecodeTxError } from '@/core/decodeTx'
import { approvePlan, isPending, runGuards, selfCheck, type GuardInput } from '@/core/guards'
import { tryRecipient, type Recipient } from '@/core/recipient'
import { SvmDiscoverError } from '@/core/svm/errors'
import type { SourceInfo, SuspiciousFlag } from '@/core/types'
import { planSvmOptions } from '@/core/options'
import { assembleSendArgs, DEFAULT_FEE_BUFFER_BPS, DEFAULT_SLIPPAGE_BPS, PlanError } from '@/core/plan'
import { ProbeError } from '@/core/probe'
import type { DvnConfig } from '@/core/lz/dvn'
import { formatRevert, revertMeaning } from '@/core/sim/revert'
import { fmt, useDict, type Dict } from '@/i18n'
import { FromBox, ToBox, type DestinationState } from './components/FromTo'
import { ProtocolBadge } from './components/History'
import { Panel, TwoColumn } from './components/Layout'
import { Checks, Cta, Details, type CtaState } from './components/Review'
import { Alert } from './components/ui'
import { ContractFacts, TokenStep } from './components/TokenStep'
import { VerdictCard } from './components/Verdict'
import { Tracker } from './components/Tracker'
import { isUserRejection, shortError, useAllowance, useCheck, useDvn, useScanDelivered, type CheckResult, useDecode, useNativeBalance, usePeerBack, usePlan, useProbe, useSvmDestination, useSvmRecipient, useTokenBalance } from './hooks'
import { activeTransfer, pushHistory, pushRecent, setHistoryStatus, type HistoryEntry, type Stored } from './storage'
import { useSvmWallet } from './svm/context'
import { SvmWalletPicker } from './svm/SvmWalletButton'
import { useSvmCheck, useSvmContext, useSvmDecode, useSvmNativeBalance, useSvmPlan, useSvmProbe, useSvmSend, useSvmTokenBalance } from './svmHooks'
import { useAnalysis } from './useAnalysis'

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
  onOpenTab,
}: {
  stored: Stored
  setStored: (s: Stored) => void
  srcKey: ChainKey
  setSrcKey: (k: ChainKey) => void
  /** A past transfer the user asked to track from Recent transfers. */
  trackRequest: HistoryEntry | null
  onTrackConsumed: () => void
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
  const [noGasAccepted, setNoGasAccepted] = useState(false)
  const [peerBackAccepted, setPeerBackAccepted] = useState(false)
  const [pdaAccepted, setPdaAccepted] = useState(false)
  // A transfer that was in flight when the page was last closed is re-opened, not forgotten.
  const [sent, setSent] = useState<Sent | null>(() => {
    const a = activeTransfer(stored, 'lz-oft')
    return a ? { txHash: a.txHash, dstEid: a.dstEid, startedAt: a.at, srcChain: a.srcChain, restored: true } : null
  })
  const [txError, setTxError] = useState('')

  // "Track" in Recent transfers: the shell switches to this tab and hands the entry over.
  useEffect(() => {
    if (!trackRequest) return
    setSent({ txHash: trackRequest.txHash, dstEid: trackRequest.dstEid, startedAt: trackRequest.at, srcChain: trackRequest.srcChain, restored: true })
    onTrackConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackRequest])

  // Follow the EVM wallet's chain when it is one we support and the source is EVM.
  useEffect(() => {
    if (walletChainId === undefined || svmSource) return
    const c = byChainId(walletChainId)
    if (c) setSrcKey(c.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletChainId])

  const reset = useCallback(() => {
    setProbeTarget(null)
    setDecodeTarget(null)
    setAnalysisInput(null)
    setDest(EMPTY_DEST)
    setNoGasAccepted(false)
    setPeerBackAccepted(false)
    setPdaAccepted(false)
    setSent(null)
    setTxError('')
  }, [])

  const onSrcChange = (k: ChainKey) => {
    setSrcKey(k)
    reset()
  }

  // ---- step 1: analyse whatever was pasted ------------------------------------
  const analysis = useAnalysis(analysisInput, srcKey, stored.customRpc)
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

  const onInput = (i: AnalysisInput) => {
    setTxError('')
    setProbeTarget(null)
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
  const probeError = svmSource ? svmProbe.error : probe.error
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

  const infoId = info ? (info.vm === 'evm' ? info.oft : info.oftStore) : undefined
  useEffect(() => {
    if (infoId) setStored(pushRecent(stored, src.key, infoId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoId])

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
  const recipientConfirmed =
    recipientIsCustom && recipient !== undefined && dest.confirmLast6.trim().toLowerCase() === recipient.display.slice(-6).toLowerCase()

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
    return f
  }, [dstVm, svmDestInfo, svmDestUnknown, scanDelivered, svmRecipient.data, stored.customRpc])

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
      tokenBalance,
      nativeBalance,
      allowance: allowance.data,
      gasCostWei: undefined,
      simulation: undefined,
      selfCheck: undefined,
      noExecutorGasAccepted: noGasAccepted,
      flags: [...flags, ...svmFlags],
      peerBack,
      peerBackUnavailableAccepted: peerBackAccepted,
      svmRecipientClass: svmRecipient.data?.class,
      svmRecipientPdaAccepted: pdaAccepted,
      svmDestinationKnown: dstVm !== 'svm' || !!svmDest.data,
      svmDestinationRecognised: dstVm !== 'svm' || !svmDestUnknown,
    }),
    [svmSource, wallet, walletChainId, evmSrc?.chainId, svmWallet.address, info, planData, recipientIsCustom, recipientConfirmed, tokenBalance, nativeBalance, allowance.data, noGasAccepted, flags, svmFlags, peerBack, peerBackAccepted, svmRecipient.data?.class, pdaAccepted, dstVm, svmDest.data, svmDestUnknown],
  )
  const pre = runGuards(baseInput)
  const preOk = pre.results.filter((r) => PRE_IDS.has(r.id)).every((r) => r.ok)
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
  const fullInput: GuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation,
    selfCheck: check.data?.selfCheck,
  }
  const report = runGuards(fullInput)

  // ---- approve (EVM only: Solana OFTs pull tokens through the program directly) ---
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
    // Re-derive at click time; never trust stale render state (§6.10–12).
    if (!info || info.vm !== 'evm' || !evmSrc || !evmPlan.data || !info.approvalRequired) return
    const intent = approvePlan(info, evmPlan.data, allowance.data)
    if (!intent || intent.spender.toLowerCase() !== info.oft.toLowerCase() || intent.amount !== evmPlan.data.amounts.amountLD) return
    approveWrite.writeContract(
      {
        address: info.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [intent.spender, intent.amount],
        chainId: evmSrc.chainId,
      },
      { onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)) },
    )
  }

  // ---- send ---------------------------------------------------------------------
  const sendWrite = useWriteContract()
  const svmSend = useSvmSend()
  const recordSent = (txHash: string, dstEid: number, oft: string) => {
    setSent({ txHash, dstEid, startedAt: Date.now(), srcChain: src.key, restored: false })
    setStored(pushHistory(stored, { srcChain: src.key, protocol: 'lz-oft', dstEid, oft, txHash, at: Date.now() }))
  }
  const onSend = () => {
    setTxError('')
    const p = planData
    if (!p || !info) return
    const fresh = runGuards(fullInput)
    if (!fresh.canSend) return
    if (p.vm === 'svm') {
      // The transaction is rebuilt from the plan and decoded back right before signing (core/svm/send.ts).
      if (!svmCtx.data || !svmWallet.signer || svmWallet.address !== p.sender) return
      svmSend.mutate(
        { ctx: svmCtx.data, plan: p, signer: svmWallet.signer },
        {
          onSuccess: (sig) => recordSent(sig, p.dstEid, p.oftStore),
          onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : `${d.errors.svm_send_failed} ${shortError(e)}`),
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
      },
    )
  }

  // ---- CTA state: the next thing the user has to do ------------------------------
  const chainMismatch = !svmSource && wallet !== undefined && walletChainId !== undefined && evmSrc !== undefined && walletChainId !== evmSrc.chainId
  // Explain the real blocker first; a read still in flight is only shown when nothing else is wrong.
  const firstFailing = report.results.find((r) => !r.ok && !isPending(r)) ?? report.results.find((r) => !r.ok)
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
                  ? { kind: 'approve', intent: approveIntent }
                  : !report.canSend && report.results.every((r) => r.ok || isPending(r))
                    ? { kind: 'checking' }
                    : { kind: 'send', enabled: report.canSend, ...(firstFailing && !firstFailing.ok ? { reason: d.guard[firstFailing.code] } : {}) }

  const approving = approveWrite.isPending || (!!approveWrite.data && approveReceipt.isLoading)
  const sending = sendWrite.isPending || svmSend.isPending
  const busy = switching || approving || sending
  const busyLabel = approving ? d.step3.approving : sending ? d.step3.sending_ : ''
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
  const left = sent ? (
    <Tracker
      src={byKey(sent.srcChain)}
      dstEid={sent.dstEid}
      txHash={sent.txHash}
      startedAt={sent.startedAt}
      restored={sent.restored}
      customRpc={stored.customRpc['solana']}
      onFinal={(phase) => setStored(setHistoryStatus(stored, sent.txHash, phase))}
      onNew={reset}
    />
  ) : (
    <>
      <TokenStep
        chain={src}
        onInput={onInput}
        busy={analysis.isFetching || probe.isFetching || decode.isFetching || svmProbe.isFetching || svmDecode.isFetching}
        recent={stored.recentContracts.filter((r) => r.chain === src.key).map((r) => r.address)}
        info={info}
        flags={flags}
        error={decodeProgramMismatch ? d.errors.decode_program_mismatch : probeError ? describeError(d, probeError) : decodeError ? describeError(d, decodeError) : ''}
        decodedHint={!!decodeData}
        decodedFailed={svmDecode.data?.observed.failed ?? false}
        droppedOptions={decodeData?.droppedOptions ?? []}
        optionsMalformed={decodeData?.optionsMalformed ?? false}
      />

      <FromBox
        src={src}
        onSrcChange={onSrcChange}
        info={info}
        balance={tokenBalance}
        amountInput={dest.amountInput}
        onAmount={(v) => setDest({ ...dest, amountInput: v })}
        amountError={amountError}
        dustTrimmed={planData?.amounts.dustTrimmed}
      />

      {info ? (
        <>
          <div className="relative z-10 -my-4 flex justify-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-muted shadow-sm">↓</span>
          </div>
          <ToBox
            info={info}
            wallet={sender}
            plan={planData}
            state={dest}
            onChange={(next) => {
              // Switching between an EVM and a Solana destination clears the recipient:
              // an address for one VM must never linger into the other.
              const nextVm = next.dstEid !== undefined ? byEid(next.dstEid)?.vm : undefined
              setDest(nextVm !== dstVm ? { ...next, recipientCustom: false, recipientInput: '', confirmLast6: '' } : next)
              setPdaAccepted(false)
            }}
            dstVm={dstVm}
            recipientError={recipientError}
            svmError={svmDest.error ? describeError(d, svmDest.error) : ''}
          />
        </>
      ) : null}

      <div className="pt-1">
        <Cta state={cta} info={info} busy={busy} busyLabel={busyLabel} onClick={onCta} error={txError || (svmSource && !svmWallet.address ? svmWallet.error : '')} />
      </div>
    </>
  )

  const unreachable = analysis.data?.failed ?? []
  const analysisError = analysis.error ? describeError(d, analysis.error) : ''

  // The panel is the live preview: the verdict first, then what comes out, what it costs and
  // every check — all without scrolling.
  const right = (
    <Panel title={d.ui.preview} badge={<ProtocolBadge id="lz-oft" />}>
      {sent ? (
        <p className="text-sm text-muted">{d.ui.previewTracking}</p>
      ) : (
        <div className="space-y-4">
          {results.length > 1 ? (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{fmt(d.analysis.severalTitle, { n: results.length })}</div>
              <p className="mb-2 text-xs text-muted">{d.analysis.severalHint}</p>
              <div className="flex flex-wrap gap-1">
                {results.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setChosen(i)}
                    className={`h-8 rounded-lg px-3 text-xs font-semibold ${i === chosen ? 'bg-accent text-page' : 'bg-surface-2 text-ink hover:bg-line'}`}
                  >
                    {i + 1}. {r.protocol ? r.protocol : d.analysis.title_unknown}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {primary ? <VerdictCard result={primary} onAction={onAnalysisAction} /> : null}

          {unreachable.length > 0 ? (
            <Alert kind="warn">{fmt(d.analysis.unreachable, { chains: unreachable.map((f) => byKey(f.chain).name).join(', ') })}</Alert>
          ) : null}

          {analysisError ? <Alert kind="error">{analysisError}</Alert> : null}

          {info ? (
            <>
              <PanelSection title={d.ui.section_contract}>
                <ContractFacts chain={src} info={info} />
              </PanelSection>
              <PanelSection title={d.ui.section_quote}>
                <Details src={src} info={info} plan={planData} state={dest} onChange={setDest} svmOptions={svmOptions} svmInfo={svmDestInfo} flat />
              </PanelSection>
              <Checks
                report={report}
                noGasAccepted={noGasAccepted}
                onNoGasAccepted={setNoGasAccepted}
                peerBackAccepted={peerBackAccepted}
                onPeerBackAccepted={setPeerBackAccepted}
                pdaAccepted={pdaAccepted}
                onPdaAccepted={setPdaAccepted}
                show={!!planData}
                defaultOpen
              />
              <SimulationNote check={evmData} />
              <DvnNote config={dvn.data} />
            </>
          ) : primary ? null : (
            <p className="text-sm text-muted">{d.ui.previewEmpty}</p>
          )}
        </div>
      )}
    </Panel>
  )

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

/** §Task 4, informational: how many parties attest to messages on this route. Never blocks. */
function DvnNote({ config }: { config: DvnConfig | undefined }) {
  const d = useDict()
  if (!config) return null
  const optional = config.optionalThreshold > 0 ? fmt(d.analysis.dvnOptional, { n: config.optionalThreshold, total: config.optionalDVNs.length }) : ''
  return (
    <div className="text-xs text-muted">
      {fmt(d.analysis.dvn, { required: config.requiredDVNs.length, optional, confirmations: config.confirmations.toString() })}
      {config.weak ? <div className="mt-1 text-warn">⚠ {d.analysis.dvnWeak}</div> : null}
    </div>
  )
}

/** §Task 4: the human sentence behind a failed simulation, with the raw line underneath. */
function SimulationNote({ check }: { check: CheckResult | undefined }) {
  const d = useDict()
  if (!check) return null
  if (check.rpcUnavailable) return <Alert kind="warn">{d.revert.rpcUnavailable}</Alert>
  const r = check.revert
  if (!r) return check.batched ? <p className="text-xs text-muted">{d.revert.batched}</p> : null
  const meaning = revertMeaning(r) ?? 'generic'
  return (
    <Alert kind="error">
      <div className="font-semibold">{d.revert[meaning]}</div>
      <div className="mono mt-1 text-xs opacity-80">{formatRevert(r)}</div>
      {r.kind === 'error' && r.source === 'contract' ? <div className="mt-1 text-xs opacity-80">{d.revert.fromContractAbi}</div> : null}
      {r.kind === 'unknown' ? (
        <a href={r.lookupUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs underline">
          {d.analysis.lookupSelector}
        </a>
      ) : null}
    </Alert>
  )
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{title}</div>
      {children}
    </div>
  )
}

function describeError(d: Dict, e: unknown): string {
  if (e instanceof ProbeError) return d.errors[`probe_${e.code}`]
  if (e instanceof SvmDiscoverError) return d.errors[`svm_${e.code}`]
  if (e instanceof DecodeTxError) return d.errors[`decode_${e.code}`]
  if (e instanceof PlanError) return `${d.errors[`plan_${e.code}`]}${e.code === 'quote_failed' ? ` (${e.message.slice(0, 160)})` : ''}`
  if (e instanceof AmountError) return d.errors[`amount_${e.code}`]
  return `${d.errors.generic} ${shortError(e)}`
}
