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
 *   - being IN the book does not lift that refusal by itself. Two entries that share their ends
 *     are allowed only when the user said, about that specific pair, "yes, this is a different
 *     address" — on the add form or row by row in an import preview — and the answer is recorded
 *     on the entry (`distinctFrom`). A twin that arrived any other way is still refused.
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
  /**
   * Came in through `previewImport` and has not been used since.
   *
   * An entry the user typed earned its place by having its tail confirmed. An imported one did
   * not: the file could have come from anywhere, and a row in it can carry an attacker's address
   * under a label the user trusts. So an imported entry is NOT a known address — it is a
   * suggestion, and it has to be confirmed once, at the moment it is first used to send.
   *
   * `confirmImported` clears the flag after that transfer, and from then on it is an ordinary
   * entry. The flag is absent rather than false on entries that never needed it.
   */
  imported?: boolean
  /**
   * Addresses this entry was explicitly confirmed to be DIFFERENT from, by the user, at the moment
   * it went in: the twins it shares its first and last four characters with.
   *
   * Two entries that share their ends are a look-alike pair, and a look-alike is refused at send
   * time (`lookUp`). The refusal is lifted for a pair only by this record — one of the two saying
   * "yes, this is a different address" about the other. An entry that reached the book by any
   * other path (an import applied without that answer, a hand-edited store) has no such record,
   * and stays refused: its presence in the book proves nothing about who put it there.
   *
   * Addresses, not ids: ids are reissued on import, addresses are the thing being compared.
   * Absent when there was nothing to confirm against.
   */
  distinctFrom?: string[]
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
  return twinsOf(book.entries, family, address)[0]
}

/** Every entry this address is dressed up as (see `findLookalike`), in book order. */
export function twinsOf(entries: readonly AddressBookEntry[], family: AddressFamily, address: string): AddressBookEntry[] {
  const mine = addressEdges(family, address)
  if (mine.head.length < EDGE || mine.tail.length < EDGE) return []
  return entries.filter((e) => {
    if (e.family !== family) return false
    if (sameBookAddress(family, e.address, address)) return false
    const theirs = addressEdges(family, e.address)
    return theirs.head === mine.head && theirs.tail === mine.tail
  })
}

/** Did the user, when `e` went in, say it is a different address from `other`? */
function vouchedDistinct(e: AddressBookEntry, other: AddressBookEntry): boolean {
  return (e.distinctFrom ?? []).some((a) => sameBookAddress(e.family, a, other.address))
}

/**
 * The twin of `entry` inside the book that nobody has confirmed it is different from, if any.
 *
 * A pair sharing its ends is fine when either member was added with an explicit "this is a
 * different address" about the other. Without that, the pair is exactly what an address swap
 * leaves behind, and the entry that arrived is refused at send time as if it were not in the book.
 */
export function unvouchedTwin(book: AddressBook, entry: AddressBookEntry): AddressBookEntry | undefined {
  return twinsOf(book.entries, entry.family, entry.address).find((t) => !vouchedDistinct(entry, t) && !vouchedDistinct(t, entry))
}

/** What the send form needs to know about a recipient, in one value. */
export type BookVerdict =
  /** In the book and vouched for: no tail needed. */
  | { kind: 'known'; entry: AddressBookEntry }
  /** In the book, but it arrived by import and has never been confirmed. Tail required. */
  | { kind: 'imported'; entry: AddressBookEntry }
  /**
   * Not in the book but dressed up as an entry — or in the book next to an entry it resembles,
   * with nobody having confirmed the two are different. `entry` is the one it resembles.
   */
  | { kind: 'lookalike'; entry: AddressBookEntry }
  | { kind: 'new' }

export function lookUp(book: AddressBook, family: AddressFamily, address: string): BookVerdict {
  const exact = findEntry(book, family, address)
  if (exact) {
    // Being in the book is not enough on its own: a twin that got in without the explicit
    // "different address" answer (an import, a hand-edited store) is still the shape of a swap.
    const twin = unvouchedTwin(book, exact)
    if (twin) return { kind: 'lookalike', entry: twin }
    return exact.imported ? { kind: 'imported', entry: exact } : { kind: 'known', entry: exact }
  }
  const alike = findLookalike(book, family, address)
  return alike ? { kind: 'lookalike', entry: alike } : { kind: 'new' }
}

/**
 * Does the book alone settle the tail confirmation?
 *
 * Only `known` does. `imported` deliberately does not: that entry was suggested by a file, not
 * vouched for by this user, and the whole point of the flag is that it still owes one confirmation.
 */
export function bookConfirms(v: BookVerdict | undefined): boolean {
  return v?.kind === 'known'
}

/** Does the book refuse this recipient outright? Guard 3 turns this into a blocked send. */
export function bookRefuses(v: BookVerdict | undefined): boolean {
  return v?.kind === 'lookalike'
}

/** The entry a completed transfer should stamp — already trusted, or trusted as of this send. */
export function entryToStamp(v: BookVerdict | undefined): AddressBookEntry | undefined {
  return v?.kind === 'known' || v?.kind === 'imported' ? v.entry : undefined
}

// ------------------------------------------------------------------ mutations ----

export type BookErrorCode = 'invalid_address' | 'duplicate' | 'label_empty' | 'full' | 'not_found' | 'lookalike_unconfirmed'

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

export type NewEntry = {
  label: string
  address: string
  family: AddressFamily
  /**
   * The user's explicit "yes, this is a different address" about the entries this one resembles.
   * Required when there is such an entry; meaningless, and ignored, when there is none.
   */
  twinAccepted?: boolean
}

