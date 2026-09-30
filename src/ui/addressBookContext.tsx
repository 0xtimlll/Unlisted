'use client'
/**
 * One address book for the whole app: the header opens it, the send forms read it.
 *
 * A context rather than props because the two consumers sit on opposite sides of the tree
 * (Providers → AppShell → Header, and Providers → the tab's form) and threading a book through
 * AppShell would make every tab depend on a shape it does not use.
 *
 * Writes go to localStorage immediately, but only ever from an explicit user action upstream:
 * there is no effect in here that saves anything on its own.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  addEntry,
  applyImport,
  AddressBookError,
  confirmImported,
  EMPTY_BOOK,
  removeEntry,
  renameEntry,
  touchEntry,
  type AddressBook,
  type BookErrorCode,
  type ImportPreview,
  type NewEntry,
} from '@/core/addressBook'
import { loadBook, saveBook } from './addressBookStore'

export type BookStatus = 'ok' | 'corrupt' | 'unavailable'

export type AddressBookApi = {
  book: AddressBook
  status: BookStatus
  /** The stored string when `status` is 'corrupt', so the user can still rescue it by hand. */
  corruptRaw: string
  /** True when the last write did not reach storage (quota, private mode). */
  unsaved: boolean
  add: (e: NewEntry) => { ok: true } | { ok: false; code: BookErrorCode }
  rename: (id: string, label: string) => { ok: true } | { ok: false; code: BookErrorCode }
  remove: (id: string) => void
  /** Records a successful transfer to this entry. Never called for an address not in the book. */
  touch: (id: string) => void
  /**
   * Clears `imported` once the user has confirmed an imported entry's tail and sent to it.
   * Only ever called after a transfer the guards already let through.
   */
  confirmImported: (id: string) => void
  applyPreview: (p: ImportPreview) => void
}

const Ctx = createContext<AddressBookApi | undefined>(undefined)

export function AddressBookProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(() => loadBook(), [])
  const [book, setBook] = useState<AddressBook>(initial.ok ? initial.book : { ...EMPTY_BOOK, entries: [] })
  const [status] = useState<BookStatus>(initial.ok ? 'ok' : initial.reason)
  const [corruptRaw] = useState<string>(!initial.ok && initial.reason === 'corrupt' ? initial.raw : '')
  const [unsaved, setUnsaved] = useState(false)

  /**
   * A corrupt store is never written over: the user still has the raw string in front of them and
   * overwriting it would be the one loss this feature cannot undo. Mutations are disabled in the
   * UI in that state; this is the second line of the same rule.
   */
  const commit = useCallback(
    (next: AddressBook) => {
      setBook(next)
      if (status === 'corrupt') return
      setUnsaved(!saveBook(next).ok)
    },
    [status],
  )

  const add = useCallback(
    (e: NewEntry) => {
      try {
        commit(addEntry(book, e, Date.now()))
        return { ok: true } as const
      } catch (err) {
        return { ok: false, code: err instanceof AddressBookError ? err.code : 'invalid_address' } as const
      }
    },
    [book, commit],
  )

  const rename = useCallback(
    (id: string, label: string) => {
      try {
        commit(renameEntry(book, id, label))
        return { ok: true } as const
      } catch (err) {
        return { ok: false, code: err instanceof AddressBookError ? err.code : 'label_empty' } as const
      }
    },
    [book, commit],
  )

  const remove = useCallback((id: string) => commit(removeEntry(book, id)), [book, commit])
  // One write: the stamp and the confirmation happen at the same moment, and committing them
  // separately would leave a window where the entry is used but still marked unconfirmed.
  const touch = useCallback((id: string) => commit(touchEntry(book, id, Date.now())), [book, commit])
  const confirm = useCallback((id: string) => commit(confirmImported(touchEntry(book, id, Date.now()), id)), [book, commit])
  const applyPreview = useCallback((p: ImportPreview) => commit(applyImport(book, p)), [book, commit])

  const api = useMemo<AddressBookApi>(
    () => ({ book, status, corruptRaw, unsaved, add, rename, remove, touch, confirmImported: confirm, applyPreview }),
    [book, status, corruptRaw, unsaved, add, rename, remove, touch, confirm, applyPreview],
  )
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function useAddressBook(): AddressBookApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAddressBook outside AddressBookProvider')
  return v
}
