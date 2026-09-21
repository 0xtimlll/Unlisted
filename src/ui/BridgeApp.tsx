'use client'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { encodeFunctionData, type Hash } from 'viem'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi, oftAbi } from '@/core/abi'
import { AmountError, parseAmount } from '@/core/amounts'
import { byChainId, byEid, byKey, isEvm, type ChainKey } from '@/core/chains'
import { DecodeTxError } from '@/core/decodeTx'
import { approvePlan, isPending, runGuards, selfCheck, type GuardInput } from '@/core/guards'
import { tryRecipient, type Recipient } from '@/core/recipient'
import { SvmDiscoverError } from '@/core/svm/errors'
import type { SourceInfo, SuspiciousFlag } from '@/core/types'
import { planSvmOptions } from '@/core/options'
import { assembleSendArgs, DEFAULT_FEE_BUFFER_BPS, DEFAULT_SLIPPAGE_BPS, PlanError } from '@/core/plan'
import { ProbeError } from '@/core/probe'
import { useDict, type Dict } from '@/i18n'
import { Footer } from './components/Footer'
import { FromBox, ToBox, type DestinationState } from './components/FromTo'
import { Header } from './components/Header'
import { History } from './components/History'
import { Checks, Cta, Details, type CtaState } from './components/Review'
import { SettingsDialog } from './components/SettingsDialog'
import { TokenStep, type TokenMode } from './components/TokenStep'
import { Tracker } from './components/Tracker'
import { isUserRejection, shortError, useAllowance, useCheck, useDecode, useNativeBalance, usePeerBack, usePlan, useProbe, useSvmDestination, useSvmRecipient, useTokenBalance } from './hooks'
import { activeTransfer, pushHistory, pushRecent, setHistoryStatus, type HistoryEntry, type Stored, type Theme } from './storage'
import { useSvmWallet } from './svm/context'
import { SvmWalletPicker } from './svm/SvmWalletButton'
import { useSvmCheck, useSvmContext, useSvmNativeBalance, useSvmPlan, useSvmProbe, useSvmSend, useSvmTokenBalance } from './svmHooks'

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

/** Guards that do not depend on simulation/gas; the check query waits for these. */
const PRE_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 15, 17, 18, 19, 20])

type Sent = { txHash: string; dstEid: number; startedAt: number; srcChain: ChainKey; restored: boolean }

