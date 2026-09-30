// Series (ARCH.md §16 #52): what Open Library and Google Books really say about them, what's missing from a
// series, what each member reads next, and editing a book's series and the series itself.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { GB_ISBN_ABADDON, GB_ISBN_ORCS, OL_ISBN_ABADDON, OL_ISBN_EARTHSEA, OL_SEARCH_LAST_WISH, OL_SEARCH_TWO_TOWERS } from './fixtures/series-responses';
import { as, book, html, member, rows, type Member } from './member-helpers';
import { addPastRead, createLibrary, deleteItem, deleteLibrary, getItem, startRead, updateItemWithTags } from '../src/db/queries';
import { budgeted } from '../src/federation/budget';
import {
  cleanSeriesName,
  missingNumbers,
  nextUp,
  parseSeriesNumber,
  parseSeriesTotal,
  parseTitleSeries,
  seriesKey,
  type SeriesVolume,
} from '../src/lib/series';
import { lookupByBarcode, mergeBookCandidates } from '../src/metadata';
import { googleBooks } from '../src/metadata/googlebooks';
import { openLibrary } from '../src/metadata/openlibrary';
import app from '../src/index';

const OL = 'https://openlibrary.org';
const GB = 'https://www.googleapis.com';

// ---------- what the providers say ----------

describe('series from the providers, as recorded', () => {
  beforeEach(() => activateFetchMock());
  afterEach(() => assertNoPendingInterceptors());

  it('reads Open Library’s series name and position, and asks for them', async () => {
    let asked = '';
    intercept(OL, (p) => (p.startsWith('/search.json?q=isbn%3A9780316129077') ? ((asked = p), true) : false), json(OL_ISBN_ABADDON));
    const hit = await openLibrary.lookupByBarcode('9780316129077');
    expect(hit?.series).toEqual({ name: 'The Expanse', number: 3 });
    expect(decodeURIComponent(asked)).toContain('series_name,series_position');
  });

  it('leaves the series out when Open Library has none for the work', async () => {
    intercept(OL, (p) => p.startsWith('/search.json?q=isbn%3A9780547773742'), json(OL_ISBN_EARTHSEA));
    const hit = await openLibrary.lookupByBarcode('9780547773742');
    expect(hit?.title).toBe('A Wizard of Earthsea');
    expect(hit).not.toHaveProperty('series');
  });

  it('keeps a fractional position, and an omnibus in its series without a number', async () => {
    intercept(OL, (p) => p.startsWith('/search.json?q=the%20last%20wish'), json(OL_SEARCH_LAST_WISH));
    intercept(OL, (p) => p.startsWith('/search.json?q=the%20two%20towers'), json(OL_SEARCH_TWO_TOWERS));
    const [witcher, boxed] = await openLibrary.search('the last wish sapkowski');
    expect(witcher?.series).toEqual({ name: 'The Witcher', number: 0.5 });
    expect(boxed).not.toHaveProperty('series');
    const [towers, omnibus] = await openLibrary.search('the two towers');
    expect(towers?.series).toEqual({ name: 'The Lord of the Rings', number: 2 });
    expect(omnibus?.series).toEqual({ name: 'The Lord of the Rings', number: null }); // "1-3"
  });

  it('takes nothing from Google Books: its seriesInfo has a number but never the series’ name', async () => {
    intercept(GB, (p) => p.startsWith('/books/v1/volumes?q=isbn%3A9781646684656'), json(GB_ISBN_ORCS));
    const hit = await googleBooks().lookupByBarcode('9781646684656');
    expect(hit?.title).toBe('ORCS! #4');
    expect(hit).not.toHaveProperty('series');
  });

  it('merges a scan: Open Library’s series survives Google Books filling the blanks', async () => {
    intercept(OL, (p) => p.startsWith('/search.json?q=isbn%3A9780316129077'), json(OL_ISBN_ABADDON));
    intercept(GB, (p) => p.startsWith('/books/v1/volumes?q=isbn%3A9780316129077'), json(GB_ISBN_ABADDON));
    const { candidates } = await lookupByBarcode(env, '9780316129077');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ provider: 'openlibrary+googlebooks', series: { name: 'The Expanse', number: 3 } });
    expect(candidates[0]!.description).toContain('third book'); // Google's, as ever
    expect(mergeBookCandidates(null, { ...candidates[0]!, series: undefined })?.series).toBeUndefined();
  });

  it('carries a scanned book’s series through the Add page into the new item', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    intercept(OL, (p) => p.startsWith('/search.json?q=isbn%3A9780316129077'), json(OL_ISBN_ABADDON));
    intercept(GB, (p) => p.startsWith('/books/v1/volumes?q=isbn%3A9780316129077'), json(GB_ISBN_ABADDON));
    const results = await (await as(asha, '/add/results?barcode=9780316129077', { htmx: true })).text();
    expect(results).toContain('name="seriesName" value="The Expanse"');
    expect(results).toContain('name="seriesNumber" value="3"');

    // the candidate card's form, as the browser would send it (covers are fetched on save: none here)
    const res = await as(asha, '/items', {
      body: { mediaType: 'book', title: 'Abaddon’s Gate', creators: 'James S. A. Corey', libraryId: String(shelf.id), seriesName: 'The Expanse', seriesNumber: '3', coverUrl: '' },
    });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get('location')!.split('/').pop());
    expect(await rows('SELECT s.name, i.series_number AS n FROM items i JOIN series s ON s.id = i.series_id WHERE i.id = ?1', id)).toEqual([
      { name: 'The Expanse', n: 3 },
    ]);
    // and the manual form offers it from then on
    expect(await html(asha, '/add')).toContain('<option value="The Expanse">');
  });
});

