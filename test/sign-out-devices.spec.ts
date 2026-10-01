// Sign out other devices (ARCH.md §16 #70): beside the key that says which account a session is for (§16 #56), a
// generation says which of that account's sessions still count. The cookie names it, "Sign out other devices", a
// password change and an admin's reset move it on, and the device acting re-issues its own cookie so it stays in.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApiToken, createUser, getUserById } from '../src/db/queries';
import { b64url, createSessionToken, hashApiToken, hashPassword, newApiToken, SESSION_COOKIE, sessionMatches, verifySessionToken } from '../src/lib/auth';
import app from '../src/index';
import { member, rows } from './member-helpers';

const ORIGIN = 'http://nalanda.test';
const now = () => Math.floor(Date.now() / 1000);

async function send(path: string, cookie: string, form?: Record<string, string>, extra: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie, ...extra };
  let body: string | undefined;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const cookieFor = async (user: { id: number; sessionKey: string; sessionGeneration?: number }) =>
  `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user, now())}`;

/** The session cookie a response sets, as a request would send it back; null when it sets none. */
function setCookie(res: Response): string | null {
  const header = res.headers.get('set-cookie');
  const m = header && new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
  return m ? `${SESSION_COOKIE}=${m[1]}` : null;
}

const payloadOf = (cookie: string) => JSON.parse(new TextDecoder().decode(b64url.decode(cookie.split('=')[1]!.split('.')[0]!)));

const signedIn = async (cookie: string) => (await send('/account', cookie)).status === 200;

describe('the cookie and the generation', () => {
  it('names no generation at 0, so a cookie from before the column is byte for byte the same, and names it from 1 on', async () => {
    const ann = await member('ann');
    const row = (await getUserById(env.DB, ann.id))!;
    expect(row.sessionGeneration).toBe(0);
    expect(payloadOf(await cookieFor(row))).toEqual({ u: ann.id, k: ann.sessionKey, e: expect.any(Number) });
    expect(payloadOf(await cookieFor({ ...row, sessionGeneration: 3 }))).toEqual({ u: ann.id, k: ann.sessionKey, g: 3, e: expect.any(Number) });
  });

  it('matches only the row’s current generation', async () => {
    const ann = { id: 7, sessionKey: 'kkkkkkkkkkkkkkkkkkkkkk' };
    const atTwo = await verifySessionToken('secret', await createSessionToken('secret', { ...ann, sessionGeneration: 2 }, now()), now());
    expect(atTwo?.generation).toBe(2);
    expect(sessionMatches(atTwo, { ...ann, sessionGeneration: 2 })).toBe(true);
    expect(sessionMatches(atTwo, { ...ann, sessionGeneration: 3 })).toBe(false); // signed out since
    expect(sessionMatches(atTwo, { ...ann, sessionGeneration: 1 })).toBe(false); // never issued: a forgery or a restore
    const atZero = await verifySessionToken('secret', await createSessionToken('secret', ann, now()), now());
    expect(atZero?.generation).toBe(0);
    expect(sessionMatches(atZero, ann)).toBe(true); // a row without the field is generation 0
    expect(sessionMatches(atZero, { ...ann, sessionGeneration: 0 })).toBe(true);
    expect(sessionMatches(atZero, { ...ann, sessionGeneration: 1 })).toBe(false);
  });

  it('refuses a token whose generation isn’t a whole number from 0', async () => {
    const forged = async (g: unknown) => {
      const payload = b64url.encode(new TextEncoder().encode(JSON.stringify({ u: 1, k: 'kkkkkkkkkkkkkkkkkkkkkk', g, e: now() + 60 })));
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = b64url.encode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
      return verifySessionToken('secret', `${payload}.${sig}`, now());
    };
    expect(await forged(-1)).toBeNull();
    expect(await forged(1.5)).toBeNull();
    expect(await forged('2')).toBeNull();
    expect((await forged(2))?.generation).toBe(2);
  });
});

