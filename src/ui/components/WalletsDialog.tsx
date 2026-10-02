'use client'
/**
 * The wallets sheet: slides in from the right. Two rows, one per VM — connect, or the connected
 * address with a button to disconnect. The EVM row opens the wallet chooser (RainbowKit); the
 * Solana row opens the wallet picker, loading the Solana stack first if it is not loaded yet.
 * Both wallets can stay connected; the form uses the one its source chain needs.
 */
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import type { ReactNode } from 'react'
import { useDict } from '@/i18n'
import { useSvmWallet } from '../svm/context'
import { ChainIcon } from './ChainIcon'
import { CloseIcon } from './icons'
import { Button, CloseButton, useDismiss } from './ui'

function Row({ icon, title, tag, hint, connected, onConnect, onDisconnect, connectLabel, disconnectLabel }: {
  icon: ReactNode
  title: string
  tag: string
  hint: string
  /** The connected address, when there is one. */
  connected: string | undefined
  onConnect: () => void
  onDisconnect: () => void
  connectLabel: string
  disconnectLabel: string
}) {
  const d = useDict()
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl bg-surface-2 p-4">
      <div className="flex min-w-0 gap-2">
        <span className="relative h-8 w-8 shrink-0">{icon}</span>
        <div className="grid min-w-0 gap-0.5">
          <h3 className="truncate text-base font-semibold leading-none text-ink">
            {connected ? <span className="tnum">{connected}</span> : title} <span className="ml-1 text-xs font-semibold text-muted">{tag}</span>
          </h3>
          <p className="text-xs text-muted">{connected ? d.wallets.connected : hint}</p>
        </div>
      </div>
      {connected ? (
        <button type="button" onClick={onDisconnect} aria-label={disconnectLabel} title={disconnectLabel} className="inline-flex h-8 w-[34px] shrink-0 items-center justify-center rounded-full bg-surface text-muted transition hover:scale-105 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink/30">
          <CloseIcon className="h-2.5 w-2.5" />
        </button>
      ) : (
        <Button variant="primary" className="h-9 px-3" onClick={onConnect}>
          {connectLabel}
        </Button>
      )}
    </div>
  )
}

export function WalletsDialog({
  onClose,
  onConnectSvm,
}: {
  onClose: () => void
  /** Opens the Solana wallet picker, loading the stack first if it is not loaded yet. */
  onConnectSvm: () => void
}) {
  const d = useDict()
  const { leaving, dismiss } = useDismiss(onClose, 400)
  const { address } = useAccount()
  const { disconnect } = useDisconnect()
  const { openConnectModal } = useConnectModal()
  const svm = useSvmWallet()

  const short = (a: string, n: number) => `${a.slice(0, n)}…${a.slice(-4)}`

  return (
    <div className={`overlay-light fixed inset-0 z-50 ${leaving ? 'animate-scrim-out' : 'animate-scrim-in'}`} onMouseDown={dismiss}>
      <div role="dialog" aria-modal="true" aria-label={d.wallets.title} onMouseDown={(e) => e.stopPropagation()} className={`fixed right-0 top-0 w-full max-w-[480px] p-5 outline-none ${leaving ? 'animate-sheet-out' : 'animate-sheet-in'}`}>
        <div className="flex flex-col gap-4 rounded-dialog bg-surface p-6 shadow-lg">
          <div className="flex items-center justify-between gap-4">
            <h2 className="px-2 text-lg font-semibold text-ink">{d.wallets.title}</h2>
            <CloseButton onClick={dismiss} label={d.ui.close} />
          </div>
          <Row
            icon={<ChainIcon chain="ethereum" size={32} />}
            title={d.wallets.evmTitle}
            tag={d.wallets.evmTag}
            hint={d.wallets.evmHint}
            connected={address ? short(address, 6) : undefined}
            onConnect={() => openConnectModal?.()}
            onDisconnect={() => disconnect()}
            connectLabel={d.header.connect}
            disconnectLabel={d.header.disconnect}
          />
          <Row
            icon={<ChainIcon chain="solana" size={32} />}
            title={d.wallets.svmTitle}
            tag={d.wallets.svmTag}
            hint={d.wallets.svmHint}
            connected={svm.address ? short(svm.address, 4) : undefined}
            onConnect={() => {
              dismiss()
              onConnectSvm()
            }}
            onDisconnect={() => void svm.disconnect()}
            connectLabel={d.header.connect}
            disconnectLabel={d.header.disconnect}
          />
        </div>
      </div>
    </div>
  )
}