// ---------- the pure parts ----------

describe('series numbers, names and titles', () => {
  it('parses numbers a person or a provider writes, and refuses the rest', () => {
    expect(parseSeriesNumber('3')).toBe(3);
    expect(parseSeriesNumber('#3')).toBe(3);
    expect(parseSeriesNumber(' 03 ')).toBe(3);
    expect(parseSeriesNumber('2.5')).toBe(2.5);
    expect(parseSeriesNumber('0.5')).toBe(0.5);
    expect(parseSeriesNumber('')).toBeNull();
    for (const bad of ['1-3', 'three', '-1', '2.555', '10000', '1e3', '3.']) expect(parseSeriesNumber(bad), bad).toBeUndefined();
    expect(parseSeriesTotal('9')).toBe(9);
    expect(parseSeriesTotal('')).toBeNull();
    for (const bad of ['0', '2.5', '10000', 'nine']) expect(parseSeriesTotal(bad), bad).toBeUndefined();
  });

  it('folds names by Unicode case and spacing, and strips what could hide in them', () => {
    expect(seriesKey('The  Expanse')).toBe(seriesKey('the expanse'));
    expect(seriesKey('ÆTHER')).toBe(seriesKey('æther')); // past ASCII, where SQLite's NOCASE stops
    expect(cleanSeriesName('  The‮Expanse \n')).toBe('The Expanse');
    expect(cleanSeriesName('   ')).toBeNull();
    expect(cleanSeriesName('x'.repeat(300))).toHaveLength(200);
    // as a display name is: the joiner a Persian name needs stays, and the cap never splits a character
    expect(cleanSeriesName('کتاب‌ها')).toBe('کتاب‌ها');
    expect(cleanSeriesName(`${'a'.repeat(199)}😀x`)).toBe(`${'a'.repeat(199)}😀`);
  });

  it('splits a Goodreads title into its title and series', () => {
    expect(parseTitleSeries('The Gunslinger (The Dark Tower, #1)')).toEqual({ title: 'The Gunslinger', series: { name: 'The Dark Tower', number: 1 } });
    expect(parseTitleSeries('Guards! Guards! (Discworld, #8; City Watch, #1)')).toEqual({
      title: 'Guards! Guards!',
      series: { name: 'Discworld', number: 8 },
    });
    expect(parseTitleSeries('Gods of Risk (The Expanse, #2.5)')?.series).toEqual({ name: 'The Expanse', number: 2.5 });
    expect(parseTitleSeries('The Dark Tower Boxed Set (The Dark Tower, #1-4)')?.series).toEqual({ name: 'The Dark Tower', number: null });
    expect(parseTitleSeries('Selected Poems (Penguin Classics)')).toBeNull(); // a note, not a numbered series
    expect(parseTitleSeries('Dune')).toBeNull();
    // a title no book has isn't looked into: the patterns backtrack, and an import row mustn't spend the CPU budget
    expect(parseTitleSeries(`${' '.repeat(600)}x (S, #1)`)).toBeNull();
  });
});

