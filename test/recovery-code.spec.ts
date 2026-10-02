// An admin's recovery code (ARCH.md §16 #100): shown once at setup, used at /recover to choose a new password — once,
// replaced by a new one in the same batch — and made again on Account, for the password, by admins only.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser, deleteUser } from '../src/db/queries';
import { hashLinkToken, hashPassword, LINK_DAYS, SESSION_COOKIE } from '../src/lib/auth';
import { normalizeRecoveryCode } from '../src/lib/recovery';
import app from '../src/index';
import { rows } from './member-helpers';
import * as resetLink from '../scripts/reset-link.mjs';

const ORIGIN = 'http://nalanda.test';

async function send(path: string, init: { cookie?: string; form?: Record<string, string>; ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: init.cookie ?? '', 'cf-connecting-ip': init.ip ?? '203.0.113.9' };
  let body: string | undefined;
  if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: init.form ? 'POST' : 'GET', headers, body, redirect: 'manual' }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const sessionOf = (res: Response): string | null => {
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '');
  return m && m[1] ? `${SESSION_COOKIE}=${m[1]}` : null;
};
const codeOn = (html: string): string | null => /class="recovery-digits mono">([A-Z2-9-]{24})</.exec(html)?.[1] ?? null;
const signsIn = async (cookie: string | null) => !!cookie && (await send('/account', { cookie })).status === 200;
const logIn = async (username: string, password: string) => sessionOf(await send('/auth/login', { form: { username, password } }));

/** A fresh instance's admin, as setup leaves them: signed in, and the recovery code setup showed. */
async function setUp() {
  const res = await send('/setup', { form: { username: 'admin', password: 'first-password', confirm: 'first-password' } });
  return { cookie: sessionOf(res)!, code: codeOn(await res.text())! };
}

const recover = (form: Partial<Record<'username' | 'code' | 'password' | 'confirm', string>>, ip?: string) =>
  send('/recover', { form: { username: 'admin', password: 'second-password', confirm: 'second-password', code: '', ...form }, ip });

describe('the code setup shows', () => {
  it('is kept only as a hash, and chooses a new password once — signing out every device, ending tokens and links — and is replaced by a new one', async () => {
    const { cookie, code } = await setUp();
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    expect(await rows<{ h: string }>('SELECT code_hash AS h FROM recovery_codes')).toEqual([{ h: await hashLinkToken(code.replaceAll('-', '')) }]);
    await send('/account/tokens', { cookie, form: { name: 'reader' } });
    const elsewhere = await logIn('admin', 'first-password');

    const page = await send('/recover');
    expect(await page.text()).toContain('Recovery code');
    // typed as people type it: lower case, spaces for dashes
    const res = await recover({ code: code.toLowerCase().replaceAll('-', ' ') });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Your new password is set');
    const next = codeOn(html)!;
    expect(next).not.toBe(code);
    expect(await signsIn(sessionOf(res))).toBe(true);

    expect(await logIn('admin', 'first-password')).toBeNull();
    expect(await signsIn(await logIn('admin', 'second-password'))).toBe(true);
    expect(await signsIn(cookie)).toBe(false);
    expect(await signsIn(elsewhere)).toBe(false);
    expect(await rows('SELECT * FROM api_tokens')).toEqual([]);
    expect(await rows<{ h: string }>('SELECT code_hash AS h FROM recovery_codes')).toEqual([{ h: await hashLinkToken(next.replaceAll('-', '')) }]);

    // used: the old code opens nothing; the new one does
    expect(await (await recover({ code, password: 'third-password', confirm: 'third-password' })).text()).toContain('don’t go together');
    expect((await recover({ code: next, password: 'third-password', confirm: 'third-password' })).status).toBe(200);
    expect(await logIn('admin', 'third-password')).not.toBeNull();
  });

  it('answers a wrong code and an unknown username alike, and changes nothing', async () => {
    const { code } = await setUp();
    const wrongCode = await (await recover({ code: 'ABCD-EFGH-JKMN-PQRS-TUVW' })).text();
    const wrongName = await (await recover({ username: 'nobody', code })).text();
    const notACode = await (await recover({ code: 'not a code' })).text();
    for (const html of [wrongCode, wrongName, notACode]) expect(html).toContain('That username and recovery code don’t go together.');
    expect(await logIn('admin', 'first-password')).not.toBeNull();
  });

  it('checks the new password before the code: a short or unconfirmed one costs no try', async () => {
    const { code } = await setUp();
    expect(await (await recover({ code, password: 'short', confirm: 'short' })).text()).toContain('at least 8 characters');
    expect(await (await recover({ code, confirm: 'something-else' })).text()).toContain('Passwords do not match');
    expect(await rows('SELECT * FROM login_attempts')).toEqual([]);
    expect((await recover({ code })).status).toBe(200);
  });

  it('allows ten wrong tries an account in ten minutes, from anywhere, as login does', async () => {
    const { code } = await setUp();
    for (let i = 0; i < 10; i++) await recover({ code: 'ABCD-EFGH-JKMN-PQRS-TUVW' }, `198.51.100.${i}`);
    const refused = await recover({ code }, '198.51.100.200');
    expect(refused.status).toBe(429);
    expect(await logIn('admin', 'first-password')).toBeNull(); // the account's tries are spent for login too
  });

  it('of two uses racing, signs one in', async () => {
    const { code } = await setUp();
    const both = await Promise.all([recover({ code }), recover({ code, password: 'other-password', confirm: 'other-password' })]);
    expect(both.filter((r) => sessionOf(r)).length).toBe(1);
  });

  it('dies with its account: a removed admin’s code opens no newcomer', async () => {
    const { code } = await setUp();
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: await hashPassword('ann-password'), role: 'admin', mustChangePassword: false });
    const admin = (await rows<{ id: number }>(`SELECT id FROM users WHERE username = 'admin'`))[0]!;
    await deleteUser(env.DB, admin.id, ann.id);
    expect(await rows('SELECT * FROM recovery_codes')).toEqual([]);
    expect(await (await recover({ code })).text()).toContain('don’t go together');
  });
});

