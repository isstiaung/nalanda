// "Read next" on the Overview (ARCH.md §16 #46): one random book from the signed-in member's own pool — any book they
// haven't finished and aren't reading, owned or not, whatever anyone else has read — with "Another" swapping in a new
// pick over htmx and "Start reading" opening their own read through the book page's start route.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addPastRead, closeRead, createLibrary, pickNextRead, startRead } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';
import { actor, as, book, html, member, openReadOf, readsOf, rows, type Member } from './member-helpers';

const household = async () => ({ asha: await member('asha', 'admin'), ravi: await member('ravi') });

/** The id the card on a page or partial offers, from its "Start reading" form; null when it offers none. */
const pickedId = (page: string): number | null => {
  const m = page.match(/action="\/items\/(\d+)\/reads\/start"/);
  return m ? Number(m[1]) : null;
};

/** The card alone, as "Another" asks for it. */
const another = async (who: Member, shown?: number) => (await as(who, shown === undefined ? '/' : `/?not=${shown}`, { htmx: true })).text();

const finish = (itemId: number, who: Member) => addPastRead(env.DB, itemId, { status: 'completed', beganOn: '2025-01-01', endedOn: '2025-02-01' }, who.id);

// ---------- the pool ----------

describe('the pool', () => {
  it('keeps a book another member finished', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha);
    await finish(item.id, ravi);
    expect((await pickNextRead(env.DB, asha.id))?.id).toBe(item.id);
    expect(pickedId(await html(asha, '/'))).toBe(item.id);
  });

  it('keeps a book another member is reading now', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha);
    await startRead(env.DB, item.id, '2026-09-01', ravi.id);
    expect((await pickNextRead(env.DB, asha.id))?.id).toBe(item.id);
  });

  it('leaves out a book you finished', async () => {
    const { asha } = await household();
    const item = await book(asha);
    await finish(item.id, asha);
    expect(await pickNextRead(env.DB, asha.id)).toBeNull();
  });

  it('leaves out a book you are reading now, and one you are re-reading', async () => {
    const { asha, ravi } = await household();
    const lib = await createLibrary(env.DB, 'Shelf');
    const reading = await book(asha, { libraryId: lib.id, title: 'Reading' });
    await startRead(env.DB, reading.id, '2026-09-01', asha.id);
    expect(await pickNextRead(env.DB, asha.id)).toBeNull();
    // ravi's pool still has it
    expect((await pickNextRead(env.DB, ravi.id))?.id).toBe(reading.id);

    const again = await book(asha, { libraryId: lib.id, title: 'Again' });
    await finish(again.id, asha);
    await startRead(env.DB, again.id, '2026-09-01', asha.id);
    expect(await pickNextRead(env.DB, asha.id)).toBeNull();
  });

  it('keeps a book you stopped reading', async () => {
    const { asha } = await household();
    const item = await book(asha);
    await startRead(env.DB, item.id, '2026-09-01', asha.id);
    await closeRead(env.DB, item.id, await openReadOf(item.id, asha), 'abandoned', '2026-09-02', actor(asha));
    expect((await pickNextRead(env.DB, asha.id))?.id).toBe(item.id);
  });

  it('includes a book you don’t own, and badges it "Not owned"', async () => {
    const { asha } = await household();
    const item = await book(asha, { copies: 0, title: 'Borrowed from the library' });
    expect((await pickNextRead(env.DB, asha.id))?.id).toBe(item.id);
    const card = await another(asha);
    expect(card).toContain('Borrowed from the library');
    expect(card).toContain('<span class="pill ghost">Not owned</span>');
  });

  it('badges only a book you don’t own', async () => {
    const { asha } = await household();
    await book(asha, { copies: 2, title: 'Owned twice' });
    const card = await another(asha);
    expect(card).toContain('Owned twice');
    expect(card).not.toContain('Not owned');
  });

  it('is books only', async () => {
    const { asha } = await household();
    const lib = await createLibrary(env.DB, 'Shelf');
    await book(asha, { libraryId: lib.id, mediaType: 'vinyl', title: 'A record' });
    await book(asha, { libraryId: lib.id, mediaType: 'boardgame', title: 'A game' });
    expect(await pickNextRead(env.DB, asha.id)).toBeNull();
    const only = await book(asha, { libraryId: lib.id, title: 'The only book' });
    for (let i = 0; i < 20; i++) expect((await pickNextRead(env.DB, asha.id))?.id).toBe(only.id);
  });
});

