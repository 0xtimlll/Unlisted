'use client'
/**
 * §5: Status / Rescue.
 *
 * Paste the hash of a transaction that sent a LayerZero message and this says what became of it, and
 * — for the four states that have one — offers the single call that would finish it.
 *
 * What this screen does NOT do is as much the point as what it does. It does not build a transfer, it
 * does not approve anything, and it never offers a button for a call it has not just executed against
 * the chain. The four actions it can submit are the four §5 names, each confined to
 * `src/protocols/lz-rescue/` by the build's own check, and each submitted with no value.
 */
import { useCallback, useMemo, useState } from 'react'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import { byKey, evmChains, isEvm, type ChainKey } from '@/core/chains'
import { isTxHash } from '@/core/decodeTx'
import { makeReadClient } from '@/core/client'
import { formatRevert } from '@/core/sim/revert'
import { scanMessageUrl } from '@/core/track'
import {
  EXPLAIN_ONLY,
  lookupRescue,
  RescueRefused,
  rescueClientFor,
  simulateRescue,
  submitRescue,
  type RescueReport,
  type RescueSimulation,
} from '@/protocols/lz-rescue'
import { fmt, useDict, type Dict } from '@/i18n'
import { Address as AddressView } from './components/Address'
import { Panel, TwoColumn } from './components/Layout'
import { Alert, Box, BoxLabel, Button, Disclosure, Input, Row, Spinner } from './components/ui'
import { ChainRow } from './components/FromTo'
import { isUserRejection, shortError } from './hooks'
import type { Stored } from './storage'

type Lookup = { reports: RescueReport[]; unserved: number; searched: ChainKey }

/** The state names, as sentences rather than identifiers. */
function stateLabel(d: Dict, kind: string): string {
  return (d.rescue.states as Record<string, string>)[kind] ?? kind
}

