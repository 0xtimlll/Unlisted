'use client'
import { useState } from 'react'
import { CHAINS, type ChainKey } from '@/core/chains'
import { validateRpcUrl } from '@/core/rpcPolicy'
import { fmt, useDict } from '@/i18n'
import { clearAll, exportJson, type Stored } from '../storage'
import { Button, Input } from './ui'

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
      a.download = 'oft-bridge-ui-local-data.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mt-8 w-full max-w-md rounded-card border border-line bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink">{d.settings.title}</h2>
          <Button variant="ghost" onClick={onClose} className="w-9 px-0" aria-label={d.settings.close}>
            ✕
          </Button>
        </div>
        <p className="mb-3 text-xs text-muted">{d.settings.hint}</p>
        <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {CHAINS.map((c) => (
            <label key={c.key} className="block text-xs">
              <span className="text-muted">{fmt(d.settings.customRpc, { chain: c.name })}</span>
              <Input
                value={draft[c.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}
                placeholder={c.rpcUrls[0]}
                aria-invalid={!!errors[c.key]}
                className="mono mt-1 h-9"
              />
              {errors[c.key] ? <span className="text-danger">{errors[c.key]}</span> : null}
              {c.vm === 'svm' ? <span className="block text-muted">{d.settings.solanaHint}</span> : null}
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={save} disabled={hasErrors}>
            {d.settings.save}
          </Button>
          <span className="flex-1" />
          <Button onClick={doExport}>{d.settings.export}</Button>
          <Button
            variant="danger"
            onClick={() => {
              clearAll()
              location.reload()
            }}
          >
            {d.settings.clearAll}
          </Button>
        </div>
      </div>
    </div>
  )
}
