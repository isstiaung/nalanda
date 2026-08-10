// Cover backfill: query filters/cursor + the whole route with provider APIs mocked.
// Three seeded cases: exact ISBN hit (Open Library), full-chain miss, and an
// identifier-less item rescued by the title/author pass (Google Books).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateFetchMock, assertNoPendingInterceptors, intercept, jpeg, json } from './fetch-mock';
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

beforeEach(() => {
  activateFetchMock();
});
afterEach(() => {
  assertNoPendingInterceptors();
});

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
    intercept('https://openlibrary.org', olSearch('9780000000001'), json({ docs: [{ title: 'Findable', cover_i: 42 }] }));
    intercept('https://covers.openlibrary.org', '/b/id/42-L.jpg', jpeg());

    // B — junk everywhere (the polluted-ISBN case seen live): OL search returns a
    // record for a DIFFERENT book (no cover_i → would fall back to the by-ISBN cover
    // URL); the title guard must reject it without fetching that cover at all.
    intercept(
      'https://openlibrary.org',
      olSearch('9780000000002'),
      json({ docs: [{ title: 'The Three Voices of Poetry' }] }),
    );
    intercept('https://openlibrary.org', '/isbn/9780000000002.json', { status: 404, body: 'not found' });
    // GB "fuzzy" behavior for unknown ISBNs: returns an unrelated volume — the
    // identity guard must reject it (wrong ISBN, wrong title), never fetch its cover.
    intercept(
      'https://www.googleapis.com',
      gbSearch('9780000000002'),
      json({
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
    );
    intercept(
      'https://itunes.apple.com',
      (p) => p.startsWith('/lookup') && p.includes('9780000000002'),
      json({ resultCount: 0, results: [] }),
    );
    intercept('https://openlibrary.org', olSearch('Unfindable'), json({ docs: [] }));
    intercept('https://www.googleapis.com', gbSearch('Unfindable'), json({ items: [] }));

    // C — no identifier; OL title search misses, Google Books title search hits
    // (title differs only in case → titlesMatch accepts; http thumbnail → https).
    intercept('https://openlibrary.org', olSearch('identifier'), json({ docs: [] }));
    intercept(
      'https://www.googleapis.com',
      gbSearch('identifier'),
      json({
        items: [
          {
            volumeInfo: {
              title: 'No Identifier',
              imageLinks: { thumbnail: 'http://books.google.com/covers/c.jpg' },
            },
          },
        ],
      }),
    );
    intercept('https://books.google.com', '/covers/c.jpg', jpeg());

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
