'use client'
/**
 * The Wormhole NTT tab. EVM to EVM.
 *
 * Nothing here can be signed until verifyNttManager() returns ok: the manager is the approve
 * spender, so the four-part gate is what stands between the user and handing an allowance to a
 * look-alike contract. The gate's verdict is the first thing on the right.
 */
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEffect, useMemo, useState } from 'react'
import { isAddress } from 'viem'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { erc20Abi } from '@/core/abi'
import { AmountError, formatAmount, parseAmount } from '@/core/amounts'
import { byChainId, byKey, evmChains, isEvm, type ChainKey } from '@/core/chains'
import type { AnalysisTarget } from '@/core/analysis/result'
import { tryRecipient, type Recipient } from '@/core/recipient'
import { formatRevert, revertMeaning } from '@/core/sim/revert'
import { nttManagerAbi } from '@/protocols/wormhole-ntt/abi'
import { isNttPending, nttApprovePlan, runNttGuards, type NttGuardInput } from '@/protocols/wormhole-ntt/guards'
import { assembleNttTransferArgs } from '@/protocols/wormhole-ntt/plan'
import { wormholescanTxUrl } from '@/protocols/wormhole-ntt/track'
import { fmt, useDict } from '@/i18n'
import { Address as AddressView } from './components/Address'
import { ChainIcon } from './components/ChainIcon'
import { ProtocolBadge } from './components/History'
import { Panel, TwoColumn } from './components/Layout'
import { Alert, AmountInput, Box, BoxLabel, Button, Input, PillSelect, Row, Spinner } from './components/ui'
import { isUserRejection, shortError, useAllowance, useNativeBalance, useTokenBalance } from './hooks'
import { nttDestinations, useNttCheck, useNttDiscovery, useNttPlan, useNttTokenList, useNttVerification } from './nttHooks'
import { pushHistory, type Stored } from './storage'

