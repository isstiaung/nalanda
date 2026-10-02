// One-time links to an account (ARCH.md §16 #97): an admin invites a member, or resets a forgotten password, with a
// link the member opens to choose their own password — no admin ever sees one. Only the link's hash is kept; it is
// bound to the account (id and key, #56), good for LINK_DAYS and once.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApiToken, createUser, deleteUser, getUserById } from '../src/db/queries';
import { hashLinkToken, hashPassword, newApiToken, hashApiToken, SESSION_COOKIE } from '../src/lib/auth';
import { as, member, rows } from './member-helpers';

const LINK = /http:\/\/nalanda\.test\/join\/([A-Za-z0-9_-]{43})/;

/** The link a Members response shows, and its secret. */
function linkIn(html: string): { url: string; token: string } {
  const m = LINK.exec(html);
  if (!m) throw new Error('no link on the page');
  return { url: m[0], token: m[1]! };
}

/** The session cookie a response sets, as a request sends it back; null when it sets none. */
function cookieOf(res: Response): string | null {
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '');
  return m ? `${SESSION_COOKIE}=${m[1]}` : null;
}

const signedInAs = async (cookie: string) => {
  const res = await as({ id: 0, name: '', cookie, admin: false, sessionKey: '' }, '/account');
  return res.status === 200 ? await res.text() : null;
};

const login = (username: string, password: string) => as(null, '/auth/login', { body: { username, password } });

async function invite(admin: Awaited<ReturnType<typeof member>>, username: string) {
  const res = await as(admin, '/settings/users', { body: { username, role: 'member' } });
  expect(res.status).toBe(200);
  const html = await res.text();
  return { html, ...linkIn(html) };
}

