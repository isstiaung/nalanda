// The per-isolate share-page cache (ARCH.md §16 #19): keyed by the canonical path and the listing's page number — the
// one query the routes read — so no visitor can evict the real pages with query-string variants; and cleared only by
// a request that can write, so an anonymous HEAD or OPTIONS leaves it warm.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createItem, createLibrary, createShare } from '../src/db/queries';
import { newShareToken } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { as } from './member-helpers';

async function raw(method: string, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, { method, redirect: 'manual' }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const cache = async (path: string) => (await as(null, path)).headers.get('x-cache');

async function shelfShare() {
  const lib = await createLibrary(env.DB, 'Books');
  const item = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'Public book' });
  const token = newShareToken();
  await createShare(env.DB, { token, name: 'Our shelf', libraryId: lib.id });
  return { lib, item, token };
}

beforeEach(() => clearSharePageCache());

describe('the cache key', () => {
  it('is the path and the page, so a junk query string is the same page and can’t evict the real ones', async () => {
    const { token } = await shelfShare();
    expect(await cache(`/share/${token}`)).toBe('miss');
    expect(await cache(`/share/${token}`)).toBe('hit');
    expect(await cache(`/share/${token}?junk=1`)).toBe('hit');
    expect(await cache(`/share/${token}?page=1`)).toBe('hit'); // the first page, spelled out
    for (let i = 0; i < 200; i++) {
      const res = await as(null, `/share/${token}?junk=${i}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe('hit'); // never a fresh render, never a slot of its own
    }
    expect(await cache(`/share/${token}`)).toBe('hit');
  });

  it('keeps each listing page apart, and keys item pages and feeds by their path alone', async () => {
    const { token, item } = await shelfShare();
    await as(null, `/share/${token}`);
    expect(await cache(`/share/${token}?page=2`)).toBe('miss'); // negative control: a page the route reads is its own entry
    expect(await cache(`/share/${token}?page=2`)).toBe('hit');
    expect(await cache(`/share/${token}/items/${item.id}`)).toBe('miss');
    expect(await cache(`/share/${token}/items/${item.id}?page=2`)).toBe('hit'); // an item page reads no page
    expect(await cache(`/share/${token}/feed.atom`)).toBe('miss');
    expect(await cache(`/share/${token}/feed.atom?x=1`)).toBe('hit');
  });
});

describe('clearing the cache', () => {
  it('is not done by an anonymous HEAD of a share page', async () => {
    const { token } = await shelfShare();
    await as(null, `/share/${token}`);
    expect(await cache(`/share/${token}`)).toBe('hit');
    const head = await raw('HEAD', `/share/${token}`);
    expect(head.status).toBe(200);
    expect(await cache(`/share/${token}`)).toBe('hit');
  });

  it('is not done by an anonymous OPTIONS to a route that answers it', async () => {
    const { token } = await shelfShare();
    await as(null, `/share/${token}`);
    expect(await cache(`/share/${token}`)).toBe('hit');
    const options = await raw('OPTIONS', '/login');
    expect(options.status).toBeLessThan(400); // negative control: the request is answered, as the probe found
    expect(await cache(`/share/${token}`)).toBe('hit');
  });
});