describe('what’s missing from a series', () => {
  it('finds the whole numbers between the ones held', () => {
    expect(missingNumbers([1, 2, 3, 5])).toEqual([[4, 4]]);
    expect(missingNumbers([3, 1, 7])).toEqual([
      [2, 2],
      [4, 6],
    ]);
    expect(missingNumbers([4, 5])).toEqual([[1, 3]]); // a series starts at 1
    expect(missingNumbers([1, 2, 3])).toEqual([]);
  });

  it('never counts a fractional number as filling a whole one, or as missing itself', () => {
    expect(missingNumbers([1, 2.5, 3])).toEqual([[2, 2]]);
    expect(missingNumbers([1, 2, 2.5, 3])).toEqual([]);
    expect(missingNumbers([0.5, 1])).toEqual([]); // a prequel at 0.5 or 0 needs nothing before it
    expect(missingNumbers([0, 1, 2])).toEqual([]);
    expect(missingNumbers([1, 4.5])).toEqual([[2, 4]]); // held up to 4.5: 2 to 4 are missing
  });

  it('counts a number held twice once, and a volume with no number not at all', () => {
    expect(missingNumbers([1, 1, 3, 3, null])).toEqual([[2, 2]]);
    expect(missingNumbers([null, null])).toEqual([]);
    expect(missingNumbers([])).toEqual([]);
  });

  it('shows what comes after the last held once the total is known', () => {
    expect(missingNumbers([1, 2, 3, 5], 7)).toEqual([
      [4, 4],
      [6, 7],
    ]);
    expect(missingNumbers([null], 3)).toEqual([[1, 3]]);
    expect(missingNumbers([1, 2, 3, 5], 3)).toEqual([[4, 4]]); // a total lower than what's held adds nothing
  });

  it('stays linear however far a number reaches', () => {
    const ranges = missingNumbers([1, 9999], 9999);
    expect(ranges).toEqual([[2, 9998]]);
  });
});

describe('next up', () => {
  const vol = (id: number, n: number | null, extra: Partial<SeriesVolume> = {}): SeriesVolume => ({
    id,
    title: `Volume ${n ?? '?'}`,
    seriesNumber: n,
    copies: 1,
    finishedByMe: false,
    readingByMe: false,
    ...extra,
  });

  it('is the lowest-numbered volume the member hasn’t finished', () => {
    const next = nextUp([vol(1, 1, { finishedByMe: true }), vol(2, 2), vol(3, 3)]);
    expect(next).toMatchObject({ kind: 'volume', volume: { id: 2 }, skipped: [] });
  });

  it('is a volume finished out of order too: #1 unread after #2 and #3', () => {
    const next = nextUp([vol(1, 1), vol(2, 2, { finishedByMe: true }), vol(3, 3, { finishedByMe: true })]);
    expect(next).toMatchObject({ kind: 'volume', volume: { id: 1 } });
  });

  it('says which missing numbers come before it', () => {
    const next = nextUp([vol(1, 1, { finishedByMe: true }), vol(2, 2, { finishedByMe: true }), vol(3, 3, { finishedByMe: true }), vol(5, 5)]);
    expect(next).toMatchObject({ kind: 'volume', volume: { id: 5 }, skipped: [[4, 4]] });
    // with nothing finished, everything missing below counts
    expect(nextUp([vol(3, 3), vol(4, 4)])).toMatchObject({ kind: 'volume', volume: { id: 3 }, skipped: [[1, 2]] });
  });

  it('counts a number finished in any edition, and prefers the edition being read', () => {
    const next = nextUp([vol(1, 1), vol(2, 1, { finishedByMe: true }), vol(3, 2), vol(4, 2, { readingByMe: true })]);
    expect(next).toMatchObject({ kind: 'volume', volume: { id: 4 } });
  });

  it('includes fractional volumes in order', () => {
    const next = nextUp([vol(1, 1, { finishedByMe: true }), vol(2, 2, { finishedByMe: true }), vol(25, 2.5), vol(3, 3)]);
    expect(next).toMatchObject({ kind: 'volume', volume: { id: 25 } });
  });

  it('points past the shelf when every numbered volume is finished and the series goes on', () => {
    const done = [vol(1, 1, { finishedByMe: true }), vol(2, 2, { finishedByMe: true })];
    expect(nextUp(done, 4)).toEqual({ kind: 'missing', number: 3 });
    expect(nextUp(done)).toEqual({ kind: 'done' });
    expect(nextUp([vol(1, null), vol(2, null)])).toEqual({ kind: 'none' }); // no numbers, no order
  });
});

// ---------- in the app ----------

