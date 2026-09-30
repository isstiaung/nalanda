// A session names an account, not an id (ARCH.md §16 #56). users.id has no AUTOINCREMENT, so SQLite gives a new row
// max(id)+1: removing the newest member freed their id for the next one made, and a session cookie — just the id,
// signed — then signed its old holder in as the new member, for the rest of its 30 days. Every account now has a
// random key of its own, set when it is made; a cookie names it, and the middleware compares it with the row it reads.
import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFirstAdmin, createUser, deleteUser, getUserById, getUserByUsername } from '../src/db/queries';
import { budgeted } from '../src/federation/budget';
import { b64url, createSessionToken, hashPassword, isSessionKey, newSessionKey, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

const ORIGIN = 'http://nalanda.test';
const now = () => Math.floor(Date.now() / 1000);

async function send(
  path: string,
  init: { form?: Record<string, string>; cookie?: string; db?: D1Database } = {},
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
    init.db ? { ...env, DB: init.db } : env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const cookieFor = async (user: { id: number; sessionKey: string }) =>
  `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user, now())}`;

/** A token signed with the real secret over any payload — genuine as far as the HMAC goes. */
async function genuine(data: unknown): Promise<string> {
  const enc = new TextEncoder();
  const payload = b64url.encode(enc.encode(JSON.stringify(data)));
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${SESSION_COOKIE}=${payload}.${b64url.encode(await crypto.subtle.sign('HMAC', key, enc.encode(payload)))}`;
}

/** Signed out: the protected page sends the request to login, and shows nobody's page. */
async function expectSignedOut(res: Response, whoNot?: string) {
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/login');
  if (whoNot) expect(await res.text()).not.toContain(whoNot);
}

const keys = async () =>
  (await env.DB.prepare('SELECT id, username, session_key AS k FROM users ORDER BY id').all<{ id: number; username: string; k: string }>())
    .results;

async function adminWithCookie() {
  const admin = await createUser(env.DB, { username: 'root', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
  return { admin, cookie: await cookieFor(admin) };
}

describe('a removed member’s cookie, once their id is reused', () => {
  it('the reviewer’s probe: signs in nobody — not the member given that id next', async () => {
    const { cookie: adminCookie } = await adminWithCookie();
    // members a and b, made the way an admin makes them
    for (const username of ['a', 'b']) {
      expect((await send('/settings/users', { cookie: adminCookie, form: { username, role: 'member' } })).status).toBe(200);
    }
    const b = (await getUserByUsername(env.DB, 'b'))!;
    await env.DB.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?1').bind(b.id).run();
    const bCookie = await cookieFor(b);
    expect((await send('/account', { cookie: bCookie })).status).toBe(200); // b's cookie works while b exists

    // b removed; c created — and given b's id
    expect((await send(`/settings/users/${b.id}/delete`, { cookie: adminCookie, form: {} })).status).toBe(302);
    expect((await send('/settings/users', { cookie: adminCookie, form: { username: 'c', role: 'member' } })).status).toBe(200);
    const c = (await getUserByUsername(env.DB, 'c'))!;
    expect(c.id).toBe(b.id);
    await env.DB.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?1').bind(c.id).run();

    for (const path of ['/account', '/', '/loans']) {
      await expectSignedOut(await send(path, { cookie: bCookie }), 'c · member');
    }
    // c's own cookie is c's
    const own = await send('/account', { cookie: await cookieFor(c) });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('c · member');
  });

  it('holds however the account is removed and remade — deleteUser and createUser directly', async () => {
    await createUser(env.DB, { username: 'a', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const b = await createUser(env.DB, { username: 'b', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const bCookie = await cookieFor(b);
    await deleteUser(env.DB, b.id);
    const c = await createUser(env.DB, { username: 'c', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    expect(c.id).toBe(b.id);
    expect(c.sessionKey).not.toBe(b.sessionKey);

    // an admin's id, reused by an admin: nothing an admin could do opens to the old cookie
    await expectSignedOut(await send('/settings/users', { cookie: bCookie }), 'c · admin');
    await expectSignedOut(await send('/settings/users', { cookie: bCookie, form: { username: 'intruder', role: 'admin' } }));
    expect(await getUserByUsername(env.DB, 'intruder')).toBeNull();
  });
});

describe('signing in', () => {
  it('logs in with a password and holds the session, request after request', async () => {
    await createUser(env.DB, { username: 'ann', passwordHash: await hashPassword('correct horse'), role: 'member', mustChangePassword: false });
    const login = await send('/auth/login', { form: { username: 'ann', password: 'correct horse' } });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/');
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    for (const path of ['/', '/account', '/loans']) {
      const res = await send(path, { cookie });
      expect(res.status, path).toBe(200);
    }
    expect(await (await send('/account', { cookie })).text()).toContain('ann · member');
  });

  it('a cookie from before keys existed — genuine, unexpired — signs nobody in: everyone logs in again once', async () => {
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const old = await genuine({ u: ann.id, e: now() + 3600 });
    await expectSignedOut(await send('/account', { cookie: old }), 'ann · admin');
  });

  it('a cookie naming a key that isn’t the account’s signs nobody in, even signed with the real secret', async () => {
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const ben = await createUser(env.DB, { username: 'ben', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    for (const k of [newSessionKey(), ben.sessionKey, ann.sessionKey.toUpperCase(), `${ann.sessionKey}x`, '']) {
      await expectSignedOut(await send('/account', { cookie: await genuine({ u: ann.id, k, e: now() + 3600 }) }), 'ann · admin');
    }
    // and a real key under a forged signature fails the HMAC first
    const [payload] = (await cookieFor(ann)).split('=')[1]!.split('.');
    await expectSignedOut(await send('/account', { cookie: `${SESSION_COOKIE}=${payload}.${b64url.encode(new Uint8Array(32))}` }));
  });

  it('an account without a usable key (added by hand, or restored from an older backup) gets one at its next login', async () => {
    await env.DB.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('old', ?1, 'member', 0)",
    ).bind(await hashPassword('correct horse')).run();
    const before = (await getUserByUsername(env.DB, 'old'))!;
    expect(before.sessionKey).toBe('');
    // nothing signs it in until then — a cookie naming the empty key included
    await expectSignedOut(await send('/account', { cookie: await genuine({ u: before.id, k: '', e: now() + 3600 }) }));

    const login = await send('/auth/login', { form: { username: 'old', password: 'correct horse' } });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/');
    const after = (await getUserByUsername(env.DB, 'old'))!;
    expect(isSessionKey(after.sessionKey)).toBe(true);
    const res = await send('/account', { cookie: login.headers.get('set-cookie')!.split(';')[0]! });
    expect(res.status).toBe(200);

    // a second login keeps that key: the first device stays signed in
    await send('/auth/login', { form: { username: 'old', password: 'correct horse' } });
    expect((await getUserByUsername(env.DB, 'old'))!.sessionKey).toBe(after.sessionKey);
  });
});

describe('every way an account is made gives it a key of its own', () => {
  it('setup, an admin adding members, createUser and createFirstAdmin: each key usable and unlike any other', async () => {
    // setup's admin
    const setup = await send('/setup', { form: { username: 'admin', password: 'correct horse', confirm: 'correct horse' } });
    expect(setup.status).toBe(302);
    const setupCookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    expect((await send('/account', { cookie: setupCookie })).status).toBe(200);

    // members the admin adds, then a member added and removed so an id is reused
    for (const username of ['m1', 'm2', 'm3']) {
      await send('/settings/users', { cookie: setupCookie, form: { username, role: 'member' } });
    }
    await send('/settings/users', { cookie: setupCookie, form: { username: 'co-admin', role: 'admin' } });
    await createUser(env.DB, { username: 'direct', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });

    const all = await keys();
    expect(all.map((u) => u.username)).toEqual(['admin', 'm1', 'm2', 'm3', 'co-admin', 'direct']);
    for (const u of all) expect(isSessionKey(u.k), u.username).toBe(true);
    expect(new Set(all.map((u) => u.k)).size).toBe(all.length);

    // a new database, where createFirstAdmin makes the first account: its key comes back with its id
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const first = await createFirstAdmin(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$a$a' }, ['Books']);
    expect(first).not.toBeNull();
    expect(isSessionKey(first!.sessionKey)).toBe(true);
    expect((await getUserById(env.DB, first!.id))!.sessionKey).toBe(first!.sessionKey);
    expect(all.map((u) => u.k)).not.toContain(first!.sessionKey);
  });

  it('a racing setup’s winner gets a key, signs in with it, and the loser writes none', async () => {
    const results = await Promise.all([
      send('/setup', { form: { username: 'ann', password: 'correct horse', confirm: 'correct horse' } }),
      send('/setup', { form: { username: 'ben', password: 'correct horse', confirm: 'correct horse' } }),
    ]);
    const won = results.find((r) => r.headers.get('location') === '/')!;
    const all = await keys();
    expect(all).toHaveLength(1);
    expect(isSessionKey(all[0]!.k)).toBe(true);
    expect((await send('/account', { cookie: won.headers.get('set-cookie')!.split(';')[0]! })).status).toBe(200);
  });
});

describe('the cost of a signed-in request', () => {
  // The key is compared with the row the middleware already reads: no D1 call is added. These are the counts main
  // made for the same requests, by the same admin, before keys existed.
  it('adds no D1 call to any page', async () => {
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = await cookieFor(ann);
    const measured: Record<string, number> = {};
    for (const path of ['/account', '/', '/loans', '/settings/users', '/tags']) {
      const budget = { left: 1000 };
      const res = await send(path, { cookie, db: budgeted(env.DB, budget) });
      expect(res.status, path).toBe(200);
      measured[path] = 1000 - budget.left;
    }
    expect(measured).toEqual({ '/account': 4, '/': 11, '/loans': 5, '/settings/users': 4, '/tags': 4 }); // '/': read next and the reading goal (§16 #46, #49)
  });
});

describe('migration 0029', () => {
  it('gives every existing account its own key, and changes nothing else', async () => {
    const at = env.TEST_MIGRATIONS.findIndex((m) => m.name.endsWith('_session-key.sql'));
    expect(at).toBeGreaterThan(0);
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, at));
    await env.DB.batch(
      ['ann', 'ben', 'cat', 'dev', 'eve'].map((name, n) =>
        env.DB.prepare("INSERT INTO users (username, password_hash, role, display_name) VALUES (?1, 'pbkdf2$1$x$y', ?2, ?3)")
          .bind(name, n === 0 ? 'admin' : 'member', n % 2 ? null : name.toUpperCase()),
      ),
    );
    const before = (await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results;

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const after = (await env.DB.prepare('SELECT * FROM users ORDER BY id').all<Record<string, unknown>>()).results;
    expect(after.map(({ session_key: _, ...rest }) => rest)).toEqual(before);
    const got = after.map((u) => u.session_key as string);
    for (const k of got) expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(got).size).toBe(got.length);
  });
});
