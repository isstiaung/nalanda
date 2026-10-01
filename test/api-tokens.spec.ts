// The read-only API and its tokens (ARCH.md §16 #88): a member makes a token on the Account page, sees it once, and
// a script reads what that member sees — JSON, GET only, 250 items a page. Bound to the account as a session is:
// revoked, signed out everywhere, a new password or a removed member all take it down; a cookie signs nobody in here.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addPastRead, API_PAGE, createItem, createLibrary, deleteUser, lendIfFree, MAX_API_TOKENS, setGoal, setItemTags, setPassword, setWant } from '../src/db/queries';
import type { NewItem } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';
import { hashApiToken, hashPassword, isApiToken, newApiToken } from '../src/lib/auth';
import { as, html, member, rows, type Member } from './member-helpers';
import { sessionTokenFor } from './session-helpers';
import { SESSION_COOKIE } from '../src/lib/auth';

const ORIGIN = 'http://nalanda.test';

async function get(path: string, token?: string, init: { method?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.cookie) headers.cookie = init.cookie;
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers }), env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Makes a token on the Account page as the app does, and reads it off the page it is shown on. */
async function mint(who: Member, name = 'the blog'): Promise<string> {
  const res = await as(who, '/account/tokens', { body: { name } });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store'); // the page the secret is on, never from a cache
  const page = await res.text();
  const token = page.match(/class="mono break-anywhere token-secret">(nal_[A-Za-z0-9_-]{43})</)?.[1];
  if (!token) throw new Error('no token on the page');
  return token;
}

describe('making and revoking tokens', () => {
  it('shows the secret once on the page, keeps only its hash, lists and revokes it, and caps them', async () => {
    const ravi = await member('ravi');
    expect(isApiToken(newApiToken())).toBe(true);
    const token = await mint(ravi, 'the blog');
    const stored = await rows<{ name: string; token_hash: string; user_id: number }>('SELECT name, token_hash, user_id FROM api_tokens');
    expect(stored).toEqual([{ name: 'the blog', token_hash: await hashApiToken(token), user_id: ravi.id }]);
    expect(stored[0]!.token_hash).not.toContain(token.slice(4, 20));
    // the page lists it, without the secret, and offers a revoke
    const page = await html(ravi, '/account');
    expect(page).toContain('<strong>the blog</strong>');
    expect(page).not.toContain(token);
    expect(page).toMatch(/action="\/account\/tokens\/\d+\/revoke"/);
    // a nameless token is refused, on the page
    expect(await (await as(ravi, '/account/tokens', { body: { name: '  ' } })).text()).toContain('Give the token a name');
    // the cap
    for (let i = 1; i < MAX_API_TOKENS; i++) await mint(ravi, `t${i}`);
    expect(await (await as(ravi, '/account/tokens', { body: { name: 'one more' } })).text()).toContain(`You have ${MAX_API_TOKENS} tokens`);
    expect(await html(ravi, '/account')).toContain('revoke one to make another');
    // revoke: the member's own only
    const id = (await rows<{ id: number }>('SELECT id FROM api_tokens WHERE name = ?1', 'the blog'))[0]!.id;
    const asha = await member('asha');
    await as(asha, `/account/tokens/${id}/revoke`, { body: {} });
    expect((await get('/api/v1/me', token)).status).toBe(200);
    const gone = await as(ravi, `/account/tokens/${id}/revoke`, { body: {} });
    expect(gone.headers.get('location')).toBe('/account#tokens');
    expect((await get('/api/v1/me', token)).status).toBe(401);
  });

  it('dies with other devices, a new password and the member — and a newcomer given the id inherits nothing', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const t1 = await mint(ravi, 'phone');
    expect((await get('/api/v1/me', t1)).json).toMatchObject({ id: ravi.id, username: 'ravi', role: 'member' });
    await as(ravi, '/account/sign-out-others', { body: {} });
    expect((await get('/api/v1/me', t1)).status).toBe(401);
    expect(await rows('SELECT id FROM api_tokens WHERE user_id = ?1', ravi.id)).toEqual([]); // gone, not just dead
    // this device signed in again (the test's cookie is the old generation's); a password change moves the generation on
    // once more: the token made before it signs in nobody
    ravi.cookie = `${SESSION_COOKIE}=${await sessionTokenFor(ravi.id)}`;
    const t2 = await mint(ravi, 'laptop');
    await setPassword(env.DB, ravi.id, await hashPassword('new-password-123'), false);
    expect((await get('/api/v1/me', t2)).status).toBe(401);
    expect(await rows('SELECT id FROM api_tokens WHERE user_id = ?1', ravi.id)).toEqual([]); // gone with the password change too
    // the member is removed and a newcomer takes their id: the row cascades, the newcomer is nobody's token
    const t3 = await mint(await member('ravi2'), 'tablet');
    const ravi2 = (await rows<{ id: number }>("SELECT id FROM users WHERE username = 'ravi2'"))[0]!.id;
    await deleteUser(env.DB, ravi2);
    const newcomer = await member('newcomer');
    expect(newcomer.id).toBe(ravi2);
    expect((await get('/api/v1/me', t3)).status).toBe(401);
    void asha;
  });
});

