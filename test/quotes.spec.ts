// Quotes and highlights (ARCH.md §16 #77): a member's own, private until marked shared; the Kindle import, parsed in
// the browser's module and matched by title and author; the CSV cell; the trash; and what a share page may show.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addQuote, createLibrary, createShare, deleteItem, deleteUser, getItem, listMembersWithKeys, listTrash, memberKeys, quotesOf, restoreFromTrash, updateSiteSettings } from '../src/db/queries';
import { mapNalandaRow } from '../src/lib/csv';
import { cleanKindleBook, cleanQuote, formatQuotesCell, MAX_QUOTES_PER_ITEM, parseQuotesCell } from '../src/lib/quotes';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { kindleDate, parseClippings, parseKindle, parseNotebookHtml } from '../public/kindle.js';
import { as, book, html, member, rows, upgradedSwitches, type Member } from './member-helpers';

describe('the quotes library', () => {
  it('tidies a quote and reads a cell back', () => {
    expect(cleanQuote({ text: '  A line.\r\nAnother.  \n', page: ' p. 42 ', note: 'mine', shared: '1' })).toEqual({ text: 'A line.\nAnother.', page: 'p. 42', note: 'mine', shared: true, at: null, source: null });
    expect(cleanQuote({ text: '   ' })).toBeNull();
    expect(cleanQuote({ text: 'x', at: '2026-01-02 03:04:05', source: 'kindle' })).toMatchObject({ at: '2026-01-02 03:04:05', source: 'kindle' });
    expect(cleanQuote({ text: 'x', at: 'yesterday', source: 'other' })).toMatchObject({ at: null, source: null });
    const cell = formatQuotesCell([{ by: 'asha', text: 'A', page: '1', note: null, shared: true, at: '2026-01-01 00:00:00', source: null }, { text: 'B', page: null, note: 'n', shared: false }]);
    expect(parseQuotesCell(cell)).toEqual([
      { by: 'asha', text: 'A', page: '1', note: null, shared: true, at: '2026-01-01 00:00:00', source: null },
      { by: null, text: 'B', page: null, note: 'n', shared: false, at: null, source: null },
    ]);
    expect(parseQuotesCell('[{"text":"keep"},{"nope":1},"x"]')).toEqual([{ text: 'keep', page: null, note: null, shared: false, at: null, source: null }]);
    expect(parseQuotesCell('not json')).toEqual([]);
    expect(cleanKindleBook({ title: ' Piranesi ', author: 'Susanna Clarke', highlights: [{ text: 'A house', page: 'p. 1', note: null, at: 'bad' }, { text: '' }] })).toEqual({
      title: 'Piranesi',
      author: 'Susanna Clarke',
      highlights: [{ text: 'A house', page: 'p. 1', note: null, at: null }],
    });
    expect(cleanKindleBook({ title: 'x', highlights: [] })).toBeNull();
  });
});

const CLIPPINGS = `﻿Piranesi (Clarke, Susanna)
- Your Highlight on page 12 | Location 180-182 | Added on Monday, 1 September 2025 21:14:03

The Beauty of the House is immeasurable; its Kindness infinite.
==========
Piranesi (Clarke, Susanna)
- Your Note on page 12 | Location 182 | Added on Monday, 1 September 2025 21:15:10

First line. Keep this.
==========
Piranesi (Clarke, Susanna)
- Your Bookmark on page 30 | Location 450 | Added on Tuesday, 2 September 2025 08:00:00


==========
The Dispossessed (Ursula K. Le Guin)
- Your Highlight on Location 1012-1014 | Added on Wednesday, 3 September 2025 07:30:00

There was a wall. It did not look important.
==========
The Dispossessed (Ursula K. Le Guin)
- Your Note on Location 2000 | Added on Wednesday, 3 September 2025 07:40:00

A note on its own, with no highlight here.
==========
`;

