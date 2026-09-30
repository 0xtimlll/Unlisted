/**
 * The address book: the only list of recipients this app treats as "seen before".
 *
 * Nothing lands here on its own. There is no autosave anywhere in this file or above it — an
 * address becomes an entry when the user says so and re-reads its tail, and never as a side effect
 * of a transfer. That is what makes membership mean something later: a recipient that is in the
 * book is one a human has already checked against the source they copied it from.
 *
 * Two things are decided here and enforced by guard 3 in every tab:
 *
 *   - a recipient that exactly matches an entry needs no tail confirmation (it already had one);
 *   - a recipient that matches an entry at both ends but is NOT that entry is refused outright.
 *     That is the shape of an address-substitution attack: the swap keeps the head and tail a
 *     human glances at and changes the middle. There is no checkbox for it, because a user who
 *     could tick it is exactly the user who has already been fooled.
 *
 * Pure: no storage, no DOM, no crypto beyond id generation. ui/addressBookStore.ts persists it.
 */
import { getAddress, isAddress } from 'viem'
import { decodeBase58, isBase58 } from './svm/base58'
import { sanitizeText } from './text'

/** Bumped only when the stored shape changes in a way `parseBook` cannot absorb. */
export const ADDRESS_BOOK_VERSION = 1

/**
 * The stored name of a chain family. Deliberately NOT the `vm` tag used inside the app
 * (`'evm' | 'svm'`): this string goes into a file the user can export, read and hand-edit, and
 * "solana" is what it means to them. `familyOfVm` is the one place the two vocabularies meet.
 */
export type AddressFamily = 'evm' | 'solana'

export type AddressBookEntry = {
  id: string
  label: string
  /** EVM: EIP-55 checksummed. Solana: base58 exactly as the user gave it. */
  address: string
  family: AddressFamily
  createdAt: number
  /** Set after a transfer to this address succeeds; absent until then. */
  lastUsedAt?: number
}

export type AddressBook = { version: number; entries: AddressBookEntry[] }

export const EMPTY_BOOK: AddressBook = { version: ADDRESS_BOOK_VERSION, entries: [] }

export const MAX_ENTRIES = 200
export const MAX_LABEL = 48

export function familyOfVm(vm: 'evm' | 'svm'): AddressFamily {
  return vm === 'evm' ? 'evm' : 'solana'
}

// ------------------------------------------------------------------ addresses ----

/**
 * The canonical form of an address for this family, or undefined if it is not one.
 *
 * EVM goes to EIP-55 so the book always shows a checksummed address; Solana is kept byte-for-byte,
 * because in base58 the case IS the address and "normalising" it would change which account it is.
 */
export function normalizeAddress(family: AddressFamily, raw: string): string | undefined {
  const s = raw.trim()
  if (s === '') return undefined
  if (family === 'evm') {
    if (!isAddress(s, { strict: false })) return undefined
    return getAddress(s)
  }
  // A Solana pubkey is 32 bytes of base58. Hex is refused outright, exactly as svmRecipient does.
  if (/^0x/i.test(s) || !isBase58(s)) return undefined
  try {
    return decodeBase58(s).length === 32 ? s : undefined
  } catch {
    return undefined
  }
}

