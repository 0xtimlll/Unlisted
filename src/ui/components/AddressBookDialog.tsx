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
import { CopyIcon, DownloadIcon, PencilIcon, PlusIcon, TrashIcon, UploadIcon } from './icons'
import { Alert, Button, Input, Modal, Select } from './ui'

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
    <Modal title={d.addressBook.title} onClose={onClose} closeLabel={d.addressBook.close} width={640}>
      <div className="flex flex-col gap-3">
        <p className="px-1 text-xs text-muted">{d.addressBook.intro}</p>

        {ab.status === 'corrupt' ? (
          <div>
            <Alert kind="error">{d.addressBook.corrupt}</Alert>
            <textarea readOnly value={ab.corruptRaw} className="mono mt-2 h-24 w-full rounded-xl bg-surface-2 p-3 text-xs text-muted outline-none" />
          </div>
        ) : null}
        {ab.status === 'unavailable' ? <Alert kind="warn">{d.addressBook.unavailable}</Alert> : null}
        {ab.unsaved ? <Alert kind="warn">{d.addressBook.unsaved}</Alert> : null}

        {adding ? (
          <AddForm
            initial={initial}
            onDone={() => {
              setAdding(false)
              if (initial) onClose()
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setAdding(true)} disabled={readOnly}>
              <PlusIcon className="h-4 w-4" />
              {d.addressBook.add}
            </Button>
            <Button variant="muted" onClick={doExport}>
              <DownloadIcon className="h-4 w-4" />
              {d.addressBook.export}
            </Button>
            <Button variant="muted" onClick={() => fileRef.current?.click()} disabled={readOnly}>
              <UploadIcon className="h-4 w-4" />
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

        {importError ? <Alert kind="error">{importError}</Alert> : null}
        {preview ? (
          <div className="rounded-card bg-surface-2 p-4">
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
                  const twins = Object.hasOwn(preview.twins, e.id) ? preview.twins[e.id] : undefined
                  const twin = twins?.[0]
                  const confirmed = confirmedTwins.has(e.id)
                  return (
                    <li key={e.id} className="text-xs">
                      <span className="text-ink">{e.label}</span> <span className="text-muted">({d.addressBook[`family_${e.family}`]})</span>
                      <div className="mono break-all text-muted">{e.address}</div>
                      {twin ? (
                        <div className="mt-0.5 rounded-xl bg-surface p-3 text-danger">
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

        <div className="flex flex-col gap-2">
          {ab.book.entries.length === 0 ? (
            <p className="rounded-card bg-surface-2 py-6 text-center text-xs text-muted">{d.addressBook.empty}</p>
          ) : (
            FAMILIES.flatMap((f) =>
              entriesFor(ab.book, f).map((e) => <EntryRow key={e.id} entry={e} readOnly={readOnly} />),
            )
          )}
        </div>
      </div>
    </Modal>
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
    <div className="rounded-card bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex gap-2">
              <Input tone="surface" value={draft} onChange={(e) => setDraft(e.target.value)} className="max-w-xs" autoFocus />
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
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="pill" onClick={copy} title={d.addressBook.copy} aria-label={d.addressBook.copy}>
            <CopyIcon className="h-3.5 w-3.5" />
            {copied ? d.addressBook.copied : d.addressBook.copy}
          </Button>
          <Button variant="pill" onClick={() => setRenaming(true)} disabled={readOnly} title={d.addressBook.rename} aria-label={d.addressBook.rename}>
            <PencilIcon className="h-3.5 w-3.5" />
          </Button>
          <Button variant="pill" onClick={() => setConfirmDel(true)} disabled={readOnly} title={d.addressBook.remove} aria-label={d.addressBook.remove}>
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {confirmDel ? (
        <div className="mt-3 rounded-xl bg-surface p-3">
          <div className="mb-2 text-xs text-danger">{fmt(d.addressBook.confirmRemove, { label: entry.label })}</div>
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => ab.remove(entry.id)}>
              {d.addressBook.remove}
            </Button>
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
    <div className="rounded-card bg-surface-2 p-4">
      <div className="mb-2 text-sm font-semibold text-ink">{d.addressBook.addTitle}</div>
      <div className="space-y-2">
        <label className="block text-xs">
          <span className="text-muted">{d.addressBook.family}</span>
          <Select value={family} onChange={(e) => setFamily(e.target.value as AddressFamily)} wrapClassName="mt-1 w-full" disabled={!!initial}>
            {FAMILIES.map((f) => (
              <option key={f} value={f}>
                {d.addressBook[`family_${f}`]}
              </option>
            ))}
          </Select>
        </label>
        <label className="block text-xs">
          <span className="text-muted">{d.addressBook.address}</span>
          <Input
            value={address}
            onChange={(e) => {
              setAddress(e.target.value)
              // The "different address" answer was about the address that was in the field; a
              // new value is a new question, even if it resembles the same entry.
              setTwinAccepted(false)
            }}
            tone="surface"
            className="mono mt-1"
            spellCheck={false}
            readOnly={!!initial}
          />
        </label>
        <label className="block text-xs">
          <span className="text-muted">{d.addressBook.label}</span>
          <Input tone="surface" value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1" placeholder={d.addressBook.labelPlaceholder} autoFocus />
        </label>
        {twin ? (
          <div className="rounded-xl bg-surface p-3 text-xs text-danger">
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
              tone="surface"
              value={tail}
              onChange={(e) => setTail(e.target.value)}
              maxLength={CONFIRM_TAIL}
              className={`mono mt-1 max-w-36 ${tailOk ? 'ring-1 ring-ok' : ''}`}
              spellCheck={false}
              aria-invalid={!tailOk}
            />
            {tail.length === CONFIRM_TAIL && !tailOk ? <div className="mt-1 text-danger">{d.addressBook.tailMismatch}</div> : null}
          </label>
        )}
      </div>
      {error ? <div className="mt-2 text-xs text-danger">{error}</div> : null}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={save} disabled={!canSave}>
          {d.addressBook.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {d.addressBook.cancel}
        </Button>
      </div>
    </div>
  )
}
