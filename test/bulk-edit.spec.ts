// Bulk edit (ARCH.md §16 #47): select items on a shelf or in search results, then add or remove a tag, move them to a
// shelf, mark them owned or not owned, or — an admin only — delete them. Each action is one D1 batch.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { activityInView, createConnectionView, stillShared } from '../src/db/federation';
import {
  addProgress,
  BULK_MAX,
  createItem,
  createLibrary,
  createLoan,
  createShare,
  getItem,
  searchItems,
  setItemTags,
  tagsForItem,
} from '../src/db/queries';
import type { Item, MediaType, NewItem } from '../src/db/schema';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';
import { newShareToken } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import { captureErrors } from './console';
import { as, html, member, rows, type Member } from './member-helpers';

// ---------- helpers ----------

type Fields = Array<[string, string]>;

/** A POST of the bar's form as a browser without JavaScript sends it: urlencoded, `id` repeated. */
async function post(who: Member, fields: Fields, opts: { db?: D1Database; origin?: string; path?: string } = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${opts.path ?? '/bulk'}`, {
      method: 'POST',
      headers: { origin: opts.origin ?? 'http://nalanda.test', cookie: who.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    }),
    { ...env, ...(opts.db ? { DB: opts.db } : {}) },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const picked = (items: Array<{ id: number }>): Fields => items.map((i) => ['id', String(i.id)]);
const bulk = (who: Member, action: string, items: Array<{ id: number }>, extra: Fields = [], opts = {}) =>
  post(who, [['action', action], ['back', '/libraries/1'], ...extra, ...picked(items)], opts);

async function item(shelf: number, values: Partial<NewItem> = {}): Promise<Item> {
  return createItem(env.DB, { libraryId: shelf, mediaType: 'book', title: 'Untitled', details: '{}', ...values });
}

async function household() {
  const admin = await member('asha', 'admin');
  const ravi = await member('ravi');
  const shelf = await createLibrary(env.DB, 'Front room');
  const other = await createLibrary(env.DB, 'Attic');
  return { admin, ravi, shelf, other };
}

const stamp = (ids: number[]) =>
  env.DB.prepare(`UPDATE items SET updated_at = '2000-01-01 00:00:00' WHERE id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(ids))
    .run();
const updatedAt = async (id: number) => (await getItem(env.DB, id))!.updatedAt;

async function ftsIntact() {
  // external-content FTS5: checks the index against the items table, row for row
  await env.DB.prepare(`INSERT INTO items_fts(items_fts) VALUES ('integrity-check')`).run();
}