/** Same account? EVM ignores case (EIP-55 case is a checksum); Solana does not. */
export function sameBookAddress(family: AddressFamily, a: string, b: string): boolean {
  return family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * The part of an address a look-alike attack has to preserve: the characters a human actually
 * reads. `0x` is not one of them — it is on every EVM address — so it is stripped first.
 */
function significant(family: AddressFamily, address: string): string {
  const s = family === 'evm' ? address.replace(/^0x/i, '').toLowerCase() : address
  return s
}

const EDGE = 4

/** First four and last four significant characters, the pair a glance actually compares. */
export function addressEdges(family: AddressFamily, address: string): { head: string; tail: string } {
  const s = significant(family, address)
  return { head: s.slice(0, EDGE), tail: s.slice(-EDGE) }
}

// ------------------------------------------------------------------ lookups ----

/** The entry for exactly this address in this family, if the book has one. */
export function findEntry(book: AddressBook, family: AddressFamily, address: string): AddressBookEntry | undefined {
  return book.entries.find((e) => e.family === family && sameBookAddress(family, e.address, address))
}

/**
 * An entry this address is dressed up as: same first four and last four characters, different
 * account. Returns the first such entry, or undefined.
 *
 * An exact match is never a look-alike — `findEntry` covers that case and means the opposite.
 */
export function findLookalike(book: AddressBook, family: AddressFamily, address: string): AddressBookEntry | undefined {
  const mine = addressEdges(family, address)
  if (mine.head.length < EDGE || mine.tail.length < EDGE) return undefined
  return book.entries.find((e) => {
    if (e.family !== family) return false
    if (sameBookAddress(family, e.address, address)) return false
    const theirs = addressEdges(family, e.address)
    return theirs.head === mine.head && theirs.tail === mine.tail
  })
}

/** What the send form needs to know about a recipient, in one value. */
export type BookVerdict =
  | { kind: 'known'; entry: AddressBookEntry }
  | { kind: 'lookalike'; entry: AddressBookEntry }
  | { kind: 'new' }

export function lookUp(book: AddressBook, family: AddressFamily, address: string): BookVerdict {
  const exact = findEntry(book, family, address)
  if (exact) return { kind: 'known', entry: exact }
  const alike = findLookalike(book, family, address)
  return alike ? { kind: 'lookalike', entry: alike } : { kind: 'new' }
}

// ------------------------------------------------------------------ mutations ----

export type BookErrorCode = 'invalid_address' | 'duplicate' | 'label_empty' | 'full' | 'not_found'

export class AddressBookError extends Error {
  constructor(public readonly code: BookErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'AddressBookError'
  }
}

/** A random id. Falls back to a time/counter id where crypto.randomUUID is unavailable. */
let idCounter = 0
export function newId(): string {
  try {
    const c: Crypto | undefined = globalThis.crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  } catch {
    /* fall through */
  }
  idCounter += 1
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export type NewEntry = { label: string; address: string; family: AddressFamily }

/**
 * Adds an entry, or throws. The address must be valid for its family and must not already be in
 * the book — a second label for the same account would make "is this address known" ambiguous
 * exactly where it has to be a yes or a no.
 *
 * A look-alike of an existing entry is NOT refused here: the book may legitimately hold two
 * addresses that happen to share their ends, and this is a deliberate act by the user. The refusal
 * belongs at send time, where an address arrived from somewhere else.
 */
export function addEntry(book: AddressBook, e: NewEntry, now: number, id: string = newId()): AddressBook {
  const label = sanitizeText(e.label, MAX_LABEL)
  if (label === '') throw new AddressBookError('label_empty')
  const address = normalizeAddress(e.family, e.address)
  if (!address) throw new AddressBookError('invalid_address')
  if (findEntry(book, e.family, address)) throw new AddressBookError('duplicate')
  if (book.entries.length >= MAX_ENTRIES) throw new AddressBookError('full')
  return { ...book, entries: [...book.entries, { id, label, address, family: e.family, createdAt: now }] }
}

export function renameEntry(book: AddressBook, id: string, label: string): AddressBook {
  const clean = sanitizeText(label, MAX_LABEL)
  if (clean === '') throw new AddressBookError('label_empty')
  if (!book.entries.some((e) => e.id === id)) throw new AddressBookError('not_found')
  return { ...book, entries: book.entries.map((e) => (e.id === id ? { ...e, label: clean } : e)) }
}

export function removeEntry(book: AddressBook, id: string): AddressBook {
  return { ...book, entries: book.entries.filter((e) => e.id !== id) }
}

/** Records that a transfer to this entry succeeded. Absent entry: the book is returned unchanged. */
export function touchEntry(book: AddressBook, id: string, now: number): AddressBook {
  return { ...book, entries: book.entries.map((e) => (e.id === id ? { ...e, lastUsedAt: now } : e)) }
}

/** Entries usable for a route into this family, most recently used first. */
export function entriesFor(book: AddressBook, family: AddressFamily): AddressBookEntry[] {
  return book.entries
    .filter((e) => e.family === family)
    .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt))
}

// ------------------------------------------------------------------ parsing ----

const isFamily = (v: unknown): v is AddressFamily => v === 'evm' || v === 'solana'
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * One entry out of untrusted JSON, or undefined. Everything is re-derived rather than trusted:
 * the address must still parse for its family, and the label is stripped of characters that could
 * make it read as something else (core/text.ts — the same stripper token symbols go through).
 */
