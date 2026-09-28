// First-run setup and the session secret. Setup used to create the admin and the starter shelves one call at a
// time and only then sign the cookie — with an empty SESSION_SECRET the signing threw, the request 500ed after the
// admin existed, setup closed, and login failed the same way. Now a missing or blank secret is explained before
// anything is read or written, and the admin and shelves are one batch that only the first setup wins.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFirstAdmin, createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { b64url, createSessionToken, hashPassword, SESSION_COOKIE, verifySessionToken } from '../src/lib/auth';
import app from '../src/index';

const ORIGIN = 'http://nalanda.test';
const SHELVES = ['Books', 'Board games', 'Vinyl'];

async function send(
  path: string,
  bindings: Bindings,
  init: { form?: Record<string, string>; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (init.cookie) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method: init.form ? 'POST' : 'GET', headers, body, redirect: 'manual' }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const setupForm = (username: string, password = 'correct horse') => ({ username, password, confirm: password });

/** Every table's row count: "nothing written" means this doesn't change. */
async function snapshot(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`,
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of results) {
    counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>())!.n;
  }
  return counts;
}

async function users() {
  return (await env.DB.prepare('SELECT username, role, must_change_password FROM users ORDER BY id').all()).results;
}

async function shelves() {
  return (await env.DB.prepare('SELECT name FROM libraries ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
}

/** The explanation page: a 503 naming the secret and both ways to set it — never an error page. */
async function expectExplained(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get('content-type')).toContain('text/html');
  const html = await res.text();
  expect(html).toContain('class="auth-card"');
  expect(html).toContain('<code>SESSION_SECRET</code>');
  expect(html).toContain('npx wrangler secret put SESSION_SECRET');
  expect(html).toContain('Variables and Secrets');
  expect(html).not.toContain('Something went wrong');
  expect(html).not.toContain('DataError');
  return html;
}

/** A session cookie signed with any key, blank ones included — what someone would forge. */
async function signedWith(key: string, userId: number): Promise<string> {
  const enc = new TextEncoder();
  const payload = b64url.encode(enc.encode(JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + 3600 })));
  const hmac = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${SESSION_COOKIE}=${payload}.${b64url.encode(await crypto.subtle.sign('HMAC', hmac, enc.encode(payload)))}`;
}

function without(secret: string | undefined): Bindings {
  const { SESSION_SECRET: _, ...rest } = env;
  return secret === undefined ? rest : { ...rest, SESSION_SECRET: secret };
}

describe.each([
  ['empty', ''],
  ['whitespace-only', ' \t\n '],
  ['missing', undefined],
])('an instance whose SESSION_SECRET is %s', (_label, secret) => {
  const bindings = without(secret);

  it('GET /setup explains how to set it, and writes nothing', async () => {
    const before = await snapshot();
    await expectExplained(await send('/setup', bindings));
    expect(await snapshot()).toEqual(before);
  });

  it('POST /setup creates nothing, and leaves setup open for when the secret is set', async () => {
    const before = await snapshot();
    const res = await send('/setup', bindings, { form: setupForm('admin') });

    // rows first: the old failure was the admin and shelves written before the 500
    expect(await snapshot()).toEqual(before);
    const html = await expectExplained(res);
    expect(html).toContain('Nothing was saved');

    const later = await send('/setup', env);
    expect(later.status).toBe(200);
    expect(await later.text()).toContain('Create the admin account');
  });

  describe('login', () => {
    const ann = async () =>
      createUser(env.DB, { username: 'ann', passwordHash: await hashPassword('correct horse'), role: 'admin', mustChangePassword: false });

    it('with the right password explains, and sets no cookie', async () => {
      await ann();
      const res = await send('/auth/login', bindings, { form: { username: 'ann', password: 'correct horse' } });
      await expectExplained(res);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('the page explains', async () => {
      await ann();
      await expectExplained(await send('/login', bindings));
    });

    it('with a wrong password records no attempt, and explains', async () => {
      await ann();
      const before = await snapshot();
      const res = await send('/auth/login', bindings, { form: { username: 'ann', password: 'wrong' } });
      expect(await snapshot()).toEqual(before);
      await expectExplained(res);
    });
  });

  it('protected pages treat everyone as signed out — no 500 — and lead to the explanation', async () => {
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, ann.id, Math.floor(Date.now() / 1000))}`;

    for (const path of ['/', '/loans', '/settings/users']) {
      for (const c of [undefined, cookie]) {
        const res = await send(path, bindings, { cookie: c });
        expect(res.status, `${path}${c ? ' with a cookie' : ''}`).toBe(302);
        expect(res.headers.get('location')).toBe('/login');
      }
    }
    await expectExplained(await send('/login', bindings));
  });

  it('with nobody set up yet, a protected page leads to setup, which explains', async () => {
    const res = await send('/loans', bindings);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/setup');
    await expectExplained(await send('/setup', bindings));
  });

  it('never verifies a session cookie, nor signs one', async () => {
    const token = await createSessionToken(env.SESSION_SECRET, 1, 1_800_000_000);
    expect(await verifySessionToken(secret, token, 1_800_000_000)).toBeNull();
    await expect(createSessionToken(secret as string, 1, 1_800_000_000)).rejects.toThrow();
  });
});

describe('a whitespace-only SESSION_SECRET', () => {
  it('signs nobody in with a cookie forged under it', async () => {
    const blank = ' \t\n ';
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });

    const res = await send('/settings/users', without(blank), { cookie: await signedWith(blank, ann.id) });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('setup with a SESSION_SECRET', () => {
  it('creates the admin and the three starter shelves, and signs them in', async () => {
    const res = await send('/setup', env, { form: setupForm('admin') });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(await users()).toEqual([{ username: 'admin', role: 'admin', must_change_password: 0 }]);
    expect(await shelves()).toEqual(SHELVES);
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));

    const home = await send('/', env, { cookie });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Overview');

    const login = await send('/auth/login', env, { form: { username: 'admin', password: 'correct horse' } });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/');
  });

  it('refuses a second setup once one succeeded', async () => {
    expect((await send('/setup', env, { form: setupForm('admin') })).status).toBe(302);
    const before = await snapshot();

    expect((await send('/setup', env, { form: setupForm('intruder') })).status).toBe(404);
    expect((await send('/setup', env)).status).toBe(404);

    expect(await snapshot()).toEqual(before);
    expect(await users()).toEqual([{ username: 'admin', role: 'admin', must_change_password: 0 }]);
    expect(await shelves()).toEqual(SHELVES);
  });

  it.each([
    ['two people', 'ann', 'ben'],
    ['a double submit', 'ann', 'ann'],
  ])('lets one of two racing setups win (%s): one admin, three shelves', async (_label, first, second) => {
    const results = await Promise.all([
      send('/setup', env, { form: setupForm(first) }),
      send('/setup', env, { form: setupForm(second) }),
    ]);

    expect(await users()).toHaveLength(1);
    expect(await shelves()).toEqual(SHELVES);
    expect(results.map((r) => r.status).sort()).toEqual([302, 404]);
  });
});

describe('createFirstAdmin', () => {
  it('decides inside the batch: of two at once, one makes the admin and the shelves', async () => {
    const [a, b] = await Promise.all([
      createFirstAdmin(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$a$a' }, SHELVES),
      createFirstAdmin(env.DB, { username: 'ben', passwordHash: 'pbkdf2$1$b$b' }, SHELVES),
    ]);

    expect([a, b].filter((id) => id !== null)).toHaveLength(1);
    expect(await users()).toHaveLength(1);
    expect(await shelves()).toEqual(SHELVES);
  });

  it('writes nothing once anyone exists', async () => {
    await createUser(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    const before = await snapshot();

    expect(await createFirstAdmin(env.DB, { username: 'ben', passwordHash: 'pbkdf2$1$b$b' }, SHELVES)).toBeNull();

    expect(await snapshot()).toEqual(before);
  });
});
