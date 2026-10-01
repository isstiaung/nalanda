// Scans held on the device while offline, reviewed on the Add page once it's back (ARCH.md §16 #48). The queue
// itself lives in the browser (IndexedDB, scan-queue.js) and is exercised there; these check what the server does
// for it: the review section on /add, one looked-up entry per held barcode, and adding one — only for whoever it was
// shown to.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibrary, deleteUser } from '../src/db/queries';
import { scanQueueOwner } from '../src/lib/auth';
import { CandidateCard } from '../src/views/components';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { as, member, rows } from './member-helpers';

const ISBN = '9780306406157';

/** Open Library knows the book; Google Books doesn't. */
function bookLookup(title = 'The Held Book') {
  intercept('https://openlibrary.org', (p) => p.startsWith('/search.json'), json({
    docs: [{ title, author_name: ['A. Writer'], first_publish_year: 2001, cover_i: 42, key: '/works/OL1W' }],
  }));
  intercept('https://www.googleapis.com', (p) => p.startsWith('/books/v1/volumes'), json({ totalItems: 0 }));
}

beforeEach(() => activateFetchMock());
afterEach(() => assertNoPendingInterceptors());

describe('the Add page', () => {
  it('carries a hidden review section, with "add all" to any shelf, and loads the queue before the review script', async () => {
    const ravi = await member('ravi', 'admin');
    await createLibrary(env.DB, 'Fiction');
    await createLibrary(env.DB, 'Records');
    const html = await (await as(ravi, '/add')).text();
    expect(html).toContain('<section id="scan-review" class="scan-review" hidden="">');
    expect(html).toContain('scanned while offline');
    expect(html).toMatch(/<form id="scan-review-all" class="inline-form"><select name="libraryId"[^>]*><option value="\d+">Fiction<\/option><option value="\d+">Records<\/option>/);
    expect(html).toContain('Add all to <span data-shelf-name="true">Fiction</span>');
    const order = ['/scan-queue.js', '/scanner.js', '/scan-review.js'].map((src) => html.indexOf(`<script src="${src}" defer="">`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('GET /add/review — one held barcode, looked up', () => {
  it('shows what the lookup found, when it was scanned, and a shelf to add it to or a way to drop it', async () => {
    const ravi = await member('ravi', 'admin');
    await createLibrary(env.DB, 'Fiction');
    bookLookup();
    const res = await as(ravi, `/add/review?barcode=${ISBN}&scanned=2026-09-30T08:15:02.123Z`, { htmx: true });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<article class="candidate review-entry" data-barcode="${ISBN}">`);
    expect(html).toContain('<strong>The Held Book</strong>');
    expect(html).toContain('<div>A. Writer</div>');
    expect(html).toContain('<time datetime="2026-09-30T08:15:02.123Z">2026-09-30 08:15 UTC</time>');
    expect(html).toContain('<form method="post" action="/items" class="candidate-save" data-review-add="true">');
    expect(html).toContain('<input type="hidden" name="title" value="The Held Book"/>');
    expect(html).toContain(`<input type="hidden" name="isbn13" value="${ISBN}"/>`);
    expect(html).toContain(`<input type="hidden" name="scanOwner" value="${await scanQueueOwner(env.SESSION_SECRET, ravi)}"/>`);
    expect(html).toMatch(/<select name="libraryId" aria-label="Shelf"><option value="\d+">Fiction<\/option><\/select>/);
    expect(html).toContain('<button type="submit">Add to shelf</button>');
    expect(html).toContain('data-review-drop');
    // no "Log — not owned" here: an entry is added, wanted or dropped
    expect(html).not.toContain('logOnly');
  });

  it('offers Want, the same button a search result has: name, value, label and title', async () => {
    const ravi = await member('ravi', 'admin');
    await createLibrary(env.DB, 'Fiction');
    bookLookup();
    const html = await (await as(ravi, `/add/review?barcode=${ISBN}`, { htmx: true })).text();
    // the search result's own button, rendered for the same book, is in the entry's form word for word
    const card = String(
      CandidateCard({
        candidate: { provider: 'openlibrary', mediaType: 'book', title: 'The Held Book', creators: null, publisher: null, published: null, description: null, length: null, isbn13: ISBN, isbn10Upc: null, coverUrl: null, details: {} },
        libraries: [],
      } as never),
    );
    const want = /<button type="submit" name="want" value="1"[^>]*>[^<]*<\/button>/.exec(card)?.[0];
    expect(want).toContain('>Want to read</button>');
    expect(want).toContain('title="Put it on your want list — added as Not owned, or the copy already in the catalog if there is one"');
    const form = /<form[^>]*data-review-add[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0];
    expect(form).toContain(want);
    expect(form).toContain('name="scanOwner"'); // the stamp rides with Want as with Add
  });

  it('says so when nothing matched, and offers another look or a drop — nothing to add', async () => {
    const ravi = await member('ravi', 'admin');
    await createLibrary(env.DB, 'Records');
    // a record's barcode, on an instance without a Discogs token: no lookup goes out
    const html = await (await as(ravi, '/add/review?barcode=0602547288011', { htmx: true })).text();
    expect(html).toContain('<strong>No match</strong>');
    expect(html).toContain('DISCOGS_TOKEN');
    expect(html).toContain('data-review-retry');
    expect(html).toContain('data-review-drop');
    expect(html).not.toContain('data-review-add');
    expect(html).not.toContain('<time'); // no scan time given, none shown
  });

  it('points to making a shelf first when there is none', async () => {
    const ravi = await member('ravi', 'admin');
    bookLookup();
    const html = await (await as(ravi, `/add/review?barcode=${ISBN}`, { htmx: true })).text();
    expect(html).toContain("There&#39;s no shelf to add it to yet");
    expect(html).not.toContain('data-review-add');
    expect(html).toContain('data-review-drop');
  });

  it('shows only a well-formed scan time, and refuses what isn’t a barcode', async () => {
    const ravi = await member('ravi', 'admin');
    await createLibrary(env.DB, 'Fiction');
    bookLookup();
    const html = await (await as(ravi, `/add/review?barcode=${ISBN}&scanned=${encodeURIComponent('<b>soon</b>')}`)).text();
    expect(html).not.toContain('<time');
    expect(html).not.toContain('<b>soon');
    for (const code of ['', 'abc', '12345', '123456789012345', '9780306406157x']) {
      expect((await as(ravi, `/add/review?barcode=${encodeURIComponent(code)}`)).status, code).toBe(400);
    }
  });

  it('is only for someone signed in', async () => {
    await member('ravi', 'admin');
    const res = await as(null, `/add/review?barcode=${ISBN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('POST /items from the review list', () => {
  const fields = (libraryId: number, scanOwner?: string) => ({
    mediaType: 'book',
    title: 'The Held Book',
    creators: 'A. Writer',
    isbn13: ISBN,
    coverUrl: '',
    details: '{}',
    libraryId: String(libraryId),
    ...(scanOwner === undefined ? {} : { scanOwner }),
  });

  it('adds it for whoever the list was shown to, and answers with the entry, added — not a redirect', async () => {
    const ravi = await member('ravi', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const res = await as(ravi, '/items', { body: fields(shelf.id, await scanQueueOwner(env.SESSION_SECRET, ravi)), htmx: true });
    expect(res.status).toBe(200);
    const [item] = await rows<{ id: number; library_id: number; added_by: number; copies: number }>(
      'SELECT id, library_id, added_by, copies FROM items WHERE isbn13 = ?',
      ISBN,
    );
    expect(item).toMatchObject({ library_id: shelf.id, added_by: ravi.id, copies: 1 });
    expect(await res.text()).toBe(
      `<article class="notice review-entry" data-added="true">Added <a href="/items/${item?.id}">The Held Book</a> to Fiction.</article>`,
    );
  });

  it('refuses a scan held for someone else — signed in since, in another tab — and adds nothing', async () => {
    const ravi = await member('ravi', 'admin');
    const priya = await member('priya');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const ravisStamp = await scanQueueOwner(env.SESSION_SECRET, ravi);
    for (const stamp of [ravisStamp, '', 'forged-stamp-000000000']) {
      const res = await as(priya, '/items', { body: fields(shelf.id, stamp), htmx: true });
      expect(res.status, stamp).toBe(409);
      expect(await res.text(), stamp).toContain('Nothing was added');
    }
    expect(await rows('SELECT id FROM items')).toEqual([]);
  });

  // §16 #56: ids are reused. A member removed and one added after them can share an id, and a phone they shared still
  // holds the removed member's scans under that account's stamp — the new member must neither see them nor add them.
  it('stamps an account, not its id: a member given a removed member’s id gets another stamp, and their scans are refused', async () => {
    await member('ravi', 'admin');
    const priya = await member('priya');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const priyasStamp = await scanQueueOwner(env.SESSION_SECRET, priya);
    await deleteUser(env.DB, priya.id);
    const sam = await member('sam');
    expect(sam.id).toBe(priya.id);

    const samsStamp = await scanQueueOwner(env.SESSION_SECRET, sam);
    expect(samsStamp).not.toBe(priyasStamp);
    const page = await (await as(sam, '/loans')).text();
    expect(/<body data-scan-owner="([^"]+)"/.exec(page)?.[1]).toBe(samsStamp); // the phone empties priya's queue
    const res = await as(sam, '/items', { body: fields(shelf.id, priyasStamp), htmx: true });
    expect(res.status).toBe(409);
    expect(await rows('SELECT id FROM items')).toEqual([]);
  });

  const wantsOf = async (userId: number) =>
    (await rows<{ item: number }>('SELECT item_id AS item FROM wants WHERE user_id = ? ORDER BY item_id', userId)).map((r) => r.item);

  it('wants it for whoever the list was shown to — added as Not owned — and answers with the entry, not a redirect', async () => {
    const ravi = await member('ravi', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const res = await as(ravi, '/items', { body: { ...fields(shelf.id, await scanQueueOwner(env.SESSION_SECRET, ravi)), want: '1' }, htmx: true });
    expect(res.status).toBe(200);
    const [item] = await rows<{ id: number; library_id: number; added_by: number; copies: number }>(
      'SELECT id, library_id, added_by, copies FROM items WHERE isbn13 = ?',
      ISBN,
    );
    expect(item).toMatchObject({ library_id: shelf.id, added_by: ravi.id, copies: 0 });
    expect(await wantsOf(ravi.id)).toEqual([item?.id]);
    // data-added: scan-review.js takes the entry out of the device's queue on this answer, as for Add
    expect(await res.text()).toBe(
      `<article class="notice review-entry" data-added="true">Put <a href="/items/${item?.id}">The Held Book</a> on your want list, added to Fiction as Not owned.</article>`,
    );
  });

  it('wants the copy already in the catalog, with no second one, and answers with the entry too', async () => {
    const ravi = await member('ravi', 'admin');
    const priya = await member('priya');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await as(ravi, '/items', { body: fields(shelf.id) }); // the catalog's copy, owned
    const [held] = await rows<{ id: number }>('SELECT id FROM items');
    const res = await as(priya, '/items', { body: { ...fields(shelf.id, await scanQueueOwner(env.SESSION_SECRET, priya)), want: '1' }, htmx: true });
    expect(res.status).toBe(200); // not the item page's redirect, which the review list would read as signed out
    expect(await res.text()).toBe(
      `<article class="notice review-entry" data-added="true">Put <a href="/items/${held?.id}">The Held Book</a> on your want list — the copy already in the catalog.</article>`,
    );
    expect(await rows('SELECT id, copies FROM items')).toEqual([{ id: held?.id, copies: 1 }]);
    expect(await wantsOf(priya.id)).toEqual([held?.id]);
    expect(await wantsOf(ravi.id)).toEqual([]);
  });

  it('refuses a Want held for someone else, as it refuses Add: nothing added, nothing wanted', async () => {
    const ravi = await member('ravi', 'admin');
    const priya = await member('priya');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const ravisStamp = await scanQueueOwner(env.SESSION_SECRET, ravi);
    for (const stamp of [ravisStamp, '', 'forged-stamp-000000000']) {
      const res = await as(priya, '/items', { body: { ...fields(shelf.id, stamp), want: '1' }, htmx: true });
      expect(res.status, stamp).toBe(409);
      expect(await res.text(), stamp).toContain('Nothing was added');
    }
    expect(await rows('SELECT id FROM items')).toEqual([]);
    // and with the book already in the catalog, where Want would only add a want: refused before that too
    await as(ravi, '/items', { body: fields(shelf.id) });
    const res = await as(priya, '/items', { body: { ...fields(shelf.id, ravisStamp), want: '1' }, htmx: true });
    expect(res.status).toBe(409);
    expect(await rows('SELECT user_id FROM wants')).toEqual([]);
    expect(await rows('SELECT id FROM items')).toHaveLength(1);
  });

  it('leaves the ordinary add as it was: no stamp, no htmx, a redirect to the new item', async () => {
    const ravi = await member('ravi', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const res = await as(ravi, '/items', { body: fields(shelf.id) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/items\/\d+$/);
  });

  it('answers an htmx add that can’t be saved with the reason, in plain text', async () => {
    const ravi = await member('ravi', 'admin');
    const res = await as(ravi, '/items', { body: { ...fields(9999, await scanQueueOwner(env.SESSION_SECRET, ravi)) }, htmx: true });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('No such shelf.');
  });
});