describe('the Kindle parser (public/kindle.js)', () => {
  it('reads My Clippings.txt: books, highlights with their notes, bookmarks ignored, "Last, First" turned round', () => {
    const books = parseClippings(CLIPPINGS);
    expect(books.map((b) => [b.title, b.author])).toEqual([
      ['Piranesi', 'Susanna Clarke'],
      ['The Dispossessed', 'Ursula K. Le Guin'],
    ]);
    expect(books[0]!.highlights).toEqual([
      { text: 'The Beauty of the House is immeasurable; its Kindness infinite.', page: 'p. 12', note: 'First line. Keep this.', at: '2025-09-01 21:14:03' },
    ]);
    expect(books[1]!.highlights).toEqual([
      { text: 'There was a wall. It did not look important.', page: 'loc. 1012-1014', note: null, at: '2025-09-03 07:30:00' },
      // a note with no highlight at its place: kept as the reader's own words, text and note alike
      { text: 'A note on its own, with no highlight here.', page: 'loc. 2000', note: 'A note on its own, with no highlight here.', at: '2025-09-03 07:40:00' },
    ]);
    expect(kindleDate('Monday, 1 September 2025 21:14:03')).toBe('2025-09-01 21:14:03');
    expect(kindleDate('September 1, 2025 9:14:03 PM')).toBe('2025-09-01 21:14:03');
    expect(kindleDate('not a date')).toBeNull();
    expect(parseKindle(CLIPPINGS)).toHaveLength(2);
    expect(parseClippings('')).toEqual([]);
  });

  it('reads the app’s notebook export (HTML)', () => {
    const html = `<html><body><div class="bookTitle">Piranesi</div><div class="authors">Clarke, Susanna</div>
      <div class="noteHeading">Highlight (<span class="highlight_yellow">Yellow</span>) - Page 12 · Location 180</div>
      <div class="noteText">The Beauty of the House &amp; its Kindness.</div>
      <div class="noteHeading">Note - Page 12 · Location 182</div>
      <div class="noteText">Keep this.</div>
      <div class="noteHeading">Highlight (<span>Blue</span>) - Location 900</div>
      <div class="noteText">Second.</div></body></html>`;
    expect(parseNotebookHtml(html)).toEqual([
      {
        title: 'Piranesi',
        author: 'Susanna Clarke',
        highlights: [
          { text: 'The Beauty of the House & its Kindness.', page: 'p. 12', note: 'Keep this.', at: null },
          { text: 'Second.', page: 'loc. 900', note: null, at: null },
        ],
      },
    ]);
    expect(parseKindle(html)[0]!.title).toBe('Piranesi');
  });
});

async function household() {
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  const shelf = await createLibrary(env.DB, 'Fiction');
  return { asha, ravi, shelf };
}
const quotesIn = (itemId: number) => rows<{ userId: number | null; text: string; page: string | null; note: string | null; shared: number; source: string | null }>('SELECT user_id AS userId, text, page, note, shared, source FROM quotes WHERE item_id = ?1 ORDER BY id', itemId);

