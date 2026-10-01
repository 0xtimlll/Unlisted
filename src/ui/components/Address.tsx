'use client'
import { useState } from 'react'
import { checksum } from '@/core/encoding'
import { CheckIcon, CopyIcon } from './icons'

const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/**
 * EIP-55 address (or a Solana base58 key), monospace, first/last chars emphasized (§7). Text only.
 */
export function Address({ value, href, short = false }: { value: string; href?: string | undefined; short?: boolean }) {
  const [copied, setCopied] = useState(false)
  let a: string
  try {
    a = BASE58_KEY.test(value) ? value : checksum(value)
  } catch {
    return <span className="mono text-danger">{String(value).slice(0, 44)}</span>
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
      <button type="button" onClick={copy} title="copy" className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted transition hover:text-ink" aria-label="copy address">
        {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
      </button>
    </span>
  )
}
