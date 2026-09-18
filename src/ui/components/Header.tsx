'use client'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { CHAINS, type ChainKey } from '@/core/chains'
import { LANGS, useDict, useLang } from '@/i18n'
import { Button, Select } from './ui'

export const CANONICAL_DOMAIN = process.env['NEXT_PUBLIC_CANONICAL_DOMAIN'] ?? 'localhost'

export function Header({ srcKey, onSrcChange, onSettings }: { srcKey: ChainKey; onSrcChange: (k: ChainKey) => void; onSettings: () => void }) {
  const d = useDict()
  const { lang, setLang } = useLang()
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{d.app.title}</h1>
          <p className="text-xs opacity-60">
            {d.app.domainNotice} <span className="mono font-semibold">{CANONICAL_DOMAIN}</span>
          </p>
        </div>
        <ConnectButton chainStatus="none" showBalance={false} accountStatus="address" label={d.header.connect} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="opacity-60">{d.header.sourceChain}</span>
          <Select value={srcKey} onChange={(e) => onSrcChange(e.target.value as ChainKey)} aria-label={d.header.sourceChain}>
            {CHAINS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700" role="group" aria-label={d.header.language}>
            {LANGS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`px-2 py-1 text-xs uppercase ${lang === l ? 'bg-sky-600 text-white' : 'opacity-70 hover:opacity-100'}`}
              >
                {l}
              </button>
            ))}
          </div>
          <Button onClick={onSettings} className="text-xs">
            {d.header.settings}
          </Button>
        </div>
      </div>
    </header>
  )
}