describe('what the API refuses', () => {
  it('a missing, malformed or unknown token, a cookie, a write, and a member who must change their password', async () => {
    const ravi = await member('ravi');
    expect((await get('/api/v1/me')).status).toBe(401);
    expect((await get('/api/v1/me', 'not-a-token')).status).toBe(401);
    expect((await get('/api/v1/me', newApiToken())).status).toBe(401);
    expect((await get('/api/v1/me', undefined, { cookie: ravi.cookie })).status).toBe(401); // a session is not a token
    const token = await mint(ravi);
    expect((await get('/api/v1/items', token, { method: 'POST' })).status).toBe(405);
    expect((await get('/api/v1/nothing', token)).status).toBe(404);
    expect((await get('/api/v1/me', token)).headers.get('cache-control')).toBe('no-store');
    expect((await get('/api/v1/me')).headers.get('www-authenticate')).toBe('Bearer realm="Nalanda"');
    // a revoke with nonsense for an id is a redirect, not an error
    expect((await as(ravi, '/account/tokens/abc/revoke', { body: {} })).status).toBe(302);
    // a token signs nobody into the app's pages either
    expect((await get('/account', token)).status).toBe(302);
    // must change password: refused with a reason
    await env.DB.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?1').bind(ravi.id).run();
    expect((await get('/api/v1/me', token)).status).toBe(403);
  });
});

describe('what the API reads', () => {
  async function shelf() {
    const lib = await createLibrary(env.DB, 'Books');
    const item = (values: Partial<NewItem>) => createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'x', ...values });
    return { lib, item };
  }

  it('items with the shelf’s filters, tags along, paged by id; one item with its reads, reviews and loans', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const token = await mint(ravi);
    const read = await item({ title: 'Read one', creators: 'Someone', notes: 'private to the household', location: 'loft' });
    const unread = await item({ title: 'Unread one' });
    const game = await createItem(env.DB, { libraryId: (await createLibrary(env.DB, 'Games')).id, mediaType: 'boardgame', details: '{}', title: 'Catan' });
    await setItemTags(env.DB, read.id, ['sf']);
    await addPastRead(env.DB, read.id, { status: 'completed', beganOn: '2026-01-02', endedOn: '2026-01-10' }, ravi.id);
    await lendIfFree(env.DB, { itemId: read.id, borrower: 'Priya', contact: null, dueOn: '2026-12-01' });
    const all = await get('/api/v1/items', token);
    expect(all.status).toBe(200);
    expect((all.json!.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['Read one', 'Unread one', 'Catan']);
    expect(all.json).not.toHaveProperty('next');
    const first = (all.json!.items as Array<Record<string, unknown>>)[0]!;
    expect(first.tags).toEqual(['sf']);
    expect(first.notes).toBe('private to the household'); // a token sees what its member sees
    expect(first.location).toBe('loft');
    const books = await get(`/api/v1/items?library=${lib.id}&status=completed`, token);
    expect((books.json!.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['Read one']);
    const mine = await get(`/api/v1/items?readBy=me`, token);
    expect((mine.json!.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['Read one']);
    expect((await get('/api/v1/items?library=abc', token)).status).toBe(400);
    expect((await get('/api/v1/items?after=x', token)).status).toBe(400);
    const one = await get(`/api/v1/items/${read.id}`, token);
    expect(one.json).toMatchObject({ item: { title: 'Read one', tags: ['sf'] }, reviews: [], progress: [] });
    expect(one.json!.reads).toMatchObject([{ status: 'completed', beganOn: '2026-01-02', endedOn: '2026-01-10', readerId: ravi.id }]);
    expect(one.json!.loans).toMatchObject([{ borrower: 'Priya', dueOn: '2026-12-01' }]);
    expect(one.json!.people).toMatchObject([{ id: ravi.id, username: 'ravi' }]);
    expect((await get('/api/v1/items/999', token)).status).toBe(404);
    void unread;
    void game;
  });

  it('pages 250 at a time, and the rest: libraries, search, loans, the want list, a goal', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const token = await mint(ravi);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${API_PAGE + 5})
       INSERT INTO items (library_id, media_type, title, details) SELECT ?1, 'book', 'Book ' || i, '{}' FROM n`,
    )
      .bind(lib.id)
      .run();
    const page1 = await get('/api/v1/items', token);
    expect((page1.json!.items as unknown[]).length).toBe(API_PAGE);
    const next = page1.json!.next as number;
    expect(next).toBeGreaterThan(0);
    const page2 = await get(`/api/v1/items?after=${next}`, token);
    expect((page2.json!.items as unknown[]).length).toBe(5);
    expect(page2.json).not.toHaveProperty('next');
    const libs = await get('/api/v1/libraries', token);
    expect(libs.json!.libraries).toMatchObject([{ id: lib.id, name: 'Books', itemCount: API_PAGE + 5 }]);
    const wanted = await item({ title: 'Wanted one', copies: 0 });
    await setWant(env.DB, wanted.id, ravi.id, true);
    const search = await get('/api/v1/search?q=wanted', token);
    expect((search.json!.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['Wanted one']);
    expect((await get('/api/v1/search', token)).status).toBe(400);
    const wants = await get('/api/v1/wants', token);
    expect((wants.json!.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['Wanted one']);
    await lendIfFree(env.DB, { itemId: wanted.id, borrower: 'Nobody', contact: null, dueOn: null }); // not owned: no loan
    const loans = await get('/api/v1/loans', token);
    expect(loans.json).toEqual({ out: [], returned: [] });
    await setGoal(env.DB, ravi.id, 2026, 12, { id: ravi.id, admin: false });
    const goal = await get('/api/v1/goals?year=2026', token);
    expect(goal.json).toMatchObject({ year: 2026, goal: { target: 12 } });
    expect((await get('/api/v1/goals?year=20', token)).status).toBe(400);
  });

  it('costs the Account page no call more than it made', async () => {
    const ravi = await member('ravi');
    await mint(ravi);
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${ORIGIN}/account`, { headers: { cookie: ravi.cookie } }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
    await res.text();
    await waitOnExecutionContext(ctx);
    expect(1000 - budget.left).toBe(3); // the session, the sidebar's shelves, the row with its tokens — as before tokens
  });
});
