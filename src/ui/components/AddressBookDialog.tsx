'use client'
/**
 * The address book panel: the whole list, and the only place entries are created.
 *
 * Two rules from core/addressBook.ts show up as UI here:
 *
 *   - Addresses are printed in full, never shortened. Everywhere else in the app an address may be
 *     abbreviated because the user is glancing at it; here they are reading it to decide, and the
 *     middle is exactly the part a look-alike changes.
 *   - Adding asks for the last six characters and does NOT print them. Same rule as the send form:
 *     the tail has to come from the source the address was copied from, or confirming it proves
 *     nothing. This is the one moment an address earns the trust every later transfer spends.
 */
import { useRef, useState } from 'react'
import {
  entriesFor,
  exportBook,
  findLookalike,
  importable,
  normalizeAddress,
  previewImport,
  type AddressBookEntry,
  type AddressFamily,
  type ImportPreview,
} from '@/core/addressBook'
import { CONFIRM_TAIL } from '@/core/recipient'
import { fmt, useDict } from '@/i18n'
import { useAddressBook } from '../addressBookContext'
import { Alert, Button, Input, Select } from './ui'

const FAMILIES: AddressFamily[] = ['evm', 'solana']

/** Does the typed tail match the address being added? Case follows the family, as everywhere. */
function tailMatches(family: AddressFamily, address: string, typed: string): boolean {
  const t = typed.trim()
  if (t.length !== CONFIRM_TAIL) return false
  const tail = address.slice(-CONFIRM_TAIL)
  return family === 'evm' ? t.toLowerCase() === tail.toLowerCase() : t === tail
}