/** The series' rows, and which items are in which. */
const seriesRows = () => rows('SELECT id, name, key, total FROM series ORDER BY id');
const membership = () => rows('SELECT id, series_id AS seriesId, series_number AS n FROM items ORDER BY id');

/** An edit form's fields for `item`, as the edit page would send them, with `change` on top. */
async function editForm(who: Member, id: number, change: Record<string, string>) {
  const item = (await getItem(env.DB, id))!;
  return as(who, `/items/${id}`, {
    body: { title: item.title, libraryId: String(item.libraryId), mediaType: item.mediaType, copies: String(item.copies), status: 'not_started', ...change },
  });
}

describe('a book’s series, edited', () => {
  it('puts a book in a series by name, and a second into the same one whatever the case', async () => {
    const asha = await member('asha', 'admin');
    const first = await book(asha, { title: 'Leviathan Wakes' });
    const third = await book(asha, { title: 'Abaddon’s Gate', libraryId: first.libraryId });
    expect((await editForm(asha, first.id, { seriesName: 'The Expanse', seriesNumber: '1' })).status).toBe(302);
    expect((await editForm(asha, third.id, { seriesName: '  the  EXPANSE ', seriesNumber: '#3' })).status).toBe(302);
    const [series] = await seriesRows();
    expect(await seriesRows()).toEqual([{ id: series!.id, name: 'The Expanse', key: 'the expanse', total: null }]); // first spelling stays
    expect(await membership()).toEqual([
      { id: first.id, seriesId: series!.id, n: 1 },
      { id: third.id, seriesId: series!.id, n: 3 },
    ]);
    // and the form shows it back
    const form = await html(asha, `/items/${third.id}/edit`);
    expect(form).toContain('name="seriesName" value="The Expanse"');
    expect(form).toContain('name="seriesNumber" value="3"');
    expect(form).toContain('<option value="The Expanse">');
  });

  it('refuses a number that isn’t one, or a number with no series, and keeps what was typed', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    const bad = await editForm(asha, b.id, { seriesName: 'Hainish Cycle', seriesNumber: 'five' });
    expect(bad.status).toBe(400);
    const page = await bad.text();
    expect(page).toContain('A number in a series is like 3');
    expect(page).toContain('value="Hainish Cycle"');
    expect(page).toContain('value="five"');
    const orphan = await editForm(asha, b.id, { seriesName: '', seriesNumber: '5' });
    expect(orphan.status).toBe(400);
    expect(await orphan.text()).toContain('needs the series’ name');
    expect(await seriesRows()).toEqual([]);
    // and on the add form too
    const added = await as(asha, '/items', { body: { title: 'New', libraryId: String(b.libraryId), mediaType: 'book', seriesNumber: '1-3', seriesName: 'X' } });
    expect(added.status).toBe(400);
  });

  it('takes a book out when the fields are cleared, and deletes a series left with no volumes', async () => {
    const asha = await member('asha', 'admin');
    const a = await book(asha, { title: 'A' });
    const b = await book(asha, { title: 'B', libraryId: a.libraryId });
    await editForm(asha, a.id, { seriesName: 'Earthsea', seriesNumber: '1' });
    await editForm(asha, b.id, { seriesName: 'Earthsea', seriesNumber: '2' });
    await editForm(asha, a.id, { seriesName: '', seriesNumber: '' });
    expect((await seriesRows()).map((s) => s.name)).toEqual(['Earthsea']);
    await editForm(asha, b.id, { seriesName: 'Earthsea Cycle', seriesNumber: '2' }); // moved to another series
    expect((await seriesRows()).map((s) => s.name)).toEqual(['Earthsea Cycle']);
    await deleteItem(env.DB, b.id);
    expect(await seriesRows()).toEqual([]);
  });

  it('prunes series whose shelf went, and never one that still has a volume elsewhere', async () => {
    const asha = await member('asha', 'admin');
    const a = await book(asha, { title: 'A' });
    const b = await book(asha, { title: 'B' }); // its own shelf
    await editForm(asha, a.id, { seriesName: 'Shared', seriesNumber: '1' });
    await editForm(asha, b.id, { seriesName: 'Shared', seriesNumber: '2' });
    await editForm(asha, a.id, { seriesName: 'Only here', seriesNumber: '1' });
    await deleteLibrary(env.DB, a.libraryId);
    expect((await seriesRows()).map((s) => s.name)).toEqual(['Shared']);
  });

  it('leaves the series alone when a form without its fields is saved (one opened before they existed)', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    await editForm(asha, b.id, { seriesName: 'Hainish Cycle', seriesNumber: '5' });
    const res = await as(asha, `/items/${b.id}`, { body: { title: 'The Dispossessed', libraryId: String(b.libraryId), mediaType: 'book', status: 'not_started' } });
    expect(res.status).toBe(302);
    expect(await rows('SELECT series_number AS n FROM items WHERE id = ?1', b.id)).toEqual([{ n: 5 }]);
    // and updateItemWithTags without a series says nothing about it either
    await updateItemWithTags(env.DB, b.id, { title: 'Renamed' }, []);
    expect(await rows('SELECT series_number AS n FROM items WHERE id = ?1', b.id)).toEqual([{ n: 5 }]);
  });
});

