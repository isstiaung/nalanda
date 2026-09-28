// Lending from the item page follows the rule connections' borrowing already uses: a copy is free while the
// household holds more copies than are out. A single copy used to be lendable twice, and the item page then
// showed only the first borrower; with two copies and one out, the second couldn't be lent at all.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { activeLoansForItem, createItem, createLibrary, createUser, lendIfFree } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

async function setup(copies: number) {
  const u = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
  const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, u.id, Math.floor(Date.now() / 1000))}`;
  const shelf = await createLibrary(env.DB, 'Main');
  const item = await createItem(env.DB, { libraryId: shelf.id, title: 'Wingspan', copies, details: '{}' });
  return { cookie, item };
}

async function request(path: string, cookie: string, form?: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: form ? 'POST' : 'GET',
      headers: { cookie, origin: 'http://nalanda.test', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'manual',
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('lending from the item page', () => {
  it('will not lend a single copy twice', async () => {
    const { cookie, item } = await setup(1);
    expect((await request(`/items/${item.id}/loan`, cookie, { borrower: 'Ann' })).status).toBe(302);

    const second = await request(`/items/${item.id}/loan`, cookie, { borrower: 'Bob' });

    expect(second.status).toBe(409);
    expect((await activeLoansForItem(env.DB, item.id)).map((l) => l.borrower)).toEqual(['Ann']);
  });

  it('lends both copies of a two-copy item, and shows both borrowers', async () => {
    const { cookie, item } = await setup(2);
    await request(`/items/${item.id}/loan`, cookie, { borrower: 'Ann' });

    // one out, one free: the page still offers to lend
    const between = await (await request(`/items/${item.id}`, cookie)).text();
    expect(between).toContain(`action="/items/${item.id}/loan"`);

    await request(`/items/${item.id}/loan`, cookie, { borrower: 'Bob' });
    const html = await (await request(`/items/${item.id}`, cookie)).text();

    expect(html).toContain('Ann');
    expect(html).toContain('Bob');
    expect(html.match(/Mark returned/g)).toHaveLength(2);
    expect(html).not.toContain(`action="/items/${item.id}/loan"`); // both out: nothing left to lend
  });

  it('decides in one statement, so the last copy goes to one borrower only', async () => {
    const { item } = await setup(1);
    const results = await Promise.all(
      ['Ann', 'Bob', 'Cy'].map((borrower) => lendIfFree(env.DB, { itemId: item.id, borrower, contact: null, dueOn: null })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await activeLoansForItem(env.DB, item.id)).toHaveLength(1);
  });
});
