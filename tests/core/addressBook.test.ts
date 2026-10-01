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
  importable,
  confirmImported,
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

describe('an imported entry is a suggestion until its first use confirms it', () => {
  const A2 = '0x1111111111111111111111111111111111111111'
  const file = (entries: unknown[]) => ({ version: 1, entries })

  const withImported = (): AddressBook => {
    const p = previewImport(file([{ label: 'Exchange', address: A2, family: 'evm' }]), { ...EMPTY_BOOK, entries: [] })
    return applyImport({ ...EMPTY_BOOK, entries: [] }, p!)
  }

  it('import marks what it brings in', () => {
    const b = withImported()
    expect(b.entries).toHaveLength(1)
    expect(b.entries[0]!.imported).toBe(true)
  })

  it('an unconfirmed imported address is NOT "known" — the tail is still required', () => {
    const b = withImported()
    const v = lookUp(b, 'evm', A2)
    expect(v.kind).toBe('imported')
    // The distinction that matters: it must not be the verdict that waives confirmation.
    expect(v.kind).not.toBe('known')
  })

  it('after confirmation it becomes an ordinary entry, and stays one', () => {
    const b = withImported()
    const id = b.entries[0]!.id
    const after = confirmImported(b, id)
    expect(after.entries[0]!.imported).toBeUndefined()
    expect(lookUp(after, 'evm', A2).kind).toBe('known')
    // Next use asks for nothing again.
    expect(lookUp(confirmImported(after, id), 'evm', A2).kind).toBe('known')
  })

  it('an entry the user typed is never marked, and needs no confirming', () => {
    const b = addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'Mine', address: A, family: 'evm' }, NOW)
    expect(b.entries[0]!.imported).toBeUndefined()
    expect(lookUp(b, 'evm', A).kind).toBe('known')
  })

  it('the flag survives a reload — a refresh must not launder an unconfirmed address', () => {
    const b = withImported()
    const back = parseBook(JSON.parse(exportBook(b)))
    expect(back.ok).toBe(true)
    if (back.ok) expect(lookUp(back.book, 'evm', A2).kind).toBe('imported')
  })

  it('an imported look-alike is still refused outright, not merely unconfirmed', () => {
    const saved = '0x1234000000000000000000000000000000005678'
    const twin = '0x1234ffffffffffffffffffffffffffffffff5678'
    const b = addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'Real', address: saved, family: 'evm' }, NOW)
    const p = previewImport(file([{ label: 'Fake', address: twin, family: 'evm' }]), b)
    // The preview lists it, marked as a twin of "Real"...
    expect(p!.add).toHaveLength(1)
    expect(p!.twins[p!.add[0]!.id]!.map((t) => t.label)).toEqual(['Real'])
    // ...and applying without the row's own answer leaves it out: the book is as it was, and the
    // address is still refused as a look-alike.
    const after = applyImport(b, p!)
    expect(after.entries).toHaveLength(1)
    expect(lookUp(after, 'evm', twin).kind).toBe('lookalike')
    // A twin that is NOT in the book is blocked as before.
    const other = '0x1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5678'
    expect(lookUp(b, 'evm', other).kind).toBe('lookalike')
  })
})