describe('an invite', () => {
  it('shows the admin a link and its QR code, never a password, and keeps only the link’s hash', async () => {
    const admin = await member('asha', 'admin');
    const { html, url, token } = await invite(admin, 'ravi');
    expect(html).toContain('Invite link for “ravi”');
    expect(html).toContain(`data-qr="${url}"`);
    expect(html).not.toContain('Temporary password');
    const [row] = await rows<{ purpose: string; tokenHash: string; days: number }>(
      `SELECT purpose, token_hash AS tokenHash, round(julianday(expires_at) - julianday('now')) AS days FROM account_links`,
    );
    expect(row).toEqual({ purpose: 'invite', tokenHash: await hashLinkToken(token), days: 7 });
    expect(JSON.stringify(await rows('SELECT * FROM account_links'))).not.toContain(token);
    // the account exists, with a password nobody knows, and nothing to change on first sign-in
    const ravi = (await rows<{ id: number; must: number }>(`SELECT id, must_change_password AS must FROM users WHERE username = 'ravi'`))[0]!;
    expect(ravi.must).toBe(0);
    expect((await login('ravi', '')).status).toBe(200); // refused: the login page again
    // Members says so, and offers a new invite rather than a reset
    const members = await (await as(admin, '/settings/users')).text();
    expect(members).toMatch(/Invited · until \d{4}-\d{2}-\d{2}/);
    expect(members).toContain('New invite link');
    expect(members).not.toContain(url); // shown once: only on the response that made it
  });

  it('opens a page to choose a password, signs the member in, and works once', async () => {
    const admin = await member('asha', 'admin');
    const { token } = await invite(admin, 'ravi');
    const page = await as(null, `/join/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const body = await page.text();
    expect(body).toContain('value="ravi"');
    expect(body).toContain(`action="/join/${token}"`);

    // too short, and not matching: the form again, saying which field, and the link still good
    expect(await (await as(null, `/join/${token}`, { body: { password: 'short', confirm: 'short' } })).text()).toContain('at least 8 characters');
    expect(await (await as(null, `/join/${token}`, { body: { password: 'a-good-password', confirm: 'another-one' } })).text()).toContain('Passwords do not match.');

    const done = await as(null, `/join/${token}`, { body: { password: 'a-good-password', confirm: 'a-good-password' } });
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/');
    expect(await signedInAs(cookieOf(done)!)).toContain('ravi');
    expect((await login('ravi', 'a-good-password')).status).toBe(302);

    // used: gone, and a second use changes nothing
    expect((await as(null, `/join/${token}`)).status).toBe(410);
    const again = await as(null, `/join/${token}`, { body: { password: 'someone-else', confirm: 'someone-else' } });
    expect(again.status).toBe(410);
    expect(cookieOf(again)).toBeNull();
    expect((await login('ravi', 'someone-else')).status).toBe(200);
    expect(await rows('SELECT * FROM account_links')).toEqual([]);
  });

  it('of two uses racing, sets one password', async () => {
    const admin = await member('asha', 'admin');
    const { token } = await invite(admin, 'ravi');
    const [a, b] = await Promise.all([
      as(null, `/join/${token}`, { body: { password: 'first-password', confirm: 'first-password' } }),
      as(null, `/join/${token}`, { body: { password: 'second-password', confirm: 'second-password' } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([302, 410]);
    const won = a.status === 302 ? 'first-password' : 'second-password';
    const lost = a.status === 302 ? 'second-password' : 'first-password';
    expect((await login('ravi', won)).status).toBe(302);
    expect((await login('ravi', lost)).status).toBe(200);
  });

  it('a new invite replaces the old one, and stays an invite even once the first has expired', async () => {
    const admin = await member('asha', 'admin');
    const first = await invite(admin, 'ravi');
    const ravi = (await rows<{ id: number }>(`SELECT id FROM users WHERE username = 'ravi'`))[0]!.id;
    await env.DB.prepare(`UPDATE account_links SET expires_at = datetime('now', '-1 day')`).run();
    expect((await as(null, `/join/${first.token}`)).status).toBe(410); // expired
    const res = await as(admin, `/settings/users/${ravi}/reset`, { body: {} });
    const second = linkIn(await res.text());
    expect(await (await as(admin, `/settings/users/${ravi}/reset`, { body: {} })).text()).toContain('Invite link for “ravi”');
    expect((await as(null, `/join/${second.token}`)).status).toBe(410); // replaced by the one just made
    expect(await rows<{ purpose: string }>('SELECT purpose FROM account_links')).toEqual([{ purpose: 'invite' }]);
  });
});

describe('a reset', () => {
  it('stops the old password at once, signs the member out everywhere, takes their tokens, and lets them choose another', async () => {
    const admin = await member('asha', 'admin');
    const dee = await createUser(env.DB, { username: 'dee', passwordHash: await hashPassword('old-password'), role: 'member', mustChangePassword: false });
    const phone = cookieOf(await login('dee', 'old-password'))!;
    await createApiToken(env.DB, dee, 'the blog', await hashApiToken(newApiToken()));
    const res = await as(admin, `/settings/users/${dee.id}/reset`, { body: {} });
    const html = await res.text();
    expect(html).toContain('Password reset link for “dee”');
    expect(html).toContain('signed out everywhere');
    const { token } = linkIn(html);
    expect(await signedInAs(phone)).toBeNull();
    expect((await login('dee', 'old-password')).status).toBe(200);
    expect(await rows('SELECT id FROM api_tokens')).toEqual([]);
    expect(await (await as(admin, '/settings/users')).text()).toMatch(/Reset link out · until \d{4}-\d{2}-\d{2}/);

    expect(await (await as(null, `/join/${token}`)).text()).toContain('Choose a new password for dee');
    const done = await as(null, `/join/${token}`, { body: { password: 'new-password-1', confirm: 'new-password-1' } });
    expect(done.status).toBe(302);
    expect((await login('dee', 'new-password-1')).status).toBe(302);
    expect((await getUserById(env.DB, dee.id))!.mustChangePassword).toBe(false);
  });

  it('is an admin’s alone', async () => {
    await member('asha', 'admin');
    const ravi = await member('ravi');
    const dee = await member('dee');
    expect((await as(ravi, `/settings/users/${dee.id}/reset`, { body: {} })).status).toBe(403);
    expect((await as(ravi, '/settings/users', { body: { username: 'eve', role: 'admin' } })).status).toBe(403);
    expect(await rows('SELECT * FROM account_links')).toEqual([]);
  });
});

describe('a link that no longer works', () => {
  it('says so, the same way, whatever the reason — and never whose it was', async () => {
    const admin = await member('asha', 'admin');
    const { token } = await invite(admin, 'ravi');
    const made = await as(null, '/join/not-a-token');
    expect(made.status).toBe(410);
    const text = await made.text();
    expect(text).toContain('This link no longer works');
    expect(text).not.toContain('ravi');
    expect((await as(null, `/join/${'A'.repeat(43)}`)).status).toBe(410);
    expect((await as(null, `/join/${'A'.repeat(43)}`, { body: { password: 'a-good-password', confirm: 'a-good-password' } })).status).toBe(410);
    expect((await as(null, `/join/${token}`)).status).toBe(200); // the real one, untouched by the guesses
  });

  it('dies with its member, and a newcomer given their id inherits nothing', async () => {
    const admin = await member('asha', 'admin');
    const { token } = await invite(admin, 'ravi');
    const ravi = (await rows<{ id: number }>(`SELECT id FROM users WHERE username = 'ravi'`))[0]!.id;
    expect(await deleteUser(env.DB, ravi, admin.id)).toBe(true);
    const newcomer = await member('newcomer');
    expect(newcomer.id).toBe(ravi);
    expect((await as(null, `/join/${token}`)).status).toBe(410);
    expect(await rows('SELECT * FROM account_links')).toEqual([]);
  });
});
