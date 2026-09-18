'use client'
import { useState } from 'react'
import { checksum } from '@/core/encoding'

/**
 * EIP-55 address, monospace, first/last 6 chars emphasized (§7). Text only.
 */
export function Address({ value, href, short = false }: { value: string; href?: string | undefined; short?: boolean }) {
  const [copied, setCopied] = useState(false)
  let a: string
  try {
    a = checksum(value)
  } catch {
    return <span className="mono text-red-600 dark:text-red-400">{String(value).slice(0, 42)}</span>
  }
  const head = a.slice(0, 8)
  const mid = a.slice(8, -6)
  const tail = a.slice(-6)
  const body = (
    <span className="mono break-all">
      <span className="font-semibold">{head}</span>
      <span className="opacity-60">{short ? '…' : mid}</span>
      <span className="font-semibold">{tail}</span>
    </span>
  )
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(a).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <span className="inline-flex items-center gap-1">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">
          {body}
        </a>
      ) : (
        body
      )}
      <button type="button" onClick={copy} title="copy" className="rounded px-1 text-xs opacity-60 hover:opacity-100" aria-label="copy address">
        {copied ? '✓' : '⧉'}
      </button>
    </span>
  )
}
