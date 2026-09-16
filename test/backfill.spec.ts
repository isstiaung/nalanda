// Cover backfill: query filters/cursor + the whole route with provider APIs mocked.
// Four seeded cases: exact ISBN hit (Open Library), full-chain miss, an identifier-less
// item rescued by the title/author pass (Google Books), and an item that already has a
// cover but no description — it keeps its cover and gains details.
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
import { olSearchLean, openLibrary } from '../src/metadata/openlibrary';
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
  // nothing left to fetch: a cover and a description already
  await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Already done',
    isbn13: '9780000000009',
    coverKey: 'existing-key',
    description: 'Written by hand.',
    details: '{}',
  });
  const needsDetails = await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Cover but no words',
    creators: 'Ada Author',
    coverKey: 'keep-this-key',
    details: '{}',
  });
  return { lib, byIsbn, unfindable, byTitle, needsDetails };
}

// Match on raw (still URL-encoded) paths with space/quote-free tokens — decoding
// inside matchers is fragile.
const olSearch = (needle: string) => (p: string) => p.startsWith('/search.json') && p.includes(needle);
const gbSearch = (needle: string) => (p: string) => p.includes(needle);

async function backfill(userId: number, after: number): Promise<Record<string, unknown>> {
  const token = await createSessionToken(env.SESSION_SECRET, userId, Math.floor(Date.now() / 1000));
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request('http://nalanda.test/api/backfill-covers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ after }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('backfill queries', () => {
  it('selects items short of a cover or a description, cursor-paged', async () => {
    const { byIsbn, unfindable, byTitle, needsDetails } = await seed();
    // the one with both is left alone; the cover-only item counts toward descriptions but not covers
    expect(await countBackfillable(env.DB)).toEqual({ total: 4, noCover: 3, noDescription: 4 });

    const first = await nextBackfillable(env.DB, 0, 1);
    expect(first.map((i) => i.id)).toEqual([byIsbn.id]);

    const rest = await nextBackfillable(env.DB, byIsbn.id, 10);
    expect(rest.map((i) => i.id)).toEqual([unfindable.id, byTitle.id, needsDetails.id]);
  });
});

describe('GET /import', () => {
  it('reports the cover and description gaps separately', async () => {
    await seed();
    const admin = await createUser(env.DB, {
      username: 'admin',
      passwordHash: 'pbkdf2$1$x$y',
      role: 'admin',
      mustChangePassword: false,
    });
    const token = await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000));
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://nalanda.test/import', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const text = (await res.text()).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    // overlapping gaps: three lack a cover, four lack a description, four items in all
    expect(text).toContain('3 items missing cover art · 4 items missing a description');
    expect(text).toContain('Run backfill');
  });
});