/**
 * Adds an entry, or throws. The address must be valid for its family and must not already be in
 * the book — a second label for the same account would make "is this address known" ambiguous
 * exactly where it has to be a yes or a no.
 *
 * A look-alike of an existing entry may be added — the book may legitimately hold two addresses
 * that happen to share their ends — but only with `twinAccepted`: the form asks that question
 * separately from the tail, and the answer is recorded on the entry (`distinctFrom`) so that the
 * pair is not refused at send time. Without it the add is refused, because an entry that shares
 * its ends with a saved one and was never confirmed different is what an address swap looks like.
 */
export function addEntry(book: AddressBook, e: NewEntry, now: number, id: string = newId()): AddressBook {
  const label = sanitizeText(e.label, MAX_LABEL)
  if (label === '') throw new AddressBookError('label_empty')
  const address = normalizeAddress(e.family, e.address)
  if (!address) throw new AddressBookError('invalid_address')
  if (findEntry(book, e.family, address)) throw new AddressBookError('duplicate')
  if (book.entries.length >= MAX_ENTRIES) throw new AddressBookError('full')
  const twins = twinsOf(book.entries, e.family, address)
  if (twins.length > 0 && e.twinAccepted !== true) throw new AddressBookError('lookalike_unconfirmed')
  const entry: AddressBookEntry = { id, label, address, family: e.family, createdAt: now }
  if (twins.length > 0) entry.distinctFrom = twins.map((t) => t.address)
  return { ...book, entries: [...book.entries, entry] }
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

/**
 * Clears `imported` after the user has confirmed the tail and sent to it once. From here on the
 * entry is indistinguishable from one they typed themselves, because it has now earned the same
 * thing: a human read its last six characters against the source.
 */
export function confirmImported(book: AddressBook, id: string): AddressBook {
  return {
    ...book,
    entries: book.entries.map((e) => {
      if (e.id !== id || !e.imported) return e
      // Removed rather than set to false: absent is the shape every entry the user typed has, so
      // the two cannot drift apart. Copying first keeps any future field intact.
      const confirmed = { ...e }
      delete confirmed.imported
      return confirmed
    }),
  }
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
  // Kept so the user's own answer survives a reload. `previewImport` strips it again: in a file
  // this field is the file's claim, not the user's, and a claim that lifts a refusal is worth nothing.
  const distinctFrom = Array.isArray(r['distinctFrom'])
    ? (r['distinctFrom'] as unknown[]).flatMap((a) => {
        const n = typeof a === 'string' ? normalizeAddress(family, a) : undefined
        return n ? [n] : []
      })
    : []
  return {
    id: id || newId(),
    label,
    address,
    family,
    createdAt,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    // Survives a reload: an entry awaiting its first confirmation must not become trusted just
    // because the page was refreshed. A file that sets it itself only ever adds caution.
    ...(r['imported'] === true ? { imported: true as const } : {}),
    ...(distinctFrom.length > 0 ? { distinctFrom } : {}),
  }
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
  /**
   * By entry id: the entries — already in the book, or elsewhere in this same file — that the row
   * shares its first and last four characters with. A row listed here is NOT imported unless the
   * user confirms that specific row ("yes, this is a different address"), exactly as the add form
   * asks; see `applyImport`.
   */
  twins: Record<string, AddressBookEntry[]>
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
    // The file's own word on who it resembles counts for nothing; the user answers that below.
    delete e.distinctFrom
    add.push(e)
  }
  // Ids that clash with the book's own, or with each other, are reissued before anything is shown.
  // Everything an import brings in is marked: it has not been confirmed by this user yet.
  const marked = dedupeIds(add, new Set(book.entries.map((e) => e.id))).map((e) => ({ ...e, imported: true as const }))
  // Twins are looked for in the book AND among the other rows: two rows of one file that share
  // their ends would otherwise land as an unvouched pair and refuse each other at send time.
  // Keyed by ids that came out of a FILE: a null-prototype object, so an id of `__proto__` or
  // `constructor` is a key like any other and not a walk up the prototype chain.
  const twins: Record<string, AddressBookEntry[]> = Object.create(null) as Record<string, AddressBookEntry[]>
  for (const e of marked) {
    const t = twinsOf([...book.entries, ...marked], e.family, e.address)
    if (t.length > 0) twins[e.id] = t
  }
  return { add: marked, twins, duplicates, invalid }
}

/** The rows of a preview that `applyImport` would bring in, given these confirmations. */
export function importable(preview: ImportPreview, confirmedTwins: ReadonlySet<string> = new Set()): AddressBookEntry[] {
  return preview.add.filter((e) => !Object.hasOwn(preview.twins, e.id) || confirmedTwins.has(e.id))
}

/**
 * Applies a preview the user accepted. `confirmedTwins` holds the ids of the look-alike rows the
 * user answered "yes, this is a different address" for, one by one. A look-alike row without that
 * answer is left out — it is not refused later, it simply never enters the book — and a confirmed
 * one records the answer (`distinctFrom`) the same way the add form does. Every row stays
 * `imported`: the tail is still owed on first use, whatever was answered here.
 */
export function applyImport(book: AddressBook, preview: ImportPreview, confirmedTwins: ReadonlySet<string> = new Set()): AddressBook {
  const rows = importable(preview, confirmedTwins).map((e) => {
    const t = Object.hasOwn(preview.twins, e.id) ? preview.twins[e.id] : undefined
    return t ? { ...e, distinctFrom: t.map((x) => x.address) } : e
  })
  return { ...book, entries: [...book.entries, ...rows].slice(0, MAX_ENTRIES) }
}
