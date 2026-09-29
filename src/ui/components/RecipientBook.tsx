'use client'
/**
 * The address book, as the send forms see it: a picker and one verdict line under the recipient.
 *
 * Three states, and they are not decoration — guard 3 reads the same verdict:
 *
 *   known      the address is an entry. It was checked once, by hand, against its source, so the
 *              tail is not asked for again.
 *   new        not in the book. The tail must be confirmed, exactly as before the book existed.
 *   lookalike  not in the book, but shares its first four and last four characters with an entry.
 *              That is the signature of an address swap, and it is a refusal with no override.
 *
 * One component for all four tabs so the rule cannot drift between them.
 */
import { useEffect, useRef, useState } from 'react'
import {
  entriesFor,
  lookUp,
  type AddressBookEntry,
  type AddressFamily,
  type BookVerdict,
} from '@/core/addressBook'
import { fmt, useDict } from '@/i18n'
import { useAddressBook } from '../addressBookContext'
import { AddressBookDialog } from './AddressBookDialog'
import { Button, Select } from './ui'

/**
 * The book's verdict on a recipient, or undefined when there is nothing to judge yet.
 * `address` is the recipient's display form (EIP-55 hex, or base58 on Solana).
 */
export function useBookVerdict(family: AddressFamily | undefined, address: string | undefined): BookVerdict | undefined {
  const ab = useAddressBook()
  if (!family || !address) return undefined
  return lookUp(ab.book, family, address)
}

/** The entry a successful transfer should stamp, or undefined when the recipient is not in the book. */
export function entryOfVerdict(v: BookVerdict | undefined): AddressBookEntry | undefined {
  return v?.kind === 'known' ? v.entry : undefined
}

/** True when the book alone settles the confirmation — a known address needs no tail. */
export function bookConfirms(v: BookVerdict | undefined): boolean {
  return v?.kind === 'known'
}

/** True when the book refuses this recipient outright. Guard 3 turns this into a blocked send. */
export function bookRefuses(v: BookVerdict | undefined): boolean {
  return v?.kind === 'lookalike'
}

/** Picker: fills the recipient field from the book, filtered to the route's family. */
export function BookPicker({ family, onPick }: { family: AddressFamily | undefined; onPick: (address: string) => void }) {
  const d = useDict()
  const ab = useAddressBook()
  if (!family) return null
  const entries = entriesFor(ab.book, family)
  if (entries.length === 0) return <span className="text-xs text-faint">{d.addressBook.pickNone}</span>
  return (
    <Select
      value=""
      aria-label={d.addressBook.pick}
      className="h-9 max-w-48 text-xs"
      onChange={(e) => {
        const entry = entries.find((x) => x.id === e.target.value)
        if (entry) onPick(entry.address)
      }}
    >
      <option value="">{d.addressBook.pick}</option>
      {entries.map((e) => (
        <option key={e.id} value={e.id}>
          {e.label}
        </option>
      ))}
    </Select>
  )
}

/**
 * The verdict line. Green means "already checked", amber means "check it", red means "no".
 * The red case prints the entry it resembles AND that entry's full address, because the whole
 * point is that the two differ somewhere the user did not look.
 */
export function BookVerdictNote({ verdict }: { verdict: BookVerdict | undefined }) {
  const d = useDict()
  if (!verdict) return null
  if (verdict.kind === 'known') {
    return (
      <div className="rounded-xl border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
        ✓ {fmt(d.addressBook.fromBook, { label: verdict.entry.label })}
      </div>
    )
  }
  if (verdict.kind === 'lookalike') {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
        <div className="font-semibold">⛔ {fmt(d.addressBook.lookalike, { label: verdict.entry.label })}</div>
        <div className="mono mt-1 break-all opacity-90">{fmt(d.addressBook.lookalikeDetail, { label: verdict.entry.label, saved: verdict.entry.address })}</div>
        <div className="mt-1">{d.addressBook.lookalikeBlocked}</div>
      </div>
    )
  }
  return <div className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">⚠ {d.addressBook.newAddress}</div>
}

/**
 * The strip under a submitted transfer: stamp the entry that was used, or offer to save the one
 * that was not.
 *
 * The stamp is the only write in this feature the user does not click for, and it is not a new
 * address — it records that an address they already saved was used. Nothing is ever ADDED here
 * without the button.
 *
 * `tailConfirmed` is true because the send form would not have let the transfer through otherwise,
 * so the add form does not ask for the tail a second time.
 */
export function RecipientBookAfterSend({
  family,
  address,
}: {
  family: AddressFamily | undefined
  /** The recipient that was actually sent to, or undefined when it was the wallet's own address. */
  address: string | undefined
}) {
  const d = useDict()
  const ab = useAddressBook()
  const verdict = useBookVerdict(family, address)
  const [saving, setSaving] = useState(false)
  const stamped = useRef<string | undefined>(undefined)

  const knownId = verdict?.kind === 'known' ? verdict.entry.id : undefined
  useEffect(() => {
    if (!knownId || stamped.current === knownId) return
    stamped.current = knownId
    ab.touch(knownId)
  }, [knownId, ab])

  if (!family || !address) return null
  if (verdict?.kind === 'known') {
    return <div className="mt-3 text-xs text-muted">✓ {fmt(d.addressBook.fromBook, { label: verdict.entry.label })}</div>
  }
  return (
    <div className="mt-3">
      <Button variant="ghost" className="text-xs" onClick={() => setSaving(true)}>
        {d.addressBook.saveToBook}
      </Button>
      {saving ? <AddressBookDialog onClose={() => setSaving(false)} initial={{ address, family, tailConfirmed: true }} /> : null}
    </div>
  )
}