async function shareGet(token: string) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test/share/${token}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** How many D1 calls a request makes — a batch is one (§16 #37). */
async function calls(who: Member, fields: Fields) {
  const budget = { left: 1000 };
  const res = await post(who, fields, { db: budgeted(env.DB, budget) });
  return { res, calls: 1000 - budget.left };
}

/** Makes the next write that touches `table` for item `id` fail, inside whatever batch runs it. */
async function failOn(when: 'INSERT ON item_tags' | 'UPDATE ON items' | 'DELETE ON items', id: number) {
  const row = when === 'INSERT ON item_tags' ? 'new.item_id' : when === 'UPDATE ON items' ? 'new.id' : 'old.id';
  await env.DB.prepare(`CREATE TRIGGER test_fail BEFORE ${when} WHEN ${row} = ${id} BEGIN SELECT RAISE(ABORT, 'test: fail here'); END`).run();
}

// ---------- the selection ----------

describe('selecting items', () => {
  it('puts a checkbox on every row of a shelf table, each joined to the bar by its form attribute', async () => {
    const { admin, shelf } = await household();
    const a = await item(shelf.id, { title: 'Ficciones' });
    const b = await item(shelf.id, { title: 'Catan', mediaType: 'boardgame' });
    const c = await item(shelf.id, { title: 'Kind of Blue', mediaType: 'vinyl' });
    const page = await html(admin, `/libraries/${shelf.id}`);
    for (const i of [a, b, c]) {
      expect(page).toContain(`<input type="checkbox" class="bulk-pick" name="id" value="${i.id}" form="bulk" aria-label="Select ${i.title}"/>`);
    }
    expect(page).toContain('<form id="bulk" method="post" action="/bulk" class="bulk-bar" data-max="250"');
    expect(page).toContain(`<input type="hidden" name="back" value="/libraries/${shelf.id}"/>`);
    expect(page).toContain('up to 250 at a time');
    // select all sits in the header, hidden until app.js can make it work
    expect(page).toContain('<th class="col-pick"><input type="checkbox" data-bulk-all="true" aria-label="Select all on this page" hidden=""/></th>');
    // the table isn't inside the bar's form: the form comes after it, and holds no checkbox of its own
    const form = page.slice(page.indexOf('<form id="bulk"'), page.indexOf('</form>', page.indexOf('<form id="bulk"')));
    expect(form).not.toContain('bulk-pick');
    expect(page.indexOf('<form id="bulk"')).toBeGreaterThan(page.lastIndexOf('bulk-pick'));
  });

  it('puts one on every card of the covers view, beside the card’s link rather than inside it', async () => {
    const { admin, shelf } = await household();
    const a = await item(shelf.id, { title: 'Ficciones' });
    const page = await html(admin, `/libraries/${shelf.id}?view=grid`);
    expect(page).toMatch(new RegExp(`</a><label class="pick"><input type="checkbox" class="bulk-pick" name="id" value="${a.id}" form="bulk"`));
    expect(page).toContain('<label class="bulk-all" hidden=""><input type="checkbox" data-bulk-all="true"/>Select all on this page</label>');
    // the grid's own view survives a bulk action
    expect(page).toContain(`<input type="hidden" name="back" value="/libraries/${shelf.id}?view=grid"/>`);
  });

  it('puts one on every search result, coming back to the same search', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'Ficciones' });
    const page = await html(ravi, '/search?q=ficciones');
    expect(page).toContain(`value="${a.id}" form="bulk"`);
    expect(page).toContain('<input type="hidden" name="back" value="/search?q=ficciones"/>');
  });

  it('offers no move when there is no other shelf to move to, and every other shelf when there is', async () => {
    const admin = await member('asha', 'admin');
    const only = await createLibrary(env.DB, 'The only shelf');
    await item(only.id, { title: 'A' });
    const alone = await html(admin, `/libraries/${only.id}`);
    expect(alone).not.toContain('value="move"');
    expect(alone).toContain('<option value="owned">Mark owned</option>');
    const other = await createLibrary(env.DB, 'Attic');
    const page = await html(admin, `/libraries/${only.id}`);
    expect(page).toContain('<option value="move">Move to shelf</option>');
    expect(page).toContain(`<select class="bulk-shelf" name="libraryId" aria-label="Shelf to move to"><option value="${other.id}">Attic</option></select>`);
  });

  it('offers no bar on an empty shelf', async () => {
    const { admin, shelf } = await household();
    const page = await html(admin, `/libraries/${shelf.id}`);
    expect(page).not.toContain('id="bulk"');
  });

  it('never shows a member the delete action, on a shelf or in search', async () => {
    const { admin, ravi, shelf } = await household();
    await item(shelf.id, { title: 'Ficciones' });
    for (const path of [`/libraries/${shelf.id}`, `/libraries/${shelf.id}?view=grid`, '/search?q=ficciones']) {
      const theirs = await html(ravi, path);
      expect(theirs).toContain('<option value="tag-add">Add a tag</option>');
      expect(theirs).not.toContain('value="delete"');
      expect(theirs).not.toContain('Delete…');
      // negative control: the same page shows it to an admin, so the check above can see it
      expect(await html(admin, path)).toContain('<option value="delete">Delete…</option>');
    }
  });
});

// ---------- tags ----------