describe('on a book’s page', () => {
  it('a member adds, edits, shares and deletes their own quote; another member may not; an admin may', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    expect((await as(ravi, `/items/${b.id}/quotes`, { body: { text: 'The Beauty of the House.', where: 'p. 12', note: 'love this' } })).status).toBe(302);
    expect((await as(ravi, `/items/${b.id}/quotes`, { body: { text: '   ' } })).headers.get('location')).toBe(`/items/${b.id}?quote=refused#quotes`);
    expect(await html(ravi, `/items/${b.id}?quote=refused`)).toContain('A quote needs some text.');
    let list = await quotesIn(b.id);
    expect(list).toEqual([{ userId: ravi.id, text: 'The Beauty of the House.', page: 'p. 12', note: 'love this', shared: 0, source: null }]);
    const page = await html(ravi, `/items/${b.id}`);
    expect(page).toContain('Quotes and highlights');
    expect(page).toContain('<blockquote class="quote-text prewrap">The Beauty of the House.</blockquote>');
    expect(page).toContain('You <span class="muted">· ravi</span>');
    expect(page).toContain('love this');
    const id = (await rows<{ id: number }>('SELECT id FROM quotes WHERE item_id = ?1', b.id))[0]!.id;
    // asha is an admin: she may edit it; a plain other member may not
    const mira = await member('mira');
    expect((await as(mira, `/items/${b.id}/quotes/${id}`, { body: { text: 'changed' } })).status).toBe(403);
    expect((await as(ravi, `/items/${b.id}/quotes/${id}`, { body: { text: 'The Beauty of the House is immeasurable.', where: 'p. 12', shared: '1' } })).status).toBe(302);
    list = await quotesIn(b.id);
    expect(list[0]).toMatchObject({ text: 'The Beauty of the House is immeasurable.', shared: 1, note: null });
    expect(await html(asha, `/items/${b.id}`)).toContain('<span class="pill">Shared</span>');
    expect((await as(asha, `/items/${b.id}/quotes/${id}`, { body: { text: 'Admin edit', shared: '' } })).status).toBe(302);
    expect((await quotesIn(b.id))[0]).toMatchObject({ text: 'Admin edit', shared: 0 });
    expect((await as(mira, `/items/${b.id}/quotes/${id}/delete`, { body: {} })).status).toBe(403);
    expect((await as(ravi, `/items/${b.id}/quotes/${id}/delete`, { body: {} })).status).toBe(302);
    expect(await quotesIn(b.id)).toEqual([]);
  });

  it('holds at most 500 quotes, checked where it writes, and takes none on a record or a game', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    await env.DB.prepare("INSERT INTO quotes (item_id, user_id, text, shared, at) SELECT ?1, ?2, 'line ' || value, 0, datetime('now') FROM json_each(?3)")
      .bind(b.id, ravi.id, JSON.stringify(Array.from({ length: MAX_QUOTES_PER_ITEM }, (_, i) => i)))
      .run();
    expect(await addQuote(env.DB, b.id, ravi.id, { text: 'One more', page: null, note: null, shared: false })).toBe(false);
    const res = await as(ravi, `/items/${b.id}/quotes`, { body: { text: 'One more' } });
    expect(res.headers.get('location')).toBe(`/items/${b.id}?quote=full#quotes`);
    expect(await html(ravi, `/items/${b.id}?quote=full`)).toContain('as many quotes as it can hold (500)');
    expect(await quotesIn(b.id)).toHaveLength(MAX_QUOTES_PER_ITEM);
    // a record: its page has no quotes section, and the route takes none either
    const record = await book(asha, { libraryId: shelf.id, title: 'Kind of Blue', mediaType: 'vinyl' });
    expect((await as(ravi, `/items/${record.id}/quotes`, { body: { text: 'So what' } })).status).toBe(400);
    expect(await quotesIn(record.id)).toEqual([]);
  });

  it('lists a member’s quotes, newest first, on their page — and the household picks whose', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    const c2 = await book(asha, { libraryId: shelf.id, title: 'The Dispossessed' });
    await as(ravi, `/items/${b.id}/quotes`, { body: { text: 'First' } });
    await env.DB.prepare("UPDATE quotes SET at = '2026-01-01 00:00:00'").run();
    await as(ravi, `/items/${c2.id}/quotes`, { body: { text: 'Second', where: 'loc. 10' } });
    const mine = await html(ravi, '/quotes');
    expect(mine).toContain('<h1>Your quotes</h1>');
    expect(mine.indexOf('Second')).toBeLessThan(mine.indexOf('First'));
    expect(mine).toContain('The Dispossessed');
    expect(await html(asha, `/quotes?member=${ravi.id}`)).toContain('<h1>ravi’s quotes</h1>');
    expect(await html(asha, '/quotes')).toContain('No quotes yet');
    expect(await html(asha, '/')).toContain('href="/quotes"');
    const { quotes, more } = await quotesOf(env.DB, ravi.id, 1);
    expect(quotes.map((q) => q.text)).toEqual(['Second', 'First']);
    expect(more).toBe(false);
  });
});