describe('the series page and the item page', () => {
  /** Expanse 1, 2, 3, 5 on the shelf (4 missing), and 2.5 between. */
  async function expanse(owner: Member) {
    const shelf = await createLibrary(env.DB, 'Fiction');
    const vols: Record<string, number> = {};
    for (const [n, title] of [
      ['1', 'Leviathan Wakes'],
      ['2', 'Caliban’s War'],
      ['2.5', 'Gods of Risk'],
      ['3', 'Abaddon’s Gate'],
      ['5', 'Nemesis Games'],
    ] as const) {
      const b = await book(owner, { title, libraryId: shelf.id });
      await editForm(owner, b.id, { seriesName: 'The Expanse', seriesNumber: n });
      vols[n] = b.id;
    }
    const seriesId = (await seriesRows())[0]!.id as number;
    return { vols, seriesId };
  }

  it('orders the volumes, shows the gap in place, and each member their own next up', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const { vols, seriesId } = await expanse(asha);
    // Asha finished 1, 2 and 3; Ravi only 1, and is reading 2
    for (const n of ['1', '2', '3']) await addPastRead(env.DB, vols[n]!, { status: 'completed', beganOn: null, endedOn: '2026-01-01' }, asha.id);
    await addPastRead(env.DB, vols['1']!, { status: 'completed', beganOn: null, endedOn: '2026-01-01' }, ravi.id);
    await startRead(env.DB, vols['2']!, '2026-09-01', ravi.id);

    const forAsha = await html(asha, `/series/${seriesId}`);
    const nextOf = (page: string) => page.slice(page.indexOf('class="next-up"'), page.indexOf('</p>', page.indexOf('class="next-up"')));
    expect(nextOf(forAsha)).toContain('Gods of Risk'); // 2.5, the lowest she hasn't finished
    expect(forAsha).toContain('<span class="eyebrow">Missing</span> <span class="mono">#4</span>');
    // the ledger: in order, with #4 in its place
    const order = ['Leviathan Wakes', 'Caliban’s War', 'Gods of Risk', 'Abaddon’s Gate', 'Not in the catalog', 'Nemesis Games'].map((t) =>
      forAsha.indexOf(t, forAsha.indexOf('class="volume-ledger"')),
    );
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!))).toBe(true);

    const forRavi = await html(ravi, `/series/${seriesId}`);
    expect(nextOf(forRavi)).toContain('Caliban’s War');
    expect(nextOf(forRavi)).toContain('Reading');

    // the item page carries the same, for whoever is looking
    const item = await html(ravi, `/items/${vols['3']}`);
    expect(item).toContain(`<a href="/series/${seriesId}">The Expanse</a>`);
    expect(item).toContain('#3');
    expect(item).toContain('class="vol missing"');
    expect(item).toMatch(/aria-current="page"[^>]*>3</);
    expect(nextOf(item)).toContain('Caliban’s War');
  });

  it('shows the numbers after the last once a total is set, and next up past the shelf', async () => {
    const asha = await member('asha', 'admin');
    const { vols, seriesId } = await expanse(asha);
    for (const n of ['1', '2', '2.5', '3', '5']) await addPastRead(env.DB, vols[n]!, { status: 'completed', beganOn: null, endedOn: '2026-01-01' }, asha.id);
    const res = await as(asha, `/series/${seriesId}`, { body: { name: 'The Expanse', total: '9' } });
    expect(res.status).toBe(302);
    const page = await html(asha, `/series/${seriesId}`);
    expect(page).toContain('<span class="mono">#4, #6–9</span>');
    expect(page).toContain('5 VOLUMES OF 9');
    // everything here finished: next is #6, which isn't on the shelf
    expect(page).toContain('<span class="mono">#6</span> <span class="muted">— not in the catalog</span>');
  });

  it('renames a series, merges it into one of the same name, and refuses a bad total', async () => {
    const asha = await member('asha', 'admin');
    const a = await book(asha, { title: 'A' });
    const b = await book(asha, { title: 'B', libraryId: a.libraryId });
    await editForm(asha, a.id, { seriesName: 'Expanse', seriesNumber: '1' });
    await editForm(asha, b.id, { seriesName: 'The Expanse', seriesNumber: '2' });
    const [first, second] = await seriesRows();
    expect((await as(asha, `/series/${second!.id}`, { body: { name: 'The Expanse', total: '9' } })).status).toBe(302);
    const bad = await as(asha, `/series/${first!.id}`, { body: { name: 'The Expanse', total: '2.5' } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('whole number');
    // "Expanse" renamed to "the expanse": it merges, keeping the total the other had
    const merged = await as(asha, `/series/${first!.id}`, { body: { name: 'the expanse', total: '' } });
    expect(merged.headers.get('location')).toBe(`/series/${second!.id}`);
    expect(await seriesRows()).toEqual([{ id: second!.id, name: 'The Expanse', key: 'the expanse', total: 9 }]);
    expect((await membership()).map((m) => m.seriesId)).toEqual([second!.id, second!.id]);
    // a plain rename, and clearing the total
    await as(asha, `/series/${second!.id}`, { body: { name: 'The Expanse (Corey)', total: '' } });
    expect(await seriesRows()).toEqual([{ id: second!.id, name: 'The Expanse (Corey)', key: 'the expanse (corey)', total: null }]);
    // no name: refused
    expect((await as(asha, `/series/${second!.id}`, { body: { name: '  ', total: '' } })).status).toBe(400);
    expect((await as(asha, '/series/99999', { body: { name: 'x', total: '' } })).status).toBe(404);
  });

  it('lists every series with what it holds and what’s missing', async () => {
    const asha = await member('asha', 'admin');
    await expanse(asha);
    const b = await book(asha, { title: 'Unnumbered' });
    await editForm(asha, b.id, { seriesName: 'Anthologies', seriesNumber: '' });
    const page = await html(asha, '/series');
    expect(page.indexOf('Anthologies')).toBeLessThan(page.indexOf('The Expanse'));
    expect(page).toContain('5 volumes');
    expect(page).toContain('1 missing');
    expect(page).toContain('href="/series"'); // in the sidebar
  });

  it('shows no series section, and costs no query, for a book in none', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    const page = await html(asha, `/items/${b.id}`);
    expect(page).not.toContain('series-section');
  });
});

