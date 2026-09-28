// Requests that used to end in a 500 instead of doing the right thing. Each case was proven against the old
// code by the nalanda-review pass.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createLoan, createUser, getItem, tagsForItem } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

async function admin() {
  const u = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
  return { id: u.id, cookie: `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, u.id, Math.floor(Date.now() / 1000))}` };
}

async function send(path: string, cookie: string, init: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { cookie, origin: 'http://nalanda.test', ...init.headers };
  let body: string | undefined;
  if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  } else if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, { method: init.method ?? (init.form || init.json !== undefined ? 'POST' : 'GET'), headers, body, redirect: 'manual' }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('requests that used to 500', () => {
  it('removes a member who added items, keeping the items unattributed', async () => {
    const me = await admin();
    const member = await createUser(env.DB, { username: 'kid', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    const shelf = await createLibrary(env.DB, 'Main');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Added by the kid', addedBy: member.id, details: '{}' });

    const res = await send(`/settings/users/${member.id}/delete`, me.cookie, { form: {} });

    expect(res.status).toBe(302); // was: FOREIGN KEY constraint failed
    expect((await getItem(env.DB, book.id))?.addedBy).toBeNull();
  });

  it('opens the page of a tag with a percent sign in it', async () => {
    const me = await admin();
    const shelf = await createLibrary(env.DB, 'Main');
    await createItem(env.DB, { libraryId: shelf.id, title: 'Soft', details: '{}' }).then(async (i) => {
      const { setItemTags } = await import('../src/db/queries');
      await setItemTags(env.DB, i.id, ['100% cotton']);
    });

    const res = await send(`/tags/${encodeURIComponent('100% cotton')}`, me.cookie);

    expect(res.status).toBe(200); // was: URIError from decoding a second time
    expect(await res.text()).toContain('Soft');
  });

  it('returns a loan when the Referer is not a URL', async () => {
    const me = await admin();
    const shelf = await createLibrary(env.DB, 'Main');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Lent', details: '{}' });
    await createLoan(env.DB, { itemId: book.id, borrower: 'Ann' });
    const { id: loanId } = (await env.DB.prepare('SELECT id FROM loans').first<{ id: number }>())!;

    const res = await send(`/loans/${loanId}/return`, me.cookie, { form: {}, headers: { referer: 'not a url at all' } });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/loans');
  });

  it('imports a batch carrying more distinct tags than D1 binds in one statement', async () => {
    const me = await admin();
    const shelf = await createLibrary(env.DB, 'Imported');
    const rows = Array.from({ length: 150 }, (_, n) => ({ title: `Book ${n}`, tags: `tag-${n}` }));

    const res = await send('/api/import', me.cookie, { json: { libraryId: shelf.id, rows } });

    expect(res.status).toBe(200);
    const last = (await env.DB.prepare("SELECT id FROM items WHERE title = 'Book 149'").first<{ id: number }>())!;
    expect(await tagsForItem(env.DB, last.id)).toEqual(['tag-149']);
  });

  it('refuses a shelf that does not exist, on import and on edit, instead of failing on the foreign key', async () => {
    const me = await admin();
    const shelf = await createLibrary(env.DB, 'Main');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Stays put', details: '{}' });

    expect((await send('/api/import', me.cookie, { json: { libraryId: 9999, rows: [{ title: 'x' }] } })).status).toBe(400);
    expect((await send(`/items/${book.id}`, me.cookie, { form: { title: 'Stays put', libraryId: '9999' } })).status).toBe(400);
    expect((await getItem(env.DB, book.id))?.libraryId).toBe(shelf.id);
  });

  it('skips import rows that are not objects, and counts them as skipped', async () => {
    const me = await admin();
    const shelf = await createLibrary(env.DB, 'Main');

    const res = await send('/api/import', me.cookie, { json: { libraryId: shelf.id, rows: [null, 'x', [1], { title: 'Real one' }] } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 1, skipped: 3 });
  });
});
