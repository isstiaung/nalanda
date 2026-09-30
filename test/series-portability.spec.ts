// Series leave and come back through the CSV (CLAUDE.md's round trip), arrive from libib and Goodreads files, and
// reach share pages as a name and a number only (ARCH.md §9, §16 #52).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { as, book, html, member, rows } from './member-helpers';
import { createLibrary, createShare, getItem, updateItemWithTags } from '../src/db/queries';
import { toConnectionItem } from '../src/federation/items';
import { EXPORT_COLUMNS, mapGoodreadsRow, mapLibibRow, mapNalandaRow } from '../src/lib/csv';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';

/** RFC 4180, as public/import.js parses it. */
function parseCsv(text: string): Record<string, string>[] {
  const out: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field), out.push(row), (row = []), (field = '');
    } else field += ch;
  }
  if (field || row.length) out.push([...row, field]);
  const [header, ...body] = out;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
}

const inSeries = (id: number) =>
  rows<{ name: string | null; n: number | null; total: number | null }>(
    'SELECT s.name, i.series_number AS n, s.total FROM items i LEFT JOIN series s ON s.id = i.series_id WHERE i.id = ?1',
    id,
  ).then((r) => r[0]);

describe('series in the export', () => {
  it('go out as name, number and total, and come back from a Nalanda re-import', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const gods = await book(asha, { title: 'Gods of Risk', libraryId: shelf.id });
    const nemesis = await book(asha, { title: 'Nemesis Games', libraryId: shelf.id });
    const loose = await book(asha, { title: 'An anthology, "unnumbered"', libraryId: shelf.id });
    const alone = await book(asha, { title: 'Standalone', libraryId: shelf.id });
    await updateItemWithTags(env.DB, gods.id, {}, [], undefined, asha.id, undefined, { name: 'The Expanse, "Corey"', number: 2.5 });
    await updateItemWithTags(env.DB, nemesis.id, {}, [], undefined, asha.id, undefined, { name: 'The Expanse, "Corey"', number: 5 });
    await updateItemWithTags(env.DB, loose.id, {}, [], undefined, asha.id, undefined, { name: 'Anthologies', number: null });
    await env.DB.prepare("UPDATE series SET total = 9 WHERE name LIKE 'The Expanse%'").run();

    expect(EXPORT_COLUMNS).toEqual(expect.arrayContaining(['series', 'series_number', 'series_total']));
    const exported = parseCsv(await (await as(asha, '/export.csv?after=0')).text());
    expect(exported.map((r) => [r['title'], r['series'], r['series_number'], r['series_total']])).toEqual([
      ['Gods of Risk', 'The Expanse, "Corey"', '2.5', '9'],
      ['Nemesis Games', 'The Expanse, "Corey"', '5', '9'],
      ['An anthology, "unnumbered"', 'Anthologies', '', ''],
      ['Standalone', '', '', ''],
    ]);

    // into an empty catalog, as a move to a new instance would be
    await env.DB.batch([env.DB.prepare('DELETE FROM items'), env.DB.prepare('DELETE FROM series')]);
    const target = await createLibrary(env.DB, 'Restored');
    const res = await as(asha, '/api/import', { json: { libraryId: target.id, rows: exported } });
    expect(await res.json()).toMatchObject({ inserted: 4 });
    const back = await rows<{ id: number; title: string }>('SELECT id, title FROM items ORDER BY id');
    expect(await Promise.all(back.map((b) => inSeries(b.id)))).toEqual([
      { name: 'The Expanse, "Corey"', n: 2.5, total: 9 },
      { name: 'The Expanse, "Corey"', n: 5, total: 9 },
      { name: 'Anthologies', n: null, total: null },
      { name: null, n: null, total: null },
    ]);
    expect(await rows('SELECT count(*) AS n FROM series')).toEqual([{ n: 2 }]);
    // and exported again, it says exactly what it said
    const again = parseCsv(await (await as(asha, '/export.csv?after=0')).text());
    const pick = (r: Record<string, string>) => [r['title'], r['series'], r['series_number'], r['series_total']];
    expect(again.map(pick)).toEqual(exported.map(pick));
  });

  it('drop a number or total that isn’t one, keeping the series', () => {
    const row = Object.fromEntries(EXPORT_COLUMNS.map((c) => [c, '']));
    const m = mapNalandaRow({ ...row, title: 'Edited', series: ' The Expanse ', series_number: 'three', series_total: '-4' })!;
    expect(m.series).toEqual({ name: 'The Expanse', number: null, total: null });
    expect(mapNalandaRow({ ...row, title: 'None', series_number: '3' })!.series).toBeNull(); // a number needs a series
    // an export from before series has no such columns at all
    const { series: _a, series_number: _b, series_total: _c, ...older } = row;
    expect(mapNalandaRow({ ...older, title: 'Old' })!.series).toBeNull();
  });
});

