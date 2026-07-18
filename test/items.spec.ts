// Route-level: the add flow's "Log — not owned" action and the copies=0 lend guard,
// driven through the real app (session cookie + browser-faithful CSRF headers).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createUser, getItem } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

async function seedSession() {
  const user = await createUser(env.DB, {
    username: `u-${crypto.randomUUID().slice(0, 8)}`,
    passwordHash: 'pbkdf2$100000$x$y',
    role: 'member',
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

  it('a normal add still defaults to one copy and lands on the detail page', async () => {
    const { lib, cookie } = await seedSession();
    const res = await post('/items', { title: 'Owned Book', libraryId: String(lib.id), mediaType: 'book' }, cookie);
    const location = res.headers.get('location')!;
    expect(location).toMatch(/^\/items\/\d+$/);
    const item = await getItem(env.DB, Number(location.match(/\d+/)![0]));
    expect(item!.copies).toBe(1);
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
