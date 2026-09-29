/**
 * localStorage for the address book (core/addressBook.ts).
 *
 * Its own key, separate from `oft-bridge-ui:v1`, because it carries its own `version` and its own
 * failure mode: settings that fail to parse can be rebuilt from defaults, addresses cannot. So a
 * stored value that does not parse is reported as `corrupt` and the screen refuses to write over
 * it. The user can still export the raw string and recover what is in it by hand; a silent reset
 * would take that away.
 */
import { parseBook, type AddressBook } from '@/core/addressBook'

export const ADDRESS_BOOK_KEY = 'oft-bridge-ui:address-book:v1'

export type BookLoad =
  | { ok: true; book: AddressBook }
  /** Something is stored under the key and it is not a book. Never overwrite without asking. */
  | { ok: false; reason: 'corrupt'; raw: string }
  /** No localStorage at all (private mode, blocked storage). The book is read-only and empty. */
  | { ok: false; reason: 'unavailable' }

export function loadBook(): BookLoad {
  let stored: string | null
  try {
    stored = globalThis.localStorage?.getItem(ADDRESS_BOOK_KEY) ?? null
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
  if (stored === null) return parseBook(null) as { ok: true; book: AddressBook }
  let json: unknown
  try {
    json = JSON.parse(stored)
  } catch {
    return { ok: false, reason: 'corrupt', raw: stored }
  }
  const parsed = parseBook(json)
  return parsed.ok ? parsed : { ok: false, reason: 'corrupt', raw: stored }
}

export type BookSave = { ok: true } | { ok: false; reason: 'unavailable' }

export function saveBook(book: AddressBook): BookSave {
  try {
    globalThis.localStorage?.setItem(ADDRESS_BOOK_KEY, JSON.stringify(book))
    return { ok: true }
  } catch {
    // Quota or private mode. The caller keeps the in-memory book and says it did not persist.
    return { ok: false, reason: 'unavailable' }
  }
}

/** Removes the stored book. Only ever called from an explicit, confirmed user action. */
export function clearBook(): void {
  try {
    globalThis.localStorage?.removeItem(ADDRESS_BOOK_KEY)
  } catch {
    /* nothing to do */
  }
}
