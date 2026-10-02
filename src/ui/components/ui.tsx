'use client'
/**
 * In-house primitives (no UI kits). The visual language: pills for every button, grey panels in
 * steps (page → card → panel → control), 150ms ease transitions and a small scale on hover.
 */
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { CaretDownIcon, CloseIcon } from './icons'

const focus = 'outline-none focus-visible:ring-2 focus-visible:ring-ink/30'

export type ButtonVariant = 'primary' | 'secondary' | 'muted' | 'ghost' | 'danger' | 'pill' | 'cta'

/**
 * Buttons. `primary` is the filled pill (ink on page), `secondary` the card-coloured pill that sits
 * on a panel, `muted` the panel-coloured pill that sits on the card, `pill` a small one of those,
 * `ghost` text only. `cta` is the big one under the form: card-coloured by default, filled when
 * `data-tone="primary"` (Approve / Send ready to go), half-transparent when disabled — a disabled
 * button is a plain fact, not a warning.
 */
export function Button({ variant = 'secondary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const v =
    variant === 'cta'
      ? 'h-14 w-full rounded-full px-4 text-sm font-semibold shadow-sm bg-surface text-ink data-[tone=primary]:bg-accent data-[tone=primary]:text-page enabled:hover:scale-[1.03] disabled:opacity-50'
      : variant === 'primary'
        ? 'h-10 rounded-full bg-accent px-5 text-sm font-semibold text-page enabled:hover:scale-105 disabled:opacity-50'
        : variant === 'danger'
          ? 'h-10 rounded-full bg-danger px-4 text-sm font-semibold text-solid-ink enabled:hover:scale-105 disabled:opacity-50'
          : variant === 'ghost'
            ? 'h-9 rounded-full px-3 text-sm text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50'
            : variant === 'pill'
              ? 'h-7 rounded-full bg-surface px-2.5 text-xs font-semibold text-ink enabled:hover:scale-105 disabled:opacity-50'
              : variant === 'muted'
                ? 'h-10 rounded-full bg-surface-2 px-5 text-sm font-semibold text-ink enabled:hover:scale-105 disabled:opacity-50'
                : 'h-10 rounded-full bg-surface px-5 text-sm font-semibold text-ink enabled:hover:scale-105 disabled:opacity-50'
  return <button type="button" {...p} className={`inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap transition disabled:cursor-not-allowed ${focus} ${v} ${className}`} />
}

/**
 * A round icon button. `md` is the header's 40px pill, `sm` the 32px one above a card. The glyph
 * is muted and brightens on hover; the pill itself grows a little, like every other pill.
 */
export function IconButton({
  label,
  size = 'md',
  tone = 'surface',
  children,
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'md' | 'sm'; tone?: 'surface' | 'muted' | 'bare' }) {
  const s = size === 'md' ? 'h-10 w-10 [&_svg]:h-6 [&_svg]:w-6' : 'h-8 w-9 [&_svg]:h-5 [&_svg]:w-5'
  const t = tone === 'bare' ? 'text-muted hover:text-ink' : tone === 'muted' ? 'bg-surface-2 text-ink shadow-sm' : 'bg-surface text-muted shadow-sm hover:text-ink'
  return (
    <button type="button" {...p} aria-label={label} title={label} className={`group inline-flex shrink-0 items-center justify-center rounded-full transition hover:scale-105 ${focus} ${s} ${t} ${className}`}>
      <span aria-hidden className="inline-flex items-center justify-center">
        {children}
      </span>
    </button>
  )
}

/** The round close button in a dialog's corner. */
export function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <IconButton label={label} tone="muted" onClick={onClick}>
      <CloseIcon className="!h-3.5 !w-3.5" />
    </IconButton>
  )
}

/**
 * Text inputs. On the card they are panel-coloured; on a panel (`tone="surface"`) card-coloured,
 * so the field always reads as a cut-out in whatever it sits on.
 */
