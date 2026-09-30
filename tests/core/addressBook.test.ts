/**
 * The address book's two load-bearing claims: a saved address is recognised exactly, and an
 * address dressed up as a saved one is caught. Everything else here is about not losing data.
 */
import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  addEntry,
  AddressBookError,
  addressEdges,
  applyImport,
  ADDRESS_BOOK_VERSION,
  entriesFor,
  EMPTY_BOOK,
  exportBook,
  familyOfVm,
  findLookalike,
  lookUp,
  MAX_ENTRIES,
  normalizeAddress,
  parseBook,
  previewImport,
  removeEntry,
  renameEntry,
  touchEntry,
  type AddressBook,
} from '@/core/addressBook'

const A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
const NOW = 1_700_000_000_000

const book = (...addrs: { label: string; address: string; family?: 'evm' | 'solana' }[]): AddressBook =>
  addrs.reduce(
    (b, a, i) => addEntry(b, { label: a.label, address: a.address, family: a.family ?? 'evm' }, NOW, `id${i}`),
    { ...EMPTY_BOOK, entries: [] } as AddressBook,
  )

describe('normalizeAddress', () => {
  it('checksums EVM and accepts any input case', () => {
    expect(normalizeAddress('evm', A.toLowerCase())).toBe(getAddress(A))
    expect(normalizeAddress('evm', A.toUpperCase().replace('0X', '0x'))).toBe(getAddress(A))
  })
  it('refuses what is not an address for the family', () => {
    expect(normalizeAddress('evm', 'nope')).toBeUndefined()
    expect(normalizeAddress('evm', '')).toBeUndefined()
    // A 20-byte hex string is not a Solana pubkey, and hex is refused outright there.
    expect(normalizeAddress('solana', A)).toBeUndefined()
    expect(normalizeAddress('solana', '0Ol')).toBeUndefined()
  })
  it('keeps a Solana pubkey byte for byte — case IS the address there', () => {
    const sol = '11111111111111111111111111111111'
    expect(normalizeAddress('solana', sol)).toBe(sol)
  })
  it('familyOfVm maps the app vocabulary to the stored one', () => {
    expect(familyOfVm('evm')).toBe('evm')
    expect(familyOfVm('svm')).toBe('solana')
  })
})

describe('look-alike detection', () => {
  // Same first four and last four hex characters, different middle: an address swap.
  const saved = '0x1234000000000000000000000000000000005678'
  const twin = '0x1234ffffffffffffffffffffffffffffffff5678'
  const unrelated = '0x9999000000000000000000000000000000009999'

  it('edges ignore 0x and case on EVM', () => {
    expect(addressEdges('evm', saved)).toEqual({ head: '1234', tail: '5678' })
    expect(addressEdges('evm', saved.toUpperCase().replace('0X', '0x'))).toEqual({ head: '1234', tail: '5678' })
  })

  it('flags an address that shares both ends with an entry', () => {
    const b = book({ label: 'Exchange', address: saved })
    const hit = findLookalike(b, 'evm', twin)
    expect(hit?.label).toBe('Exchange')
    expect(lookUp(b, 'evm', twin)).toEqual({ kind: 'lookalike', entry: hit })
  })

  it('the saved address itself is KNOWN, never a look-alike of itself', () => {
    const b = book({ label: 'Exchange', address: saved })
    expect(findLookalike(b, 'evm', saved)).toBeUndefined()
    expect(lookUp(b, 'evm', saved).kind).toBe('known')
    // Case must not change the verdict on EVM.
    expect(lookUp(b, 'evm', saved.toUpperCase().replace('0X', '0x')).kind).toBe('known')
  })

  it('leaves an unrelated address alone', () => {
    const b = book({ label: 'Exchange', address: saved })
    expect(lookUp(b, 'evm', unrelated)).toEqual({ kind: 'new' })
  })

  it('an empty book never refuses anything', () => {
    expect(lookUp({ ...EMPTY_BOOK, entries: [] }, 'evm', twin)).toEqual({ kind: 'new' })
  })

  it('does not cross families: a Solana entry cannot flag an EVM address', () => {
    const b = book({ label: 'Sol', address: '11111111111111111111111111111111', family: 'solana' })
    expect(lookUp(b, 'evm', twin)).toEqual({ kind: 'new' })
  })
})

describe('mutations', () => {
  it('refuses a duplicate address, whatever its case', () => {
    const b = book({ label: 'One', address: A })
    expect(() => addEntry(b, { label: 'Two', address: A.toLowerCase(), family: 'evm' }, NOW)).toThrow(AddressBookError)
  })
  it('refuses an empty label and an invalid address', () => {
    const b = { ...EMPTY_BOOK, entries: [] }
    expect(() => addEntry(b, { label: '  ', address: A, family: 'evm' }, NOW)).toThrow(/label_empty/)
    expect(() => addEntry(b, { label: 'x', address: 'nope', family: 'evm' }, NOW)).toThrow(/invalid_address/)
  })
  it('rename, remove and touch do what they say', () => {
    let b = book({ label: 'One', address: A })
    const id = b.entries[0]!.id
    b = renameEntry(b, id, 'Renamed')
    expect(b.entries[0]!.label).toBe('Renamed')
    b = touchEntry(b, id, NOW + 5)
    expect(b.entries[0]!.lastUsedAt).toBe(NOW + 5)
    expect(removeEntry(b, id).entries).toHaveLength(0)
    // Touching something that is gone is a no-op, not a throw.
    expect(touchEntry(removeEntry(b, id), id, NOW).entries).toHaveLength(0)
  })
  it('strips layout-controlling characters out of a label', () => {
    const b = addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'a‮b', address: A, family: 'evm' }, NOW)
    expect(b.entries[0]!.label).toBe('ab')
  })
  it('entriesFor sorts most recently used first and filters by family', () => {
    let b = book({ label: 'Old', address: A }, { label: 'New', address: '0x1111111111111111111111111111111111111111' })
    b = touchEntry(b, b.entries[1]!.id, NOW + 10)
    expect(entriesFor(b, 'evm').map((e) => e.label)).toEqual(['New', 'Old'])
    expect(entriesFor(b, 'solana')).toHaveLength(0)
  })
})