export function BridgeApp({
  stored,
  setStored,
  onTheme,
  srcKey,
  setSrcKey,
}: {
  stored: Stored
  setStored: (s: Stored) => void
  onTheme: (t: Theme) => void
  srcKey: ChainKey
  setSrcKey: (k: ChainKey) => void
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [svmPickerOpen, setSvmPickerOpen] = useState(false)
  const [mode, setMode] = useState<TokenMode>('address')
  const [probeTarget, setProbeTarget] = useState<string | null>(null)
  const [decodeTarget, setDecodeTarget] = useState<Hash | null>(null)
  const [dest, setDest] = useState<DestinationState>(EMPTY_DEST)
  const [noGasAccepted, setNoGasAccepted] = useState(false)
  const [peerBackAccepted, setPeerBackAccepted] = useState(false)
  const [pdaAccepted, setPdaAccepted] = useState(false)
  // A transfer that was in flight when the page was last closed is re-opened, not forgotten.
  const [sent, setSent] = useState<Sent | null>(() => {
    const a = activeTransfer(stored)
    return a ? { txHash: a.txHash, dstEid: a.dstEid, startedAt: a.at, srcChain: a.srcChain, restored: true } : null
  })
  const [txError, setTxError] = useState('')

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
    setDest(EMPTY_DEST)
    setNoGasAccepted(false)
    setPeerBackAccepted(false)
    setPdaAccepted(false)
    setSent(null)
    setTxError('')
  }, [])

  const onSrcChange = (k: ChainKey) => {
    setSrcKey(k)
    setMode('address')
    reset()
  }

  // ---- step 1: probe / decode -------------------------------------------------
  const probe = useProbe(evmSrc, svmSource ? null : probeTarget, stored.customRpc[src.key])
  const decode = useDecode(evmSrc, decodeTarget, stored.customRpc[src.key])
  const svmProbe = useSvmProbe(svmSource, probeTarget, stored.customRpc['solana'])
  const info: SourceInfo | undefined = svmSource ? svmProbe.data?.info : probe.data?.info
  const flags = useMemo(() => (svmSource ? (svmProbe.data?.flags ?? []) : (probe.data?.flags ?? [])), [svmSource, svmProbe.data, probe.data])
  const probeError = svmSource ? svmProbe.error : probe.error

  useEffect(() => {
    if (!decode.data) return
    setProbeTarget(decode.data.oft)
    setDest((s) => ({ ...s, dstEid: decode.data.dstEid, extraOptions: decode.data.extraOptions }))
  }, [decode.data])

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
  const svmRecipient = useSvmRecipient(svmDest.data?.info, dstVm === 'svm' && recipient?.vm === 'svm' ? recipient.display : undefined, stored.customRpc['solana'])
  const peerBack = dstVm === 'svm' ? svmDest.data?.peerBack : evmPeerBack.data
  const svmFlags = useMemo<SuspiciousFlag[]>(() => {
    if (dstVm !== 'svm') return []
    const f: SuspiciousFlag[] = []
    if (svmDest.data?.info.paused) f.push('svm_paused')
    if ((svmDest.data?.info.defaultFeeBps ?? 0) > 0) f.push('svm_fee')
    if (svmRecipient.data?.class === 'missing') f.push('svm_recipient_not_activated')
    if (!stored.customRpc['solana']) f.push('svm_single_provider')
    return f
  }, [dstVm, svmDest.data, svmRecipient.data, stored.customRpc])

  // §5.1 Solana destination: extraOptions are derived from the contract's enforced options and
  // the recipient's token-account state, never typed by hand (a sample tx only contributes a hint).
  const svmOptions = useMemo(() => {
    if (dstVm !== 'svm' || !info || dest.dstEid === undefined || !svmRecipient.data) return undefined
    return planSvmOptions({ enforced: info.enforced[dest.dstEid] ?? '0x', ataExists: svmRecipient.data.ataExists, sample: dest.extraOptions })
  }, [dstVm, info, dest.dstEid, dest.extraOptions, svmRecipient.data])

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
    }),
    [svmSource, wallet, walletChainId, evmSrc?.chainId, svmWallet.address, info, planData, recipientIsCustom, recipientConfirmed, tokenBalance, nativeBalance, allowance.data, noGasAccepted, flags, svmFlags, peerBack, peerBackAccepted, svmRecipient.data?.class, pdaAccepted, dstVm, svmDest.data],
  )
  const pre = runGuards(baseInput)
  const preOk = pre.results.filter((r) => PRE_IDS.has(r.id)).every((r) => r.ok)
  const evmCheck = useCheck(evmSrc, evmPlan.data, preOk && !svmSource)
  const svmCheck = useSvmCheck(svmCtx.data, svmPlan.data, preOk && svmSource)
  const check = svmSource ? svmCheck : evmCheck
  const fullInput: GuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation: check.data?.simulation,
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
    setStored(pushHistory(stored, { srcChain: src.key, dstEid, oft, txHash, at: Date.now() }))
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
  return (
    <div className="flex min-h-screen w-full flex-col">
      <Header theme={stored.theme} onTheme={onTheme} onSettings={() => setSettingsOpen(true)} srcVm={src.vm} />

      <main className="flex flex-1 flex-col items-center px-3 py-8 sm:py-14">
        <div className="w-full max-w-[408px] space-y-2">
          {sent ? (
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
                mode={mode}
                onMode={setMode}
                busy={probe.isFetching || decode.isFetching || svmProbe.isFetching}
                recent={stored.recentContracts.filter((r) => r.chain === src.key).map((r) => r.address)}
                info={info}
                flags={flags}
                error={probeError ? describeError(d, probeError) : decode.error ? describeError(d, decode.error) : ''}
                decodedHint={!!decode.data}
                droppedOptions={decode.data?.droppedOptions ?? []}
                optionsMalformed={decode.data?.optionsMalformed ?? false}
                onProbe={(a) => {
                  setDecodeTarget(null)
                  setDest(EMPTY_DEST)
                  setProbeTarget(a)
                }}
                onDecode={(h) => {
                  setProbeTarget(null)
                  setDest(EMPTY_DEST)
                  setDecodeTarget(h)
                }}
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
                  <Details src={src} info={info} plan={planData} state={dest} onChange={setDest} svmOptions={svmOptions} svmInfo={svmDest.data?.info} />
                  <Checks
                    report={report}
                    noGasAccepted={noGasAccepted}
                    onNoGasAccepted={setNoGasAccepted}
                    peerBackAccepted={peerBackAccepted}
                    onPeerBackAccepted={setPeerBackAccepted}
                    pdaAccepted={pdaAccepted}
                    onPdaAccepted={setPdaAccepted}
                    show={!!planData}
                  />
                </>
              ) : null}

              <div className="pt-1">
                <Cta state={cta} info={info} busy={busy} busyLabel={busyLabel} onClick={onCta} error={txError || (svmSource && !svmWallet.address ? svmWallet.error : '')} />
              </div>
            </>
          )}

          <div className="pt-4">
            <History
              entries={stored.history}
              onClear={() => setStored({ ...stored, history: [] })}
              onTrack={(e: HistoryEntry) => setSent({ txHash: e.txHash, dstEid: e.dstEid, startedAt: e.at, srcChain: e.srcChain, restored: true })}
            />
          </div>
        </div>
      </main>

      <Footer />

      {settingsOpen ? (
        <SettingsDialog
          stored={stored}
          onClose={() => setSettingsOpen(false)}
          onSave={(rpc) => {
            setStored({ ...stored, customRpc: rpc })
            setSettingsOpen(false)
          }}
        />
      ) : null}
      {svmPickerOpen ? (
        <SvmWalletPicker
          onClose={() => setSvmPickerOpen(false)}
          onPick={(name) => {
            setSvmPickerOpen(false)
            void svmWallet.connect(name)
          }}
        />
      ) : null}
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
