'use client'
/**
 * RPC settings: the personal RPCs, one row per network that has one, and a row to add another.
 *
 * A personal RPC goes first in the queue of the site's /rpc relay (core/rpcProxy.ts). Before it is
 * saved it is checked through that relay — does it answer for this network? — and the row says
 * so; the relay checks again every time it is used. Reads reach the RPC only through the relay;
 * the Solana one is the exception, because the Solana send path talks to its RPC from the page
 * (core/svm/urls.ts), so that host has to be one the page may reach (core/rpcPolicy.ts).
 */
import { useState } from 'react'
import { byKey, CHAINS, type ChainKey } from '@/core/chains'
import { validateRpcUrl } from '@/core/rpcPolicy'
import { fmt, useDict } from '@/i18n'
import { checkCustomRpc } from '../rpcCheck'
import { clearAll, exportJson, type Stored } from '../storage'
import { ChainIcon } from './ChainIcon'
import { DownloadIcon, TrashIcon } from './icons'
import { Button, Group, Input, Modal, Select, SettingRow } from './ui'

type RowState = { value: string; check: 'idle' | 'checking' | 'ok' | 'failed'; reason?: string }

export function SettingsDialog({ stored, onSave, onClose }: { stored: Stored; onSave: (rpc: Partial<Record<ChainKey, string>>) => void; onClose: () => void }) {
  const d = useDict()
  const [rows, setRows] = useState<Partial<Record<ChainKey, RowState>>>(() =>
    Object.fromEntries(Object.entries(stored.customRpc).map(([k, v]) => [k, { value: v ?? '', check: 'ok' as const }])),
  )
  const [addChain, setAddChain] = useState<ChainKey>(CHAINS.find((c) => !(c.key in stored.customRpc))?.key ?? CHAINS[0]!.key)
  const [addUrl, setAddUrl] = useState('')
  const [addState, setAddState] = useState<{ check: 'idle' | 'checking' | 'failed'; reason?: string }>({ check: 'idle' })

  const syntax = (key: ChainKey, value: string): string | undefined => {
    const v = value.trim()
    if (v === '') return undefined
    const r = validateRpcUrl(v, byKey(key).vm)
    return r.ok ? undefined : d.settings[`invalid_${r.reason}`]
  }

  const setRow = (key: ChainKey, patch: Partial<RowState>) => setRows((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { value: '', check: 'idle' }), ...patch } }))

  const check = async (key: ChainKey, value: string): Promise<boolean> => {
    const v = value.trim()
    const r = validateRpcUrl(v, byKey(key).vm)
    if (!r.ok) {
      setRow(key, { check: 'failed', reason: d.settings[`invalid_${r.reason}`] })
      return false
    }
    setRow(key, { check: 'checking' })
    const res = await checkCustomRpc(byKey(key), r.url)
    setRow(key, res.ok ? { check: 'ok', value: r.url } : { check: 'failed', reason: res.reason })
    return res.ok
  }

  const add = async () => {
    const v = addUrl.trim()
    const r = validateRpcUrl(v, byKey(addChain).vm)
    if (!r.ok) {
      setAddState({ check: 'failed', reason: d.settings[`invalid_${r.reason}`] })
      return
    }
    setAddState({ check: 'checking' })
    const res = await checkCustomRpc(byKey(addChain), r.url)
    if (!res.ok) {
      setAddState({ check: 'failed', reason: res.reason })
      return
    }
    setRow(addChain, { value: r.url, check: 'ok' })
    setAddUrl('')
    setAddState({ check: 'idle' })
    const next = CHAINS.find((c) => c.key !== addChain && !(c.key in rows))
    if (next) setAddChain(next.key)
  }

  const entries = Object.entries(rows).filter(([, r]) => r && r.value.trim() !== '') as [ChainKey, RowState][]
  const order = new Map(CHAINS.map((c, i) => [c.key, i]))
  entries.sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
  const busy = entries.some(([, r]) => r.check === 'checking') || addState.check === 'checking'
  const blocked = busy || entries.some(([k, r]) => r.check === 'failed' || syntax(k, r.value) !== undefined)

  const save = async () => {
    // Anything edited since its last check is checked now; a failure keeps the dialog open.
    for (const [key, r] of entries) {
      if (r.check === 'ok') continue
      if (!(await check(key, r.value))) return
    }
    const out: Partial<Record<ChainKey, string>> = {}
    for (const [key, r] of entries) {
      const v = validateRpcUrl(r.value, byKey(key).vm)
      if (v.ok) out[key] = v.url
    }
    onSave(out)
  }

  const doExport = () => {
    try {
      const blob = new Blob([exportJson()], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'unlisted-local-data.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
  }

  const status = (key: ChainKey, r: RowState) => {
    const s = syntax(key, r.value)
    if (s) return <span className="text-danger">{s}</span>
    if (r.check === 'checking') return <span>{d.settings.checking}</span>
    if (r.check === 'failed') return <span className="text-danger">{r.reason}</span>
    if (r.check === 'ok') return <span className="text-ok">{fmt(d.settings.checked, { chain: byKey(key).name })}</span>
    return <span>{d.settings.unchecked}</span>
  }

  return (
    <Modal title={d.settings.title} onClose={onClose} closeLabel={d.settings.close} width={600}>
      <div className="flex flex-col gap-4">
        {/* A custom RPC answers every read this screen makes; say so before the fields, not after. */}
        <div className="rounded-2xl bg-surface-2 p-4 text-xs text-warn">{d.settings.rpcTrust}</div>
        <div>
          <div className="mb-2 px-1 text-xs font-semibold text-muted">{d.settings.rpcGroup}</div>
          <Group>
            {entries.length === 0 ? <div className="p-4 text-xs text-muted">{d.settings.noCustom}</div> : null}
            {entries.map(([key, r]) => {
              const c = byKey(key)
              return (
                <SettingRow key={key} icon={<ChainIcon chain={key} size={24} />} title={c.name} note={status(key, r)} align="start">
                  <div className="flex flex-col items-end gap-1">
                    <Input
                      value={r.value}
                      onChange={(e) => setRow(key, { value: e.target.value, check: 'idle' })}
                      onBlur={() => {
                        if (r.check === 'idle' && r.value.trim() !== '' && !syntax(key, r.value)) void check(key, r.value)
                      }}
                      placeholder={c.rpcUrls[0]}
                      aria-label={fmt(d.settings.customRpc, { chain: c.name })}
                      aria-invalid={r.check === 'failed' || !!syntax(key, r.value)}
                      className="mono w-[260px] text-xs"
                    />
                    <div className="flex gap-1">
                      <Button variant="pill" className="h-6" onClick={() => void check(key, r.value)} disabled={r.check === 'checking' || !!syntax(key, r.value)}>
                        {d.settings.check}
                      </Button>
                      <Button variant="pill" className="h-6" onClick={() => setRows((prev) => ({ ...prev, [key]: { value: '', check: 'idle' } }))}>
                        {d.settings.remove}
                      </Button>
                    </div>
                  </div>
                </SettingRow>
              )
            })}
            <SettingRow
              icon={<ChainIcon chain={addChain} size={24} />}
              title={d.settings.addRpc}
              note={addState.check === 'checking' ? d.settings.checking : addState.check === 'failed' ? <span className="text-danger">{addState.reason}</span> : byKey(addChain).vm === 'svm' ? d.settings.solanaHint : d.settings.hint}
              align="start"
            >
              <div className="flex flex-col items-end gap-1">
                <Select value={addChain} onChange={(e) => setAddChain(e.target.value as ChainKey)} aria-label={d.settings.chain} wrapClassName="w-[260px]">
                  {CHAINS.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </Select>
                <Input
                  value={addUrl}
                  onChange={(e) => {
                    setAddUrl(e.target.value)
                    setAddState({ check: 'idle' })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void add()
                  }}
                  placeholder={byKey(addChain).rpcUrls[0]}
                  aria-label={fmt(d.settings.customRpc, { chain: byKey(addChain).name })}
                  aria-invalid={addState.check === 'failed'}
                  className="mono w-[260px] text-xs"
                />
                <Button variant="pill" className="h-6" onClick={() => void add()} disabled={addUrl.trim() === '' || addState.check === 'checking'}>
                  {d.settings.checkAndAdd}
                </Button>
              </div>
            </SettingRow>
          </Group>
        </div>
        <div>
          <div className="mb-2 px-1 text-xs font-semibold text-muted">{d.settings.dataGroup}</div>
          <Group>
            <SettingRow icon={<DownloadIcon />} title={d.settings.export} note={d.settings.exportNote}>
              <Button variant="muted" className="h-9 px-4" onClick={doExport}>
                {d.settings.exportAction}
              </Button>
            </SettingRow>
            <SettingRow icon={<TrashIcon />} title={d.settings.clearAll} note={d.settings.clearAllNote}>
              <Button
                variant="danger"
                className="h-9 px-4"
                onClick={() => {
                  clearAll()
                  location.reload()
                }}
              >
                {d.settings.clearAllAction}
              </Button>
            </SettingRow>
          </Group>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => void save()} disabled={blocked}>
            {busy ? d.settings.checking : d.settings.save}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