describe('adding and removing a tag', () => {
  it('adds it, normalized, to every selected item of every media type, and stamps only the ones it changed', async () => {
    const { ravi, shelf } = await household();
    const types: MediaType[] = ['book', 'boardgame', 'vinyl'];
    const all = await Promise.all(types.map((t, n) => item(shelf.id, { title: `Thing ${n}`, mediaType: t })));
    await setItemTags(env.DB, all[2]!.id, ['summer reads']);
    await stamp(all.map((i) => i.id));
    const res = await bulk(ravi, 'tag-add', all, [['tag', '  Summer READS ']]);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/libraries/1?bulk=tag-add&n=2&same=1');
    for (const i of all) expect(await tagsForItem(env.DB, i.id)).toEqual(['summer reads']);
    expect(await rows('SELECT name FROM tags')).toEqual([{ name: 'summer reads' }]);
    expect(await updatedAt(all[0]!.id)).not.toBe('2000-01-01 00:00:00');
    expect(await updatedAt(all[1]!.id)).not.toBe('2000-01-01 00:00:00');
    expect(await updatedAt(all[2]!.id)).toBe('2000-01-01 00:00:00'); // tagged already: not edited
    await ftsIntact();
  });

  it('takes comma-separated tags as several, as the edit form does', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'A' });
    await bulk(ravi, 'tag-add', [a], [['tag', 'Gift, to-read ,,']]);
    expect(await tagsForItem(env.DB, a.id)).toEqual(['gift', 'to-read']);
  });

  it('removes it from the items carrying it, keeps the tag, and stamps only those', async () => {
    const { ravi, shelf } = await household();
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((t) => item(shelf.id, { title: t })));
    await setItemTags(env.DB, a!.id, ['gift', 'keep']);
    await setItemTags(env.DB, b!.id, ['gift']);
    await stamp([a!.id, b!.id, c!.id]);
    const res = await bulk(ravi, 'tag-remove', [a!, b!, c!], [['tag', 'GIFT']]);
    expect(res.headers.get('location')).toBe('/libraries/1?bulk=tag-remove&n=2&same=1');
    expect(await tagsForItem(env.DB, a!.id)).toEqual(['keep']);
    expect(await tagsForItem(env.DB, b!.id)).toEqual([]);
    expect(await rows('SELECT name FROM tags ORDER BY name')).toEqual([{ name: 'gift' }, { name: 'keep' }]);
    expect(await updatedAt(c!.id)).toBe('2000-01-01 00:00:00');
    expect(await updatedAt(a!.id)).not.toBe('2000-01-01 00:00:00');
  });

  it('refuses without a tag, changing nothing', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'A' });
    const res = await bulk(ravi, 'tag-add', [a], [['tag', ' , ']]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Type the tag to add or remove.');
    expect(await rows('SELECT * FROM tags')).toEqual([]);
  });

  it('leaves re-tagged items where search finds them', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'Pedro Paramo', creators: 'Juan Rulfo' });
    await bulk(ravi, 'tag-add', [a], [['tag', 'mexico']]);
    expect((await searchItems(env.DB, 'rulfo')).map((i) => i.id)).toEqual([a.id]);
    await ftsIntact();
  });

  it('tells the shelf what it did, from counts alone', async () => {
    const { ravi, shelf } = await household();
    await item(shelf.id, { title: 'A' });
    const page = await html(ravi, `/libraries/${shelf.id}?bulk=tag-add&n=2&same=1`);
    expect(page).toContain('Tagged 2 items. 1 already had it.');
    // nothing but numbers comes from the link: an unknown action says nothing
    expect(await html(ravi, `/libraries/${shelf.id}?bulk=<script>&n=2`)).not.toContain('class="notice"');
  });
});

// ---------- moving ----------