describe('a twin in the book is refused until someone confirmed the pair is two addresses', () => {
  const saved = '0x1234000000000000000000000000000000005678'
  const twin = '0x1234ffffffffffffffffffffffffffffffff5678'
  const third = '0x1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5678'
  const file = (entries: unknown[]) => ({ version: 1, entries })
  const real = () => addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'Real', address: saved, family: 'evm' }, NOW, 'real')

  it('1. import: the twin row is marked and not imported without its own confirmation', () => {
    const p = previewImport(file([{ label: 'Fake', address: twin, family: 'evm' }]), real())!
    const row = p.add[0]!
    expect(p.twins[row.id]!.map((t) => t.address)).toEqual([getAddress(saved)])
    const b = applyImport(real(), p)
    expect(b.entries.map((e) => e.label)).toEqual(['Real'])
    // The refusal is what the guards see, on the very address the file tried to slip in.
    expect(lookUp(b, 'evm', twin)).toMatchObject({ kind: 'lookalike', entry: { label: 'Real' } })
    // The entry it resembles is untouched by the attempt.
    expect(lookUp(b, 'evm', saved).kind).toBe('known')
  })

  it('2. import with the row confirmed: in the book, still imported, tail owed on first use', () => {
    const p = previewImport(file([{ label: 'Other', address: twin, family: 'evm' }]), real())!
    const b = applyImport(real(), p, new Set([p.add[0]!.id]))
    expect(b.entries.map((e) => e.label)).toEqual(['Real', 'Other'])
    const added = b.entries[1]!
    expect(added.imported).toBe(true)
    expect(added.distinctFrom).toEqual([getAddress(saved)])
    // Confirmed different, but not yet confirmed at all: the tail is still required.
    const v = lookUp(b, 'evm', twin)
    expect(v.kind).toBe('imported')
    // After the first send confirms it, it is an ordinary entry — and the pair stays fine.
    const after = confirmImported(b, added.id)
    expect(lookUp(after, 'evm', twin).kind).toBe('known')
    expect(lookUp(after, 'evm', saved).kind).toBe('known')
    // The answer survives a reload of the store.
    const back = parseBook(JSON.parse(exportBook(after)))
    expect(back.ok && lookUp(back.book, 'evm', twin).kind).toBe('known')
  })

  it('3. a twin that got in by any path without that answer is still refused', () => {
    // A hand-edited store: two entries sharing their ends, neither vouching for the other.
    const stored = parseBook({
      version: ADDRESS_BOOK_VERSION,
      entries: [
        { id: 'a', label: 'Real', address: saved, family: 'evm', createdAt: NOW },
        { id: 'b', label: 'Fake', address: twin, family: 'evm', createdAt: NOW },
      ],
    })
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(lookUp(stored.book, 'evm', twin)).toMatchObject({ kind: 'lookalike', entry: { label: 'Real' } })
    expect(lookUp(stored.book, 'evm', saved)).toMatchObject({ kind: 'lookalike', entry: { label: 'Fake' } })
    // The add form's path refuses it outright without the answer, and records the answer with it.
    expect(() => addEntry(real(), { label: 'Fake', address: twin, family: 'evm' }, NOW)).toThrow(AddressBookError)
    try {
      addEntry(real(), { label: 'Fake', address: twin, family: 'evm' }, NOW)
    } catch (e) {
      expect((e as AddressBookError).code).toBe('lookalike_unconfirmed')
    }
    const ok = addEntry(real(), { label: 'Other', address: twin, family: 'evm', twinAccepted: true }, NOW)
    expect(ok.entries[1]!.distinctFrom).toEqual([getAddress(saved)])
    expect(lookUp(ok, 'evm', twin).kind).toBe('known')
    expect(lookUp(ok, 'evm', saved).kind).toBe('known')
  })

  it('an answer given about one pair does not cover a third address that shares the same ends', () => {
    const b = addEntry(real(), { label: 'Other', address: twin, family: 'evm', twinAccepted: true }, NOW, 'other')
    const stored = parseBook({ ...JSON.parse(exportBook(b)), entries: [...b.entries, { id: 'c', label: 'Third', address: third, family: 'evm', createdAt: NOW }] })
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(lookUp(stored.book, 'evm', third)).toMatchObject({ kind: 'lookalike' })
    // The refusal is symmetric on purpose: while an unvouched twin sits in the book, the entries it
    // resembles are refused too, each naming "Third" as the thing to look at. A user who sees that
    // and removes the stranger gets the vouched pair back exactly as it was.
    expect(lookUp(stored.book, 'evm', twin)).toMatchObject({ kind: 'lookalike', entry: { label: 'Third' } })
    expect(lookUp(stored.book, 'evm', saved)).toMatchObject({ kind: 'lookalike', entry: { label: 'Third' } })
    const cleaned = removeEntry(stored.book, 'c')
    expect(lookUp(cleaned, 'evm', twin).kind).toBe('known')
    expect(lookUp(cleaned, 'evm', saved).kind).toBe('known')
  })

  it("a file's own distinctFrom is ignored: the confirmation is the user's to give, not the file's", () => {
    const p = previewImport(file([{ label: 'Fake', address: twin, family: 'evm', distinctFrom: [saved] }]), real())!
    expect(p.add[0]!.distinctFrom).toBeUndefined()
    expect(Object.keys(p.twins)).toEqual([p.add[0]!.id])
    expect(applyImport(real(), p).entries).toHaveLength(1)
  })

  it('an id of `__proto__` in the file is an id, not a walk up the prototype chain', () => {
    const p = previewImport(file([{ id: '__proto__', label: 'Odd', address: '0x5555555555555555555555555555555555555555', family: 'evm' }, { id: 'constructor', label: 'Odder', address: '0x6666666666666666666666666666666666666666', family: 'evm' }]), { ...EMPTY_BOOK, entries: [] })!
    expect(p.add.map((e) => e.label)).toEqual(['Odd', 'Odder'])
    // Neither row has a twin, so neither is held back — and nothing throws on the lookup.
    expect(importable(p).map((e) => e.label)).toEqual(['Odd', 'Odder'])
    expect(applyImport({ ...EMPTY_BOOK, entries: [] }, p).entries).toHaveLength(2)
  })

  it('two rows of one file that share their ends are twins of each other, and each needs its own answer', () => {
    const p = previewImport(file([
      { label: 'One', address: twin, family: 'evm' },
      { label: 'Two', address: third, family: 'evm' },
    ]), { ...EMPTY_BOOK, entries: [] })!
    expect(p.add).toHaveLength(2)
    const [one, two] = p.add as [typeof p.add[0], typeof p.add[0]]
    expect(p.twins[one.id]!.map((t) => t.label)).toEqual(['Two'])
    expect(p.twins[two.id]!.map((t) => t.label)).toEqual(['One'])
    // Only the confirmed one goes in, and it records the answer about the other.
    const b = applyImport({ ...EMPTY_BOOK, entries: [] }, p, new Set([one.id]))
    expect(b.entries.map((e) => e.label)).toEqual(['One'])
    expect(b.entries[0]!.distinctFrom).toEqual([getAddress(third)])
    // Both confirmed: both in, and neither refuses the other.
    const both = applyImport({ ...EMPTY_BOOK, entries: [] }, p, new Set([one.id, two.id]))
    expect(both.entries).toHaveLength(2)
    expect(lookUp(both, 'evm', twin).kind).toBe('imported')
    expect(lookUp(both, 'evm', third).kind).toBe('imported')
  })
})