export function RescueApp({ stored, srcKey, setSrcKey }: { stored: Stored; srcKey: ChainKey; setSrcKey: (k: ChainKey) => void }) {
  const d = useDict()
  const { address: wallet, chainId: walletChainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()

  const [hash, setHash] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [sims, setSims] = useState<Record<number, RescueSimulation>>({})
  const [simBusy, setSimBusy] = useState<Record<number, boolean>>({})
  const [sent, setSent] = useState<Record<number, string>>({})
  const [actionError, setActionError] = useState<Record<number, string>>({})

  // Only chains whose v1/V2 endpoints this app knows: a rescue reads the destination's own state,
  // and there is nothing to read on a chain the registry does not serve.
  const chains = useMemo(() => evmChains(), [])
  const srcDef = byKey(srcKey)
  const write = useWriteContract()

  const onLook = useCallback(async () => {
    setError('')
    setLookup(null)
    setSims({})
    setSimBusy({})
    setSent({})
    setActionError({})
    if (!isTxHash(hash.trim())) {
      setError(d.rescue.badHash)
      return
    }
    if (!isEvm(srcDef)) {
      setError(d.rescue.evmOnly)
      return
    }
    setBusy(true)
    try {
      const client = makeReadClient(srcDef, stored.customRpc[srcKey])
      const receipt = await client.getTransactionReceipt({ hash: hash.trim() as `0x${string}` })
      const result = await lookupRescue(receipt.logs, srcKey, (c) => rescueClientFor(c, stored.customRpc))
      setLookup({ reports: result.reports, unserved: result.unservedDestinations.length, searched: srcKey })
    } catch (e) {
      setError(shortError(e))
    } finally {
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, srcKey, srcDef, stored.customRpc])

  /** Runs the exact call. Only a successful run puts a button on screen. */
  const onSimulate = useCallback(
    async (i: number, report: RescueReport) => {
      if (report.plan.kind !== 'action' || !wallet) return
      const dstChain = report.diagnosis.message.dstChain
      const client = dstChain ? rescueClientFor(dstChain, stored.customRpc) : undefined
      if (!client) return
      setSimBusy((b) => ({ ...b, [i]: true }))
      try {
        const sim = await simulateRescue(client, report.plan.call, wallet)
        setSims((s) => ({ ...s, [i]: sim }))
      } finally {
        setSimBusy((b) => ({ ...b, [i]: false }))
      }
    },
    [wallet, stored.customRpc],
  )

  const onSubmit = useCallback(
    async (i: number, report: RescueReport) => {
      setActionError((s) => ({ ...s, [i]: '' }))
      if (report.plan.kind !== 'action' || !wallet) return
      const dstChain = report.diagnosis.message.dstChain
      const dst = dstChain ? byKey(dstChain) : undefined
      const client = dstChain ? rescueClientFor(dstChain, stored.customRpc) : undefined
      if (!dst || !isEvm(dst) || !client) return
      try {
        const tx = await submitRescue(write, report.plan.call, { chainId: dst.chainId, from: wallet, client })
        setSent((s) => ({ ...s, [i]: tx }))
      } catch (e) {
        const message =
          e instanceof RescueRefused
            ? fmt(d.rescue.refused, { code: (d.rescue.refusedCodes as Record<string, string>)[e.code] ?? e.code, detail: e.detail })
            : isUserRejection(e)
              ? d.errors.wallet_rejected
              : shortError(e)
        setActionError((s) => ({ ...s, [i]: message }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, stored.customRpc, write],
  )

  const left = (
    <div className="space-y-4">
      <Panel title={d.rescue.title}>
        <p className="mb-3 text-xs text-muted">{d.rescue.intro}</p>
        <div className="space-y-3">
          <ChainRow label={d.rescue.srcChain} chain={byKey(srcKey)} options={chains.map((c) => c.key)} onSelect={(k: ChainKey) => setSrcKey(k)} />
          <Box>
            <BoxLabel>{d.rescue.txHash}</BoxLabel>
            <Input tone="surface" value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" spellCheck={false} className="mono" />
          </Box>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Button variant="cta" data-tone={busy ? 'default' : 'primary'} disabled={busy} onClick={() => void onLook()}>
            {busy ? (
              <>
                <Spinner /> {d.rescue.looking}
              </>
            ) : (
              d.rescue.look
            )}
          </Button>
          {isTxHash(hash.trim()) ? (
            <a href={scanMessageUrl(hash.trim())} target="_blank" rel="noopener noreferrer" className="block text-xs text-accent-ink underline">
              {d.rescue.onScan}
            </a>
          ) : null}
        </div>
      </Panel>

      <Panel title={d.rescue.cannotTitle}>
        <div className="space-y-2 text-xs text-muted">
          <p>{EXPLAIN_ONLY.forceResumeReceive}</p>
          <p>{EXPLAIN_ONLY.deadDvn}</p>
          <p>{d.rescue.noNttCcip}</p>
        </div>
      </Panel>
    </div>
  )

  const right = (
    <Panel title={d.rescue.found}>
      {!lookup ? (
        <p className="text-xs text-muted">{d.rescue.empty}</p>
      ) : lookup.reports.length === 0 ? (
        <Alert kind="info">{lookup.unserved > 0 ? fmt(d.rescue.unserved, { n: lookup.unserved }) : d.rescue.noMessages}</Alert>
      ) : (
        <div className="space-y-4">
          {lookup.reports.map((report, i) => {
            const m = report.diagnosis.message
            const dst = m.dstChain ? byKey(m.dstChain) : undefined
            const sim = sims[i]
            const canShowButton = sim?.status === 'ok'
            const needsSwitch = dst && isEvm(dst) && walletChainId !== dst.chainId
            return (
              <div key={i} className="space-y-2 rounded-card bg-surface-2 p-4">
                <div className="text-xs font-semibold text-ink">
                  {m.version === 'v1' ? d.rescue.v1 : d.rescue.v2} · {byKey(m.srcChain).name} → {dst?.name ?? d.rescue.unknownChain}
                </div>
                <Row label={d.rescue.state}>
                  <span className={report.diagnosis.state.kind === 'delivered' ? 'text-ok' : 'text-warn'}>{stateLabel(d, report.diagnosis.state.kind)}</span>
                </Row>
                {'note' in report.diagnosis.state && report.diagnosis.state.note ? (
                  <p className="text-xs text-muted">{report.diagnosis.state.note}</p>
                ) : null}
                {'reason' in report.diagnosis.state && report.diagnosis.state.reason ? (
                  <p className="text-xs text-muted">{report.diagnosis.state.reason}</p>
                ) : null}
                <Row label={d.rescue.receiver} mono>
                  {m.version === 'v1' ? (
                    <AddressView value={m.dstOApp} href={dst ? dst.explorerAddrUrl + m.dstOApp : undefined} short />
                  ) : m.dstOApp ? (
                    <AddressView value={m.dstOApp} href={dst ? dst.explorerAddrUrl + m.dstOApp : undefined} short />
                  ) : (
                    '—'
                  )}
                </Row>
                <Row label={d.rescue.nonce} mono>
                  {m.version === 'v1' ? m.nonce.toString() : m.packet.nonce.toString()}
                </Row>
                <p className="text-xs text-faint">{d.rescue.readFromChain}</p>

                {report.plan.kind === 'nothing' ? <Alert kind="info">{report.plan.reason}</Alert> : null}
                {report.plan.kind === 'refused' ? <Alert kind="warn">{report.plan.reason}</Alert> : null}
                {report.plan.kind === 'action' ? (
                  <div className="space-y-2">
                    <Alert kind="info">{report.plan.call.what}</Alert>
                    <Disclosure title={<span className="text-xs text-muted">{d.rescue.evidence}</span>} open={false} onToggle={() => {}}>
                      <div className="space-y-1 text-xs">
                        <Row label={d.rescue.payloadHash} mono>
                          <span className="break-all">{report.plan.call.evidence.payloadHash}</span>
                        </Row>
                        <p className="text-muted">{fmt(d.rescue.matchedAgainst, { where: report.plan.call.evidence.readFrom })}</p>
                        <Row label={d.rescue.callTo} mono>
                          <span className="break-all">{report.plan.call.to}</span>
                        </Row>
                        <Row label={d.rescue.callValue} mono>
                          0
                        </Row>
                        <Row label={d.rescue.calldata} mono>
                          <span className="break-all">{report.plan.call.data}</span>
                        </Row>
                      </div>
                    </Disclosure>

                    {sent[i] ? (
                      <Alert kind="ok">
                        <a
                          href={dst ? dst.explorerTxUrl + sent[i] : '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          {d.rescue.submitted}
                        </a>
                      </Alert>
                    ) : !wallet ? (
                      <p className="text-xs text-muted">{d.rescue.connect}</p>
                    ) : needsSwitch && dst && isEvm(dst) ? (
                      <Button variant="cta" disabled={switching} onClick={() => switchChain({ chainId: dst.chainId })}>
                        {fmt(d.ui.cta_switch, { chain: dst.name })}
                      </Button>
                    ) : simBusy[i] ? (
                      <p className="text-xs text-muted">{d.rescue.simulating}</p>
                    ) : !sim ? (
                      <Button variant="cta" onClick={() => void onSimulate(i, report)}>
                        {d.rescue.simulate}
                      </Button>
                    ) : sim.status === 'reverted' ? (
                      <Alert kind="error">
                        <div>{d.rescue.reverts}</div>
                        <div className="mono mt-1 text-xs opacity-80">{formatRevert(sim.revert)}</div>
                      </Alert>
                    ) : sim.status === 'unavailable' ? (
                      <Alert kind="warn">{fmt(d.rescue.simUnavailable, { reason: sim.reason })}</Alert>
                    ) : canShowButton ? (
                      <div className="space-y-1">
                        <Button variant="cta" disabled={write.isPending} onClick={() => void onSubmit(i, report)}>
                          {write.isPending ? (
                            <>
                              <Spinner /> {d.rescue.submitting}
                            </>
                          ) : (
                            fmt(d.rescue.submit, { what: report.plan.call.write })
                          )}
                        </Button>
                        {sim.gas !== undefined ? <p className="text-xs text-muted">{fmt(d.rescue.simOk, { gas: sim.gas.toString() })}</p> : null}
                      </div>
                    ) : null}
                    {actionError[i] ? <Alert kind="error">{actionError[i]}</Alert> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          {lookup.unserved > 0 ? <Alert kind="info">{fmt(d.rescue.unserved, { n: lookup.unserved })}</Alert> : null}
        </div>
      )}
    </Panel>
  )

  return <TwoColumn left={left} right={right} />
}
