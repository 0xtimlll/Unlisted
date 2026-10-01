'use client'
import { useState } from 'react'
import { CHAINS, type ChainKey } from '@/core/chains'
import { validateRpcUrl } from '@/core/rpcPolicy'
import { fmt, useDict } from '@/i18n'
import { clearAll, exportJson, type Stored } from '../storage'
import { ChainIcon } from './ChainIcon'
import { DownloadIcon, TrashIcon } from './icons'
import { Button, Group, Input, Modal, SettingRow } from './ui'

export function SettingsDialog({ stored, onSave, onClose }: { stored: Stored; onSave: (rpc: Partial<Record<ChainKey, string>>) => void; onClose: () => void }) {
  const d = useDict()
  const [draft, setDraft] = useState<Partial<Record<ChainKey, string>>>({ ...stored.customRpc })

  const errors: Partial<Record<ChainKey, string>> = {}
  for (const c of CHAINS) {
    const v = draft[c.key]?.trim() ?? ''
    if (v === '') continue
    const r = validateRpcUrl(v)
    if (!r.ok) errors[c.key] = d.settings[`invalid_${r.reason}`]
  }
  const hasErrors = Object.keys(errors).length > 0

  const save = () => {
    const out: Partial<Record<ChainKey, string>> = {}
    for (const c of CHAINS) {
      const v = draft[c.key]?.trim() ?? ''
      if (v === '') continue
      const r = validateRpcUrl(v)
      if (r.ok) out[c.key] = r.url
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

  return (
    <Modal title={d.settings.title} onClose={onClose} closeLabel={d.settings.close} width={560}>
      <div className="flex flex-col gap-4">
        {/* A custom RPC answers every read this screen makes; say so before the fields, not after. */}
        <div className="rounded-2xl bg-surface-2 p-4 text-xs text-warn">{d.settings.rpcTrust}</div>
        <div>
          <div className="mb-2 px-1 text-xs font-semibold text-muted">{d.settings.rpcGroup}</div>
          <Group>
            {CHAINS.map((c) => (
              <SettingRow
                key={c.key}
                icon={<ChainIcon chain={c.key} size={24} />}
                title={c.name}
                note={
                  errors[c.key] ? <span className="text-danger">{errors[c.key]}</span> : c.vm === 'svm' ? d.settings.solanaHint : undefined
                }
                align={c.vm === 'svm' ? 'start' : 'center'}
              >
                <Input
                  value={draft[c.key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}
                  placeholder={c.rpcUrls[0]}
                  aria-label={fmt(d.settings.customRpc, { chain: c.name })}
                  aria-invalid={!!errors[c.key]}
                  className="mono w-[236px] text-xs"
                />
              </SettingRow>
            ))}
          </Group>
          <p className="mt-2 px-1 text-xs text-muted">{d.settings.hint}</p>
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
          <Button variant="primary" onClick={save} disabled={hasErrors}>
            {d.settings.save}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
