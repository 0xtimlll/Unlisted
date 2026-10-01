'use client'
/** The Solana wallet picker: the wallets the browser exposes, one row each. */
import { useDict } from '@/i18n'
import { Alert, Modal } from '../components/ui'
import { useSvmWallet } from './context'

export function SvmWalletPicker({ onClose, onPick }: { onClose: () => void; onPick: (name: string) => void }) {
  const d = useDict()
  const w = useSvmWallet()
  const installed = w.wallets.filter((x) => x.installed)
  return (
    <Modal title={d.header.connectSolana} onClose={onClose} closeLabel={d.ui.close} width={400}>
      <div className="flex flex-col gap-3">
        {w.error ? <Alert kind="error">{w.error}</Alert> : null}
        {installed.length === 0 ? (
          <Alert kind="info">{d.header.noSolanaWallet}</Alert>
        ) : (
          <ul className="flex flex-col gap-1">
            {installed.map((x) => (
              <li key={x.name}>
                <button type="button" onClick={() => onPick(x.name)} className="flex h-14 w-full items-center gap-3 rounded-2xl px-3 text-left text-sm font-semibold text-ink transition hover:bg-surface-2">
                  {/* Icons come from the wallet extension itself (data: URIs). */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={x.icon} alt="" width={32} height={32} className="rounded-lg" />
                  {x.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{d.header.solanaWalletHint}</p>
      </div>
    </Modal>
  )
}
