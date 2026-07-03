// Cover backfill: query filters/cursor + the whole route with provider APIs mocked.
// Three seeded cases: exact ISBN hit (Open Library), full-chain miss, and an
// identifier-less item rescued by the title/author pass (Google Books).
import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  countBackfillable,
  createItem,
  createLibrary,
  createUser,
  getItem,
  nextBackfillable,
} from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };
const FAKE_JPEG = ['x'.repeat(1200), { headers: { 'content-type': 'image/jpeg' } }] as const;

async function seed() {
  const lib = await createLibrary(env.DB, 'Backfill shelf');
  const byIsbn = await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Findable',
    isbn13: '9780000000001',
    details: '{}',
  });
  const unfindable = await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Unfindable',
    isbn13: '9780000000002',
    details: '{}',
  });
  const byTitle = await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'No identifier',
    details: '{}',
  });
  await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Already has cover',
    isbn13: '9780000000009',
    coverKey: 'existing-key',
    details: '{}',
  });
  return { lib, byIsbn, unfindable, byTitle };
}

// Match on raw (still URL-encoded) paths with space/quote-free tokens — decoding
// inside matchers is fragile.
const olSearch = (needle: string) => (p: string) => p.startsWith('/search.json') && p.includes(needle);
const gbSearch = (needle: string) => (p: string) => p.includes(needle);

describe('backfill queries', () => {
  it('selects every coverless item, cursor-paged', async () => {
    const { byIsbn, unfindable, byTitle } = await seed();
    expect(await countBackfillable(env.DB)).toBe(3);

    const first = await nextBackfillable(env.DB, 0, 1);
    expect(first.map((i) => i.id)).toEqual([byIsbn.id]);

    const rest = await nextBackfillable(env.DB, byIsbn.id, 10);
    expect(rest.map((i) => i.id)).toEqual([unfindable.id, byTitle.id]);
  });
});

describe('POST /api/backfill-covers', () => {
  it('exact match stores, full miss skips, title match rescues', async () => {
    const { byIsbn, unfindable, byTitle } = await seed();

    // A — exact ISBN hit on Open Library search (cover id 42).
    fetchMock
      .get('https://openlibrary.org')
      .intercept({ path: olSearch('9780000000001') })
      .reply(200, JSON.stringify({ docs: [{ title: 'Findable', cover_i: 42 }] }), JSON_HEADERS);
    fetchMock.get('https://covers.openlibrary.org').intercept({ path: '/b/id/42-L.jpg' }).reply(200, ...FAKE_JPEG);

    // B — junk everywhere (the polluted-ISBN case seen live): OL search returns a
    // record for a DIFFERENT book (no cover_i → would fall back to the by-ISBN cover
    // URL); the title guard must reject it without fetching that cover at all.
    fetchMock
      .get('https://openlibrary.org')
      .intercept({ path: olSearch('9780000000002') })
      .reply(200, JSON.stringify({ docs: [{ title: 'The Three Voices of Poetry' }] }), JSON_HEADERS);
    fetchMock
      .get('https://openlibrary.org')
      .intercept({ path: '/isbn/9780000000002.json' })
      .reply(404, 'not found');
    // GB "fuzzy" behavior for unknown ISBNs: returns an unrelated volume — the
    // identity guard must reject it (wrong ISBN, wrong title), never fetch its cover.
    fetchMock
      .get('https://www.googleapis.com')
      .intercept({ path: gbSearch('9780000000002') })
      .reply(
        200,
        JSON.stringify({
          items: [
            {
              volumeInfo: {
                title: 'Random Wrong Book',
                imageLinks: { thumbnail: 'http://books.google.com/covers/wrong.jpg' },
                industryIdentifiers: [{ type: 'ISBN_13', identifier: '9789999999999' }],
              },
            },
          ],
        }),
        JSON_HEADERS,
      );
    fetchMock
      .get('https://itunes.apple.com')
      .intercept({ path: (p) => p.startsWith('/lookup') && p.includes('9780000000002') })
      .reply(200, JSON.stringify({ resultCount: 0, results: [] }), JSON_HEADERS);
    fetchMock
      .get('https://openlibrary.org')
      .intercept({ path: olSearch('Unfindable') })
      .reply(200, JSON.stringify({ docs: [] }), JSON_HEADERS);
    fetchMock
      .get('https://www.googleapis.com')
      .intercept({ path: gbSearch('Unfindable') })
      .reply(200, JSON.stringify({ items: [] }), JSON_HEADERS);

    // C — no identifier; OL title search misses, Google Books title search hits
    // (title differs only in case → titlesMatch accepts; http thumbnail → https).
    fetchMock
      .get('https://openlibrary.org')
      .intercept({ path: olSearch('identifier') })
      .reply(200, JSON.stringify({ docs: [] }), JSON_HEADERS);
    fetchMock
      .get('https://www.googleapis.com')
      .intercept({ path: gbSearch('identifier') })
      .reply(
        200,
        JSON.stringify({
          items: [
            {
              volumeInfo: {
                title: 'No Identifier',
                imageLinks: { thumbnail: 'http://books.google.com/covers/c.jpg' },
              },
            },
          ],
        }),
        JSON_HEADERS,
      );
    fetchMock.get('https://books.google.com').intercept({ path: '/covers/c.jpg' }).reply(200, ...FAKE_JPEG);

    const admin = await createUser(env.DB, {
      username: 'admin',
      passwordHash: 'pbkdf2$1$x$y',
      role: 'admin',
      mustChangePassword: false,
    });
    const token = await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000));

    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://nalanda.test/api/backfill-covers', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ after: 0 }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const result = (await res.json()) as Record<string, unknown>;
    expect(result).toEqual({ tried: 3, found: 2, byTitle: 1, lastId: byTitle.id, done: true });

    // head(), not get(): an unconsumed R2 body breaks isolated-storage teardown
    const exact = await getItem(env.DB, byIsbn.id);
    expect(exact?.coverKey).toBeTruthy();
    expect(await env.COVERS.head(exact!.coverKey!)).not.toBeNull();

    expect((await getItem(env.DB, unfindable.id))?.coverKey).toBeNull();

    const rescued = await getItem(env.DB, byTitle.id);
    expect(rescued?.coverKey).toBeTruthy();
    expect(await env.COVERS.head(rescued!.coverKey!)).not.toBeNull();
  });
});