describe('series from libib and Goodreads files', () => {
  const opts = { defaultType: 'book' as const, musicAsVinyl: true };

  it('takes libib’s group — its word for a series — as the series, and still as a tag', () => {
    const m = mapLibibRow({ title: 'Mort', creators: 'Terry Pratchett', group: 'Discworld' }, opts)!;
    expect(m.series).toEqual({ name: 'Discworld', number: null });
    expect(m.tags).toContain('Discworld');
    expect(JSON.parse(m.item.details!)).toEqual({});
    // a file with series columns of its own is taken at its word, and they don't fall into details
    const own = mapLibibRow({ title: 'Mort', series: 'Death', series_number: '1', group: 'Discworld' }, opts)!;
    expect(own.series).toEqual({ name: 'Death', number: 1 });
    expect(JSON.parse(own.item.details!)).toEqual({});
    expect(mapLibibRow({ title: 'Loose' }, opts)!.series).toBeNull();
  });

  it('splits a Goodreads title’s series suffix into the series, and keeps a merged book’s own', async () => {
    const m = mapGoodreadsRow({ Title: 'The Gunslinger (The Dark Tower, #1)', Author: 'Stephen King', 'Exclusive Shelf': 'read' })!;
    expect(m.item.title).toBe('The Gunslinger');
    expect(m.series).toEqual({ name: 'The Dark Tower', number: 1 });
    expect(mapGoodreadsRow({ Title: 'Dune', 'Exclusive Shelf': 'to-read' })!.series).toBeNull();

    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    // already here, from an older import: its title still carries the suffix, and it has no series
    const held = await book(asha, { title: 'The Drawing of the Three (The Dark Tower, #2)', creators: 'Stephen King', libraryId: shelf.id });
    const file = [
      { Title: 'The Gunslinger (The Dark Tower, #1)', Author: 'Stephen King', 'Exclusive Shelf': 'read', 'Date Read': '2024/01/01' },
      { Title: 'The Drawing of the Three (The Dark Tower, #2)', Author: 'Stephen King', 'Exclusive Shelf': 'read', 'My Rating': '4' },
    ];
    const res = await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: file } });
    expect(await res.json()).toMatchObject({ inserted: 1, merged: 1 });
    const fresh = (await rows<{ id: number }>("SELECT id FROM items WHERE title = 'The Gunslinger'"))[0]!;
    expect(await inSeries(fresh.id)).toEqual({ name: 'The Dark Tower', n: 1, total: null });
    // a merge never touches bibliographic fields (§16 #14): no series, and its title as it was
    expect(await inSeries(held.id)).toEqual({ name: null, n: null, total: null });
    expect((await getItem(env.DB, held.id))!.title).toBe('The Drawing of the Three (The Dark Tower, #2)');
    // a second run matches the stripped title to what the first inserted, and adds nothing
    const rerun = await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: file } });
    expect(await rerun.json()).toMatchObject({ inserted: 0, merged: 2 });
  });
});

describe('series on share pages', () => {
  async function scene() {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const first = await book(asha, { title: 'Leviathan Wakes', libraryId: shelf.id });
    const third = await book(asha, { title: 'Abaddon’s Gate', libraryId: shelf.id });
    const plain = await book(asha, { title: 'Standalone', libraryId: shelf.id });
    await updateItemWithTags(env.DB, first.id, {}, [], undefined, asha.id, undefined, { name: 'The Expanse', number: 1 });
    await updateItemWithTags(env.DB, third.id, {}, [], undefined, asha.id, undefined, { name: 'The Expanse', number: 3 });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: shelf.id });
    clearSharePageCache();
    return { asha, first, third, plain, share };
  }

  it('show an item’s series name and number, like its publisher', async () => {
    const { third, share } = await scene();
    const page = await html(null, `/share/${share.token}/items/${third.id}`);
    expect(page).toContain('<dt>Series</dt><dd>The Expanse<span class="mono">#3</span></dd>');
  });

  it('never show the gaps, anyone’s next up, or a link into the app’s series pages', async () => {
    const { asha, first, third, share } = await scene();
    const inApp = await html(asha, `/items/${third.id}`);
    expect(inApp).toContain('Next up for you'); // the signed-in page has them…
    expect(inApp).toContain('class="vol missing"');
    for (const id of [first.id, third.id]) {
      const page = await html(null, `/share/${share.token}/items/${id}`);
      for (const inside of ['Next up', 'Missing', 'series-strip', 'vol missing', '/series/', 'Not in the catalog']) {
        expect(page, inside).not.toContain(inside);
      }
    }
    const listing = await html(null, `/share/${share.token}`);
    expect(listing).not.toContain('The Expanse'); // listings are as before
  });

  it('leave an item in no series exactly as it was', async () => {
    const { plain, share } = await scene();
    const page = await html(null, `/share/${share.token}/items/${plain.id}`);
    expect(page).not.toContain('<dt>Series</dt>');
  });

  it('add the key only when the page passes the item’s own series — and connections never get it', async () => {
    const { third } = await scene();
    const item = (await getItem(env.DB, third.id))!;
    expect(toPublicItem(item)).not.toHaveProperty('series');
    expect(toPublicItem(item, { series: { id: item.seriesId!, name: 'The Expanse' } }).series).toEqual({ name: 'The Expanse', number: 3 });
    expect(toPublicItem(item, { series: { id: item.seriesId! + 1, name: 'Another' } })).not.toHaveProperty('series');
    const toPeer = toConnectionItem(item) as unknown as Record<string, unknown>;
    for (const key of ['series', 'seriesId', 'seriesNumber']) expect(toPeer).not.toHaveProperty(key);
  });
});
