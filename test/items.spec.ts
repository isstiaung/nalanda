// Route-level: the add flow's "Log — not owned" action and the copies=0 lend guard,
// driven through the real app (session cookie + browser-faithful CSRF headers).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createUser, getItem, listShares } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

async function seedSession() {
  const user = await createUser(env.DB, {
    username: `u-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: 'pbkdf2$100000$x$y',
    role: 'admin', // share-view publishing is admin-only
    mustChangePassword: false,
  });
  const lib = await createLibrary(env.DB, 'Shelf');
  const token = await createSessionToken(env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000));
  return { lib, cookie: `${SESSION_COOKIE}=${token}` };
}

async function post(path: string, body: Record<string, string>, cookie: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        cookie,
      },
      body: new URLSearchParams(body).toString(),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('add flow: Log — not owned', () => {
  it('creates a copies=0 entry and redirects to the edit form', async () => {
    const { lib, cookie } = await seedSession();
    const res = await post(
      '/items',
      { title: 'Piranesi', libraryId: String(lib.id), mediaType: 'book', logOnly: '1' },
      cookie,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toMatch(/^\/items\/\d+\/edit$/);

    const id = Number(location.match(/\d+/)![0]);
    const item = await getItem(env.DB, id);
    expect(item!.copies).toBe(0);
    expect(item!.title).toBe('Piranesi');
  });

  it('mark-owned flips a copies=0 item to owned in place, without a form', async () => {
    const { lib, cookie } = await seedSession();
    const logged = await post(
      '/items',
      { title: 'TBR Pickup', libraryId: String(lib.id), mediaType: 'book', logOnly: '1' },
      cookie,
    );
    const id = Number(logged.headers.get('location')!.match(/\d+/)![0]);
    expect((await getItem(env.DB, id))!.copies).toBe(0);

    const res = await post(`/items/${id}/mark-owned`, {}, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Owned');
    expect((await getItem(env.DB, id))!.copies).toBe(1);

    // idempotent: already-owned items are left alone (no accidental copy bump)
    const again = await post(`/items/${id}/mark-owned`, {}, cookie);
    expect(again.status).toBe(200);
    expect((await getItem(env.DB, id))!.copies).toBe(1);
  });

  it('mark-not-owned reverses the toggle, and round-trips', async () => {
    const { lib, cookie } = await seedSession();
    const added = await post('/items', { title: 'Round Trip', libraryId: String(lib.id), mediaType: 'book' }, cookie);
    const id = Number(added.headers.get('location')!.match(/\d+/)![0]);
    expect((await getItem(env.DB, id))!.copies).toBe(1); // normal add defaults to owned

    const res = await post(`/items/${id}/mark-not-owned`, {}, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Not owned');
    expect((await getItem(env.DB, id))!.copies).toBe(0);

    // idempotent: already-logged items are left alone
    const again = await post(`/items/${id}/mark-not-owned`, {}, cookie);
    expect(again.status).toBe(200);
    expect((await getItem(env.DB, id))!.copies).toBe(0);

    // and back
    const backToOwned = await post(`/items/${id}/mark-owned`, {}, cookie);
    expect(await backToOwned.text()).toContain('Owned');
    expect((await getItem(env.DB, id))!.copies).toBe(1);
  });

  it('a normal add still defaults to one copy and lands on the detail page', async () => {
    const { lib, cookie } = await seedSession();
    const res = await post('/items', { title: 'Owned Book', libraryId: String(lib.id), mediaType: 'book' }, cookie);
    const location = res.headers.get('location')!;
    expect(location).toMatch(/^\/items\/\d+$/);
    const item = await getItem(env.DB, Number(location.match(/\d+/)![0]));
    expect(item!.copies).toBe(1);
  });

  it('published view links expose only matching items to the public', async () => {
    const { lib, cookie } = await seedSession();
    const owned = await post('/items', { title: 'Owned Novel', libraryId: String(lib.id), mediaType: 'book' }, cookie);
    const ownedId = Number(owned.headers.get('location')!.match(/\d+/)![0]);
    const logged = await post(
      '/items',
      { title: 'Reviewed Only', libraryId: String(lib.id), mediaType: 'book', logOnly: '1' },
      cookie,
    );
    const loggedId = Number(logged.headers.get('location')!.match(/\d+/)![0]);

    // admin publishes a "not owned" view of this shelf
    const create = await post(
      '/shares',
      { libraryId: String(lib.id), name: 'My reviews', owned: '0', sort: 'title' },
      cookie,
    );
    expect(create.status).toBe(302);
    const [view] = await listShares(env.DB, lib.id);
    expect(view).toBeDefined();

    const publicGet = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`http://nalanda.test${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const listing = await publicGet(`/share/${view!.token}`);
    expect(listing.status).toBe(200);
    const html = await listing.text();
    expect(html).toContain('Reviewed Only');
    expect(html).toContain('My reviews'); // the view's name is the page title
    expect(html).not.toContain('Owned Novel'); // outside the view's filters

    expect((await publicGet(`/share/${view!.token}/items/${loggedId}`)).status).toBe(200);
    expect((await publicGet(`/share/${view!.token}/items/${ownedId}`)).status).toBe(404); // no id-walking out of scope
  });

  it('share pages are served from the isolate memory cache on repeat reads', async () => {
    const { lib, cookie } = await seedSession();
    await post('/items', { title: 'Cached Once', libraryId: String(lib.id), mediaType: 'book' }, cookie);
    await post('/shares', { libraryId: String(lib.id), name: 'Cache test', sort: 'title' }, cookie);
    const [view] = await listShares(env.DB, lib.id);

    const publicGet = async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`http://nalanda.test/share/${view!.token}`), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const first = await publicGet();
    expect(first.headers.get('x-cache')).toBe('miss');
    const second = await publicGet();
    expect(second.headers.get('x-cache')).toBe('hit');
    expect(await second.text()).toBe(await first.text());
    expect(await second.headers.get('content-type')).toContain('text/html');

    // any successful mutation clears this isolate's cache — the edit goes public now
    await post('/items', { title: 'Cache Buster', libraryId: String(lib.id), mediaType: 'book' }, cookie);
    const third = await publicGet();
    expect(third.headers.get('x-cache')).toBe('miss');
    expect(await third.text()).toContain('Cache Buster');
  });

  it('reviewed_in blog links render as links on item and share pages; junk filtered', async () => {
    const { lib, cookie } = await seedSession();
    const res = await post(
      '/items',
      {
        title: 'Linked Book',
        libraryId: String(lib.id),
        mediaType: 'book',
        reviewedIn: 'https://blog.example/june-reading\nnot-a-url\nhttps://blog.example/best-of-2026',
      },
      cookie,
    );
    const id = Number(res.headers.get('location')!.match(/\d+/)![0]);

    const get = async (path: string, withCookie?: string) => {
      const ctx = createExecutionContext();
      const r = await app.fetch(
        new Request(`http://nalanda.test${path}`, { headers: withCookie ? { cookie: withCookie } : {} }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return r.text();
    };

    const itemHtml = await get(`/items/${id}`, cookie);
    expect(itemHtml).toContain('href="https://blog.example/june-reading"');
    expect(itemHtml).toContain('href="https://blog.example/best-of-2026"');
    expect(itemHtml).not.toContain('not-a-url'); // non-URLs are dropped at save time

    await post('/shares', { libraryId: String(lib.id), name: 'Everything', sort: 'title' }, cookie);
    const [view] = await listShares(env.DB, lib.id);
    const shareHtml = await get(`/share/${view!.token}/items/${id}`);
    expect(shareHtml).toContain('href="https://blog.example/june-reading"'); // details are public
  });

  it('refuses to lend a copies=0 entry', async () => {
    const { lib, cookie } = await seedSession();
    const add = await post(
      '/items',
      { title: 'Logged Only', libraryId: String(lib.id), mediaType: 'book', logOnly: '1' },
      cookie,
    );
    const id = Number(add.headers.get('location')!.match(/\d+/)![0]);
    const loan = await post(`/items/${id}/loan`, { borrower: 'Ana' }, cookie);
    expect(loan.status).toBe(400);
  });
});
