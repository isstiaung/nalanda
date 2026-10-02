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
const wasOn = (html: string): string => /name="was" value="([0-9a-f]*)"/.exec(html)?.[1] ?? '';
/** "Make a new recovery code", as the page sends it: the password, and which code the page showed. */
async function makeAnother(cookie: string, current: string) {
  const was = wasOn(await (await send('/account', { cookie })).text());
  return send('/account/recovery', { cookie, form: { current, was } });
}
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

    // used: the old code opens nothing — minutes later it says it was just used (a double-click, a reload), then that
    // it's wrong — and the new one does
    expect(await (await recover({ code, password: 'third-password', confirm: 'third-password' })).text()).toContain('was used a few minutes ago');
    await env.DB.prepare(`UPDATE recovery_codes SET used_at = datetime('now', '-11 minutes')`).run();
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

  it('checks what was typed first: a short or unconfirmed password, or what can’t be a code, costs no try — and a code that works takes its try back', async () => {
    const { code } = await setUp();
    expect(await (await recover({ code, password: 'short', confirm: 'short' })).text()).toContain('at least 8 characters');
    expect(await (await recover({ code, confirm: 'something-else' })).text()).toContain('Passwords do not match');
    expect(await (await recover({ code: 'ABCD-EFGH' })).text()).toContain('don’t go together');
    expect(await rows('SELECT * FROM login_attempts')).toEqual([]);
    expect((await recover({ code })).status).toBe(200);
    expect(await rows('SELECT * FROM login_attempts')).toEqual([]);
  });

  it('leaves the browser’s own session alone when the code is wrong', async () => {
    const { cookie } = await setUp();
    const res = await send('/recover', { cookie, form: { username: 'admin', code: 'ABCD-EFGH-JKMN-PQRS-TUVW', password: 'second-password', confirm: 'second-password' } });
    expect(await res.text()).toContain('don’t go together');
    expect(await signsIn(cookie)).toBe(true);
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

    const wrong = await (await makeAnother(cookie, 'not-it')).text();
    expect(wrong).toContain('Current password is wrong.');
    expect(codeOn(wrong)).toBeNull();

    const made = await makeAnother(cookie, 'first-password');
    expect(made.headers.get('cache-control')).toBe('no-store');
    const page = await made.text();
    const fresh = codeOn(page)!;
    expect(fresh).not.toBe(code);
    expect(page).toContain('This is your new recovery code.');
    // the page that shows it names it, so another click from it replaces this one
    expect(wasOn(page)).toBe((await hashLinkToken(fresh.replaceAll('-', ''))).slice(0, 16));
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
    const first = codeOn(await (await makeAnother(cookie!, 'ann-password')).text());
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

describe('a code that would outlive its password', () => {
  it('goes when another admin resets the account: whoever made it with a phished password can’t undo the reset', async () => {
    const { cookie: a } = await setUp();
    await send('/settings/users', { cookie: a, form: { username: 'bea', role: 'admin' } });
    const bea = (await rows<{ id: number }>(`SELECT id FROM users WHERE username = 'bea'`))[0]!;
    await env.DB.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2`).bind(await hashPassword('bea-password'), bea.id).run();
    const phished = await logIn('bea', 'bea-password');
    const backdoor = codeOn(await (await makeAnother(phished!, 'bea-password')).text())!;
    await send(`/settings/users/${bea.id}/reset`, { cookie: a, form: {} });
    expect(await rows(`SELECT * FROM recovery_codes WHERE user_id = ${bea.id}`)).toEqual([]);
    expect(await (await recover({ username: 'bea', code: backdoor })).text()).toContain('don’t go together');
  });

  it('goes with a password change, and Account says to make another; and with a one-time link used', async () => {
    const { cookie, code } = await setUp();
    const changed = await send('/account/password', { cookie, form: { current: 'first-password', next: 'second-password', confirm: 'second-password' } });
    const next = sessionOf(changed)!;
    expect(await rows('SELECT * FROM recovery_codes')).toEqual([]);
    expect(await (await send('/account?ok=1', { cookie: next })).text()).toContain('Your recovery code stopped working with your old password');
    expect(await (await recover({ code })).text()).toContain('don’t go together');

    codeOn(await (await makeAnother(next, 'second-password')).text());
    const { secret } = await (async () => {
      const account = (await env.DB.prepare(resetLink.accountSql('admin')).first()) as { id: number; sessionKey: string };
      const secret = resetLink.newLinkSecret();
      const tokenHash = await resetLink.sha256Hex(secret);
      for (const sql of resetLink.resetLinkStatements({ id: account.id, sessionKey: account.sessionKey, tokenHash })) await env.DB.prepare(sql).run();
      return { secret };
    })();
    expect(await rows('SELECT user_id FROM recovery_codes')).toHaveLength(1); // the link changes nothing until it's used
    await send(`/join/${secret}`, { form: { password: 'third-password', confirm: 'third-password' } });
    expect(await rows('SELECT * FROM recovery_codes')).toEqual([]);
  });
});

describe('a double-click', () => {
  it('on /recover: one signs in, the other says the code was just used — not that it was wrong', async () => {
    const { code } = await setUp();
    const both = await Promise.all([recover({ code }), recover({ code })]);
    expect(both.filter((r) => sessionOf(r)).length).toBe(1);
    const other = both.find((r) => !sessionOf(r))!;
    expect(await other.text()).toContain('was used a few minutes ago');
  });

  it('on Make a new recovery code: one makes a code, the other makes none and says so — the code on screen always works', async () => {
    const { cookie } = await setUp();
    const was = wasOn(await (await send('/account', { cookie })).text());
    const both = await Promise.all([1, 2].map(() => send('/account/recovery', { cookie, form: { current: 'first-password', was } })));
    const pages = await Promise.all(both.map((r) => r.text()));
    const shown = pages.map(codeOn).filter((c): c is string => c !== null);
    expect(shown).toHaveLength(1);
    expect(pages.find((p) => !codeOn(p))).toContain('made a moment ago by another click');
    expect((await recover({ code: shown[0]! })).status).toBe(200);
  });
});

describe('the code', () => {
  it('is read back as typed, and nothing else passes', () => {
    expect(normalizeRecoveryCode('abcd efgh-jkmn pqrs tuvw')).toBe('ABCDEFGHJKMNPQRSTUVW');
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRS-TUV')).toBe('');
    expect(normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRS-TUV0')).toBe('');
  });
});