describe('what leaves the app', () => {
  it('a share page shows only shared quotes, never a note, signed only while names are on; the whitelist is byte-identical otherwise', async () => {
    const { asha, ravi, shelf } = await household();
    const { setDisplayName } = await import('../src/db/queries');
    await setDisplayName(env.DB, ravi.id, 'Ravi K.');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    await as(ravi, `/items/${b.id}/quotes`, { body: { text: 'SHARED-LINE', where: 'p. 12', note: 'SECRET-NOTE', shared: '1' } });
    await as(ravi, `/items/${b.id}/quotes`, { body: { text: 'PRIVATE-LINE', note: 'SECRET-NOTE-2' } });
    const item = (await getItem(env.DB, b.id))!;
    expect(JSON.stringify(toPublicItem(item))).toBe(JSON.stringify(toPublicItem(item, { quotes: [] })));
    expect(toPublicItem(item, { quotes: [{ by: 'Ravi K.', text: 'x', page: null }] }).quotes).toEqual([{ by: 'Ravi K.', text: 'x', page: null }]);
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Shelf', libraryId: shelf.id });
    await upgradedSwitches(); // names off
    clearSharePageCache();
    let text = await (await as(null, `/share/${token}/items/${b.id}`)).text();
    expect(text).toContain('SHARED-LINE');
    expect(text).toContain('<span class="reviewer">A member</span>');
    expect(text).not.toContain('PRIVATE-LINE');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('ravi');
    await updateSiteSettings(env.DB, { namesOnShares: true });
    clearSharePageCache();
    text = await (await as(null, `/share/${token}/items/${b.id}`)).text();
    expect(text).toContain('<span class="reviewer">Ravi K.</span>');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('>ravi<');
  });
});

