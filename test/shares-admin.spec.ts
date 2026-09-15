// Route-level: /shares is the "what is public right now" screen. It is admin-only,
// and the item count beside each link has to be the count that link actually exposes.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createShare, createUser, listTagShares, setItemTags } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';

async function seedUser(role: 'admin' | 'member') {
  return createUser(env.DB, {
    username: `u-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: 'pbkdf2$100000$x$y',
    role,
    mustChangePassword: false,
  });
}

async function getShares(userId: number): Promise<Response> {
  const token = await createSessionToken(env.SESSION_SECRET, userId, Math.floor(Date.now() / 1000));
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request('http://nalanda.test/shares', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('/shares', () => {
  it('is admin-only — publishing is not a member power', async () => {
    const member = await seedUser('member');
    expect((await getShares(member.id)).status).toBe(403);

    const admin = await seedUser('admin');
    expect((await getShares(admin.id)).status).toBe(200);
  });

  it('counts what each link exposes, not what its shelf holds', async () => {
    const admin = await seedUser('admin');
    const lib = await createLibrary(env.DB, `Shelf ${crypto.randomUUID().slice(0, 6)}`);
    for (const status of ['completed', 'completed', 'not_started'] as const) {
      await createItem(env.DB, {
        libraryId: lib.id,
        mediaType: 'book',
        title: `T-${crypto.randomUUID().slice(0, 6)}`,
        status,
        addedBy: admin.id,
      });
    }
    const share = await createShare(env.DB, {
      token: newShareToken(),
      name: 'Finished only',
      libraryId: lib.id,
      status: 'completed',
    });

    const html = await (await getShares(admin.id)).text();
    expect(html).toContain('Finished only');
    expect(html).toContain(share.token);
    // two of the three items are completed — the filtered view exposes only those
    const row = html.slice(html.indexOf('Finished only'));
    expect(row).toMatch(/<td class="num">2<\/td>/);
  });
});

/** A GET, or a same-origin form POST, as the given user — or anonymously, for public pages. */
async function request(path: string, userId?: number, form?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = {};
  if (userId !== undefined) {
    const token = await createSessionToken(env.SESSION_SECRET, userId, Math.floor(Date.now() / 1000));
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  const init: RequestInit = { headers, redirect: 'manual' };
  if (form) {
    init.method = 'POST';
    headers.origin = 'http://nalanda.test';
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('tag links', () => {
  it('publish everything carrying a tag, across shelves, and nothing else', async () => {
    const admin = await seedUser('admin');
    const member = await seedUser('member');
    const books = await createLibrary(env.DB, `Books ${crypto.randomUUID().slice(0, 6)}`);
    const records = await createLibrary(env.DB, `Records ${crypto.randomUUID().slice(0, 6)}`);
    const reviewed = await createItem(env.DB, { libraryId: books.id, mediaType: 'book', title: 'Reviewed book', copies: 0, addedBy: admin.id });
    const record = await createItem(env.DB, { libraryId: records.id, mediaType: 'vinyl', title: 'Reviewed record', addedBy: admin.id });
    const other = await createItem(env.DB, { libraryId: books.id, mediaType: 'book', title: 'Untagged book', addedBy: admin.id });
    await setItemTags(env.DB, reviewed.id, ['reviewed-books']);
    await setItemTags(env.DB, record.id, ['reviewed-books', 'jazz']);
    await setItemTags(env.DB, other.id, ['classics']);

    // Publishing is an admin power, here as on a shelf.
    expect((await request('/shares', member.id, { tag: 'reviewed-books', name: 'Nope' })).status).toBe(403);
    expect(await (await request('/tags/reviewed-books', member.id)).text()).not.toContain('Publish this tag');

    const published = await request('/shares', admin.id, { tag: 'Reviewed-Books', name: 'Reviewed', sort: 'title' });
    expect(published.status).toBe(302);
    expect(published.headers.get('location')).toBe('/tags/reviewed-books');
    const [link] = await listTagShares(env.DB, 'reviewed-books');
    expect(link).toMatchObject({ name: 'Reviewed', tag: 'reviewed-books', libraryId: null, mediaType: null, status: null, owned: null });
    expect(await (await request('/tags/reviewed-books', admin.id)).text()).toContain(link!.token);

    const listing = await (await request(`/share/${link!.token}`)).text();
    expect(listing).toContain('Reviewed book');
    expect(listing).toContain('Reviewed record');
    expect(listing).not.toContain('Untagged book');
    expect((await request(`/share/${link!.token}/items/${reviewed.id}`)).status).toBe(200);
    expect((await request(`/share/${link!.token}/items/${other.id}`)).status).toBe(404); // scope holds by id too

    const sharesPage = await (await request('/shares', admin.id)).text();
    expect(sharesPage.slice(sharesPage.indexOf('>Reviewed<'))).toMatch(/<td class="num">2<\/td>/);
  });
});