describe('moving to a shelf', () => {
  it('moves every selected item not already there, stamps only those, and search still finds them', async () => {
    const { ravi, shelf, other } = await household();
    const a = await item(shelf.id, { title: 'Ficciones', creators: 'Borges' });
    const b = await item(shelf.id, { title: 'Labyrinths', creators: 'Borges', mediaType: 'vinyl' });
    const c = await item(other.id, { title: 'Aleph', creators: 'Borges', mediaType: 'boardgame' });
    await stamp([a.id, b.id, c.id]);
    const res = await bulk(ravi, 'move', [a, b, c], [['libraryId', String(other.id)]]);
    expect(res.headers.get('location')).toBe(`/libraries/1?bulk=move&n=2&same=1&to=${other.id}`);
    for (const i of [a, b, c]) expect((await getItem(env.DB, i.id))!.libraryId).toBe(other.id);
    expect(await updatedAt(c.id)).toBe('2000-01-01 00:00:00');
    expect(await updatedAt(a.id)).not.toBe('2000-01-01 00:00:00');
    expect((await searchItems(env.DB, 'borges')).length).toBe(3);
    await ftsIntact();
    const page = await html(ravi, `/libraries/${shelf.id}?bulk=move&n=2&same=1&to=${other.id}`);
    expect(page).toContain(`Moved 2 items to <a href="/libraries/${other.id}">Attic</a>. 1 was there already.`);
  });

  it('refuses a shelf that doesn’t exist, moving nothing', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'A' });
    const res = await bulk(ravi, 'move', [a], [['libraryId', '999']]);
    expect(res.status).toBe(400);
    expect((await getItem(env.DB, a.id))!.libraryId).toBe(shelf.id);
  });

  it('records no news for connections, and a follower’s next pull brings nothing old', async () => {
    const { ravi, shelf, other } = await household();
    const finished = { status: 'completed' as const, completedOn: '2026-09-01', rating: 8, review: 'Loved it' };
    const a = await item(shelf.id, { title: 'A', addedBy: ravi.id, ...finished });
    const b = await item(shelf.id, { title: 'B', addedBy: ravi.id, ...finished });
    const into = await createConnectionView(env.DB, { name: 'Attic', libraryId: other.id, mediaType: null, status: null, owned: null });
    const from = await createConnectionView(env.DB, { name: 'Front', libraryId: shelf.id, mediaType: null, status: null, owned: null });
    const log = () => rows('SELECT id, item_id, kind, at FROM activity_log ORDER BY id');
    const perPerson = () => rows('SELECT id, item_id, kind, at FROM member_activity ORDER BY id');
    const [before, beforeMembers] = [await log(), await perPerson()];
    expect(before.length).toBeGreaterThan(0); // the view's backfill logged their finishes, ratings and reviews
    const cursor = Math.max(...before.map((r) => r['id'] as number));
    const sentFromFront = before.map((r) => r['id'] as number);

    await bulk(ravi, 'move', [a, b], [['libraryId', String(other.id)]]);

    expect(await log()).toEqual(before); // the same entries, ids and dates: nothing new, nothing re-dated
    expect(await perPerson()).toEqual(beforeMembers);
    expect((await activityInView(env.DB, into, cursor, 50)).rows).toEqual([]); // a follower of the Attic hears nothing
    expect(await stillShared(env.DB, from, sentFromFront)).toEqual(new Set()); // the Front room's followers drop them
  });

  it('changes what a share link shows at once, clearing the share-page cache', async () => {
    const { ravi, shelf, other } = await household();
    const a = await item(shelf.id, { title: 'Moved Along' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Attic', libraryId: other.id });
    clearSharePageCache();
    expect((await shareGet(share.token)).headers.get('x-cache')).toBe('miss');
    const cached = await shareGet(share.token);
    expect(cached.headers.get('x-cache')).toBe('hit');
    expect(await cached.text()).not.toContain('Moved Along');
    await bulk(ravi, 'move', [a], [['libraryId', String(other.id)]]);
    const fresh = await shareGet(share.token);
    expect(fresh.headers.get('x-cache')).toBe('miss');
    expect(await fresh.text()).toContain('Moved Along');
  });

  it('changes what a tag’s share link shows at once, when a tag is added', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'Newly Gifted' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Gifts', libraryId: null, tag: 'gift' });
    clearSharePageCache();
    await shareGet(share.token);
    expect((await shareGet(share.token)).headers.get('x-cache')).toBe('hit');
    await bulk(ravi, 'tag-add', [a], [['tag', 'Gift']]);
    const fresh = await shareGet(share.token);
    expect(fresh.headers.get('x-cache')).toBe('miss');
    expect(await fresh.text()).toContain('Newly Gifted');
  });

  it('keeps the cache when an action is refused (negative control for the clearing above)', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'A' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'All', libraryId: shelf.id });
    clearSharePageCache();
    await shareGet(share.token);
    expect((await bulk(ravi, 'delete', [a], [['confirm', '1']])).status).toBe(403);
    expect((await shareGet(share.token)).headers.get('x-cache')).toBe('hit');
  });
});

// ---------- owned / not owned ----------

