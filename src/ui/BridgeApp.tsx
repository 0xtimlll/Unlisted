'use client'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { encodeFunctionData, type Address, type Hash } from 'viem'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi, oftAbi } from '@/core/abi'
import { AmountError, parseAmount } from '@/core/amounts'
import { byChainId, byEid, evmByKey, type ChainKey } from '@/core/chains'
import { DecodeTxError } from '@/core/decodeTx'
import { approvePlan, isPending, runGuards, selfCheck, type GuardInput } from '@/core/guards'
import { tryRecipient, type Recipient } from '@/core/recipient'
import { SvmDiscoverError } from '@/core/svm/errors'
import type { SuspiciousFlag } from '@/core/types'
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

type Sent = { txHash: Hash; dstEid: number; startedAt: number; srcChain: ChainKey; restored: boolean }

export function BridgeApp({ stored, setStored, onTheme }: { stored: Stored; setStored: (s: Stored) => void; onTheme: (t: Theme) => void }) {
  const d = useDict()
  const { address: wallet, chainId: walletChainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { openConnectModal } = useConnectModal()

  const [srcKey, setSrcKey] = useState<ChainKey>('ethereum')
  // Source chains are EVM until the Solana source stage; svm sources get their own wallet stack then.
  const src = evmByKey(srcKey)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState<TokenMode>('address')
  const [probeTarget, setProbeTarget] = useState<Address | null>(null)
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

  // Follow the wallet's chain when it is one we support.
  useEffect(() => {
    if (walletChainId === undefined) return
    const c = byChainId(walletChainId)
    if (c) setSrcKey(c.key)
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
    reset()
  }

  // ---- step 1: probe / decode -------------------------------------------------
  const probe = useProbe(src, probeTarget, stored.customRpc[src.key])
  const decode = useDecode(src, decodeTarget, stored.customRpc[src.key])
  const info = probe.data?.info
  const flags = useMemo(() => probe.data?.flags ?? [], [probe.data])

  useEffect(() => {
    if (!decode.data) return
    setProbeTarget(decode.data.oft)
    setDest((s) => ({ ...s, dstEid: decode.data.dstEid, extraOptions: decode.data.extraOptions }))
  }, [decode.data])

  useEffect(() => {
    if (info) setStored(pushRecent(stored, src.key, info.oft))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.oft])

  // ---- step 2: destination / amount / recipient -------------------------------
  const dstChain = dest.dstEid !== undefined ? byEid(dest.dstEid) : undefined
  const dstVm = dstChain?.vm
  // §4.3: on a non-EVM destination there is NO default recipient — the wallet address is never
  // offered, and only svmRecipient() (base58) can produce a Solana recipient (core/recipient.ts).
  const recipientResult =
    dstVm === 'svm'
      ? dest.recipientInput.trim() !== ''
        ? tryRecipient('svm', dest.recipientInput)
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
  const recipientIsCustom = dstVm === 'svm' || dest.recipientCustom
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
  const evmPeerBack = usePeerBack(src.eid, info?.oft, dstVm === 'evm' ? dest.dstEid : undefined, route?.peer, stored.customRpc)
  const svmDest = useSvmDestination(dstVm === 'svm', route?.peer, src.eid, info?.oft, stored.customRpc['solana'])
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

  const plan = usePlan({
    info,
    src,
    dstEid: dest.dstEid,
    // For Solana, wait until the options are known: the quoted SendParam must be the one we send.
    amountInput: amountError || (dstVm === 'svm' && !svmOptions) ? '' : dest.amountInput,
    sender: wallet,
    recipient,
    slippageBps: dest.slippageBps,
    feeBufferBps: dest.feeBufferBps,
    extraOptions: dstVm === 'svm' ? (svmOptions?.extraOptions ?? '0x') : dest.extraOptions,
  })

  const tokenBalance = useTokenBalance(src, info?.token, wallet)
  const allowance = useAllowance(src, info?.approvalRequired ? info.token : undefined, wallet, info?.oft)
  const nativeBalance = useNativeBalance(src, wallet)

  // ---- guards -------------------------------------------------------------------
  const approveIntent = info && plan.data ? approvePlan(info, plan.data, allowance.data) : null

  const baseInput: GuardInput = useMemo(
    () => ({
      walletAddress: wallet,
      walletChainId,
      srcChainId: src.chainId,
      info,
      plan: plan.data,
      recipientIsCustom,
      customRecipientConfirmed: recipientConfirmed,
      tokenBalance: tokenBalance.data,
      nativeBalance: nativeBalance.data?.value,
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
    [wallet, walletChainId, src.chainId, info, plan.data, recipientIsCustom, recipientConfirmed, tokenBalance.data, nativeBalance.data?.value, allowance.data, noGasAccepted, flags, svmFlags, peerBack, peerBackAccepted, svmRecipient.data?.class, pdaAccepted, dstVm, svmDest.data],
  )
  const pre = runGuards(baseInput)
  const preOk = pre.results.filter((r) => PRE_IDS.has(r.id)).every((r) => r.ok)
  const check = useCheck(src, plan.data, preOk)
  const fullInput: GuardInput = {
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation: check.data?.simulation,
    selfCheck: check.data?.selfCheck,
  }
  const report = runGuards(fullInput)

  // ---- approve ------------------------------------------------------------------
  const approveWrite = useWriteContract()
  const approveReceipt = useWaitForTransactionReceipt({ hash: approveWrite.data, chainId: src.chainId })
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
    if (!info || !plan.data || !info.approvalRequired) return
    const intent = approvePlan(info, plan.data, allowance.data)
    if (!intent || intent.spender.toLowerCase() !== info.oft.toLowerCase() || intent.amount !== plan.data.amounts.amountLD) return
    approveWrite.writeContract(
      {
        address: info.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [intent.spender, intent.amount],
        chainId: src.chainId,
      },
      { onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)) },
    )
  }

  // ---- send ---------------------------------------------------------------------
  const sendWrite = useWriteContract()
  const onSend = () => {
    setTxError('')
    const p = plan.data
    if (!p || !info) return
    const fresh = runGuards(fullInput)
    if (!fresh.canSend) return
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
        chainId: src.chainId,
      },
      {
        onSuccess: (hash) => {
          setSent({ txHash: hash, dstEid: p.dstEid, startedAt: Date.now(), srcChain: src.key, restored: false })
          setStored(pushHistory(stored, { srcChain: src.key, dstEid: p.dstEid, oft: p.oft, txHash: hash, at: Date.now() }))
        },
        onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)),
      },
    )
  }

  // ---- CTA state: the next thing the user has to do ------------------------------
  const chainMismatch = wallet !== undefined && walletChainId !== undefined && walletChainId !== src.chainId
  // Explain the real blocker first; a read still in flight is only shown when nothing else is wrong.
  const firstFailing = report.results.find((r) => !r.ok && !isPending(r)) ?? report.results.find((r) => !r.ok)
  const cta: CtaState = !wallet
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
              : !plan.data
              ? plan.error
                ? { kind: 'send', enabled: false, reason: describeError(d, plan.error) }
                : { kind: 'quote' }
              : approveIntent
                ? { kind: 'approve', intent: approveIntent }
                : !report.canSend && report.results.every((r) => r.ok || isPending(r))
                  ? { kind: 'checking' }
                  : { kind: 'send', enabled: report.canSend, ...(firstFailing && !firstFailing.ok ? { reason: d.guard[firstFailing.code] } : {}) }

  const approving = approveWrite.isPending || (!!approveWrite.data && approveReceipt.isLoading)
  const busy = switching || approving || sendWrite.isPending
  const busyLabel = approving ? d.step3.approving : sendWrite.isPending ? d.step3.sending_ : ''
  const onCta = () => {
    switch (cta.kind) {
      case 'connect':
        openConnectModal?.()
        return
      case 'switch':
        switchChain({ chainId: src.chainId })
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
      <Header theme={stored.theme} onTheme={onTheme} onSettings={() => setSettingsOpen(true)} />

      <main className="flex flex-1 flex-col items-center px-3 py-8 sm:py-14">
        <div className="w-full max-w-[408px] space-y-2">
          {sent ? (
            <Tracker
              src={evmByKey(sent.srcChain)}
              dstEid={sent.dstEid}
              txHash={sent.txHash}
              startedAt={sent.startedAt}
              restored={sent.restored}
              onFinal={(phase) => setStored(setHistoryStatus(stored, sent.txHash, phase))}
              onNew={reset}
            />
          ) : (
            <>
              <TokenStep
                chain={src}
                mode={mode}
                onMode={setMode}
                busy={probe.isFetching || decode.isFetching}
                recent={stored.recentContracts.filter((r) => r.chain === src.key).map((r) => r.address)}
                info={info}
                flags={flags}
                error={probe.error ? describeError(d, probe.error) : decode.error ? describeError(d, decode.error) : ''}
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
                balance={tokenBalance.data}
                amountInput={dest.amountInput}
                onAmount={(v) => setDest({ ...dest, amountInput: v })}
                amountError={amountError}
                dustTrimmed={plan.data?.amounts.dustTrimmed}
              />

              {info ? (
                <>
                  <div className="relative z-10 -my-4 flex justify-center">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-muted shadow-sm">↓</span>
                  </div>
                  <ToBox
                    info={info}
                    wallet={wallet}
                    plan={plan.data}
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
                  <Details src={src} info={info} plan={plan.data} state={dest} onChange={setDest} svmOptions={svmOptions} svmInfo={svmDest.data?.info} />
                  <Checks
                    report={report}
                    noGasAccepted={noGasAccepted}
                    onNoGasAccepted={setNoGasAccepted}
                    peerBackAccepted={peerBackAccepted}
                    onPeerBackAccepted={setPeerBackAccepted}
                    pdaAccepted={pdaAccepted}
                    onPdaAccepted={setPdaAccepted}
                    show={!!plan.data}
                  />
                </>
              ) : null}

              <div className="pt-1">
                <Cta state={cta} info={info} busy={busy} busyLabel={busyLabel} onClick={onCta} error={txError} />
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
