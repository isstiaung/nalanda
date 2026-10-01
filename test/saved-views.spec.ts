// Saved views (ARCH.md §16 #81): a shelf's filter bar saved under a name, the household's — any member saves,
// replaces or deletes one; two decluttering presets on every shelf; the two decluttering filters behind them,
// in the app only.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addPastRead, createItem, createLibrary, deleteSavedView, deleteUser, listItems, listSavedViews, logPlay, MAX_SAVED_VIEWS_PER_SHELF, saveView } from '../src/db/queries';
import type { NewItem } from '../src/db/schema';
import { parseShelfQuery, readByValue, shelfQueryString } from '../src/routes/libraries';
import { as, html, member, rows } from './member-helpers';

const TODAY = '2026-10-01';

async function shelf() {
  const lib = await createLibrary(env.DB, 'Books');
  const item = (values: Partial<NewItem>) => createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'x', ...values });
  return { lib, item };
}

const aged = (id: number, addedAt: string) => env.DB.prepare('UPDATE items SET added_at = ?1 WHERE id = ?2').bind(addedAt, id).run();

describe('the shelf query', () => {
  it('reads only what the bar can write, and writes it back the same way', () => {
    const sp = new URLSearchParams('type=book&type=nope&status=not_started&owned=1&format=hardcover&q=+loft+&readBy=me&sort=rating&addedYears=3&unplayedMonths=12&page=4&view=grid&evil=1');
    const q = parseShelfQuery(sp, 7, [{ id: 7 }]);
    expect(q.mediaTypes).toEqual(['book']);
    expect(q.statuses).toEqual(['not_started']);
    expect(q.owned).toBe(true);
    expect(q.formatsSel).toEqual(['hardcover']);
    expect(q.name).toBe('loft');
    expect(q.reader).toEqual({ readerId: 7, mode: 'finished' });
    expect(q.sort).toBe('rating');
    expect(q.addedYears).toBe(3);
    expect(q.unplayedMonths).toBe(12);
    expect(q.filtered).toBe(true);
    // the page and the display are never part of a view, and an unknown key is dropped
    expect(shelfQueryString(q)).toBe('type=book&status=not_started&owned=1&format=hardcover&q=loft&readBy=me&sort=rating&addedYears=3&unplayedMonths=12');
    // a bad count is no filter; a member who isn't one is no "Read by"
    const bad = parseShelfQuery(new URLSearchParams('addedYears=0&unplayedMonths=abc&readBy=99'), 7, [{ id: 7 }]);
    expect(bad.addedYears).toBeUndefined();
    expect(bad.unplayedMonths).toBeUndefined();
    expect(bad.reader).toBeUndefined();
    expect(bad.filtered).toBe(false);
    expect(shelfQueryString(bad)).toBe('');
  });
});

describe('the decluttering filters', () => {
  it('"added years ago" keeps what has sat unread since, dated by the device\'s day', async () => {
    const { lib, item } = await shelf();
    const old = await item({ title: 'Old' });
    const recent = await item({ title: 'Recent' });
    const edge = await item({ title: 'Edge' });
    await aged(old.id, '2020-05-05 10:00:00');
    await aged(recent.id, '2025-05-05 10:00:00');
    await aged(edge.id, '2023-10-01 23:59:59'); // exactly three years ago today: counts
    const stale = { today: TODAY, addedYearsAgo: 3 };
    const { items } = await listItems(env.DB, lib.id, { sort: 'title' }, undefined, undefined, stale);
    expect(items.map((i) => i.title)).toEqual(['Edge', 'Old']);
    // a day earlier, the edge is not yet three years old
    expect((await listItems(env.DB, lib.id, {}, undefined, undefined, { today: '2026-09-30', addedYearsAgo: 3 })).items.map((i) => i.title)).toEqual(['Old']);
  });

  it('"not played in months" keeps games and records never played or played before then — never a book', async () => {
    const { lib, item } = await shelf();
    const asha = await member('asha', 'admin');
    const never = await item({ title: 'Never played', mediaType: 'boardgame' });
    const lately = await item({ title: 'Played lately', mediaType: 'vinyl' });
    const longAgo = await item({ title: 'Played long ago', mediaType: 'boardgame' });
    await item({ title: 'A book, unread for ever' });
    await logPlay(env.DB, lately.id, '2026-09-01', asha.id);
    await logPlay(env.DB, longAgo.id, '2025-01-01', asha.id);
    await logPlay(env.DB, longAgo.id, '2024-06-01', asha.id);
    const { items } = await listItems(env.DB, lib.id, { sort: 'title' }, undefined, undefined, { today: TODAY, unplayedMonths: 12 });
    expect(items.map((i) => i.title)).toEqual(['Never played', 'Played long ago']);
    expect((await listItems(env.DB, lib.id, {}, undefined, undefined, { today: TODAY, unplayedMonths: 24 })).items.map((i) => i.title)).toEqual(['Never played']);
  });
});