describe('owned and not owned', () => {
  async function held(shelf: number) {
    return Promise.all([0, 1, 2, 3].map((copies) => item(shelf, { title: `${copies} copies`, copies })));
  }
  const copiesOf = async (items: Item[]) => Promise.all(items.map(async (i) => (await getItem(env.DB, i.id))!.copies));

  it('not owned sets one copy to none, and skips an item held in 2 or more, saying so', async () => {
    const { ravi, shelf } = await household();
    const items = await held(shelf.id);
    await stamp(items.map((i) => i.id));
    const res = await bulk(ravi, 'not-owned', items);
    expect(res.headers.get('location')).toBe('/libraries/1?bulk=not-owned&n=1&same=1&skipped=2');
    expect(await copiesOf(items)).toEqual([0, 0, 2, 3]);
    expect(await updatedAt(items[1]!.id)).not.toBe('2000-01-01 00:00:00');
    for (const i of [items[0]!, items[2]!, items[3]!]) expect(await updatedAt(i.id)).toBe('2000-01-01 00:00:00');
    const page = await html(ravi, `/libraries/${shelf.id}?bulk=not-owned&n=1&same=1&skipped=2`);
    expect(page).toContain('Marked 1 item not owned.');
    expect(page).toContain('<strong>Skipped 2 items held in 2 or more copies:</strong>');
    expect(page).toContain('Change it on each item’s edit form.');
  });

  it('owned sets none to one copy, and skips an item held in 2 or more rather than flatten its count', async () => {
    const { ravi, shelf } = await household();
    const items = await held(shelf.id);
    const res = await bulk(ravi, 'owned', items);
    expect(res.headers.get('location')).toBe('/libraries/1?bulk=owned&n=1&same=1&skipped=2');
    expect(await copiesOf(items)).toEqual([1, 1, 2, 3]);
  });
});

// ---------- delete ----------

