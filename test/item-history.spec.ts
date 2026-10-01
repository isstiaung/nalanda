// Item history (ARCH.md §16 #84): every change to one of an item's own fields, from whatever path, recorded by the
// triggers with who made it (the `acting` row the writing batch sets), read by admins on the item page, purged after
// 90 days. Never the reading summary, never a member's page.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  addPastRead,
  bulkMove,
  bulkSetOwned,
  createItem,
  createLibrary,
  deleteUser,
  HISTORY_DAYS,
  setCover,
  updateItem,
  updateItemWithTags,
  updateSeries,
} from '../src/db/queries';
import type { NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';
import { as, html, member, rows } from './member-helpers';

async function shelf() {
  const lib = await createLibrary(env.DB, 'Books');
  const item = (values: Partial<NewItem>) => createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'x', ...values });
  return { lib, item };
}

type Row = { field: string; before: string | null; after: string | null; changed_by: number | null; changed_key: string | null };
const history = (itemId: number) => rows<Row>('SELECT field, before, after, changed_by, changed_key FROM item_history WHERE item_id = ?1 ORDER BY id', itemId);

describe('what the triggers record', () => {
  it('each changed field once, with before and after, from a plain update — nobody named without a writer', async () => {
    const { item } = await shelf();
    const book = await item({ title: 'Old title', creators: 'Someone', copies: 1 });
    await updateItem(env.DB, book.id, { title: 'New title', notes: 'a note', copies: 2 });
    expect(await history(book.id)).toEqual([
      { field: 'title', before: 'Old title', after: 'New title', changed_by: null, changed_key: null },
      { field: 'copies', before: '1', after: '2', changed_by: null, changed_key: null },
      { field: 'notes', before: null, after: 'a note', changed_by: null, changed_key: null },
    ]);
    // the same value written again is no change
    await updateItem(env.DB, book.id, { title: 'New title' });
    expect(await history(book.id)).toHaveLength(3);
    // the acting row never outlives the batch
    expect(await rows('SELECT * FROM acting')).toEqual([]);
  });

  it('names the writer, keeps the shelf and series by name and the cover as a cover, and cuts long values to 200 characters', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const other = await createLibrary(env.DB, 'Loft');
    const book = await item({ title: 'Moved', description: 'short' });
    await updateItemWithTags(env.DB, book.id, { libraryId: other.id, description: 'x'.repeat(500) }, [], undefined, ravi.id, undefined, { name: 'The Cycle', number: 2, total: null }, undefined, {
      id: ravi.id,
      sessionKey: ravi.sessionKey,
    });
    await setCover(env.DB, book.id, 'abc', { id: ravi.id, sessionKey: ravi.sessionKey });
    await setCover(env.DB, book.id, null, { id: ravi.id, sessionKey: ravi.sessionKey });
    const h = await history(book.id);
    const of = (field: string) => h.filter((r) => r.field === field).map((r) => [r.before, r.after]);
    expect(of('library_id')).toEqual([['Books', 'Loft']]);
    expect(of('series_id')).toEqual([[null, 'The Cycle']]);
    expect(of('series_number')).toEqual([[null, '2']]);
    expect(of('description')).toEqual([['short', 'x'.repeat(200)]]);
    expect(of('cover_key')).toEqual([
      [null, 'a cover'],
      ['a cover', null],
    ]);
    for (const r of h) expect([r.changed_by, r.changed_key]).toEqual([ravi.id, ravi.sessionKey]);
    expect(await rows('SELECT * FROM acting')).toEqual([]);
  });

  it('never records the reading summary, which reads carry already', async () => {
    const { item } = await shelf();
    const ravi = await member('ravi');
    const book = await item({ title: 'Read' });
    await addPastRead(env.DB, book.id, { status: 'completed', beganOn: null, endedOn: '2026-01-10' }, ravi.id);
    expect(await history(book.id)).toEqual([]);
  });

  it('comes from every path: the Holding toggle, the edit form, bulk edit and a cover change, each with who', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const asha = await member('asha', 'admin');
    const book = await item({ title: 'Toggled', copies: 0 });
    await as(ravi, `/items/${book.id}/mark-owned`, { body: {}, htmx: true });
    await as(asha, `/items/${book.id}/mark-not-owned`, { body: {}, htmx: true });
    await as(ravi, `/items/${book.id}`, { body: { title: 'Edited', libraryId: String(lib.id), mediaType: 'book', copies: '1', location: 'Loft' } });
    const other = await createLibrary(env.DB, 'Elsewhere');
    await bulkMove(env.DB, [book.id], other.id, { id: asha.id, sessionKey: asha.sessionKey });
    await bulkSetOwned(env.DB, [book.id], false, { id: asha.id, sessionKey: asha.sessionKey });
    const h = await history(book.id);
    expect(h.map((r) => [r.field, r.before, r.after, r.changed_by])).toEqual([
      ['copies', '0', '1', ravi.id],
      ['copies', '1', '0', asha.id],
      ['title', 'Toggled', 'Edited', ravi.id],
      ['copies', '0', '1', ravi.id],
      ['location', null, 'Loft', ravi.id],
      ['language', null, 'en', ravi.id], // the edit form gives an item with no language the household's (§16 #76)
      ['library_id', 'Books', 'Elsewhere', asha.id],
      ['copies', '1', '0', asha.id],
    ]);
  });
});