describe('saved views', () => {
  it('any member saves one, the same name replaces it, and any member deletes it', async () => {
    const { lib } = await shelf();
    const ravi = await member('ravi');
    const asha = await member('asha');
    const id = await saveView(env.DB, { libraryId: lib.id, name: 'Unread SF', params: 'tag=sf&status=not_started', createdBy: ravi.id });
    expect(id).not.toBeNull();
    const again = await saveView(env.DB, { libraryId: lib.id, name: 'Unread SF', params: 'status=not_started', createdBy: asha.id });
    expect(again).toBe(id);
    const views = await listSavedViews(env.DB, lib.id);
    expect(views.map((v) => [v.name, v.params, v.createdBy])).toEqual([['Unread SF', 'status=not_started', asha.id]]);
    // another shelf's view of the same name is its own
    const other = await createLibrary(env.DB, 'Games');
    expect(await saveView(env.DB, { libraryId: other.id, name: 'Unread SF', params: '', createdBy: ravi.id })).not.toBe(id);
    expect((await listSavedViews(env.DB)).map((v) => v.libraryId)).toEqual([lib.id, other.id]);
    expect(await deleteSavedView(env.DB, other.id, id!)).toBe(false); // the wrong shelf deletes nothing
    expect(await deleteSavedView(env.DB, lib.id, id!)).toBe(true);
    expect(await listSavedViews(env.DB, lib.id)).toEqual([]);
    // a gone shelf takes its views with it
    expect(await saveView(env.DB, { libraryId: 999, name: 'x', params: '', createdBy: ravi.id })).toBeNull();
  });

  it('holds twenty a shelf; the twenty-first is refused, a replacement still goes through', async () => {
    const { lib, item } = await shelf();
    await item({ title: 'Something on the shelf' }); // the bar, and the views under it, show once the shelf holds anything
    const ravi = await member('ravi');
    for (let i = 0; i < MAX_SAVED_VIEWS_PER_SHELF; i++) expect(await saveView(env.DB, { libraryId: lib.id, name: `View ${i}`, params: '', createdBy: ravi.id })).not.toBeNull();
    expect(await saveView(env.DB, { libraryId: lib.id, name: 'One more', params: '', createdBy: ravi.id })).toBeNull();
    expect(await saveView(env.DB, { libraryId: lib.id, name: 'View 3', params: 'owned=1', createdBy: ravi.id })).not.toBeNull();
    expect((await listSavedViews(env.DB, lib.id)).length).toBe(MAX_SAVED_VIEWS_PER_SHELF);
    const page = await html(ravi, `/libraries/${lib.id}`);
    expect(page).toContain('delete one to save another');
    expect(page).not.toContain('Save this view as');
  });

  it('is saved from the bar by a member, applies on ?saved=, keeps the page and display, and is the whole household\'s', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const asha = await member('asha');
    const unread = await item({ title: 'Unread one' });
    const read = await item({ title: 'Read one', status: 'completed', completedOn: '2026-01-01' });
    // a member saves the bar as it stands; the page, the display and an unknown key never get in
    const saved = await as(ravi, `/libraries/${lib.id}/views`, { body: { name: '  Still unread ', params: 'status=not_started&page=3&view=grid&evil=1' } });
    expect(saved.status).toBe(302);
    const [view] = await listSavedViews(env.DB, lib.id);
    expect(view!.name).toBe('Still unread');
    expect(view!.params).toBe('status=not_started');
    expect(saved.headers.get('location')).toBe(`/libraries/${lib.id}?saved=${view!.id}`);
    // applied for anyone in the household, with the URL's own page and display
    const page = await html(asha, `/libraries/${lib.id}?saved=${view!.id}&view=grid`);
    expect(page).toContain(`/items/${unread.id}`);
    expect(page).not.toContain(`/items/${read.id}`);
    expect(page).toContain('aria-current="page"');
    expect(page).toContain('Delete view');
    expect(page).toContain(`href="/libraries/${lib.id}?saved=${view!.id}&amp;view=grid"`); // the covers toggle keeps the view
    // the bar's checkboxes show the view's filters, and the status checkbox is checked
    expect(page).toMatch(/name="status" value="not_started" checked/);
    // a view nobody saved is the plain shelf
    expect(await html(asha, `/libraries/${lib.id}?saved=999`)).toContain(`/items/${read.id}`);
    // listed on the Overview under its shelf
    expect(await html(asha, '/')).toContain(`href="/libraries/${lib.id}?saved=${view!.id}"`);
    // any member deletes it
    const gone = await as(asha, `/libraries/${lib.id}/views/${view!.id}/delete`, { body: {} });
    expect(gone.status).toBe(302);
    expect(await listSavedViews(env.DB, lib.id)).toEqual([]);
    // a nameless save is refused
    expect((await as(ravi, `/libraries/${lib.id}/views`, { body: { name: '  ', params: '' } })).status).toBe(400);
  });

  it('offers the presets on every shelf — "Not played lately" only where there are games or records — and marks the open one', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const old = await item({ title: 'Bought and forgotten' });
    await aged(old.id, '2019-01-01 00:00:00');
    await item({ title: 'New arrival' });
    const books = await html(ravi, `/libraries/${lib.id}`);
    expect(books).toContain(`href="/libraries/${lib.id}?owned=1&amp;status=not_started&amp;addedYears=3"`);
    expect(books).not.toContain('Not played lately');
    const preset = await html(ravi, `/libraries/${lib.id}?owned=1&status=not_started&addedYears=3`);
    expect(preset).toContain('Bought and forgotten');
    expect(preset).not.toContain('New arrival');
    expect(preset).toMatch(/class="pill active" aria-current="page">\s*Unread for years/);
    const games = await createLibrary(env.DB, 'Games');
    await createItem(env.DB, { libraryId: games.id, mediaType: 'boardgame', details: '{}', title: 'Catan' });
    const gamesPage = await html(ravi, `/libraries/${games.id}`);
    expect(gamesPage).toContain(`href="/libraries/${games.id}?owned=1&amp;unplayedMonths=12"`);
    expect(await html(ravi, `/libraries/${games.id}?owned=1&unplayedMonths=12`)).toContain('Catan');
  });

  it('drops a removed member from "Read by" in every view naming them, so a newcomer given their id inherits nothing', async () => {
    const { lib, item } = await shelf();
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const read = await item({ title: 'Read by Ravi' });
    const other = await item({ title: 'Nobody read this' });
    await addPastRead(env.DB, read.id, { status: 'completed', beganOn: null, endedOn: '2026-01-10' }, ravi.id);
    const finished = await saveView(env.DB, { libraryId: lib.id, name: "Ravi's finished", params: `status=completed&readBy=${ravi.id}`, createdBy: asha.id });
    const reading = await saveView(env.DB, { libraryId: lib.id, name: 'Ravi reading', params: `readBy=now-${ravi.id}&sort=title`, createdBy: asha.id });
    const mine = await saveView(env.DB, { libraryId: lib.id, name: 'Mine', params: 'readBy=me', createdBy: asha.id });
    expect(await html(asha, `/libraries/${lib.id}?saved=${finished}`)).not.toContain('Nobody read this');
    await deleteUser(env.DB, ravi.id);
    const newcomer = await member('newcomer');
    expect(newcomer.id).toBe(ravi.id); // ids are reused (#56)
    await addPastRead(env.DB, other.id, { status: 'completed', beganOn: null, endedOn: '2026-02-10' }, newcomer.id);
    const views = new Map((await listSavedViews(env.DB, lib.id)).map((v) => [v.id, v.params]));
    expect(views.get(finished!)).toBe('status=completed');
    expect(views.get(reading!)).toBe('sort=title');
    expect(views.get(mine!)).toBe('readBy=me');
    // the view is now "completed by anyone": both finished books, and nothing attributed to the newcomer by name
    const page = await html(asha, `/libraries/${lib.id}?saved=${finished}`);
    expect(page).toContain('Read by Ravi');
    expect(page).toContain('Nobody read this');
    expect(page).not.toContain(`value="${newcomer.id}" selected`);
    expect(page).not.toContain(`value="now-${newcomer.id}" selected`);
  });

  it('writes "Read by" as the menu does, so a view saved from a hand-typed `02` loses the member with the rest when they go', async () => {
    const { lib, item } = await shelf();
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const read = await item({ title: 'Read by Ravi' });
    const other = await item({ title: 'Nobody read this' });
    await addPastRead(env.DB, read.id, { status: 'completed', beganOn: null, endedOn: '2026-01-10' }, ravi.id);
    const people = [{ id: asha.id }, { id: ravi.id }];
    // the bar reads a leading zero as the member it names, and writes the id back as the menu would
    const typed = parseShelfQuery(new URLSearchParams(`status=completed&readBy=0${ravi.id}`), asha.id, people);
    expect(typed.reader).toEqual({ readerId: ravi.id, mode: 'finished' });
    expect(shelfQueryString(typed)).toBe(`status=completed&readBy=${ravi.id}`);
    expect(shelfQueryString(parseShelfQuery(new URLSearchParams(`readBy=now-00${ravi.id}`), asha.id, people))).toBe(`readBy=now-${ravi.id}`);
    for (const v of ['me', 'not-me', 'anyone', 'now-me', 'now-anyone']) expect(readByValue(v)).toBe(v);
    expect(readByValue('now-not-me')).toBe('');
    expect(readByValue('x')).toBe('');
    // the search box's menu shows the value selected, which it couldn't while the value was echoed as typed
    expect(await html(asha, `/search?q=ravi&readBy=0${ravi.id}`)).toContain(`<option value="${ravi.id}" selected`);
    // saved from the bar as typed, and — as a view saved before this was written canonically — stored as typed
    const saved = await as(asha, `/libraries/${lib.id}/views`, { body: { name: 'Read by ravi', params: `status=completed&readBy=0${ravi.id}` } });
    expect(saved.status).toBe(302);
    const fromBar = (await listSavedViews(env.DB, lib.id)).find((v) => v.name === 'Read by ravi')!;
    expect(fromBar.params).toBe(`status=completed&readBy=${ravi.id}`);
    const stored = await saveView(env.DB, { libraryId: lib.id, name: 'Ravi reading', params: `readBy=now-0${ravi.id}&sort=title`, createdBy: asha.id });
    const older = await saveView(env.DB, { libraryId: lib.id, name: 'Old finished', params: `status=completed&readBy=00${ravi.id}`, createdBy: asha.id });
    expect(await html(asha, `/libraries/${lib.id}?saved=${older}`)).not.toContain('Nobody read this');
    await deleteUser(env.DB, ravi.id);
    const newcomer = await member('newcomer');
    expect(newcomer.id).toBe(ravi.id); // ids are reused (#56)
    await addPastRead(env.DB, other.id, { status: 'completed', beganOn: null, endedOn: '2026-02-10' }, newcomer.id);
    const views = new Map((await listSavedViews(env.DB, lib.id)).map((v) => [v.id, v.params]));
    expect(views.get(fromBar.id)).toBe('status=completed');
    expect(views.get(stored!)).toBe('sort=title');
    expect(views.get(older!)).toBe('status=completed');
    // "completed by anyone" now: ravi's unattributed read is listed with the newcomer's, and nothing is theirs by name
    for (const id of [fromBar.id, older!]) {
      const page = await html(asha, `/libraries/${lib.id}?saved=${id}`);
      expect(page).toContain('Read by Ravi');
      expect(page).toContain('Nobody read this');
      expect(page).not.toContain(`value="${newcomer.id}" selected`);
    }
  });

  it('never reaches a share: the publish form carries none of a view\'s keys, and the backup lists the table', async () => {
    const { lib } = await shelf();
    const admin = await member('admin', 'admin');
    const ravi = await member('ravi');
    const id = await saveView(env.DB, { libraryId: lib.id, name: 'Mine', params: 'readBy=me&q=loft&addedYears=3&unplayedMonths=12&status=completed', createdBy: ravi.id });
    const page = await html(admin, `/libraries/${lib.id}?saved=${id}`);
    const publish = page.slice(page.indexOf('action="/shares"'), page.indexOf('</form>', page.indexOf('action="/shares"')));
    expect(publish).toContain('name="status" value="completed"');
    for (const key of ['readBy', 'q', 'addedYears', 'unplayedMonths', 'saved']) expect(publish).not.toContain(`name="${key}"`);
    expect((await rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_views'")).length).toBe(1);
  });
});