describe('deleting', () => {
  it('is refused to a member with a 403 and a reason, at the confirmation and at the delete, changing nothing', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'Not Yours To Bin', coverKey: 'cover-a' });
    await env.COVERS.put('cover-a', 'x');
    for (const extra of [[], [['confirm', '1']]] as Fields[]) {
      const res = await bulk(ravi, 'delete', [a], extra);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).toBe('Only an admin can delete items in bulk. A member can delete an item from its own page.');
      expect(text).not.toContain('Not Yours To Bin'); // the confirmation's titles aren't shown either
    }
    expect(await getItem(env.DB, a.id)).not.toBeNull();
    expect(await env.COVERS.get('cover-a')).not.toBeNull();
    // negative control: the member can still delete that one item from its page, as before
    expect((await post(ravi, [], { path: `/items/${a.id}/delete` })).status).toBe(302);
    expect(await getItem(env.DB, a.id)).toBeNull();
  });

  it('asks an admin first, with the count and the first ten titles and how many more, deleting nothing yet', async () => {
    const { admin, shelf } = await household();
    const items: Item[] = [];
    for (let n = 1; n <= 12; n++) items.push(await item(shelf.id, { title: `Volume ${n}` }));
    const res = await bulk(admin, 'delete', items);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('<h1>Delete 12 items?</h1>');
    for (let n = 1; n <= 10; n++) expect(page).toContain(`<span class="t">Volume ${n}</span>`);
    expect(page).not.toContain('Volume 11<');
    expect(page).toContain('and 2 more.');
    for (const i of items) expect(page).toContain(`<input type="hidden" name="id" value="${i.id}"/>`);
    expect(page).toContain('<input type="hidden" name="confirm" value="1"/>');
    expect(page).toContain('<a href="/libraries/1" class="btn">Cancel</a>');
    expect((await rows('SELECT count(*) AS n FROM items'))[0]).toEqual({ n: 12 });
  });

  it('lists every title when there are ten or fewer, with no "and more"', async () => {
    const { admin, shelf } = await household();
    const a = await item(shelf.id, { title: 'Only One' });
    const page = await (await bulk(admin, 'delete', [a])).text();
    expect(page).toContain('<h1>Delete 1 item?</h1>');
    expect(page).toContain('Only One');
    expect(page).not.toContain(' more.');
  });

  it('deletes on confirmation, and its covers once the batch is done', async () => {
    const { admin, shelf } = await household();
    const a = await item(shelf.id, { title: 'Gone Girl', coverKey: 'cover-a' });
    const b = await item(shelf.id, { title: 'Gone Baby Gone', coverKey: 'cover-b' });
    const kept = await item(shelf.id, { title: 'Still Here', coverKey: 'cover-c' });
    for (const k of ['cover-a', 'cover-b', 'cover-c']) await env.COVERS.put(k, 'x');
    const res = await bulk(admin, 'delete', [a, b], [['confirm', '1']]);
    expect(res.headers.get('location')).toBe('/libraries/1?bulk=delete&n=2');
    expect(await getItem(env.DB, a.id)).toBeNull();
    expect(await getItem(env.DB, b.id)).toBeNull();
    expect(await getItem(env.DB, kept.id)).not.toBeNull();
    expect(await env.COVERS.get('cover-a')).toBeNull();
    expect(await env.COVERS.get('cover-b')).toBeNull();
    expect(await env.COVERS.get('cover-c')).not.toBeNull();
    expect(await searchItems(env.DB, 'gone')).toEqual([]);
    await ftsIntact();
  });

  it('does exactly what deleting each alone does: reads, reviews, pages, loans, tags, activity, and the messages to connections', async () => {
    const { admin, ravi, shelf } = await household();
    await env.DB.prepare(`INSERT INTO federation_settings (id, household_name, base_url) VALUES (1, 'Us', 'https://us.example')`).run();
    await env.DB.prepare(
      `INSERT INTO connections (base_url, household_name, public_key, status) VALUES ('https://them.example', 'Them', 'k', 'active')`,
    ).run();
    await createConnectionView(env.DB, { name: 'All', libraryId: null, mediaType: null, status: null, owned: null });

    /** A book with everything that hangs off an item. */
    async function loaded(title: string) {
      const i = await item(shelf.id, { title, addedBy: ravi.id, status: 'in_progress', beganOn: '2026-09-20', rating: 7, review: 'Good' });
      await setItemTags(env.DB, i.id, ['a', 'b']);
      await addProgress(env.DB, i.id, 40, ravi.id);
      await createLoan(env.DB, { itemId: i.id, borrower: 'Them' });
      const [loan] = await rows<{ id: number }>('SELECT id FROM loans WHERE item_id = ?1', i.id);
      await env.DB.prepare(`INSERT INTO connection_loans (loan_id, connection_id, request_activity_id) VALUES (?1, 1, ?2)`)
        .bind(loan!.id, `urn:lend:${i.id}`)
        .run();
      await env.DB.prepare(
        `INSERT INTO borrow_requests (activity_id, connection_id, incoming, our_item_id, item_title, requester_name) VALUES (?1, 1, 1, ?2, ?3, 'A member')`,
      )
        .bind(`urn:ask:${i.id}`, i.id, title)
        .run();
      return i;
    }
    const alone = [await loaded('Alone one'), await loaded('Alone two')];
    const together = [await loaded('Together one'), await loaded('Together two')];
    const kept = await loaded('Kept');

    const tables = ['item_tags', 'reads', 'reviews', 'reading_progress', 'loans', 'connection_loans', 'borrow_requests', 'activity_log', 'member_activity'];
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = ((await rows<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))[0]!).n;
      out['outbox'] = ((await rows<{ n: number }>('SELECT count(*) AS n FROM outbox'))[0]!).n;
      return out;
    };
    const start = await counts();
    for (const i of alone) expect((await post(admin, [], { path: `/items/${i.id}/delete` })).status).toBe(302);
    const afterAlone = await counts();
    expect((await bulk(admin, 'delete', together, [['confirm', '1']])).status).toBe(302);
    const afterTogether = await counts();

    for (const k of Object.keys(start)) {
      const byAlone = start[k]! - afterAlone[k]!;
      const byTogether = afterAlone[k]! - afterTogether[k]!;
      expect({ table: k, removed: byTogether }).toEqual({ table: k, removed: byAlone });
    }
    // what's left is the kept book's, untouched
    expect((await rows('SELECT DISTINCT item_id FROM reads')).map((r) => r['item_id'])).toEqual([kept.id]);
    // each deleted book told the connection it was returned, and declined its waiting request: four messages each
    // way, numbered in one unbroken sequence whichever way they were deleted
    const outbox = await rows<{ seq: number; type: string }>(`SELECT seq, json_extract(message, '$.type') AS type FROM outbox ORDER BY seq`);
    expect(outbox.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(outbox.filter((m) => m.type === 'Returned').length).toBe(4);
    expect(outbox.filter((m) => m.type === 'BorrowDecline').length).toBe(4);
    await ftsIntact();
  });
});