describe('Account’s recovery code', () => {
  it('says when it was made, never the code, and makes a new one for the password — the old one stops working', async () => {
    const { cookie, code } = await setUp();
    const account = await (await send('/account', { cookie })).text();
    expect(account).toContain('You have a recovery code, made');
    expect(codeOn(account)).toBeNull();

    const wrong = await (await send('/account/recovery', { cookie, form: { current: 'not-it' } })).text();
    expect(wrong).toContain('Current password is wrong.');
    expect(codeOn(wrong)).toBeNull();

    const made = await send('/account/recovery', { cookie, form: { current: 'first-password' } });
    expect(made.headers.get('cache-control')).toBe('no-store');
    const fresh = codeOn(await made.text())!;
    expect(fresh).not.toBe(code);
    expect(await (await recover({ code })).text()).toContain('don’t go together');
    expect((await recover({ code: fresh })).status).toBe(200);
  });

  it('is an admin’s alone: a member sees no panel, and can’t make one', async () => {
    const { cookie } = await setUp();
    await send('/settings/users', { cookie, form: { username: 'ravi', role: 'member' } });
    await env.DB.prepare(`UPDATE users SET password_hash = ?1 WHERE username = 'ravi'`).bind(await hashPassword('ravi-password')).run();
    const ravi = await logIn('ravi', 'ravi-password');
    expect(await (await send('/account', { cookie: ravi! })).text()).not.toContain('recovery code');
    expect((await send('/account/recovery', { cookie: ravi!, form: { current: 'ravi-password' } })).status).toBe(403);
    expect(await rows(`SELECT r.user_id FROM recovery_codes r JOIN users u ON u.id = r.user_id WHERE u.username = 'ravi'`)).toEqual([]);
  });

  it('says so when an admin has none — one from before this version — and makes their first', async () => {
    const ann = await createUser(env.DB, { username: 'ann', passwordHash: await hashPassword('ann-password'), role: 'admin', mustChangePassword: false });
    const cookie = await logIn('ann', 'ann-password');
    expect(await (await send('/account', { cookie: cookie! })).text()).toContain('You have no recovery code.');
    const first = codeOn(await (await send('/account/recovery', { cookie: cookie!, form: { current: 'ann-password' } })).text());
    expect(first).not.toBeNull();
    expect(await rows<{ id: number }>('SELECT user_id AS id FROM recovery_codes')).toEqual([{ id: ann.id }]);
  });
});

describe('npm run reset-admin’s link', () => {
  /** What the command runs, run here: the account looked up, the statements, and the check after. */
  async function mint(username: string) {
    const account = (await env.DB.prepare(resetLink.accountSql(username)).first()) as { id: number; role: string; sessionKey: string | null };
    const secret = resetLink.newLinkSecret();
    const tokenHash = await resetLink.sha256Hex(secret);
    const newSessionKey = resetLink.isKey(account.sessionKey) ? null : resetLink.newKey();
    for (const sql of resetLink.resetLinkStatements({ id: account.id, sessionKey: account.sessionKey, newSessionKey, tokenHash })) await env.DB.prepare(sql).run();
    const made = (await env.DB.prepare(resetLink.linkMadeSql(tokenHash)).first()) as { purpose: string } | null;
    return { secret, made };
  }

  it('is the app’s own reset link: its secret and hash alike, and nothing changes until it is used', async () => {
    expect(resetLink.LINK_DAYS).toBe(LINK_DAYS);
    const { cookie } = await setUp();
    const { secret, made } = await mint('admin');
    expect(made).toEqual({ purpose: 'reset' });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await resetLink.sha256Hex(secret)).toBe(await hashLinkToken(secret));
    expect(await signsIn(cookie)).toBe(true);
    expect(await logIn('admin', 'first-password')).not.toBeNull();

    const join = await send(`/join/${secret}`);
    expect(await join.text()).toContain('Choose a new password');
    const used = await send(`/join/${secret}`, { form: { password: 'second-password', confirm: 'second-password' } });
    expect(await signsIn(sessionOf(used))).toBe(true);
    expect(await signsIn(cookie)).toBe(false);
    expect(await logIn('admin', 'first-password')).toBeNull();
  });

  it('keeps an invite an invite, gives a keyless account its key, quotes a username safely, and makes nothing for a member', async () => {
    const { cookie } = await setUp();
    await send('/settings/users', { cookie, form: { username: "o'brien", role: 'admin' } });
    expect((await mint("o'brien")).made).toEqual({ purpose: 'invite' });

    await env.DB.prepare(`UPDATE users SET session_key = '' WHERE username = 'admin'`).run();
    const keyless = await mint('admin');
    expect(keyless.made).toEqual({ purpose: 'reset' });
    const used = await send(`/join/${keyless.secret}`, { form: { password: 'second-password', confirm: 'second-password' } });
    expect(await signsIn(sessionOf(used))).toBe(true);

    await createUser(env.DB, { username: 'ravi', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    expect((await mint('ravi')).made).toBeNull();
  });
});

describe('the code', () => {
  it('is read back as typed, and nothing else passes', () => {
    expect(normalizeRecoveryCode('abcd efgh-jkmn pqrs tuvw')).toBe('ABCDEFGHJKMNPQRSTUVW');
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRS-TUV')).toBe('');
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRS-TUV0')).toBe('');
  });
});