describe('publishing "the current view" from a decluttered shelf', () => {
  it('names every filter a share link can’t carry, and captures none of them', async () => {
    const admin = await member('root', 'admin');
    const { lib, item } = await shelf();
    await item({ title: 'Some book' });
    const formOf = (page: string) => page.slice(page.indexOf('<form method="post" action="/shares"'), page.indexOf('</small>', page.indexOf('<form method="post" action="/shares"')));
    // Borrowed among the Holding choices, the decluttering filters, the search box, Format and Read by: all dropped, all named
    const page = await html(admin, `/libraries/${lib.id}?owned=1&owned=b&addedYears=3&unplayedMonths=12&q=loft&format=hardcover&readBy=me`);
    const form = formOf(page);
    for (const field of ['name="owned"', 'addedYears', 'unplayedMonths', 'name="q"', 'format', 'readBy']) expect(form, field).not.toContain(field);
    expect(form).toContain('(none — the whole shelf)');
    expect(form).toContain(
      '&quot;Read by&quot;, Format, Borrowed from someone, Unread for years, Not played lately and the search box are never published: the link shows this view without them.',
    );
    // one alone keeps the singular, and the bar's own captured filter is still listed
    const one = formOf(await html(admin, `/libraries/${lib.id}?status=not_started&addedYears=3`));
    expect(one).toContain('name="status" value="not_started"');
    expect(one).toContain('(Not started)');
    expect(one).toContain('Unread for years is never published: the link shows this view without it.');
    // nothing dropped, nothing said
    const plain = formOf(await html(admin, `/libraries/${lib.id}?status=not_started`));
    expect(plain).not.toContain('never published');
  });
});