describe('POST /api/backfill-covers', () => {
  it('exact match stores, full miss skips, title match rescues, and details fill blanks', async () => {
    const { byIsbn, unfindable, byTitle, needsDetails } = await seed();
    const admin = await createUser(env.DB, {
      username: 'admin',
      passwordHash: 'pbkdf2$1$x$y',
      role: 'admin',
      mustChangePassword: false,
    });

    // A — exact ISBN hit on Open Library search (cover id 42), carrying details too.
    intercept(
      'https://openlibrary.org',
      olSearch('9780000000001'),
      json({ docs: [{ title: 'Findable', cover_i: 42, publisher: ['Real Press'], first_publish_year: 1997, number_of_pages_median: 210 }] }),
    );
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
              description: 'A book about nothing in particular, at considerable length.',
              imageLinks: { thumbnail: 'http://books.google.com/covers/c.jpg' },
            },
          },
        ],
      }),
    );
    intercept('https://books.google.com', '/covers/c.jpg', jpeg());

    const first = await backfill(admin.id, 0);
    // two per batch, so the first round covers A and B only — done stays false
    expect(first).toEqual({ tried: 2, found: 1, byTitle: 0, enriched: 1, lastId: unfindable.id, done: false });

    // head(), not get(): an unconsumed R2 body breaks isolated-storage teardown
    const exact = await getItem(env.DB, byIsbn.id);
    expect(exact?.coverKey).toBeTruthy();
    expect(await env.COVERS.head(exact!.coverKey!)).not.toBeNull();
    expect(exact?.publisher).toBe('Real Press'); // blanks filled from the same record
    expect(exact?.published).toBe('1997');
    expect(exact?.length).toBe(210);

    expect((await getItem(env.DB, unfindable.id))?.coverKey).toBeNull();

    // D — already has a cover: no image is fetched (no interceptor for the thumbnail),
    // the cover it has is kept, and only the empty fields are filled.
    intercept('https://openlibrary.org', olSearch('Cover'), json({ docs: [] }));
    intercept(
      'https://www.googleapis.com',
      gbSearch('Cover'),
      json({
        items: [
          {
            volumeInfo: {
              title: 'Cover but no words',
              authors: ['Ada Author'],
              description: 'The words it was missing, spelled out at a reasonable length.',
              publisher: 'Later Press',
              publishedDate: '2011',
              pageCount: 99,
              imageLinks: { thumbnail: 'http://books.google.com/covers/unused.jpg' },
            },
          },
        ],
      }),
    );

    const second = await backfill(admin.id, unfindable.id);
    expect(second).toEqual({ tried: 2, found: 1, byTitle: 1, enriched: 2, lastId: needsDetails.id, done: false });

    const rescued = await getItem(env.DB, byTitle.id);
    expect(rescued?.coverKey).toBeTruthy();
    expect(rescued?.description).toBe('A book about nothing in particular, at considerable length.');
    expect(await env.COVERS.head(rescued!.coverKey!)).not.toBeNull();

    const filled = await getItem(env.DB, needsDetails.id);
    expect(filled?.coverKey).toBe('keep-this-key'); // the cover it already had is left alone
    expect(filled?.description).toBe('The words it was missing, spelled out at a reasonable length.');
    expect(filled?.publisher).toBe('Later Press');
    expect(filled?.length).toBe(99);

    // E — the author is recorded more fully than the provider credits it ("Mary Wollstonecraft
    // Shelley" vs "Mary Shelley"): the author-pinned queries find nothing, the title-only retry does.
    const wrongName = await createItem(env.DB, {
      libraryId: (await createLibrary(env.DB, 'Fallback shelf')).id,
      mediaType: 'book',
      title: 'Frankenstein',
      creators: 'Mary Wollstonecraft Shelley',
      details: '{}',
    });
    // `author%3A` is the query operator — the URL's fields list mentions author_name regardless
    intercept('https://openlibrary.org', (p) => p.includes('Frankenstein') && p.includes('author%3A'), json({ docs: [] }));
    intercept('https://www.googleapis.com', (p) => p.includes('Frankenstein') && p.includes('inauthor%3A'), json({ items: [] }));
    intercept(
      'https://openlibrary.org',
      (p) => p.includes('Frankenstein') && !p.includes('author%3A'),
      json({ docs: [{ title: 'Frankenstein', author_name: ['Mary Shelley'], cover_i: 77 }] }),
    );
    intercept('https://covers.openlibrary.org', '/b/id/77-L.jpg', jpeg());

    // F — Open Library matches but its search index carries no description; the work record does.
    const workbound = await createItem(env.DB, {
      libraryId: (await createLibrary(env.DB, 'Work shelf')).id,
      mediaType: 'book',
      title: 'Workbound',
      creators: 'Ada Author',
      coverKey: 'already-has-one',
      details: '{}',
    });
    intercept(
      'https://openlibrary.org',
      (p) => p.includes('Workbound') && p.includes('author%3A'),
      json({ docs: [{ key: '/works/OL7W', title: 'Workbound', author_name: ['Ada Author'] }] }),
    );
    intercept('https://www.googleapis.com', (p) => p.includes('Workbound') && p.includes('inauthor%3A'), json({ items: [] }));
    intercept('https://openlibrary.org', (p) => p.includes('Workbound') && !p.includes('author%3A'), json({ docs: [] }));
    intercept('https://www.googleapis.com', (p) => p.includes('Workbound') && !p.includes('inauthor%3A'), json({ items: [] }));
    intercept(
      'https://openlibrary.org',
      '/works/OL7W.json',
      json({ description: { value: '**A description** from the work record, long enough to keep.\n\n([source][1])\n\n  [1]: https://example.com/x' } }),
    );

    const third = await backfill(admin.id, needsDetails.id);
    expect(third).toEqual({ tried: 2, found: 1, byTitle: 1, enriched: 1, lastId: workbound.id, done: false });
    expect((await getItem(env.DB, wrongName.id))?.coverKey).toBeTruthy(); // rescued by the title-only retry
    const described = await getItem(env.DB, workbound.id);
    expect(described?.description).toBe('A description from the work record, long enough to keep.'); // markdown and footnote stripped
    expect(described?.coverKey).toBe('already-has-one'); // its cover is left alone
  });
});

describe('Open Library request size', () => {
  // A search doc carries every edition's ISBN — 70 KB for a much-reprinted work, even at limit 1 —
  // and parsing it costs CPU the Worker does not have. Only the flow that records an ISBN asks for it.
  it('cover and description lookups use the lean field set', async () => {
    let seen = '';
    intercept(
      'https://openlibrary.org',
      (p) => {
        seen = p;
        return p.startsWith('/search.json');
      },
      json({ docs: [] }),
    );

    await olSearchLean('title:"Frankenstein"');

    expect(seen).not.toContain('isbn');
    expect(seen).toContain('cover_i');
    expect(seen).toContain('limit=5');
  });

  it('adding a book by name still asks for the ISBNs it records', async () => {
    let seen = '';
    intercept(
      'https://openlibrary.org',
      (p) => {
        seen = p;
        return p.startsWith('/search.json');
      },
      json({ docs: [] }),
    );

    await openLibrary.search('Frankenstein');

    expect(seen).toContain('isbn');
  });
});