describe('parseBook: corrupt data is reported, never silently replaced', () => {
  it('a missing value is an empty book', () => {
    expect(parseBook(null)).toEqual({ ok: true, book: { version: ADDRESS_BOOK_VERSION, entries: [] } })
  })
  it('anything that is not a book is corrupt', () => {
    expect(parseBook('nonsense')).toEqual({ ok: false, reason: 'corrupt' })
    expect(parseBook([])).toEqual({ ok: false, reason: 'corrupt' })
    expect(parseBook({ entries: [] })).toEqual({ ok: false, reason: 'corrupt' })
    expect(parseBook({ version: 1 })).toEqual({ ok: false, reason: 'corrupt' })
  })
  it('one unreadable row does not cost the whole book', () => {
    const r = parseBook({ version: 1, entries: [{ label: 'ok', address: A, family: 'evm' }, { label: 'bad', address: 'nope', family: 'evm' }, 42] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.book.entries.map((e) => e.label)).toEqual(['ok'])
  })
  it('drops a duplicate row rather than storing the same address twice', () => {
    const r = parseBook({ version: 1, entries: [{ label: 'a', address: A, family: 'evm' }, { label: 'b', address: A.toLowerCase(), family: 'evm' }] })
    expect(r.ok && r.book.entries).toHaveLength(1)
  })
})

describe('import / export', () => {
  const file = (entries: unknown[]) => ({ version: 1, entries })

  it('a round trip preserves the entries', () => {
    const b = book({ label: 'One', address: A })
    const back = parseBook(JSON.parse(exportBook(b)))
    expect(back.ok && back.book.entries[0]!.address).toBe(getAddress(A))
  })

  it('previews without applying, and counts what it would skip', () => {
    const b = book({ label: 'Have', address: A })
    const p = previewImport(file([
      { label: 'Have again', address: A, family: 'evm' },
      { label: 'New', address: '0x1111111111111111111111111111111111111111', family: 'evm' },
      { label: 'Broken', address: 'nope', family: 'evm' },
      'not even an object',
    ]), b)
    expect(p).toBeDefined()
    expect(p!.add.map((e) => e.label)).toEqual(['New'])
    expect(p!.duplicates).toBe(1)
    expect(p!.invalid).toBe(2)
    // Nothing happened to the book until applyImport is called.
    expect(b.entries).toHaveLength(1)
    expect(applyImport(b, p!).entries).toHaveLength(2)
  })

  it('a file that is not an address book yields undefined, not an empty import', () => {
    expect(previewImport('garbage', EMPTY_BOOK)).toBeUndefined()
    expect(previewImport({ nope: true }, EMPTY_BOOK)).toBeUndefined()
    expect(previewImport([], EMPTY_BOOK)).toBeUndefined()
  })

  it('a file repeating one address imports it once', () => {
    const p = previewImport(file([
      { label: 'a', address: A, family: 'evm' },
      { label: 'b', address: A.toLowerCase(), family: 'evm' },
    ]), { ...EMPTY_BOOK, entries: [] })
    expect(p!.add).toHaveLength(1)
    expect(p!.duplicates).toBe(1)
  })

  it('does not import past the cap', () => {
    const rows = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({
      label: `e${i}`,
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      family: 'evm' as const,
    }))
    const p = previewImport(file(rows), { ...EMPTY_BOOK, entries: [] })
    expect(p!.add).toHaveLength(MAX_ENTRIES)
    expect(p!.invalid).toBe(5)
  })
})

describe('ids identify exactly one entry', () => {
  const A2 = '0x1111111111111111111111111111111111111111'

  it('an imported file that repeats an id gets fresh ones', () => {
    const p = previewImport(
      { version: 1, entries: [
        { id: 'same', label: 'one', address: A, family: 'evm' },
        { id: 'same', label: 'two', address: A2, family: 'evm' },
      ] },
      { ...EMPTY_BOOK, entries: [] },
    )
    expect(p!.add).toHaveLength(2)
    expect(p!.add[0]!.id).not.toBe(p!.add[1]!.id)
  })

  it('an import cannot collide with an id the book already uses', () => {
    const book = addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'Mine', address: A, family: 'evm' }, NOW, 'kept')
    const p = previewImport({ version: 1, entries: [{ id: 'kept', label: 'Theirs', address: A2, family: 'evm' }] }, book)
    expect(p!.add[0]!.id).not.toBe('kept')
    // Removing the imported one must not touch the entry that was already there.
    const after = removeEntry(applyImport(book, p!), p!.add[0]!.id)
    expect(after.entries.map((e) => e.label)).toEqual(['Mine'])
  })

  it('a stored book with repeated ids is repaired on read', () => {
    const r = parseBook({ version: 1, entries: [
      { id: 'dup', label: 'a', address: A, family: 'evm' },
      { id: 'dup', label: 'b', address: A2, family: 'evm' },
    ] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(new Set(r.book.entries.map((e) => e.id)).size).toBe(2)
  })
})
