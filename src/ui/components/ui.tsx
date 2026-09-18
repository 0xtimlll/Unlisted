'use client'
/** Tiny in-house primitives (§1: no UI kits). */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

const base = 'rounded-lg border px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50'

export function Button({ variant = 'secondary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const v =
    variant === 'primary'
      ? 'border-sky-600 bg-sky-600 text-white hover:bg-sky-700'
      : variant === 'danger'
        ? 'border-red-600 bg-red-600 text-white hover:bg-red-700'
        : 'border-neutral-300 bg-white hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800'
  return <button type="button" {...p} className={`${base} ${v} ${className}`} />
}

export function Input({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      spellCheck={false}
      autoComplete="off"
      className={`${base} w-full border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900 ${className}`}
    />
  )
}

export function Select({ className = '', ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={`${base} border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900 ${className}`} />
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 ${className}`}>{children}</section>
}

export function H2({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-base font-semibold">{children}</h2>
}

export function Row({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,30%)_1fr] gap-2 py-1 text-sm">
      <div className="opacity-60">{label}</div>
      <div className={mono ? 'mono break-all' : 'break-words'}>{children}</div>
    </div>
  )
}

export function Alert({ kind, children }: { kind: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode }) {
  const c =
    kind === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200'
      : kind === 'warn'
        ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
        : kind === 'ok'
          ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
          : 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200'
  return <div className={`rounded-lg border px-3 py-2 text-sm ${c}`}>{children}</div>
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent align-middle" aria-hidden />
}
