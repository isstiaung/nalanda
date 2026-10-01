// Rapid batch scanning (ARCH.md §16 #94): "Add all" on the Add page's review list posts the held barcodes twenty at a
// time to POST /api/scans/add, which looks each one up, leaves alone what the catalog already has, and adds the rest
// as bare records — no cover, no description beyond the lookup's JSON, no release — in one D1 batch. These hold the
// endpoint: whose scans it takes, what it refuses, what it adds and reports, and that nothing but the providers is
// asked. The browser's loop is test/scan-batch-browser.spec.ts.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItem, createLibrary } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';
import { scanQueueOwner } from '../src/lib/auth';
import { MAX_SCANS_PER_REQUEST } from '../src/routes/add';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { html, member, rows, type Member } from './member-helpers';

const OL = 'https://openlibrary.org';
const GB = 'https://www.googleapis.com';
const DISCOGS = 'https://api.discogs.com';

/** Open Library's lean search answer for an ISBN: one edition, or nothing. */
const olAnswers = (isbn: string, title: string | null, doc: Record<string, unknown> = {}) =>
  intercept(
    OL,
    (p) => p.startsWith(`/search.json?q=isbn%3A${isbn}&`),
    json({
      numFound: title ? 1 : 0,
      docs: title ? [{ key: '/works/OL1W', title, author_name: ['A. Writer'], publisher: ['Small Press'], first_publish_year: 2001, number_of_pages_median: 240, cover_i: 42, ...doc }] : [],
    }),
  );
/** Google Books' answer for an ISBN: a volume, with a description, or nothing. */
const gbAnswers = (isbn: string, title: string | null, description?: string) =>
  intercept(
    GB,
    (p) => p.startsWith(`/books/v1/volumes?q=isbn%3A${isbn}&`),
    json(title ? { items: [{ volumeInfo: { title, description, industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn.length === 13 ? isbn : `978${isbn.slice(0, 9)}5` }] } }] } : { totalItems: 0 }),
  );
/** Both providers asked, as every ISBN is; Open Library's edition wins the bibliographic fields. */
const bookKnown = (isbn: string, title: string) => {
  olAnswers(isbn, title);
  gbAnswers(isbn, null);
};
const bookUnknown = (isbn: string) => {
  olAnswers(isbn, null);
  gbAnswers(isbn, null);
};

/** Every outbound URL the app asks for from here on, over the mock: proof of what was and wasn't fetched. */
function asked(): string[] {
  const urls: string[] = [];
  const mocked = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return mocked(input, init);
  }) as typeof fetch;
  return urls;
}

const codesOf = (codes: string[]) => codes.map((code, i) => ({ code, at: `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00Z` }));