// ---------- one batch ----------

describe('each action is one batch', () => {
  it('adds no tag, no link and no timestamp when the batch fails on its last write', async () => {
    const { ravi, shelf } = await household();
    const [a, b] = [await item(shelf.id, { title: 'A' }), await item(shelf.id, { title: 'B' })];
    await stamp([a.id, b.id]);
    await failOn('INSERT ON item_tags', b.id);
    const errors = captureErrors();
    expect((await bulk(ravi, 'tag-add', [a, b], [['tag', 'brand-new']])).status).toBe(500);
    expect(String(errors.mock.calls[0]?.[0])).toContain('test: fail here');
    expect(await rows('SELECT * FROM tags')).toEqual([]); // created earlier in the batch, rolled back with it
    expect(await rows('SELECT * FROM item_tags')).toEqual([]);
    expect(await updatedAt(a.id)).toBe('2000-01-01 00:00:00');
  });

  it('takes no tag off anything when removing fails partway', async () => {
    const { ravi, shelf } = await household();
    const [a, b] = [await item(shelf.id, { title: 'A' }), await item(shelf.id, { title: 'B' })];
    await setItemTags(env.DB, a.id, ['gift']);
    await setItemTags(env.DB, b.id, ['gift']);
    await env.DB.prepare(`CREATE TRIGGER test_fail BEFORE DELETE ON item_tags WHEN old.item_id = ${b.id} BEGIN SELECT RAISE(ABORT, 'test: fail here'); END`).run();
    captureErrors();
    expect((await bulk(ravi, 'tag-remove', [a, b], [['tag', 'gift']])).status).toBe(500);
    expect(await tagsForItem(env.DB, a.id)).toEqual(['gift']);
  });

  it('moves nothing when one item can’t be moved', async () => {
    const { ravi, shelf, other } = await household();
    const [a, b] = [await item(shelf.id, { title: 'A' }), await item(shelf.id, { title: 'B' })];
    await failOn('UPDATE ON items', b.id);
    captureErrors();
    expect((await bulk(ravi, 'move', [a, b], [['libraryId', String(other.id)]])).status).toBe(500);
    expect((await getItem(env.DB, a.id))!.libraryId).toBe(shelf.id);
  });

  it('changes no copies when one item can’t be changed', async () => {
    const { ravi, shelf } = await household();
    const [a, b] = [await item(shelf.id, { title: 'A', copies: 1 }), await item(shelf.id, { title: 'B', copies: 1 })];
    await failOn('UPDATE ON items', b.id);
    captureErrors();
    expect((await bulk(ravi, 'not-owned', [a, b])).status).toBe(500);
    expect((await getItem(env.DB, a.id))!.copies).toBe(1);
  });

  it('deletes nothing, covers included, when one item can’t be deleted', async () => {
    const { admin, shelf } = await household();
    const [a, b] = [await item(shelf.id, { title: 'A', coverKey: 'cover-a' }), await item(shelf.id, { title: 'B' })];
    await env.COVERS.put('cover-a', 'x');
    await failOn('DELETE ON items', b.id);
    captureErrors();
    expect((await bulk(admin, 'delete', [a, b], [['confirm', '1']])).status).toBe(500);
    expect(await getItem(env.DB, a.id)).not.toBeNull();
    expect(await env.COVERS.get('cover-a')).not.toBeNull();
  });
});

// ---------- the cap, and the budget ----------