describe('a twin is flagged on the way in, on both paths', () => {
  const saved = '0x1234000000000000000000000000000000005678'
  const twin = '0x1234ffffffffffffffffffffffffffffffff5678'
  const unrelated = '0x9999000000000000000000000000000000009999'
  const book = () => addEntry({ ...EMPTY_BOOK, entries: [] }, { label: 'Exchange', address: saved, family: 'evm' }, NOW, 'kept')

  it('the manual add form can see the twin it is about to create', () => {
    // The form gates its save on this; the rule itself is findLookalike.
    expect(findLookalike(book(), 'evm', twin)?.label).toBe('Exchange')
    expect(findLookalike(book(), 'evm', unrelated)).toBeUndefined()
    // The address already saved is itself, not a twin of itself.
    expect(findLookalike(book(), 'evm', saved)).toBeUndefined()
  })

  it('an imported row can be recognised as a twin of an existing entry', () => {
    const b = book()
    const p = previewImport({ version: 1, entries: [
      { label: 'Fake', address: twin, family: 'evm' },
      { label: 'Fine', address: unrelated, family: 'evm' },
    ] }, b)
    expect(p!.add).toHaveLength(2)
    // The preview lists both and names the one that resembles a saved entry.
    const marked = p!.add.map((e) => e.id in p!.twins)
    expect(marked).toEqual([true, false])
    expect(p!.add.map((e) => !!findLookalike(b, e.family, e.address))).toEqual(marked)
  })

  it('adding a twin is allowed with the explicit answer — it is the user’s own book', () => {
    const b = addEntry(book(), { label: 'Other', address: twin, family: 'evm', twinAccepted: true }, NOW)
    expect(b.entries).toHaveLength(2)
    // And once both are in, each looks up as itself rather than as the other’s twin.
    expect(lookUp(b, 'evm', twin).kind).toBe('known')
    expect(lookUp(b, 'evm', saved).kind).toBe('known')
  })
})
