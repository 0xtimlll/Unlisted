'use client'
/** In-house primitives in the Relay-like visual language (§1: no UI kits). */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

const focus = 'outline-none focus-visible:ring-2 focus-visible:ring-ink/30'

export function Button({
  variant = 'secondary',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'cta' | 'primary' | 'secondary' | 'ghost' | 'danger' | 'pill' }) {
  const v =
    variant === 'cta'
      ? 'h-11 w-full rounded-xl bg-accent text-[15px] font-bold uppercase italic tracking-wide text-page hover:bg-accent-hover disabled:bg-surface-2 disabled:text-faint disabled:opacity-100'
      : variant === 'primary'
        ? 'h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-page hover:bg-accent-hover'
        : variant === 'danger'
          ? 'h-10 rounded-xl bg-danger px-4 text-sm font-semibold text-white hover:opacity-90'
          : variant === 'ghost'
            ? 'h-9 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-ink'
            : variant === 'pill'
              ? 'h-9 rounded-full bg-surface-2 px-3 text-sm font-medium text-ink hover:bg-line'
              : 'h-10 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2'
  return <button type="button" {...p} className={`inline-flex items-center justify-center gap-2 transition disabled:cursor-not-allowed disabled:opacity-50 ${focus} ${v} ${className}`} />
}

export function Input({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      spellCheck={false}
      autoComplete="off"
      className={`h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink placeholder:text-faint ${focus} focus-visible:border-accent-ink disabled:opacity-50 ${className}`}
    />
  )
}

/** Big Relay-style amount field. */
export function AmountInput({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      inputMode="decimal"
      spellCheck={false}
      autoComplete="off"
      className={`amount tnum w-full min-w-0 bg-transparent text-[32px] font-bold leading-none text-ink outline-none disabled:opacity-60 ${className}`}
    />
  )
}

export function Select({ className = '', ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...p}
      className={`h-10 rounded-xl border border-line bg-surface px-3 text-sm text-ink ${focus} ${className}`}
    />
  )
}

/** Pill-shaped chain/token selector (a real <select> underneath, for accessibility). */
export function PillSelect({
  label,
  sub,
  dot,
  children,
  className = '',
  ...p
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; sub?: string; dot?: string }) {
  return (
    <label className={`relative inline-flex h-[50px] shrink-0 items-center gap-2.5 rounded-full bg-surface-2 pl-2.5 pr-9 text-left hover:bg-line ${className}`}>
      {dot ? <ChainDot name={dot} /> : <span className="h-8 w-8 shrink-0 rounded-full border-2 border-dashed border-line" aria-hidden />}
      <span className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold text-ink">{label}</span>
        {sub ? <span className="text-xs text-muted">{sub}</span> : null}
      </span>
      <span className="pointer-events-none absolute right-3 text-muted">›</span>
      <select {...p} className="absolute inset-0 cursor-pointer opacity-0">
        {children}
      </select>
    </label>
  )
}

/** Deterministic two-letter badge; monochrome, no remote images. */
export function ChainDot({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink font-bold text-page"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials}
    </span>
  )
}

/** The white boxes inside the bridge card ("Sell"/"Buy" style). */
export function Box({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-card border border-line bg-surface p-4 ${className}`}>{children}</section>
}

export function BoxLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between text-sm text-muted">
      <span>{children}</span>
      {right ? <span>{right}</span> : null}
    </div>
  )
}

export function Row({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <div className="shrink-0 text-muted">{label}</div>
      <div className={`min-w-0 text-right ${mono ? 'mono break-all' : 'break-words'}`}>{children}</div>
    </div>
  )
}

export function Alert({ kind, children }: { kind: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode }) {
  const c =
    kind === 'error'
      ? 'border-danger/30 bg-danger/10 text-danger'
      : kind === 'warn'
        ? 'border-warn/30 bg-warn/10 text-warn'
        : kind === 'ok'
          ? 'border-ok/30 bg-ok/10 text-ok'
          : 'border-accent-ink/30 bg-accent-soft/50 text-accent-ink'
  return <div className={`rounded-xl border px-3 py-2 text-sm ${c}`}>{children}</div>
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-middle" aria-hidden />
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-xl bg-surface-2 p-1">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={`h-8 rounded-lg px-3 text-sm font-medium transition ${value === it.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Disclosure({ title, open, onToggle, children }: { title: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div>
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between py-1 text-sm text-muted hover:text-ink">
        <span>{title}</span>
        <span className={`transition ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open ? <div className="pt-1">{children}</div> : null}
    </div>
  )
}