// ---------- the card ----------

describe('the Overview card', () => {
  it('shows the pick’s cover, title, creators and both buttons', async () => {
    const { asha } = await household();
    const item = await book(asha, { title: 'The Left Hand of Darkness', creators: 'Ursula K. Le Guin', coverKey: 'cover-uuid' });
    const page = await html(asha, '/');
    expect(page).toContain('id="read-next"');
    expect(page).toContain('The Left Hand of Darkness');
    expect(page).toContain('Ursula K. Le Guin');
    expect(page).toContain('src="/covers/cover-uuid"');
    expect(page).toContain(`action="/items/${item.id}/reads/start"`);
    expect(page).toContain('hx-get="/"');
    expect(page).toContain(`name="not" value="${item.id}"`);
  });

  it('"Another" answers htmx with the card alone', async () => {
    const { asha } = await household();
    await book(asha, { title: 'Just the card' });
    const res = await as(asha, '/', { htmx: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('vary')).toContain('HX-Request');
    const card = await res.text();
    expect(card).toContain('Just the card');
    expect(card).not.toContain('<!doctype');
    expect(card).not.toContain('class="sidebar"');
    expect(card).not.toContain('Recently accessioned');
    // and a full page without htmx, from the same URL
    const full = await (await as(asha, '/?not=1')).text();
    expect(full).toContain('<!doctype html>');
    expect(full).toContain('Recently accessioned');
  });

  it('"Another" never repeats the pick just shown while another book qualifies', async () => {
    const { asha } = await household();
    const lib = await createLibrary(env.DB, 'Shelf');
    const a = await book(asha, { libraryId: lib.id, title: 'A' });
    const b = await book(asha, { libraryId: lib.id, title: 'B' });
    for (let i = 0; i < 30; i++) {
      expect(pickedId(await another(asha, a.id))).toBe(b.id);
      expect(pickedId(await another(asha, b.id))).toBe(a.id);
    }
  });

  it('"Another" moves through a larger pool without repeating the book just shown', async () => {
    const { asha } = await household();
    const lib = await createLibrary(env.DB, 'Shelf');
    for (const title of ['A', 'B', 'C', 'D']) await book(asha, { libraryId: lib.id, title });
    let shown = pickedId(await html(asha, '/'))!;
    const seen = new Set([shown]);
    for (let i = 0; i < 40; i++) {
      const next = pickedId(await another(asha, shown))!;
      expect(next).not.toBe(shown);
      seen.add(next);
      shown = next;
    }
    expect(seen.size).toBeGreaterThan(2); // random, not a fixed alternation
  });

  it('"Another" shows the same book again when it is the only one', async () => {
    const { asha } = await household();
    const item = await book(asha);
    expect(pickedId(await another(asha, item.id))).toBe(item.id);
  });

  it('ignores a "not" that isn’t an id', async () => {
    const { asha } = await household();
    const item = await book(asha);
    for (const junk of ['', 'abc', '-1', '0', '1.5', '99999999999999999999']) {
      const res = await as(asha, `/?not=${encodeURIComponent(junk)}`, { htmx: true });
      expect(res.status).toBe(200);
      expect(pickedId(await res.text())).toBe(item.id);
    }
  });

  it('"Start reading" opens your own read and goes to the book', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha);
    await finish(item.id, ravi); // someone else's finish: still in asha's pool
    const card = await another(asha);
    expect(pickedId(card)).toBe(item.id);
    // the card's form posts to the book page's start route, without htmx
    expect(card).toMatch(new RegExp(`<form method="post" action="/items/${item.id}/reads/start">`));
    const res = await as(asha, `/items/${item.id}/reads/start`, { body: {} });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/items/${item.id}`);
    const open = (await readsOf(item.id)).filter((r) => r.status === 'in_progress');
    expect(open).toEqual([expect.objectContaining({ readerId: asha.id, endedOn: null })]);
    // now asha is reading it, it has left her pool, and ravi's reads are as they were
    expect(await pickNextRead(env.DB, asha.id)).toBeNull();
    expect((await readsOf(item.id)).filter((r) => r.readerId === ravi.id).map((r) => r.status)).toEqual(['completed']);
  });

  it('says so briefly when your pool is empty', async () => {
    const { asha, ravi } = await household();
    const item = await book(asha);
    await finish(item.id, asha);
    const page = await html(asha, '/');
    expect(page).toContain('id="read-next"');
    expect(page).toContain('Nothing to suggest');
    expect(pickedId(page)).toBeNull();
    expect(page).not.toContain('read-next-another');
    const card = await another(asha, item.id);
    expect(card).toContain('Nothing to suggest');
    // ravi hasn't read it: his card offers it
    expect(pickedId(await html(ravi, '/'))).toBe(item.id);
  });

  it('is left off an Overview with no books, which still loads', async () => {
    const { asha } = await household();
    const empty = await as(asha, '/');
    expect(empty.status).toBe(200);
    const page = await empty.text();
    expect(page).toContain('Nothing on the shelves yet');
    expect(page).not.toContain('Read next');
    expect(page).not.toContain('id="read-next"');

    await book(asha, { mediaType: 'vinyl', title: 'Only records here' });
    const records = await html(asha, '/');
    expect(records).toContain('Only records here');
    expect(records).not.toContain('id="read-next"');
  });

  it('works for a household of one', async () => {
    const solo = await member('solo', 'admin');
    const lib = await createLibrary(env.DB, 'Mine');
    const read = await book(solo, { libraryId: lib.id, title: 'Read it', status: 'completed', completedOn: '2024-01-01' });
    const unread = await book(solo, { libraryId: lib.id, title: 'Not yet' });
    for (let i = 0; i < 10; i++) {
      const res = await as(solo, '/');
      expect(res.status).toBe(200);
      const page = await res.text();
      expect(page).toContain('Read it'); // among the recent items, but never the pick
      expect(pickedId(page)).toBe(unread.id);
      expect(pickedId(page)).not.toBe(read.id);
    }
  });

  it('needs a session', async () => {
    await household();
    const res = await as(null, '/?not=1', { htmx: true });
    // not a 302: htmx would swap the login page into the card. HX-Redirect loads it as the page (§16 #65)
    expect(res.status).toBe(401);
    expect(res.headers.get('HX-Redirect')).toBe('/login');
    expect(res.headers.get('location')).toBeNull();
  });
});

// ---------- D1 budget ----------

describe('D1 calls', () => {
  const calls = async (who: Member, path: string, htmx = false) => {
    const budget = { left: 1000 };
    const headers: Record<string, string> = { cookie: who.cookie };
    if (htmx) headers['HX-Request'] = 'true';
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    await res.text();
    return 1000 - budget.left;
  };

  it('adds one call to the Overview, and "Another" is two, however big the catalog', async () => {
    const { asha, ravi } = await household();
    const lib = await createLibrary(env.DB, 'Shelf');
    await book(asha, { libraryId: lib.id });
    const small = { page: await calls(asha, '/'), card: await calls(asha, '/?not=1', true) };
    // the session's user, then the pick — nothing else
    expect(small.card).toBe(2);
    // the Overview made 9 calls before this card (measured with the pick left out): the pick is one more, the
    // signed-in member's reading goal (§16 #49) one more again, and the shelves' paid totals (§16 #61) one more
    expect(small.page).toBe(12);

    // about 2,000 books, a third finished by asha and a third read by ravi, and some records
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
       INSERT INTO items (library_id, media_type, title, copies) SELECT ?1, CASE WHEN i % 10 = 0 THEN 'vinyl' ELSE 'book' END, 'Book ' || i, i % 2 FROM n`,
    )
      .bind(lib.id)
      .run();
    // reads straight into the table: the pool reads only `reads`, never the household summary on items
    await env.DB.prepare(
      `INSERT INTO reads (item_id, reader_id, status, began_on, ended_on)
       SELECT id, CASE WHEN id % 3 = 0 THEN ?1 ELSE ?2 END, 'completed', '2020-01-01', '2020-02-01' FROM items WHERE id % 3 <> 2`,
    )
      .bind(asha.id, ravi.id)
      .run();
    expect((await rows<{ n: number }>("SELECT count(*) AS n FROM items WHERE media_type = 'book'"))[0]!.n).toBeGreaterThan(1800);
    expect(await calls(asha, '/')).toBe(small.page);
    expect(await calls(asha, '/?not=5', true)).toBe(small.card);
    const pick = await pickNextRead(env.DB, asha.id, 5);
    expect(pick).not.toBeNull();
    expect(pick!.id % 3).not.toBe(0); // never one asha finished
    expect(pick!.mediaType).toBe('book');
  });
});