export function NttApp({
  stored,
  setStored,
  srcKey,
  setSrcKey,
  handoff,
}: {
  stored: Stored
  setStored: (s: Stored) => void
  srcKey: ChainKey
  setSrcKey: (k: ChainKey) => void
  /** What the OFT tab's analysis found, when the user arrived through the banner. */
  handoff: AnalysisTarget | null
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
    if (!handoff || handoff.kind !== 'ntt-manager') return
    setSrcKey(handoff.chain)
    setInput(handoff.address)
    setTarget(handoff.address)
    if (handoff.dstChain) setDstChain(handoff.dstChain)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.address, handoff?.chain])

  const tokenList = useNttTokenList()
  const discovery = useNttDiscovery(srcKey, dstChain, target, tokenList.data, stored.customRpc)
  const manager = discovery.data?.kind === 'manager' ? discovery.data.manager : undefined

  const listedToken = useMemo(() => {
    const t = discovery.data?.kind === 'manager' ? discovery.data.token : discovery.data?.kind === 'token_without_minter' ? discovery.data.token : undefined
    if (!t || !tokenList.data) return undefined
    const platform = tokenList.data.find((x) => Object.values(x.platforms).some((a) => a.toLowerCase() === t.toLowerCase()))
    return platform
  }, [discovery.data, tokenList.data])

  const destinations = useMemo(
    () => nttDestinations(listedToken, evmChains().map((c) => c.key), srcKey),
    [listedToken, srcKey],
  )

  const verification = useNttVerification(srcKey, dstChain, manager, tokenList.data, stored.customRpc)
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
  const recipientConfirmed = recipientCustom && recipient !== undefined && confirmLast6.trim().toLowerCase() === recipient.display.slice(-6).toLowerCase()

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
    tokenBalance: tokenBalance.data,
    nativeBalance: nativeBalance.data?.value,
    allowance: allowance.data,
    gasCostWei: undefined,
    ...(approveIntent ? { approveIntent } : {}),
    simulation: undefined,
    selfCheck: undefined,
  }
  const pre = runNttGuards(baseInput)
  const preOk = pre.results.filter((r) => r.id !== 8 && r.id !== 9 && r.id !== 12 && r.id !== 13).every((r) => r.ok)
  const check = useNttCheck(planData, preOk, stored.customRpc)
  const report = runNttGuards({
    ...baseInput,
    gasCostWei: check.data?.gasCostWei,
    simulation: check.data?.simulation,
    selfCheck: check.data?.selfCheck,
  })

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
    // Re-derived at click time from the VERIFIED manager; never from render state.
    const intent = nttApprovePlan(verification.data, planData, allowance.data)
    if (!intent || !verified || !evmSrc) return
    if (intent.spender !== verified.manager || intent.token !== verified.token) return
    approveWrite.writeContract(
      { address: intent.token, abi: erc20Abi, functionName: 'approve', args: [intent.spender, intent.amount], chainId: evmSrc.chainId },
      { onError: (e) => setTxError(isUserRejection(e) ? d.errors.wallet_rejected : shortError(e)) },
    )
  }

  const sendWrite = useWriteContract()
  const onSend = () => {
    setTxError('')
    const p = planData
    if (!p || !evmSrc || !verified) return
    if (!runNttGuards({ ...baseInput, gasCostWei: check.data?.gasCostWei, simulation: check.data?.simulation, selfCheck: check.data?.selfCheck }).canSend) return
    if (p.manager !== verified.manager) return
    const a = assembleNttTransferArgs(p)
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
      },
    )
  }

  // ---- CTA ----------------------------------------------------------------------
  const chainMismatch = wallet !== undefined && walletChainId !== undefined && evmSrc !== undefined && walletChainId !== evmSrc.chainId
  const busy = switching || approveWrite.isPending || (!!approveWrite.data && approveReceipt.isLoading) || sendWrite.isPending
  const firstFailing = report.results.find((r) => !r.ok && !isNttPending(r)) ?? report.results.find((r) => !r.ok)
  const ctaLabel = !wallet
    ? d.ui.cta_connect
    : chainMismatch
      ? fmt(d.ui.cta_switch, { chain: src.name })
      : !manager
        ? d.ntt.cta_find
        : !dstChain
          ? d.ui.cta_destination
          : !verified
            ? d.ntt.cta_verifying
            : amountInput.trim() === ''
              ? d.ui.cta_amount
              : approveIntent
                ? fmt(d.step3.approveBtn, { amount: formatAmount(approveIntent.amount, verified.tokenDecimals), symbol: verified.tokenSymbol })
                : d.ui.cta_send
  const ctaEnabled = !busy && (!wallet || chainMismatch || (!!approveIntent && !!verified) || report.canSend)
  const onCta = () => {
    if (!wallet) return openConnectModal?.()
    if (chainMismatch && evmSrc) return switchChain({ chainId: evmSrc.chainId })
    if (approveIntent) return onApprove()
    onSend()
  }

  // ---- render ---------------------------------------------------------------------
  const left = sent ? (
    <Box>
      <BoxLabel>{d.tracker.title}</BoxLabel>
      <p className="text-sm text-muted">{d.ntt.sentHint}</p>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <a href={src.explorerTxUrl + sent} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">
          {d.tracker.sourceTx} ↗
        </a>
        <a href={wormholescanTxUrl(sent)} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">
          Wormholescan ↗
        </a>
      </div>
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
        <BoxLabel>{d.ntt.inputLabel}</BoxLabel>
        <div className="flex h-[50px] items-center rounded-full bg-surface-2 pl-4 pr-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isAddress(input.trim(), { strict: false })) setTarget(input.trim())
            }}
            placeholder={d.ntt.placeholder}
            spellCheck={false}
            autoComplete="off"
            className="mono min-w-0 flex-1 bg-transparent pr-2 text-sm text-ink outline-none placeholder:text-faint"
            aria-label={d.ntt.inputLabel}
          />
          <Button
            variant="primary"
            className="h-9 rounded-full px-4"
            disabled={!isAddress(input.trim(), { strict: false }) || discovery.isFetching || tokenList.isLoading}
            onClick={() => setTarget(input.trim())}
          >
            {discovery.isFetching || tokenList.isLoading ? <Spinner /> : d.analysis.button}
          </Button>
        </div>
        {tokenList.isError ? (
          <div className="mt-2">
            <Alert kind="error">{d.ntt.listUnavailable}</Alert>
          </div>
        ) : null}
        {discovery.data?.kind === 'unknown' ? (
          <div className="mt-2">
            <Alert kind="error">{discovery.data.reason === 'not_listed' ? d.ntt.notListed : d.ntt.unreadable}</Alert>
          </div>
        ) : null}
        {discovery.data?.kind === 'token_without_minter' ? (
          <div className="mt-2">
            <Alert kind="warn">{dstChain ? d.ntt.noMinter : d.ntt.pickDestinationFirst}</Alert>
          </div>
        ) : null}
        {discovery.data?.kind === 'manager' ? (
          <p className="mt-2 text-xs text-muted">
            {discovery.data.via === 'minter' ? d.ntt.foundViaMinter : discovery.data.via === 'peer' ? d.ntt.foundViaPeer : d.ntt.foundGiven}{' '}
            <AddressView value={discovery.data.manager} href={src.explorerAddrUrl + discovery.data.manager} short />
          </p>
        ) : null}
      </Box>

      <Box>
        <BoxLabel
          right={
            verified && tokenBalance.data !== undefined ? (
              <button type="button" className="tnum text-accent-ink hover:underline" onClick={() => setAmountInput(formatAmount(tokenBalance.data ?? 0n, verified.tokenDecimals))}>
                {d.step2.balance}: {formatAmount(tokenBalance.data, verified.tokenDecimals, { maxFraction: 6 })} {verified.tokenSymbol} · {d.step2.max}
              </button>
            ) : null
          }
        >
          {d.ui.from}
        </BoxLabel>
        <div className="flex items-center gap-3">
          <AmountInput value={amountInput} onChange={(e) => setAmountInput(e.target.value)} placeholder="0" disabled={!verified} aria-label={d.step2.amount} aria-invalid={!!amountError} />
          <PillSelect
            label={src.name}
            sub={verified?.tokenSymbol ?? src.nativeSymbol}
            icon={<ChainIcon chain={src.key} />}
            value={src.key}
            onSelect={(v) => {
              setSrcKey(v as ChainKey)
              setTarget(null)
              setDstChain(undefined)
            }}
            options={evmChains().map((c) => ({ value: c.key, label: c.name, sub: c.nativeSymbol, icon: <ChainIcon chain={c.key} size={28} /> }))}
            aria-label={d.header.sourceChain}
          />
        </div>
        <div className="mt-2 min-h-4 text-xs">
          {amountError ? <span className="text-danger">{amountError}</span> : planData && planData.dust > 0n ? (
            <span className="text-warn">{fmt(d.ntt.dust, { amount: formatAmount(planData.dust, planData.trim.step > 1n ? verified?.tokenDecimals ?? 18 : 0), symbol: verified?.tokenSymbol ?? '' })}</span>
          ) : null}
        </div>
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
            {planData && verified ? <span className="text-ink">{formatAmount(planData.received, planData.dst.tokenDecimals, { maxFraction: 6 })}</span> : '0'}
          </div>
          <PillSelect
            label={dstChain ? byKey(dstChain).name : d.step2.destination}
            sub={dstChain ? '' : ''}
            {...(dstChain ? { icon: <ChainIcon chain={dstChain} /> } : {})}
            value={dstChain ?? ''}
            onSelect={(v) => setDstChain(v ? (v as ChainKey) : undefined)}
            options={destinations.map((c) => ({ value: c, label: byKey(c).name, icon: <ChainIcon chain={c} size={28} /> }))}
            aria-label={d.step2.destination}
          />
        </div>
        {destinations.length === 0 && listedToken ? <p className="mt-2 text-xs text-muted">{d.ntt.noDestinations}</p> : null}
        {recipientCustom ? (
          <div className="mt-3 space-y-2 rounded-xl bg-surface-2 p-3">
            <div className="text-xs text-muted">{d.step2.otherAddress}</div>
            <Input value={recipientInput} onChange={(e) => { setRecipientInput(e.target.value); setConfirmLast6('') }} placeholder="0x…" className="mono" aria-label={d.step2.recipient} />
            {recipientError && recipientInput.trim() !== '' ? <div className="text-xs text-danger">{recipientError}</div> : null}
            {recipient ? (
              <label className="block text-xs">
                <span className="text-muted">{d.step2.confirmLast6}</span> <span className="mono text-ink">…{recipient.display.slice(-6).toLowerCase()}</span>
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
        {!report.canSend && firstFailing && !firstFailing.ok ? <div className="text-center text-xs text-muted">{d.nttGuard[firstFailing.code]}</div> : null}
      </div>
    </>
  )

  const right = (
    <Panel title={d.ui.preview} badge={<ProtocolBadge id="wormhole-ntt" />}>
      <div className="space-y-4">
        <VerificationCard verification={verification.data} loading={verification.isFetching} hasTarget={!!manager && !!dstChain} />
        {verified && planData ? (
          <>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{d.ui.section_quote}</div>
              <div className="rounded-xl bg-surface-2 px-3 py-1">
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
              </div>
            </div>
            <div>
              <ul className="grid gap-x-3 gap-y-0.5 text-xs">
                {report.results.map((r) => (
                  <li key={r.id} className={r.ok ? 'text-ok' : isNttPending(r) ? 'text-muted' : 'text-danger'}>
                    {r.ok ? '✓' : isNttPending(r) ? '○' : '✗'} {r.ok ? d.nttGuard[`ok_${r.id}` as keyof typeof d.nttGuard] ?? '' : d.nttGuard[r.code]}
                  </li>
                ))}
              </ul>
            </div>
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
        ) : null}
      </div>
    </Panel>
  )

  return <TwoColumn left={left} right={right} />
}

/** The four-part gate, in colour. This is what decides whether an approve is possible at all. */
function VerificationCard({ verification, loading, hasTarget }: { verification: ReturnType<typeof useNttVerification>['data']; loading: boolean; hasTarget: boolean }) {
  const d = useDict()
  if (!hasTarget) return <p className="text-sm text-muted">{d.ntt.previewEmpty}</p>
  if (loading || !verification) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-muted">
        <Spinner /> {d.ntt.verifying}
      </p>
    )
  }
  if (!verification.ok) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">✗ {d.ntt.rejected}</div>
        <p className="text-sm text-muted">{d.nttReject[verification.code]}</p>
        {verification.detail ? <p className="mono text-xs text-faint">{verification.detail.slice(0, 120)}</p> : null}
        <p className="text-xs text-muted">{d.ntt.noApprove}</p>
      </div>
    )
  }
  const v = verification.verified
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-xl border border-ok/30 bg-ok/10 px-3 py-2 text-sm font-bold text-ok">✓ {d.ntt.verified}</div>
      <div className="rounded-xl bg-surface-2 px-3 py-1">
        <Row label={d.ntt.manager} mono>
          <AddressView value={v.manager} href={byKey(v.chain).explorerAddrUrl + v.manager} short />
        </Row>
        <Row label={d.card.token} mono>
          <AddressView value={v.token} href={byKey(v.chain).explorerAddrUrl + v.token} short />
        </Row>
        <Row label={d.ntt.anchor}>{fmt(d.ntt.anchorValue, { side: v.anchor.side === 'source' ? byKey(v.chain).name : byKey(v.dst.chain).name, kind: v.anchor.kind })}</Row>
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