export function parseEntry(raw: unknown, now: number): AddressBookEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!isFamily(r['family'])) return undefined
  const family = r['family']
  if (typeof r['address'] !== 'string') return undefined
  const address = normalizeAddress(family, r['address'])
  if (!address) return undefined
  const label = sanitizeText(r['label'], MAX_LABEL)
  if (label === '') return undefined
  // The id is kept only so a re-import does not renumber a book the user already has. It is NOT
  // trusted to be unique — an imported file can repeat one, and rename/remove work by id, so a
  // collision would quietly act on two entries. `dedupeIds` below settles that.
  const id = typeof r['id'] === 'string' && r['id'].trim() !== '' ? sanitizeText(r['id'], 64) : newId()
  const createdAt = isFiniteNumber(r['createdAt']) ? r['createdAt'] : now
  const lastUsedAt = isFiniteNumber(r['lastUsedAt']) ? r['lastUsedAt'] : undefined
  return { id: id || newId(), label, address, family, createdAt, ...(lastUsedAt !== undefined ? { lastUsedAt } : {}) }
}

/** Gives a fresh id to anything whose id is already taken, so one id always means one entry. */
function dedupeIds(entries: readonly AddressBookEntry[], taken: ReadonlySet<string> = new Set()): AddressBookEntry[] {
  const seen = new Set(taken)
  return entries.map((e) => {
    if (!seen.has(e.id)) {
      seen.add(e.id)
      return e
    }
    let id = newId()
    while (seen.has(id)) id = newId()
    seen.add(id)
    return { ...e, id }
  })
}

export type ParseOutcome =
  | { ok: true; book: AddressBook }
  /** The stored value exists but is not a book. The caller must NOT overwrite it silently. */
  | { ok: false; reason: 'corrupt' }

/**
 * Parses the stored book. A missing value is an empty book; a present but unreadable one is
 * `corrupt`, which the UI reports and which must never be quietly replaced — that would destroy
 * addresses the user may still be able to recover by hand.
 */
export function parseBook(raw: unknown, now: number = Date.now()): ParseOutcome {
  if (raw === null || raw === undefined) return { ok: true, book: { ...EMPTY_BOOK, entries: [] } }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'corrupt' }
  const r = raw as Record<string, unknown>
  if (!isFiniteNumber(r['version']) || !Array.isArray(r['entries'])) return { ok: false, reason: 'corrupt' }
  const entries: AddressBookEntry[] = []
  for (const item of r['entries'] as unknown[]) {
    const e = parseEntry(item, now)
    // Drop an unreadable entry, keep the rest: one bad row must not cost the user the whole book.
    if (e && !findEntry({ version: ADDRESS_BOOK_VERSION, entries }, e.family, e.address)) entries.push(e)
    if (entries.length >= MAX_ENTRIES) break
  }
  return { ok: true, book: { version: ADDRESS_BOOK_VERSION, entries: dedupeIds(entries) } }
}

// ------------------------------------------------------------------ import / export ----

export function exportBook(book: AddressBook): string {
  return JSON.stringify({ version: ADDRESS_BOOK_VERSION, entries: book.entries }, null, 2)
}

export type ImportPreview = {
  /** Entries that parsed and are not already in the book. */
  add: AddressBookEntry[]
  /** Parsed, but the same address is already present — skipped, not overwritten. */
  duplicates: number
  /** Rows that did not parse at all. */
  invalid: number
}

/**
 * What an import WOULD do. Nothing is applied here: the screen shows this first and the user
 * decides. A file that is not a book at all yields `undefined`, which the screen reports as an
 * error rather than as "0 entries".
 */
export function previewImport(raw: unknown, book: AddressBook, now: number = Date.now()): ImportPreview | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rows = (raw as Record<string, unknown>)['entries']
  if (!Array.isArray(rows)) return undefined
  const add: AddressBookEntry[] = []
  let duplicates = 0
  let invalid = 0
  for (const item of rows as unknown[]) {
    const e = parseEntry(item, now)
    if (!e) {
      invalid += 1
      continue
    }
    const already = findEntry(book, e.family, e.address) ?? findEntry({ version: ADDRESS_BOOK_VERSION, entries: add }, e.family, e.address)
    if (already) {
      duplicates += 1
      continue
    }
    if (book.entries.length + add.length >= MAX_ENTRIES) {
      invalid += 1
      continue
    }
    add.push(e)
  }
  // Ids that clash with the book's own, or with each other, are reissued before anything is shown.
  return { add: dedupeIds(add, new Set(book.entries.map((e) => e.id))), duplicates, invalid }
}

/** Applies a preview the user accepted. */
export function applyImport(book: AddressBook, preview: ImportPreview): AddressBook {
  return { ...book, entries: [...book.entries, ...preview.add].slice(0, MAX_ENTRIES) }
}