export function AddressBookDialog({
  onClose,
  initial,
}: {
  onClose: () => void
  /**
   * Pre-fills the add form. Used by "Save to address book" after a transfer, where the tail was
   * already confirmed on the send form — `tailConfirmed` carries that so the user is not asked twice.
   */
  initial?: { address: string; family: AddressFamily; tailConfirmed: boolean } | undefined
}) {
  const d = useDict()
  const ab = useAddressBook()
  const [adding, setAdding] = useState(!!initial)
  const [preview, setPreview] = useState<ImportPreview | undefined>(undefined)
  // The look-alike rows of the preview the user has answered "yes, a different address" for. Per
  // row and per preview: a new file starts from nothing, exactly as the add form does per address.
  const [confirmedTwins, setConfirmedTwins] = useState<ReadonlySet<string>>(new Set())
  const [importError, setImportError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const readOnly = ab.status === 'corrupt'

  const doExport = () => {
    try {
      const blob = new Blob([exportBook(ab.book)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'unlisted-address-book.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      /* the browser refused the download; nothing to recover from */
    }
  }

  const onFile = async (file: File | undefined) => {
    setImportError('')
    setPreview(undefined)
    setConfirmedTwins(new Set())
    if (!file) return
    try {
      const p = previewImport(JSON.parse(await file.text()), ab.book)
      if (!p) {
        setImportError(d.addressBook.importUnreadable)
        return
      }
      setPreview(p)
    } catch {
      setImportError(d.addressBook.importUnreadable)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mt-8 w-full max-w-2xl rounded-card border border-line bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink">{d.addressBook.title}</h2>
          <Button variant="ghost" onClick={onClose} className="w-9 px-0" aria-label={d.addressBook.close}>
            ✕
          </Button>
        </div>
        <p className="mb-3 text-xs text-muted">{d.addressBook.intro}</p>

        {ab.status === 'corrupt' ? (
          <div className="mb-3">
            <Alert kind="error">{d.addressBook.corrupt}</Alert>
            <textarea readOnly value={ab.corruptRaw} className="mono mt-2 h-24 w-full rounded-xl border border-line bg-surface-2 p-2 text-xs text-muted" />
          </div>
        ) : null}
        {ab.status === 'unavailable' ? <div className="mb-3"><Alert kind="warn">{d.addressBook.unavailable}</Alert></div> : null}
        {ab.unsaved ? <div className="mb-3"><Alert kind="warn">{d.addressBook.unsaved}</Alert></div> : null}

        {adding ? (
          <AddForm
            initial={initial}
            onDone={() => {
              setAdding(false)
              if (initial) onClose()
            }}
          />
        ) : (
          <div className="mb-3 flex flex-wrap gap-2">
            <Button onClick={() => setAdding(true)} disabled={readOnly}>
              {d.addressBook.add}
            </Button>
            <Button variant="ghost" onClick={doExport}>
              {d.addressBook.export}
            </Button>
            <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={readOnly}>
              {d.addressBook.import}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                void onFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>
        )}

        {importError ? <div className="mb-3"><Alert kind="error">{importError}</Alert></div> : null}
        {preview ? (
          <div className="mb-3 rounded-xl border border-line bg-surface-2 p-3">
            <div className="mb-2 text-xs text-muted">
              {fmt(d.addressBook.importPreview, { add: preview.add.length, duplicates: preview.duplicates, invalid: preview.invalid })}
              {Object.keys(preview.twins).length > 0 ? (
                <span className="ml-1 text-danger">{fmt(d.addressBook.importHeld, { held: Object.keys(preview.twins).length })}</span>
              ) : null}
            </div>
            {preview.add.length > 0 ? (
              <ul className="mb-2 max-h-56 space-y-1 overflow-y-auto">
                {preview.add.map((e) => {
                  // A row that resembles an entry (in the book, or elsewhere in this file) is
                  // imported only with its own "different address" answer — the same question the
                  // add form asks, for the same reason. Nothing is answered on the user's behalf.
                  const twins = preview.twins[e.id]
                  const twin = twins?.[0]
                  const confirmed = confirmedTwins.has(e.id)
                  return (
                    <li key={e.id} className="text-xs">
                      <span className="text-ink">{e.label}</span> <span className="text-muted">({d.addressBook[`family_${e.family}`]})</span>
                      <div className="mono break-all text-muted">{e.address}</div>
                      {twin ? (
                        <div className="mt-0.5 rounded-lg border border-danger/40 bg-danger/10 p-2 text-danger">
                          <div className="font-semibold">⛔ {fmt(d.addressBook.lookalikeOnAdd, { label: twin.label })}</div>
                          {twins.map((t) => (
                            <div key={t.id} className="mono break-all opacity-90">
                              {fmt(d.addressBook.lookalikeSaved, { label: t.label, saved: t.address })}
                            </div>
                          ))}
                          <label className="mt-1 flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={confirmed}
                              onChange={(ev) =>
                                setConfirmedTwins((prev) => {
                                  const next = new Set(prev)
                                  if (ev.target.checked) next.add(e.id)
                                  else next.delete(e.id)
                                  return next
                                })
                              }
                            />
                            <span>{d.addressBook.lookalikeConfirmAdd}</span>
                          </label>
                          <div className="mt-1 opacity-90">{d.addressBook.importTwinHold}</div>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="mb-2 text-xs text-muted">{d.addressBook.importNothing}</div>
            )}
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  ab.applyPreview(preview, confirmedTwins)
                  setPreview(undefined)
                  setConfirmedTwins(new Set())
                }}
                disabled={importable(preview, confirmedTwins).length === 0 || readOnly}
              >
                {fmt(d.addressBook.importApply, { add: importable(preview, confirmedTwins).length })}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setPreview(undefined)
                  setConfirmedTwins(new Set())
                }}
              >
                {d.addressBook.cancel}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
          {ab.book.entries.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted">{d.addressBook.empty}</p>
          ) : (
            FAMILIES.flatMap((f) =>
              entriesFor(ab.book, f).map((e) => <EntryRow key={e.id} entry={e} readOnly={readOnly} />),
            )
          )}
        </div>
      </div>
    </div>
  )
}

function EntryRow({ entry, readOnly }: { entry: AddressBookEntry; readOnly: boolean }) {
  const d = useDict()
  const ab = useAddressBook()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(entry.label)
  const [copied, setCopied] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  const copy = () => {
    try {
      void navigator.clipboard?.writeText(entry.address).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
    } catch {
      /* clipboard unavailable */
    }
  }

  const when = (t: number | undefined) => (t === undefined ? d.addressBook.never : new Date(t).toISOString().slice(0, 10))

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex gap-2">
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="max-w-xs" autoFocus />
              <Button
                onClick={() => {
                  if (ab.rename(entry.id, draft).ok) setRenaming(false)
                }}
              >
                {d.addressBook.save}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(entry.label)
                  setRenaming(false)
                }}
              >
                {d.addressBook.cancel}
              </Button>
            </div>
          ) : (
            <div className="text-sm font-semibold text-ink">
              {entry.label} <span className="ml-1 text-xs font-normal text-muted">{d.addressBook[`family_${entry.family}`]}</span>
              {/* An imported entry is a suggestion until its first send confirms it. */}
              {entry.imported ? <span className="ml-2 text-xs font-normal text-warn">{d.addressBook.importedBadge}</span> : null}
            </div>
          )}
          {/* Full address, never shortened: the middle is what a look-alike changes. */}
          <div className="mono mt-1 break-all text-xs text-ink">{entry.address}</div>
          <div className="mt-1 text-xs text-muted">
            {d.addressBook.created} {when(entry.createdAt)} · {d.addressBook.lastUsed} {when(entry.lastUsedAt)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button variant="ghost" onClick={copy} className="text-xs">
            {copied ? d.addressBook.copied : d.addressBook.copy}
          </Button>
          <Button variant="ghost" onClick={() => setRenaming(true)} disabled={readOnly} className="text-xs">
            {d.addressBook.rename}
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDel(true)} disabled={readOnly} className="text-xs">
            {d.addressBook.remove}
          </Button>
        </div>
      </div>
      {confirmDel ? (
        <div className="mt-2 rounded-lg border border-danger/40 bg-danger/5 p-2">
          <div className="mb-2 text-xs text-danger">{fmt(d.addressBook.confirmRemove, { label: entry.label })}</div>
          <div className="flex gap-2">
            <Button onClick={() => ab.remove(entry.id)}>{d.addressBook.remove}</Button>
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>
              {d.addressBook.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function AddForm({
  initial,
  onDone,
}: {
  initial?: { address: string; family: AddressFamily; tailConfirmed: boolean } | undefined
  onDone: () => void
}) {
  const d = useDict()
  const ab = useAddressBook()
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [family, setFamily] = useState<AddressFamily>(initial?.family ?? 'evm')
  const [tail, setTail] = useState('')
  const [error, setError] = useState('')
  const [twinAccepted, setTwinAccepted] = useState(false)

  const normalized = normalizeAddress(family, address)
  // A new entry that shares both ends with an existing one. Adding it is allowed — this is the
  // user's own book — but it takes its own yes, separate from the tail, because the two say
  // different things: the tail confirms what was typed, this confirms it is not the other one.
  const twin = normalized ? findLookalike(ab.book, family, normalized) : undefined
  // The tail was already confirmed on the send form; asking again would teach the user that the
  // question is a formality. It is asked exactly once per address, and this is the other place.
  const tailOk = initial?.tailConfirmed === true || (!!normalized && tailMatches(family, normalized, tail))
  const canSave = !!normalized && label.trim() !== '' && tailOk && (!twin || twinAccepted)

  const save = () => {
    setError('')
    // The answer travels with the entry: core/addressBook.ts refuses a twin without it and records
    // it on the entry when given, so the pair is not refused at send time.
    const r = ab.add({ label, address, family, twinAccepted })
    if (r.ok) {
      onDone()
      return
    }
    setError(d.addressBook[`err_${r.code}`])
  }

  return (
    <div className="mb-3 rounded-xl border border-line bg-surface-2 p-3">
      <div className="mb-2 text-sm font-semibold text-ink">{d.addressBook.addTitle}</div>
      <div className="space-y-2">
        <label className="block text-xs">
          <span className="text-muted">{d.addressBook.family}</span>
          <Select value={family} onChange={(e) => setFamily(e.target.value as AddressFamily)} className="mt-1" disabled={!!initial}>
            {FAMILIES.map((f) => (
              <option key={f} value={f}>
                {d.addressBook[`family_${f}`]}
              </option>
            ))}
          </Select>
        </label>
        <label className="block text-xs">
          <span className="text-muted">{d.addressBook.address}</span>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} className="mono mt-1" spellCheck={false} readOnly={!!initial} />
        </label>
        <label className="block text-xs">
          <span className="text-muted">{d.addressBook.label}</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1" placeholder={d.addressBook.labelPlaceholder} autoFocus />
        </label>
        {twin ? (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
            <div className="font-semibold">⛔ {fmt(d.addressBook.lookalikeOnAdd, { label: twin.label })}</div>
            <div className="mono mt-1 break-all opacity-90">{fmt(d.addressBook.lookalikeSaved, { label: twin.label, saved: twin.address })}</div>
            <label className="mt-2 flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={twinAccepted} onChange={(e) => setTwinAccepted(e.target.checked)} />
              <span>{d.addressBook.lookalikeConfirmAdd}</span>
            </label>
          </div>
        ) : null}
        {initial?.tailConfirmed ? null : (
          <label className="block text-xs">
            {/* The expected value is deliberately absent — see the note at the top of this file. */}
            <span className="text-muted">{d.addressBook.confirmTail}</span>
            <Input
              value={tail}
              onChange={(e) => setTail(e.target.value)}
              maxLength={CONFIRM_TAIL}
              className={`mono mt-1 max-w-36 ${tailOk ? 'border-ok' : ''}`}
              spellCheck={false}
              aria-invalid={!tailOk}
            />
            {tail.length === CONFIRM_TAIL && !tailOk ? <div className="mt-1 text-danger">{d.addressBook.tailMismatch}</div> : null}
          </label>
        )}
      </div>
      {error ? <div className="mt-2"><Alert kind="error">{error}</Alert></div> : null}
      <div className="mt-3 flex gap-2">
        <Button onClick={save} disabled={!canSave}>
          {d.addressBook.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {d.addressBook.cancel}
        </Button>
      </div>
    </div>
  )
}