describe('Sign out other devices', () => {
  it('signs out every other cookie of the account and keeps the one that pressed it', async () => {
    const ann = await member('ann');
    const bob = await member('bob');
    const phone = await cookieFor(ann);
    const laptop = await cookieFor(ann);
    expect(await signedIn(phone)).toBe(true);
    expect(await signedIn(laptop)).toBe(true);

    const res = await send('/account/sign-out-others', laptop, {});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account?devices=out#devices');
    const laptopNow = setCookie(res);
    expect(laptopNow).not.toBeNull();
    expect(payloadOf(laptopNow!).g).toBe(1);

    expect(await signedIn(phone)).toBe(false); // the lost phone
    expect(await signedIn(laptop)).toBe(false); // the laptop's old cookie, had it kept it
    expect(await signedIn(laptopNow!)).toBe(true); // the laptop as the response left it
    expect(await signedIn(bob.cookie)).toBe(true); // nobody else's
    expect(await (await send('/account?devices=out', laptopNow!)).text()).toContain('Every other device is signed out. This one stays in.');
  });

  it('a password change does the same, and the device that changed it stays in', async () => {
    const user = await createUser(env.DB, { username: 'cy', passwordHash: await hashPassword('old-password'), role: 'member', mustChangePassword: false });
    const phone = await cookieFor(user);
    const laptop = await cookieFor(user);
    const res = await send('/account/password', laptop, { current: 'old-password', next: 'new-password-1', confirm: 'new-password-1' });
    expect(res.status).toBe(302);
    const laptopNow = setCookie(res)!;
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(laptop)).toBe(false);
    expect(await signedIn(laptopNow)).toBe(true);
    // and the new password signs in, at the new generation
    const login = await send('/auth/login', '', { username: 'cy', password: 'new-password-1' });
    expect(login.status).toBe(302);
    expect(await signedIn(setCookie(login)!)).toBe(true);
  });

  it('an admin’s reset signs the member out everywhere', async () => {
    const admin = await member('admin', 'admin');
    const dee = await member('dee');
    const phone = await cookieFor(dee);
    expect(await signedIn(phone)).toBe(true);
    const res = await send(`/settings/users/${dee.id}/reset`, admin.cookie, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('signed out everywhere');
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(admin.cookie)).toBe(true); // the admin's own session is untouched
  });

  it('is not offered on the admin’s own row, which points at Account instead, and a stray self-reset is refused', async () => {
    const admin = await member('admin', 'admin');
    const dee = await member('dee');
    const members = await (await send('/settings/users', admin.cookie)).text();
    expect(members).toContain(`action="/settings/users/${dee.id}/reset"`);
    expect(members).not.toContain(`action="/settings/users/${admin.id}/reset"`);
    expect(members).toContain('href="/account"');
    const res = await send(`/settings/users/${admin.id}/reset`, admin.cookie, {});
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Change your own password under Account');
    expect(await signedIn(admin.cookie)).toBe(true); // this device is still in
    const row = (await getUserById(env.DB, admin.id))!;
    expect(row.sessionGeneration).toBe(0);
    expect(row.mustChangePassword).toBe(false); // no temporary password minted
  });

  it('a refused password change signs nothing out', async () => {
    const user = await createUser(env.DB, { username: 'eve', passwordHash: await hashPassword('old-password'), role: 'member', mustChangePassword: false });
    const phone = await cookieFor(user);
    const laptop = await cookieFor(user);
    const res = await send('/account/password', laptop, { current: 'wrong', next: 'new-password-1', confirm: 'new-password-1' });
    expect(res.status).toBe(200);
    expect(setCookie(res)).toBeNull();
    expect(await signedIn(phone)).toBe(true);
  });

  it('the Account page offers it, except while a temporary password must still be changed', async () => {
    const ann = await member('ann');
    expect(await (await send('/account', ann.cookie)).text()).toContain('action="/account/sign-out-others"');
    const temp = await createUser(env.DB, { username: 'fay', passwordHash: await hashPassword('temp'), role: 'member', mustChangePassword: true });
    expect(await (await send('/account', await cookieFor(temp))).text()).not.toContain('action="/account/sign-out-others"');
  });
});

describe('a session that must still change its temporary password', () => {
  it('reaches the Account page and the password change only: every other Account action is sent back, and changes nothing', async () => {
    const temp = await createUser(env.DB, { username: 'fay', passwordHash: await hashPassword('temp-pass'), role: 'member', mustChangePassword: true });
    // a token of theirs — one made before the reset would have gone with it; this one stands in, to see revoke refused
    const tokenId = await createApiToken(env.DB, temp, 'the blog', await hashApiToken(newApiToken()));
    const cookie = await cookieFor(temp);
    expect((await send('/account', cookie)).status).toBe(200);
    expect((await send('/account?ok=1', cookie)).status).toBe(200);
    const refused: Array<[string, Record<string, string>]> = [
      ['/account/display-name', { displayName: 'Fay' }],
      ['/account/sign-out-others', {}],
      ['/account/tokens', { name: 'script' }],
      [`/account/tokens/${tokenId}/revoke`, {}],
    ];
    for (const [path, form] of refused) {
      const res = await send(path, cookie, form);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBe('/account');
      expect(setCookie(res), path).toBeNull();
    }
    // htmx is told why, and where to go
    const htmx = await send('/account/display-name', cookie, { displayName: 'Fay' }, { 'HX-Request': 'true' });
    expect(htmx.status).toBe(403);
    expect(htmx.headers.get('hx-redirect')).toBe('/account');
    const row = (await getUserById(env.DB, temp.id))!;
    expect(row.displayName).toBeNull(); // nothing to go out on a share page with names on
    expect(row.sessionGeneration).toBe(0); // nobody signed out
    expect(await rows('SELECT id FROM api_tokens WHERE user_id = ?1', temp.id)).toEqual([{ id: tokenId }]); // none made, none revoked
    // the password change itself goes through, and the member is in
    const changed = await send('/account/password', cookie, { current: 'temp-pass', next: 'my own password', confirm: 'my own password' });
    expect(changed.status).toBe(302);
    expect(changed.headers.get('location')).toBe('/');
    expect(await signedIn(setCookie(changed)!)).toBe(true);
    expect((await send('/account/display-name', setCookie(changed)!, { displayName: 'Fay' })).headers.get('location')).toBe('/account?name=saved#display-name');
  });
});