export function Input({ className = '', tone = 'muted', ...p }: InputHTMLAttributes<HTMLInputElement> & { tone?: 'muted' | 'surface' }) {
  return (
    <input
      {...p}
      spellCheck={false}
      autoComplete="off"
      className={`h-10 w-full rounded-xl px-4 text-sm text-ink placeholder:text-muted ${tone === 'surface' ? 'bg-surface' : 'bg-surface-2'} ${focus} disabled:opacity-50 ${className}`}
    />
  )
}

/** The big amount field: 36px, no chrome, the caret is the only decoration. */
export function AmountInput({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      inputMode="decimal"
      spellCheck={false}
      autoComplete="off"
      className={`amount tnum w-full min-w-0 bg-transparent text-4xl leading-none text-ink outline-none disabled:opacity-60 ${className}`}
    />
  )
}

/** A select in a dark rounded frame, our own chevron. */
export function Select({ className = '', wrapClassName = '', ...p }: SelectHTMLAttributes<HTMLSelectElement> & { wrapClassName?: string }) {
  return (
    <span className={`relative inline-flex ${wrapClassName}`}>
      <select {...p} className={`bare h-10 w-full rounded-[14px] border border-line bg-surface py-2 pl-3 pr-9 text-sm text-ink ${focus} disabled:opacity-50 ${className}`} />
      <CaretDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink" />
    </span>
  )
}

/** Deterministic two-letter badge for a token; monochrome, no remote images. */
export function ChainDot({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink font-semibold text-page" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {initials}
    </span>
  )
}

/** The outer card: one step above the page, the form or the preview lives in it. */
export function Shell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`flex w-full flex-col gap-3 rounded-shell bg-surface p-5 shadow-sm ${className}`}>{children}</section>
}