describe('a series merged by rename', () => {
  it('names who renamed it on every volume moved, as any other item write does', async () => {
    const { item } = await shelf();
    const asha = await member('asha', 'admin');
    const a = await item({ title: 'A' });
    const b = await item({ title: 'B' });
    const w = { id: asha.id, sessionKey: asha.sessionKey };
    await updateItemWithTags(env.DB, a.id, {}, [], undefined, asha.id, undefined, { name: 'Expanse', number: 1, total: null }, undefined, w);
    await updateItemWithTags(env.DB, b.id, {}, [], undefined, asha.id, undefined, { name: 'The Expanse', number: 2, total: null }, undefined, w);
    const sid = (await rows<{ id: number }>("SELECT id FROM series WHERE name = 'Expanse'"))[0]!.id;
    expect((await as(asha, `/series/${sid}`, { body: { name: 'The Expanse', total: '' } })).status).toBe(302);
    const moved = (await history(a.id)).filter((r) => r.field === 'series_id');
    expect(moved.map((r) => [r.before, r.after, r.changed_by])).toEqual([
      [null, 'Expanse', asha.id],
      ['Expanse', 'The Expanse', asha.id],
    ]);
    // and through the function with a writer; nobody named only when nobody is given
    const c = await item({ title: 'C' });
    await updateItemWithTags(env.DB, c.id, {}, [], undefined, asha.id, undefined, { name: 'Dune', number: 1, total: null }, undefined, w);
    const dune = (await rows<{ id: number }>("SELECT id FROM series WHERE name = 'Dune'"))[0]!.id;
    expect(await updateSeries(env.DB, dune, 'the expanse', null, w)).toBe((await rows<{ id: number }>("SELECT id FROM series WHERE name = 'The Expanse'"))[0]!.id);
    expect((await history(c.id)).filter((r) => r.field === 'series_id').at(-1)).toMatchObject({ before: 'Dune', after: 'The Expanse', changed_by: asha.id });
  });
});

describe('the item page', () => {
  const calls = async (cookie: string, path: string) => {
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie } }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
    await res.text();
    await waitOnExecutionContext(ctx);
    return 1000 - budget.left;
  };

  it('shows the history to admins only, newest first, naming a member while the account is theirs — and costs no call', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const asha = await member('asha', 'admin');
    const book = await item({ title: 'Watched' });
    await as(ravi, `/items/${book.id}`, { body: { title: 'Watched closely', libraryId: String(lib.id), mediaType: 'book', copies: '1' } });
    await updateItem(env.DB, book.id, { publisher: 'Nobody Press' }); // a script's change: nobody named
    expect(await html(ravi, `/items/${book.id}`)).not.toContain('class="item-history"');
    const page = await html(asha, `/items/${book.id}`);
    expect(page).toContain('class="item-history"');
    expect(page).toContain('3 changes'); // the title, the language the form filled in, the publisher
    const table = page.slice(page.indexOf('class="item-history"'));
    expect(table.indexOf('Nobody Press')).toBeLessThan(table.indexOf('Watched closely')); // newest first
    expect(table).toMatch(/<td>ravi<\/td><td>Title<\/td><td class="history-value">Watched<\/td><td class="history-value">Watched closely<\/td>/);
    expect(table).toMatch(/<td><span class="muted">—<\/span><\/td><td>Publisher<\/td>/);
    // the history rides in the page's batch: an admin's item page makes the calls a member's does
    expect(await calls(asha.cookie, `/items/${book.id}`)).toBe(await calls(ravi.cookie, `/items/${book.id}`));
  });

  it('calls a removed member "a former member", and a newcomer given their id too (#56)', async () => {
    const { lib, item } = await shelf();
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi'); // made last, so a newcomer after their removal is given their id
    const book = await item({ title: 'Once' });
    await as(ravi, `/items/${book.id}`, { body: { title: 'Twice', libraryId: String(lib.id), mediaType: 'book', copies: '1' } });
    await deleteUser(env.DB, ravi.id);
    expect(await html(asha, `/items/${book.id}`)).toMatch(/<td>a former member<\/td><td>Title<\/td>/);
    const newcomer = await member('newcomer');
    expect(newcomer.id).toBe(ravi.id);
    const page = await html(asha, `/items/${book.id}`);
    expect(page).toMatch(/<td>a former member<\/td><td>Title<\/td>/);
    expect(page).not.toContain('<td>newcomer</td>');
  });

  it('lets go of changes older than the kept days at the next item write — never on a read — and of an item’s when the item goes', async () => {
    const { item } = await shelf();
    const asha = await member('asha', 'admin');
    const book = await item({ title: 'Aging' });
    const other = await item({ title: 'Another' });
    await updateItem(env.DB, book.id, { title: 'Aged' });
    await env.DB.prepare(`UPDATE item_history SET at = datetime('now', '-${HISTORY_DAYS + 1} days') WHERE item_id = ?1`).bind(book.id).run();
    // an admin's read is read-only — the old row is still there — and the page keeps to the window, so it isn't listed
    expect(await html(asha, `/items/${book.id}`)).toContain('no changes');
    expect(await history(book.id)).toHaveLength(1);
    // any item's write sweeps it, with the index on `at`
    await updateItem(env.DB, other.id, { title: 'Another, renamed' });
    expect(await history(book.id)).toHaveLength(0);
    await updateItem(env.DB, book.id, { title: 'Aged twice' });
    expect(await history(book.id)).toHaveLength(1);
    expect(await html(asha, `/items/${book.id}`)).toContain('1 change');
    await as(asha, `/items/${book.id}/delete`, { body: {} });
    expect(await history(book.id)).toEqual([]);
  });
});