/** POST /api/scans/add as `who`, the body as the review list sends it — the stamp theirs unless `stamp` says otherwise. */
async function post(
  who: Member | null,
  body: { libraryId?: unknown; codes?: unknown; scanOwner?: unknown },
  opts: { bindings?: Partial<Bindings>; budget?: { left: number }; raw?: string } = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const bindings = { ...env, ...opts.bindings, ...(opts.budget ? { DB: budgeted(env.DB, opts.budget) } : {}) } as Bindings;
  const headers: Record<string, string> = { origin: 'http://nalanda.test', 'content-type': 'application/json' };
  if (who) headers.cookie = who.cookie;
  const res = await app.fetch(
    new Request('http://nalanda.test/api/scans/add', { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body), redirect: 'manual' }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

type Reply = { added: Array<{ code: string; id: number; title: string }>; already: Array<{ code: string; id: number; title: string }>; notFound: string[]; notices: string[] };

beforeEach(() => activateFetchMock());
afterEach(() => assertNoPendingInterceptors());

describe('POST /api/scans/add', () => {
  it('adds the books found as bare records of the signed-in member, in one D1 batch, and asks nothing but the providers', async () => {
    const ravi = await member('ravi'); // a member, not an admin: adding is everyone's
    const shelf = await createLibrary(env.DB, 'Fiction');
    const [a, b, c] = ['9780306406157', '9780441478125', '9780060512750'];
    olAnswers(a, 'A Wizard of Earthsea', { series_name: ['Earthsea Cycle'], series_position: ['1'], language: ['fre'] });
    gbAnswers(a, 'A Wizard of Earthsea', 'Ged, the greatest sorcerer in all Earthsea.');
    olAnswers(b, null);
    gbAnswers(b, 'Only Google Knows', 'Found by Google Books alone.');
    bookUnknown(c);
    const urls = asked();

    const budget = { left: 1000 };
    const res = await post(ravi, { libraryId: shelf.id, codes: codesOf([a, b, c]), scanOwner: await scanQueueOwner(env.SESSION_SECRET, ravi) }, { budget });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as Reply;
    expect(reply.added.map((x) => [x.code, x.title])).toEqual([
      [a, 'A Wizard of Earthsea'],
      [b, 'Only Google Knows'],
    ]);
    expect(reply.already).toEqual([]);
    expect(reply.notFound).toEqual([c]);
    expect(reply.notices).toEqual([`No book found for ISBN ${c}. Try the search tab or add manually.`]);

    // the session, the shelf with the household's settings, the catalog check, the insert: four calls, the inserts one batch
    expect(1000 - budget.left).toBe(4);
    const items = await rows<Record<string, unknown>>(
      'SELECT id, title, creators, publisher, published, length, isbn13, description, language, copies, added_by, cover_key, library_id, media_type, series_id, series_number FROM items ORDER BY id',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: reply.added[0]!.id,
      title: 'A Wizard of Earthsea',
      creators: 'A. Writer',
      publisher: 'Small Press',
      published: '2001',
      length: 240,
      isbn13: a,
      description: 'Ged, the greatest sorcerer in all Earthsea.', // what the lookup's JSON carried — nothing fetched for it
      language: 'fr', // the provider said
      copies: 1,
      added_by: ravi.id,
      cover_key: null,
      library_id: shelf.id,
      media_type: 'book',
      series_number: 1,
    });
    expect(items[0]!.series_id).not.toBeNull();
    expect(await rows('SELECT name FROM series')).toEqual([{ name: 'Earthsea Cycle' }]);
    expect(items[1]).toMatchObject({ id: reply.added[1]!.id, title: 'Only Google Knows', isbn13: b, language: 'en', added_by: ravi.id, cover_key: null, series_id: null });
    // bare: no tags, no reads, no reviews, no cover
    expect(await rows('SELECT item_id FROM item_tags')).toEqual([]);
    expect(await rows('SELECT id FROM reads')).toEqual([]);
    expect(await rows('SELECT id FROM reviews')).toEqual([]);
    // the writer's marker set and cleared in the batch (#84); a creation records no history row, by that decision
    expect(await rows('SELECT id FROM acting')).toEqual([]);
    expect(await rows('SELECT id FROM item_history')).toEqual([]);
    // two providers per ISBN and nothing else: no cover host, no work record, no Discogs
    expect(urls).toHaveLength(6);
    expect(urls.every((u) => u.startsWith(`${OL}/search.json`) || u.startsWith(`${GB}/books/v1/volumes`))).toBe(true);
    // added as today's news to connections, as an Add from the page is — not as an import
    expect(await rows('SELECT id FROM import_in_progress')).toEqual([]);
  });

  it('refuses scans held for another account — 409, nothing looked up, nothing added', async () => {
    const ravi = await member('ravi', 'admin');
    const priya = await member('priya');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const urls = asked();
    for (const stamp of [await scanQueueOwner(env.SESSION_SECRET, ravi), '', 'forged-stamp-000000000', undefined]) {
      const res = await post(priya, { libraryId: shelf.id, codes: codesOf(['9780306406157']), scanOwner: stamp });
      expect(res.status, String(stamp)).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('Nothing was added');
    }
    expect(urls).toEqual([]);
    expect(await rows('SELECT id FROM items')).toEqual([]);
  });

  it('refuses more than twenty barcodes, anything that is not one, a missing shelf and a bad body — before any lookup', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const stamp = await scanQueueOwner(env.SESSION_SECRET, ravi);
    const urls = asked();
    expect(MAX_SCANS_PER_REQUEST).toBe(20);
    const many = codesOf(Array.from({ length: 21 }, (_, i) => `97803064${String(i).padStart(5, '0')}`));
    let res = await post(ravi, { libraryId: shelf.id, codes: many, scanOwner: stamp });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Send at most 20 barcodes per request.');
    for (const bad of ['abc', '12345', '123456789012345', '9780306406157x', '']) {
      res = await post(ravi, { libraryId: shelf.id, codes: codesOf([bad]), scanOwner: stamp });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('Not a barcode.');
    }
    res = await post(ravi, { libraryId: shelf.id, codes: ['9780306406157'], scanOwner: stamp }); // a bare string is not an entry
    expect(res.status).toBe(400);
    res = await post(ravi, { libraryId: shelf.id, scanOwner: stamp });
    expect(res.status).toBe(400);
    res = await post(ravi, { libraryId: 9999, codes: codesOf(['9780306406157']), scanOwner: stamp });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('No such shelf.');
    res = await post(ravi, {}, { raw: '{not json' });
    expect(res.status).toBe(400);
    expect(urls).toEqual([]);
    expect(await rows('SELECT id FROM items')).toEqual([]);
  });

  it('leaves what the catalog already has alone — by ISBN-13, by the ISBN-10 that stands for it, by a record’s barcode — and adds a book scanned twice in one run once', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const piranesi = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'Piranesi', isbn13: '9781635575637', details: '{}' });
    const elements = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'The Elements of Style', isbn13: '9780060512750', details: '{}' });
    // a record catalogued by hand, on an instance with no Discogs token: nothing is found for its barcode, but it is here
    const record = await createItem(env.DB, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Monsoon Suites', isbn13: '0724384260910', details: '{}' });
    bookKnown('9781635575637', 'Piranesi (another edition)');
    bookKnown('0060512750', 'The Elements of Style'); // the ISBN-10: its candidate carries the derived ISBN-13
    bookKnown('9780441478125', 'The Left Hand of Darkness');
    bookKnown('0441478123', 'The Left Hand of Darkness'); // the same book's ISBN-10, later in the run
    const stamp = await scanQueueOwner(env.SESSION_SECRET, ravi);
    const res = await post(ravi, { libraryId: shelf.id, codes: codesOf(['9781635575637', '0060512750', '0724384260910', '9780441478125', '0441478123']), scanOwner: stamp });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as Reply;
    expect(reply.added).toEqual([{ code: '9780441478125', id: expect.any(Number), title: 'The Left Hand of Darkness' }]);
    const added = reply.added[0]!.id;
    expect(reply.already).toEqual([
      { code: '9781635575637', id: piranesi.id, title: 'Piranesi' }, // the catalog's title, not the lookup's
      { code: '0060512750', id: elements.id, title: 'The Elements of Style' },
      { code: '0724384260910', id: record.id, title: 'Monsoon Suites' },
      { code: '0441478123', id: added, title: 'The Left Hand of Darkness' },
    ]);
    expect(reply.notFound).toEqual([]);
    expect(reply.notices).toEqual([]); // the token notice is for a barcode nothing was found for; this one was here
    expect(await rows<{ n: number }>('SELECT count(*) AS n FROM items')).toEqual([{ n: 4 }]);
    expect(await rows('SELECT isbn13, isbn10_upc AS upc FROM items WHERE id = ?1', added)).toEqual([{ isbn13: '9780441478125', upc: null }]);
  });

  it('adds a record as Discogs’ search described it — the release, the cover and the Cover Art Archive left for later', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Records');
    intercept(DISCOGS, (p) => p.startsWith('/database/search?barcode=0724384260910&type=release'), json({
      results: [{ id: 7700123, title: 'The Hillside Quartet - Monsoon Suites', year: '2019', label: ['Harvest'], catno: 'HV-1', country: 'UK', format: ['Vinyl', 'LP', 'Album'], genre: ['Jazz'], cover_image: 'https://i.discogs.com/abc.jpg' }],
    }));
    const urls = asked();
    const stamp = await scanQueueOwner(env.SESSION_SECRET, ravi);
    const res = await post(ravi, { libraryId: shelf.id, codes: codesOf(['0724384260910']), scanOwner: stamp }, { bindings: { DISCOGS_TOKEN: 'test-token' } });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as Reply;
    expect(reply.added).toEqual([{ code: '0724384260910', id: expect.any(Number), title: 'Monsoon Suites' }]);
    const [item] = await rows<Record<string, unknown>>('SELECT media_type, title, creators, publisher, published, isbn13, isbn10_upc AS upc, formats, details, cover_key, added_by FROM items');
    // the barcode scanned is the record's own, kept in both columns as an Add from the page keeps it (§16 #53)
    expect(item).toMatchObject({ media_type: 'vinyl', title: 'Monsoon Suites', creators: 'The Hillside Quartet', publisher: 'Harvest', published: '2019', isbn13: '0724384260910', upc: '0724384260910', formats: 'lp', cover_key: null, added_by: ravi.id });
    expect(JSON.parse(String(item!.details))).toMatchObject({ discogs_id: 7700123, label: 'Harvest', catno: 'HV-1', country: 'UK', year: 2019 });
    expect(JSON.parse(String(item!.details)).tracklist).toBeUndefined(); // no release fetched: "Refresh from Discogs" fills it later
    expect(urls).toEqual([`${DISCOGS}/database/search?barcode=0724384260910&type=release&per_page=3`]);
  });

  it('reports a record’s barcode as not found without a Discogs token, with the notice, and asks nothing', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Records');
    const urls = asked();
    const res = await post(ravi, { libraryId: shelf.id, codes: codesOf(['0602547288011']), scanOwner: await scanQueueOwner(env.SESSION_SECRET, ravi) });
    const reply = (await res.json()) as Reply;
    expect(reply).toEqual({ added: [], already: [], notFound: ['0602547288011'], notices: [expect.stringContaining('DISCOGS_TOKEN')] });
    expect(urls).toEqual([]);
    expect(await rows('SELECT id FROM items')).toEqual([]);
  });

  it('takes a full batch of twenty in one request: forty provider calls, four D1 calls, twenty items', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const codes = Array.from({ length: 20 }, (_, i) => `97803064${String(i).padStart(5, '0')}`);
    codes.forEach((isbn, i) => bookKnown(isbn, `Book ${i}`));
    const urls = asked();
    const budget = { left: 1000 };
    const res = await post(ravi, { libraryId: shelf.id, codes: codesOf(codes), scanOwner: await scanQueueOwner(env.SESSION_SECRET, ravi) }, { budget });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as Reply;
    expect(reply.added).toHaveLength(20);
    expect(reply.added.map((a) => a.title)).toEqual(codes.map((_, i) => `Book ${i}`)); // in the list's order
    expect(urls).toHaveLength(40);
    expect(1000 - budget.left).toBe(4);
    expect(await rows<{ n: number }>('SELECT count(*) AS n FROM items WHERE added_by = ?1', ravi.id)).toEqual([{ n: 20 }]);
  });

  it('is only for someone signed in', async () => {
    await member('ravi');
    const res = await post(null, { libraryId: 1, codes: [], scanOwner: '' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('the Add page, for a run of scans', () => {
  it('offers "Keep scanning", a labelled checkbox beside the camera, and a live status line for the list', async () => {
    const ravi = await member('ravi');
    await createLibrary(env.DB, 'Fiction');
    const page = await html(ravi, '/add');
    expect(page).toContain('<label class="scanner-keep"><input type="checkbox" id="scanner-keep"/> Keep scanning');
    expect(page).toContain('<p id="scan-review-status" class="muted scan-review-status" aria-live="polite"></p>');
    expect(page).toContain('<p id="scanner-status" class="muted" aria-live="polite"></p>'); // the running count, said as well as beeped
    expect(page).toContain('Add all to <span data-shelf-name="true">Fiction</span>');
    // the scan tab is the one open, as before
    expect(page).toContain('<button type="button" class="tab active" data-tab="scan" aria-pressed="true">');
    expect(page).toContain('<section id="tab-manual" class="tab-panel" hidden="">');
  });

  it('opens on the manual form with the barcode filled in — "Add by hand" for a scan nothing was found for', async () => {
    const ravi = await member('ravi');
    await createLibrary(env.DB, 'Fiction');
    let page = await html(ravi, '/add?barcode=9780306406157');
    expect(page).toContain('<button type="button" class="tab active" data-tab="manual" aria-pressed="true">');
    expect(page).toContain('<button type="button" class="tab" data-tab="scan" aria-pressed="false">');
    expect(page).toContain('<section id="tab-scan" class="tab-panel" hidden="">');
    expect(page).toContain('<section id="tab-manual" class="tab-panel active">');
    expect(page).toContain('<input name="isbn13" value="9780306406157" inputmode="numeric"/>');
    expect(page).toContain('<input name="isbn10Upc" value=""/>');
    expect(page).toContain('<option value="book" selected="">Book</option>');
    // an ISBN-10 goes in its own field, as a book; a record's barcode as vinyl
    page = await html(ravi, '/add?barcode=0060512750');
    expect(page).toContain('<input name="isbn13" value="" inputmode="numeric"/>');
    expect(page).toContain('<input name="isbn10Upc" value="0060512750"/>');
    expect(page).toContain('<option value="book" selected="">Book</option>');
    page = await html(ravi, '/add?barcode=0724384260910');
    expect(page).toContain('<input name="isbn10Upc" value="0724384260910"/>');
    expect(page).toContain('<option value="vinyl" selected="">Vinyl</option>');
    // what isn't a barcode fills nothing and leaves the scan tab open
    page = await html(ravi, `/add?barcode=${encodeURIComponent('<b>9780306406157')}`);
    expect(page).toContain('<button type="button" class="tab active" data-tab="scan" aria-pressed="true">');
    expect(page).toContain('<input name="isbn13" value="" inputmode="numeric"/>');
    expect(page).not.toContain('<b>');
  });
});