/** A panel inside the card: one more step up. */
export function Box({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card bg-surface-2 p-4 ${className}`}>{children}</div>
}

/** The small grey heading over a panel or a group. */
export function BoxLabel({ children, right, className = '' }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={`mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-muted ${className}`}>
      <span>{children}</span>
      {right ? <span className="font-normal">{right}</span> : null}
    </div>
  )
}

/** A label/value row in a panel. */
export function Row({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <div className="shrink-0 text-muted">{label}</div>
      <div className={`min-w-0 text-right ${mono ? 'mono break-all' : 'break-words'}`}>{children}</div>
    </div>
  )
}

export function Alert({ kind, children }: { kind: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode }) {
  const c = kind === 'error' ? 'text-danger' : kind === 'warn' ? 'text-warn' : kind === 'ok' ? 'text-ok' : 'text-ink'
  return <div className={`rounded-xl bg-surface-2 px-3 py-2 text-sm ${c}`}>{children}</div>
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-middle" aria-hidden />
}

/** Keyboard hint, like the ⌘K next to a search field. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-full border-2 border-surface-2 px-2 py-1.5 text-[10px] leading-none text-muted opacity-70">{children}</kbd>
}

/** A row of pills where one is selected: the active one is a card-coloured pill, the rest are text. */
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex items-center gap-1">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={`h-8 rounded-full px-3 text-xs font-semibold transition hover:scale-105 ${focus} ${value === it.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:bg-surface hover:text-ink'}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The protocol tabs in the header. Each tab is a real link to its own page so it can be opened,
 * bookmarked and middle-clicked; in-app clicks are intercepted by the caller (no reload, the wallet
 * stays connected). The active tab is a card-coloured pill; the others are grey text that grows a
 * pill on hover.
 */
export function LinkTabs<T extends string>({ value, items, onSelect }: { value: T; items: { value: T; label: string; href: string }[]; onSelect: (v: T) => void }) {
  return (
    <nav className="flex items-center gap-1" aria-label="Protocol">
      {items.map((it) => {
        const active = it.value === value
        return (
          <a
            key={it.value}
            href={it.href}
            aria-current={active ? 'page' : undefined}
            onClick={(e) => {
              // Plain left-click stays in the app; modified clicks keep the browser's behaviour.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
              e.preventDefault()
              onSelect(it.value)
            }}
            className={`inline-flex h-10 items-center whitespace-nowrap rounded-full px-5 text-sm font-semibold transition hover:scale-105 ${focus} ${
              active ? 'bg-raised text-ink shadow-sm' : 'text-muted hover:bg-raised hover:text-ink hover:shadow-sm'
            }`}
          >
            {it.label}
          </a>
        )
      })}
    </nav>
  )
}

export function Disclosure({ title, open, onToggle, children }: { title: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className={`flex w-full items-center justify-between gap-2 rounded-lg py-1 text-sm text-muted transition hover:text-ink ${focus}`}>
        <span className="min-w-0 text-left">{title}</span>
        <CaretDownIcon className={`h-3.5 w-3.5 shrink-0 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="pt-1">{children}</div> : null}
    </div>
  )
}

/**
 * How a dialog leaves: the caller asks `dismiss()`, the exit animation plays for `ms`, then
 * `onClose` runs. Escape does the same. Reduced motion is honoured by the keyframes being cut to
 * 1ms in globals.css, so the wait is as short as the animation.
 */
export function useDismiss(onClose: () => void, ms = 160): { leaving: boolean; dismiss: () => void } {
  const [leaving, setLeaving] = useState(false)
  const closing = useRef(false)
  const dismiss = () => {
    if (closing.current) return
    closing.current = true
    setLeaving(true)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dismiss()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(onClose, ms)
    return () => window.clearTimeout(t)
  }, [leaving, onClose, ms])
  return { leaving, dismiss }
}

/**
 * A centred dialog: a heavy blur over the page, a card with a title and a round close button.
 * `width` is the card's width in px; the body scrolls when it is taller than the window.
 */
export function Modal({
  title,
  onClose,
  closeLabel,
  width = 440,
  children,
  headerExtra,
}: {
  title: ReactNode
  onClose: () => void
  closeLabel: string
  width?: number
  children: ReactNode
  headerExtra?: ReactNode
}) {
  const { leaving, dismiss } = useDismiss(onClose)
  const titleId = useId()
  return (
    <div className={`overlay fixed inset-0 z-50 flex items-center justify-center p-6 ${leaving ? 'animate-fade-out' : 'animate-fade-in'}`} onMouseDown={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        className={`scroll-quiet flex max-h-[min(720px,calc(100vh-48px))] w-full flex-col overflow-hidden rounded-dialog bg-surface shadow-lg ${leaving ? 'animate-exit' : 'animate-enter'}`}
        style={{ maxWidth: width }}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
          <h2 id={titleId} className="pt-1.5 text-xl font-semibold text-ink">{title}</h2>
          <div className="flex items-center gap-2">
            {headerExtra}
            <CloseButton onClick={dismiss} label={closeLabel} />
          </div>
        </div>
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
      </div>
    </div>
  )
}

/** A group of settings rows in a hairline frame, separated by hairlines. */
export function Group({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`divide-y divide-line rounded-2xl border border-line ${className}`}>{children}</div>
}

/** One settings row: an icon, a name with an optional note, and the control on the right. */
export function SettingRow({ icon, title, note, children, align = 'center' }: { icon?: ReactNode; title: ReactNode; note?: ReactNode; children?: ReactNode; align?: 'center' | 'start' }) {
  return (
    <div className={`flex gap-4 p-4 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <div className={`flex min-w-0 flex-1 gap-2 ${align === 'start' ? 'items-start' : 'items-center'}`}>
        {icon ? <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted [&_svg]:h-5 [&_svg]:w-5">{icon}</span> : null}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{title}</div>
          {note ? <div className="text-xs text-muted">{note}</div> : null}
        </div>
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}