describe('the selection cap and the D1 budget', () => {
  async function many(shelf: number, n: number) {
    const values = Array.from({ length: n }, (_, k) => `(${shelf}, 'book', 'Item ${k}', '{}', 1)`).join(',');
    await env.DB.prepare(`INSERT INTO items (library_id, media_type, title, details, copies) VALUES ${values}`).run();
    return rows<{ id: number }>('SELECT id FROM items ORDER BY id');
  }

  it(`refuses more than ${BULK_MAX} items, changing nothing, and says why`, async () => {
    const { ravi, shelf } = await household();
    const items = await many(shelf.id, BULK_MAX + 1);
    const res = await bulk(ravi, 'tag-add', items, [['tag', 'too-many']]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`One action takes up to ${BULK_MAX} items, and ${BULK_MAX + 1} were selected.`);
    expect(await rows('SELECT * FROM tags')).toEqual([]);
  });

  it(`takes ${BULK_MAX}, each action in at most three D1 calls`, async () => {
    const { admin, shelf, other } = await household();
    const items = await many(shelf.id, BULK_MAX);
    const each: Array<[string, Fields, number]> = [
      ['tag-add', [['tag', 'lots']], 2],
      ['tag-remove', [['tag', 'lots']], 2],
      ['move', [['libraryId', String(other.id)]], 3],
      ['not-owned', [], 2],
      ['owned', [], 2],
      ['delete', [['confirm', '1']], 2],
    ];
    for (const [action, extra, most] of each) {
      const { res, calls: n } = await calls(admin, [['action', action], ['back', `/libraries/${shelf.id}`], ...extra, ...picked(items)]);
      expect({ action, status: res.status }).toEqual({ action, status: 302 });
      expect({ action, calls: n }).toEqual({ action, calls: most }); // the session check, the shelf for a move, and one batch
      expect(res.headers.get('location')).toContain(`n=${BULK_MAX}`);
    }
    expect(await rows('SELECT * FROM items')).toEqual([]);
  });

  it(`asks about deleting ${BULK_MAX} within the budget, listing ten and how many more`, async () => {
    const { admin, shelf } = await household();
    const items = await many(shelf.id, BULK_MAX);
    const { res, calls: n } = await calls(admin, [['action', 'delete'], ...picked(items)]);
    expect(res.status).toBe(200);
    expect(n).toBeLessThanOrEqual(6);
    expect(await res.text()).toContain(`and ${BULK_MAX - 10} more.`);
  });
});

// ---------- the form itself ----------

describe('the form', () => {
  it('comes back only to a shelf or a search — anything else goes home', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'A' });
    const to = async (back: string) =>
      (await post(ravi, [['action', 'owned'], ['back', back], ...picked([a])])).headers.get('location');
    expect(await to('//evil.example/libraries/1')).toBe('/');
    expect(await to('https://evil.example/')).toBe('/');
    expect(await to('/items/1')).toBe('/');
    expect(await to(`/libraries/${shelf.id}?view=grid&page=2&bulk=delete&n=9`)).toBe(`/libraries/${shelf.id}?view=grid&page=2&bulk=owned&n=0&same=1`);
    expect(await to('/search?q=a')).toBe('/search?q=a&bulk=owned&n=0&same=1');
  });

  it('refuses a post from another site, before anything is read', async () => {
    const { admin, shelf } = await household();
    const a = await item(shelf.id, { title: 'A' });
    const res = await post(admin, [['action', 'delete'], ['confirm', '1'], ...picked([a])], { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await getItem(env.DB, a.id)).not.toBeNull();
  });

  it('refuses no selection, and no action', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'A' });
    expect((await post(ravi, [['action', 'owned']])).status).toBe(400);
    expect((await post(ravi, [['action', 'explode'], ...picked([a])])).status).toBe(400);
    expect((await post(ravi, picked([a]))).status).toBe(400);
  });

  it('ignores ids that aren’t items, and counts only what exists', async () => {
    const { ravi, shelf } = await household();
    const a = await item(shelf.id, { title: 'A', copies: 0 });
    const res = await post(ravi, [['action', 'owned'], ['back', '/search?q=a'], ['id', String(a.id)], ['id', '999'], ['id', 'x'], ['id', '-3']]);
    expect(res.headers.get('location')).toBe('/search?q=a&bulk=owned&n=1');
  });

  it('works for a signed-out visitor not at all', async () => {
    await household();
    const res = await as(null, '/bulk', { body: { action: 'owned', id: '1' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});
