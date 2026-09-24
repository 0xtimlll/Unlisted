'use client'
/** Header slot for a Solana source: connect (picker over the wallets the browser exposes) / account. */
import { useState } from 'react'
import { useDict } from '@/i18n'
import { Alert, Button, Spinner } from '../components/ui'
import { useSvmWallet } from './context'

export function SvmWalletButton() {
  const d = useDict()
  const w = useSvmWallet()
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)

  if (!w.ready) return <span className="h-10 w-24" aria-hidden />
  if (!w.address) {
    return (
      <>
        <button type="button" onClick={() => setOpen(true)} className="h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-page transition hover:bg-accent-hover">
          {w.connecting ? <Spinner /> : d.header.connect}
        </button>
        {open ? (
          <SvmWalletPicker
            onClose={() => setOpen(false)}
            onPick={(name) => {
              setOpen(false)
              void w.connect(name)
            }}
          />
        ) : null}
      </>
    )
  }
  return (
    <span className="relative">
      <button type="button" onClick={() => setMenu(!menu)} className="mono h-10 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink transition hover:bg-surface-2" aria-haspopup="menu">
        {w.address.slice(0, 4)}…{w.address.slice(-4)}
      </button>
      {menu ? (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-48 rounded-xl border border-line bg-surface p-1 shadow-lg">
          <div className="mono truncate px-2 py-1.5 text-xs text-muted">{w.address}</div>
          <Button variant="ghost" className="w-full justify-start" onClick={() => void navigator.clipboard?.writeText(w.address ?? '')}>
            {d.header.copyAddress}
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              setMenu(false)
              void w.disconnect()
            }}
          >
            {d.header.disconnect}
          </Button>
        </div>
      ) : null}
    </span>
  )
}

export function SvmWalletPicker({ onClose, onPick }: { onClose: () => void; onPick: (name: string) => void }) {
  const d = useDict()
  const w = useSvmWallet()
  const installed = w.wallets.filter((x) => x.installed)
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mt-8 w-full max-w-sm rounded-card border border-line bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-lg font-bold text-ink">{d.header.connectSolana}</span>
          <Button variant="ghost" onClick={onClose} aria-label={d.ui.close}>
            ✕
          </Button>
        </div>
        {w.error ? (
          <div className="mb-2">
            <Alert kind="error">{w.error}</Alert>
          </div>
        ) : null}
        {installed.length === 0 ? (
          <Alert kind="info">{d.header.noSolanaWallet}</Alert>
        ) : (
          <ul className="space-y-1">
            {installed.map((x) => (
              <li key={x.name}>
                <button type="button" onClick={() => onPick(x.name)} className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-ink hover:bg-surface-2">
                  {/* Icons come from the wallet extension itself (data: URIs). */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={x.icon} alt="" width={28} height={28} className="rounded-lg" />
                  {x.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-faint">{d.header.solanaWalletHint}</p>
      </div>
    </div>
  )
}