describe('D1 calls', () => {
  async function count(who: Member, path: string) {
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie: who.cookie } }), { ...env, DB: budgeted(env.DB, budget) }, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, calls: 1000 - budget.left };
  }

  it('keep series pages and an item in a long series well inside the budget', async () => {
    const asha = await member('asha', 'admin');
    await member('ravi');
    const shelf = await createLibrary(env.DB, 'Discworld');
    let last = 0;
    for (let n = 1; n <= 41; n += n === 20 ? 2 : 1) {
      const b = await book(asha, { title: `Discworld ${n}`, libraryId: shelf.id });
      await updateItemWithTags(env.DB, b.id, {}, [], undefined, asha.id, undefined, { name: 'Discworld', number: n });
      if (n % 3 === 0) await addPastRead(env.DB, b.id, { status: 'completed', beganOn: null, endedOn: '2026-01-01' }, asha.id);
      last = b.id;
    }
    const seriesId = (await seriesRows())[0]!.id;
    const plain = await book(asha, { title: 'Standalone', libraryId: shelf.id });

    const withSeries = await count(asha, `/items/${last}`);
    const without = await count(asha, `/items/${plain.id}`);
    expect(withSeries.status).toBe(200);
    expect(withSeries.calls - without.calls).toBe(1); // the series and every volume's reading: one batch
    expect(withSeries.calls).toBeLessThanOrEqual(12);
    expect(await count(asha, `/series/${seriesId}`)).toMatchObject({ status: 200 });
    expect((await count(asha, `/series/${seriesId}`)).calls).toBeLessThanOrEqual(6);
    expect((await count(asha, '/series')).calls).toBeLessThanOrEqual(6);
    expect((await count(asha, `/items/${last}/edit`)).calls).toBeLessThanOrEqual(12);
  });
});
