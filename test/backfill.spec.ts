// Cover backfill: query filters/cursor + the whole route with provider APIs mocked
// (Open Library hit → cover stored; Google Books miss → item left coverless).
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

async function seed() {
  const lib = await createLibrary(env.DB, 'Backfill shelf');
  const withCoverableIsbn = await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Findable',
    isbn13: '9780000000001',
    details: '{}',
  });
  const withUnfindableIsbn = await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Unfindable',
    isbn13: '9780000000002',
    details: '{}',
  });
  await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'No identifier', details: '{}' });
  await createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'Already has cover',
    isbn13: '9780000000009',
    coverKey: 'existing-key',
    details: '{}',
  });
  return { lib, withCoverableIsbn, withUnfindableIsbn };
}

describe('backfill queries', () => {
  it('selects only coverless items with an identifier, cursor-paged', async () => {
    const { withCoverableIsbn, withUnfindableIsbn } = await seed();
    expect(await countBackfillable(env.DB)).toBe(2);

    const first = await nextBackfillable(env.DB, 0, 1);
    expect(first.map((i) => i.id)).toEqual([withCoverableIsbn.id]);

    const rest = await nextBackfillable(env.DB, withCoverableIsbn.id, 10);
    expect(rest.map((i) => i.id)).toEqual([withUnfindableIsbn.id]);
  });
});

describe('POST /api/backfill-covers', () => {
  it('stores found covers, skips misses, reports progress', async () => {
    const { withCoverableIsbn, withUnfindableIsbn } = await seed();

    // Open Library: knows the first ISBN (cover id 42), not the second.
    fetchMock
      .get('https://openlibrary.org')
      .intercept({ path: (p) => p.startsWith('/search.json') && p.includes('9780000000001') })
      .reply(200, JSON.stringify({ docs: [{ title: 'Findable', cover_i: 42 }] }), {
        headers: { 'content-type': 'application/json' },
      });
    fetchMock
      .get('https://openlibrary.org')
      .intercept({ path: (p) => p.startsWith('/search.json') && p.includes('9780000000002') })
      .reply(200, JSON.stringify({ docs: [] }), { headers: { 'content-type': 'application/json' } });
    fetchMock
      .get('https://covers.openlibrary.org')
      .intercept({ path: '/b/id/42-L.jpg' })
      .reply(200, 'x'.repeat(1200), { headers: { 'content-type': 'image/jpeg' } });
    // Google Books fallback for the second ISBN: also a miss.
    fetchMock
      .get('https://www.googleapis.com')
      .intercept({ path: (p) => p.includes('9780000000002') })
      .reply(200, JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } });

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
    const result = (await res.json()) as { tried: number; found: number; lastId: number; done: boolean };
    expect(result).toEqual({ tried: 2, found: 1, lastId: withUnfindableIsbn.id, done: true });

    const updated = await getItem(env.DB, withCoverableIsbn.id);
    expect(updated?.coverKey).toBeTruthy();
    const stored = await env.COVERS.get(updated!.coverKey!);
    expect(stored).not.toBeNull();
    expect((await stored!.arrayBuffer()).byteLength).toBe(1200);

    const missed = await getItem(env.DB, withUnfindableIsbn.id);
    expect(missed?.coverKey).toBeNull();
  });
});
