'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { encodeFunctionData, isAddress, type Address, type Hash } from 'viem'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi, oftAbi } from '@/core/abi'
import { AmountError, parseAmount } from '@/core/amounts'
import { byChainId, byKey, type ChainKey } from '@/core/chains'
import { DecodeTxError } from '@/core/decodeTx'
import { checksum } from '@/core/encoding'
import { approvePlan, runGuards, selfCheck, type GuardInput } from '@/core/guards'
import { assembleSendArgs, DEFAULT_FEE_BUFFER_BPS, DEFAULT_SLIPPAGE_BPS, PlanError } from '@/core/plan'
import { ProbeError } from '@/core/probe'
import { useDict, type Dict } from '@/i18n'
import { DestinationStep, type DestinationState } from './components/DestinationStep'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { History } from './components/History'
import { OftCard } from './components/OftCard'
import { ReviewStep } from './components/ReviewStep'
import { SettingsDialog } from './components/SettingsDialog'
import { TokenStep, type TokenMode } from './components/TokenStep'
import { Tracker } from './components/Tracker'
import { Alert, Button } from './components/ui'
import { isUserRejection, shortError, useAllowance, useCheck, useDecode, useNativeBalance, usePlan, useProbe, useTokenBalance } from './hooks'
import { pushHistory, pushRecent, type Stored } from './storage'

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
const PRE_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 15])

type Sent = { txHash: Hash; dstEid: number; startedAt: number }

export function BridgeApp({ stored, setStored }: { stored: Stored; setStored: (s: Stored) => void }) {
  const d = useDict()
  const { address: wallet, chainId: walletChainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()

  const [srcKey, setSrcKey] = useState<ChainKey>('ethereum')
  const src = byKey(srcKey)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState<TokenMode>('address')
  const [probeTarget, setProbeTarget] = useState<Address | null>(null)
  const [decodeTarget, setDecodeTarget] = useState<Hash | null>(null)
  const [dest, setDest] = useState<DestinationState>(EMPTY_DEST)
  const [noGasAccepted, setNoGasAccepted] = useState(false)
  const [sent, setSent] = useState<Sent | null>(null)
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
    setSent(null)
    setTxError('')
  }, [])

  const onSrcChange = (k: ChainKey) => {
    setSrcKey(k)
    reset()
  }

  // ---- step 1: probe / decode -------------------------------------------------
  const probe = useProbe(src, probeTarget)
  const decode = useDecode(src, decodeTarget)
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
  const recipient: Address | undefined = dest.recipientCustom
    ? isAddress(dest.recipientInput.trim(), { strict: false })
      ? checksum(dest.recipientInput.trim())
      : undefined
    : wallet
  const recipientConfirmed =
    dest.recipientCustom && recipient !== undefined && dest.confirmLast6.trim().toLowerCase() === recipient.slice(-6).toLowerCase()

  let amountError = ''
  if (info && dest.amountInput.trim() !== '') {
    try {
      parseAmount(dest.amountInput, info.decimals)
    } catch (e) {
      amountError = e instanceof AmountError ? d.errors[`amount_${e.code}`] : d.errors.generic
    }
  }

  const plan = usePlan({
    info,
    src,
    dstEid: dest.dstEid,
    amountInput: amountError ? '' : dest.amountInput,
    sender: wallet,
    recipient,
    slippageBps: dest.slippageBps,
    feeBufferBps: dest.feeBufferBps,
    extraOptions: dest.extraOptions,
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
      recipientIsCustom: dest.recipientCustom,
      customRecipientConfirmed: recipientConfirmed,
      tokenBalance: tokenBalance.data,
      nativeBalance: nativeBalance.data?.value,
      allowance: allowance.data,
      gasCostWei: undefined,
      simulation: undefined,
      selfCheck: undefined,
      noExecutorGasAccepted: noGasAccepted,
      flags,
    }),
    [wallet, walletChainId, src.chainId, info, plan.data, dest.recipientCustom, recipientConfirmed, tokenBalance.data, nativeBalance.data?.value, allowance.data, noGasAccepted, flags],
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
          setSent({ txHash: hash, dstEid: p.dstEid, startedAt: Date.now() })
          setStored(pushHistory(stored, { srcChain: src.key, dstEid: p.dstEid, oft: p.oft, txHash: hash, at: Date.now() }))
        },
        onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)),
      },
    )
  }

  // ---- render -------------------------------------------------------------------
  const chainMismatch = wallet !== undefined && walletChainId !== undefined && walletChainId !== src.chainId

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <Header srcKey={srcKey} onSrcChange={onSrcChange} onSettings={() => setSettingsOpen(true)} />
      <p className="text-sm opacity-70">{d.app.tagline}</p>

      {chainMismatch ? (
        <Alert kind="warn">
          <div className="flex flex-wrap items-center gap-2">
            <span>{d.guard.chain_mismatch}</span>
            <Button className="text-xs" disabled={switching} onClick={() => switchChain({ chainId: src.chainId })}>
              → {src.name}
            </Button>
          </div>
        </Alert>
      ) : null}

      {sent ? (
        <Tracker src={src} dstEid={sent.dstEid} txHash={sent.txHash} startedAt={sent.startedAt} onNew={reset} />
      ) : (
        <>
          <TokenStep
            chain={src}
            mode={mode}
            onMode={setMode}
            busy={probe.isFetching || decode.isFetching}
            recent={stored.recentContracts.filter((r) => r.chain === src.key).map((r) => r.address)}
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
          {probe.error ? <Alert kind="error">{describeError(d, probe.error)}</Alert> : null}
          {decode.error ? <Alert kind="error">{describeError(d, decode.error)}</Alert> : null}
          {decode.data ? <Alert kind="info">{d.step1.decodedHint}</Alert> : null}
          {info ? <OftCard chain={src} info={info} flags={flags} /> : null}

          {info ? (
            <DestinationStep
              info={info}
              wallet={wallet}
              balance={tokenBalance.data}
              state={dest}
              onChange={setDest}
              amountError={amountError}
              dustTrimmed={plan.data?.amounts.dustTrimmed}
            />
          ) : null}

          {info && dest.dstEid !== undefined ? (
            <ReviewStep
              src={src}
              info={info}
              plan={plan.data}
              planError={plan.error ? describeError(d, plan.error) : ''}
              report={report}
              approve={approveIntent}
              noGasAccepted={noGasAccepted}
              onNoGasAccepted={setNoGasAccepted}
              onApprove={onApprove}
              onSend={onSend}
              approving={approveWrite.isPending || (!!approveWrite.data && approveReceipt.isLoading)}
              sending={sendWrite.isPending}
              txError={txError}
            />
          ) : null}
        </>
      )}

      <History entries={stored.history} onClear={() => setStored({ ...stored, history: [] })} />
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
  if (e instanceof DecodeTxError) return d.errors[`decode_${e.code}`]
  if (e instanceof PlanError) return `${d.errors[`plan_${e.code}`]}${e.code === 'quote_failed' ? ` (${e.message.slice(0, 160)})` : ''}`
  if (e instanceof AmountError) return d.errors[`amount_${e.code}`]
  return `${d.errors.generic} ${shortError(e)}`
}
