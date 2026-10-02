// First-run setup and the session secret. Setup used to create the admin and the starter shelves one call at a
// time and only then sign the cookie — with an empty SESSION_SECRET the signing threw, the request 500ed after the
// admin existed, setup closed, and login failed the same way. Now a missing or blank secret is explained before
// anything is written, and the admin and shelves are one batch that only the first setup wins.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { countUsers, createFirstAdmin, createUser, deleteUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import {
  b64url,
  createSessionToken,
  hashPassword,
  newSessionKey,
  SESSION_COOKIE,
  verifySessionToken,
  type AccountRef,
} from '../src/lib/auth';
import app from '../src/index';
import { as, book, member } from './member-helpers';

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

/** Setup as the form sends it, with the session secret that shows it's whoever deployed it (§16 #101). */
const setupForm = (username: string, password = 'correct horse', secret = env.SESSION_SECRET) => ({ secret, username, password, confirm: password });

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

/** A session token signed with any key, blank ones included — what someone would forge, naming the account's real key. */
async function signedWith(key: string, user: AccountRef): Promise<string> {
  const enc = new TextEncoder();
  const payload = b64url.encode(
    enc.encode(JSON.stringify({ u: user.id, k: user.sessionKey, e: Math.floor(Date.now() / 1000) + 3600 })),
  );
  const hmac = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${payload}.${b64url.encode(await crypto.subtle.sign('HMAC', hmac, enc.encode(payload)))}`;
}

/**
 * The token that would pass if the blank secret were used: one signed with it. An empty or missing secret can't
 * key an HMAC at all, so there a token signed with the real test secret stands in.
 */
async function tokenUnder(secret: string | undefined, user: AccountRef): Promise<string> {
  return secret ? signedWith(secret, user) : createSessionToken(env.SESSION_SECRET, user, Math.floor(Date.now() / 1000));
}

function without(secret: string | undefined): Bindings {
  const { SESSION_SECRET: _, ...rest } = env;
  return secret === undefined ? rest : { ...rest, SESSION_SECRET: secret };
}

describe.each([
  ['empty', ''],
  ['whitespace-only', ' \t\n '],
  ['missing', undefined],
  // the value .dev.vars.example once carried: anyone can read it, so a one-click deploy that kept it signs nothing (§16 #101)
  ['the example this repository once published', 'change-me-to-anything-long-and-random'],
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

  it('with an account already there, setup says to log in once it is set — not to create one again', async () => {
    // what the old failure left behind: the admin, made before signing failed
    await createUser(env.DB, { username: 'ann', passwordHash: await hashPassword('correct horse'), role: 'admin', mustChangePassword: false });
    const before = await snapshot();

    for (const res of [await send('/setup', bindings), await send('/setup', bindings, { form: setupForm('ann') })]) {
      const html = await expectExplained(res);
      expect(html).toContain('An account already exists');
      expect(html).not.toContain('create the account again');
    }
    expect(await snapshot()).toEqual(before);

    const login = await send('/auth/login', env, { form: { username: 'ann', password: 'correct horse' } });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/');
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
    const cookie = `${SESSION_COOKIE}=${await tokenUnder(secret, ann)}`;

    for (const path of ['/', '/loans', '/settings/users']) {
      for (const c of [undefined, cookie]) {
        const res = await send(path, bindings, { cookie: c });
        expect(res.status, `${path}${c ? ' with a cookie' : ''}`).toBe(302);
        expect(res.headers.get('location')).toBe('/login');
      }
    }
    await expectExplained(await send('/login', bindings));
  });

  it('on a database never migrated, setup still explains the secret', async () => {
    await env.DB.prepare('DROP TABLE users').run();

    await expectExplained(await send('/setup', bindings));
    const posted = await expectExplained(await send('/setup', bindings, { form: setupForm('admin') }));
    expect(posted).toContain('Nothing was saved');
  });

  it('with nobody set up yet, a protected page leads to setup, which explains', async () => {
    const res = await send('/loans', bindings);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/setup');
    await expectExplained(await send('/setup', bindings));
  });

  it('never verifies a session cookie, nor signs one', async () => {
    const someone = { id: 1, sessionKey: newSessionKey() };
    const token = await tokenUnder(secret, someone);
    expect(await verifySessionToken(secret, token, Math.floor(Date.now() / 1000))).toBeNull();
    await expect(createSessionToken(secret as string, someone, 1_800_000_000)).rejects.toThrow();
  });
});

describe('a whitespace-only SESSION_SECRET', () => {
  it('signs nobody in with a cookie forged under it', async () => {
    const blank = ' \t\n ';
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });

    const res = await send('/settings/users', without(blank), { cookie: `${SESSION_COOKIE}=${await signedWith(blank, ann)}` });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

describe('setup with a SESSION_SECRET', () => {
  it('creates the admin and the three starter shelves, and signs them in', async () => {
    const res = await send('/setup', env, { form: setupForm('admin') });

    // the answer is the admin's recovery code (§16 #100), shown this once and never kept by the browser
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = await res.text();
    expect(page).toContain('Your recovery code');
    expect(page).toMatch(/class="recovery-digits mono">[A-Z2-9]{4}(-[A-Z2-9]{4}){4}</);
    expect(page).toContain('href="/"');
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

  it('asks for the session secret first: a wrong one writes nothing, keeps the username, and is throttled', async () => {
    const before = await snapshot();
    const wrong = await send('/setup', env, { form: setupForm('admin', 'correct horse', 'not-the-secret') });
    expect(wrong.status).toBe(200);
    const html = await wrong.text();
    expect(html).toContain('That isn’t this library’s SESSION_SECRET.');
    expect(html).toMatch(/name="secret"[^>]*aria-invalid="true"/);
    expect(html).toContain('value="admin"');
    expect(html).not.toContain('not-the-secret');
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const { login_attempts: _, ...rest } = await snapshot();
    const { login_attempts: __, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    for (let i = 0; i < 9; i++) await send('/setup', env, { form: setupForm('admin', 'correct horse', 'not-the-secret') });
    expect((await send('/setup', env, { form: setupForm('admin') })).status).toBe(429);
    expect(await users()).toEqual([]);
  });

  it('refuses a second setup once one succeeded', async () => {
    expect((await send('/setup', env, { form: setupForm('admin') })).status).toBe(200);
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
    // the winner is signed in, shown its recovery code; the loser — on a double-click, the page the browser shows — goes
    // to login, which says why, and how to make the code again
    expect(results.map((r) => r.status).sort()).toEqual([200, 302]);
    const [won, lost] = results[0]!.status === 200 ? results : [results[1]!, results[0]!];
    expect(won!.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(lost!.headers.get('location')).toBe('/login?raced=1');
    expect(lost!.headers.get('set-cookie')).toBeNull();

    const login = await send(lost!.headers.get('location')!, env);
    expect(login.status).toBe(200);
    const said = await login.text();
    expect(said).toContain('another setup finished first');
    expect(said).toContain('make a new one on Account');
    expect(await (await send('/login', env)).text()).not.toContain('another setup finished first');
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

describe('removing members keeps an admin', () => {
  it('two admins removing each other at once leave one — the second is refused whole — and setup stays closed', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi', 'admin');
    const [x, y] = await Promise.all([
      as(asha, `/settings/users/${ravi.id}/delete`, { body: {} }),
      as(ravi, `/settings/users/${asha.id}/delete`, { body: {} }),
    ]);
    expect([x.status, y.status].sort()).toEqual([302, 409]);
    expect(await countUsers(env.DB)).toBe(1);
    expect((await send('/setup', env, { form: setupForm('stranger') })).status).toBe(404);
    // the last admin can't be removed by anyone, through the function either; a member can, by an admin still here
    const [left] = await users();
    const lastId = (await env.DB.prepare('SELECT id FROM users').first<{ id: number }>())!.id;
    expect(await deleteUser(env.DB, lastId)).toBe(false);
    expect(await users()).toEqual([left]);
    const mira = await member('mira');
    const gone = asha.id === lastId ? ravi : asha;
    expect(await deleteUser(env.DB, mira.id, gone.id)).toBe(false); // the remover is no longer here
    expect(await countUsers(env.DB)).toBe(2);
    expect(await deleteUser(env.DB, mira.id, lastId)).toBe(true);
    expect(await countUsers(env.DB)).toBe(1);
  });

  it('clears nothing of a member whose removal is refused', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha, { title: 'Hers', status: 'completed', completedOn: '2026-01-01' });
    expect(await deleteUser(env.DB, asha.id)).toBe(false); // the only admin
    expect((await env.DB.prepare('SELECT added_by AS by FROM items WHERE id = ?1').bind(b.id).first<{ by: number }>())!.by).toBe(asha.id);
    expect((await env.DB.prepare('SELECT reader_id AS by FROM reads WHERE item_id = ?1').bind(b.id).first<{ by: number }>())!.by).toBe(asha.id);
  });
});