async function postKindle(who: Member, body: unknown) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request('http://nalanda.test/api/import/kindle', { method: 'POST', headers: { origin: 'http://nalanda.test', cookie: who.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('the Kindle import', () => {
  it('matches books by title and author, makes Not owned entries for the rest, and adds nothing twice', async () => {
    const { asha, ravi, shelf } = await household();
    const here = await book(asha, { libraryId: shelf.id, title: 'Piranesi', creators: 'Susanna Clarke' });
    const books = parseClippings(CLIPPINGS);
    const dry = await postKindle(ravi, { libraryId: shelf.id, dryRun: true, books });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ matched: 1, created: 1, quotes: 3, duplicates: 0, skipped: 0 });
    expect(await rows('SELECT 1 FROM quotes')).toEqual([]);
    const run = await postKindle(ravi, { libraryId: shelf.id, books });
    expect(run.json).toMatchObject({ matched: 1, created: 1, quotes: 3, duplicates: 0 });
    expect(await quotesIn(here.id)).toEqual([{ userId: ravi.id, text: 'The Beauty of the House is immeasurable; its Kindness infinite.', page: 'p. 12', note: 'First line. Keep this.', shared: 0, source: 'kindle' }]);
    const [made] = await rows<{ id: number; copies: number; creators: string; addedBy: number }>("SELECT id, copies, creators, added_by AS addedBy FROM items WHERE title = 'The Dispossessed'");
    expect(made).toMatchObject({ copies: 0, creators: 'Ursula K. Le Guin', addedBy: ravi.id });
    expect((await quotesIn(made!.id)).map((q) => q.text)).toEqual(['There was a wall. It did not look important.', 'A note on its own, with no highlight here.']);
    expect(await rows("SELECT at FROM quotes WHERE text LIKE 'There was a wall%'")).toEqual([{ at: '2025-09-03 07:30:00' }]);
    // again: nothing twice, and the book made once is matched now
    const again = await postKindle(ravi, { libraryId: shelf.id, books });
    expect(again.json).toMatchObject({ matched: 2, created: 0, quotes: 0, duplicates: 3 });
    expect(await rows('SELECT count(*) AS n FROM quotes')).toEqual([{ n: 3 }]);
    // limits and junk
    expect((await postKindle(ravi, { libraryId: shelf.id, books: Array.from({ length: 26 }, () => books[0]) })).status).toBe(400);
    expect((await postKindle(ravi, { libraryId: 999, books })).status).toBe(400);
    expect((await postKindle(ravi, { libraryId: shelf.id, books: ['junk', { title: '' }] })).json).toMatchObject({ matched: 0, created: 0, skipped: 2 });
    expect(await html(ravi, '/import')).toContain('id="kindle-file"');
  });
});

describe('the CSV, the trash and a removed member', () => {
  it('exports the quotes cell with usernames, maps it back, restores from the trash, and keeps a former member’s as nobody’s', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    await as(ravi, `/items/${b.id}/quotes`, { body: { text: 'Kept line', where: 'p. 3', shared: '1' } });
    const csv = await (await as(asha, '/export.csv')).text();
    const header = csv.split('\n')[0]!;
    expect(header).toContain('quotes');
    const line = csv.split('\n').find((l) => l.includes('Piranesi'))!;
    expect(line).toContain('""by"":""ravi""');
    expect(line).toContain('Kept line');
    const mapped = mapNalandaRow({ title: 'X', media_type: 'book', quotes: '[{"by":"ravi","text":"Kept line","page":"p. 3","shared":true}]' });
    expect(mapped?.quotes).toEqual([{ by: 'ravi', text: 'Kept line', page: 'p. 3', note: null, shared: true, at: null, source: null }]);
    // the trash carries them and restore brings them back to the same person
    await deleteItem(env.DB, b.id, { id: asha.id, sessionKey: asha.sessionKey });
    const [row] = await listTrash(env.DB);
    const out = await restoreFromTrash(env.DB, row!.id, memberKeys(await listMembersWithKeys(env.DB)));
    const newId = (out as { id: number }).id;
    expect(await quotesIn(newId)).toEqual([{ userId: ravi.id, text: 'Kept line', page: 'p. 3', note: null, shared: 1, source: null }]);
    // a removed member's quote stays, nobody's, and still shows on the page as a former member's
    await deleteUser(env.DB, ravi.id);
    expect(await quotesIn(newId)).toEqual([{ userId: null, text: 'Kept line', page: 'p. 3', note: null, shared: 1, source: null }]);
    expect(await html(asha, `/items/${newId}`)).toContain('Former member');
  });

  it('an admin’s import of a household export keeps each quote with its writer, and a former member’s with nobody', async () => {
    const { asha, ravi, shelf } = await household();
    const mira = await member('mira');
    const row = {
      library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '', completed_on: '',
      title: 'Piranesi',
      reads: 'completed:..2024-01-01@ravi',
      quotes: JSON.stringify([
        { by: 'ravi', text: 'Ravi’s line', page: 'p. 3', shared: true },
        { by: null, text: 'A former member’s line', page: null, shared: false },
        { by: 'nobody-here', text: 'A stranger’s line', page: null, shared: false },
      ]),
    };
    expect((await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: [row] } })).status).toBe(200);
    const id = (await rows<{ id: number }>("SELECT id FROM items WHERE title = 'Piranesi' ORDER BY id DESC"))[0]!.id;
    // the quotes follow the same rule as the read: a member of that name keeps theirs, a former member's stays nobody's,
    // and an unknown name is the importer's — never every one the importer's
    expect((await quotesIn(id)).map((q) => [q.userId, q.text])).toEqual([
      [ravi.id, 'Ravi’s line'],
      [null, 'A former member’s line'],
      [asha.id, 'A stranger’s line'],
    ]);
    // a member's import is all theirs, as their reads and reviews are — only an admin's keeps names
    expect((await as(mira, '/api/import', { json: { libraryId: shelf.id, rows: [{ ...row, title: 'Piranesi again' }] } })).status).toBe(200);
    const again = (await rows<{ id: number }>("SELECT id FROM items WHERE title = 'Piranesi again'"))[0]!.id;
    expect((await quotesIn(again)).map((q) => q.userId)).toEqual([mira.id, mira.id, mira.id]);
  });
});
