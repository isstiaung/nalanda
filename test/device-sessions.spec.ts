// Device sessions (ARCH.md §16 #98): every sign-in is a row named after its browser, listed on Account, signed out one
// at a time; it slides — 30 days from its last use, written at most daily — and a cookie from before them still works.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser } from '../src/db/queries';
import { b64url, hashPassword, SESSION_COOKIE } from '../src/lib/auth';
import { deviceName } from '../src/lib/devices';
import app from '../src/index';
import { member, rows } from './member-helpers';

const ORIGIN = 'http://nalanda.test';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function send(path: string, cookie: string, init: { form?: Record<string, string>; ua?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie };
  if (init.ua) headers['user-agent'] = init.ua;
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

const cookieOf = (res: Response): string | null => {
  const m = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '');
  return m ? `${SESSION_COOKIE}=${m[1]}` : null;
};
const sidOf = (cookie: string): string | undefined => JSON.parse(new TextDecoder().decode(b64url.decode(cookie.split('=')[1]!.split('.')[0]!))).s;
const signedIn = async (cookie: string) => (await send('/account', cookie)).status === 200;

async function account(username: string, password = 'a-good-password') {
  await createUser(env.DB, { username, passwordHash: await hashPassword(password), role: 'member', mustChangePassword: false });
}
async function login(username: string, ua: string, password = 'a-good-password'): Promise<string> {
  const res = await send('/auth/login', '', { form: { username, password }, ua });
  expect(res.status).toBe(302);
  return cookieOf(res)!;
}

describe('a sign-in', () => {
  it('is a session named after its browser, in the cookie, and listed on Account as this device', async () => {
    await account('ravi');
    const laptop = await login('ravi', MAC_CHROME);
    const sid = sidOf(laptop)!;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await rows('SELECT id, device FROM sessions')).toEqual([{ id: sid, device: 'Chrome · macOS' }]);
    const page = await (await send('/account', laptop)).text();
    expect(page).toContain('Chrome · macOS');
    expect(page).toContain('this device');
    expect(page).not.toContain(`/account/devices/${sid}/sign-out`); // this one signs out with Log out
  });

  it('lists every device, and signs another out on its own: its cookie signs nobody in after', async () => {
    await account('ravi');
    const phone = await login('ravi', IPHONE);
    const laptop = await login('ravi', MAC_CHROME);
    const page = await (await send('/account', laptop)).text();
    expect(page).toContain('Safari · iPhone');
    expect(page).toContain(`action="/account/devices/${sidOf(phone)}/sign-out"`);
    const res = await send(`/account/devices/${sidOf(phone)}/sign-out`, laptop, { form: {} });
    expect(res.headers.get('location')).toBe('/account?devices=one#devices');
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(laptop)).toBe(true);
    expect(await (await send('/account?devices=one', laptop)).text()).toContain('That device is signed out.');
  });

  it('signs out no one else’s device', async () => {
    await account('ravi');
    await account('dee');
    const ravi = await login('ravi', IPHONE);
    const dee = await login('dee', MAC_CHROME);
    await send(`/account/devices/${sidOf(ravi)}/sign-out`, dee, { form: {} });
    expect(await signedIn(ravi)).toBe(true);
  });

  it('ends with Log out: a kept copy of the cookie signs nobody in', async () => {
    await account('ravi');
    const laptop = await login('ravi', MAC_CHROME);
    await send('/auth/logout', laptop, { form: {} });
    expect(await rows('SELECT id FROM sessions')).toEqual([]);
    expect(await signedIn(laptop)).toBe(false);
  });
});

describe('sliding', () => {
  it('moves the last use on at most once a day, and the cookie with it', async () => {
    await account('ravi');
    const laptop = await login('ravi', MAC_CHROME);
    const quiet = await send('/account', laptop);
    expect(cookieOf(quiet)).toBeNull(); // used today already: nothing written, no new cookie
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = datetime('now', '-2 days')`).run();
    const slid = await send('/account', laptop);
    expect(slid.status).toBe(200);
    const fresh = cookieOf(slid)!;
    expect(sidOf(fresh)).toBe(sidOf(laptop)); // the same session, its cookie good for another 30 days
    const [row] = await rows<{ fresh: number }>(`SELECT last_seen_at > datetime('now', '-1 minute') AS fresh FROM sessions`);
    expect(row!.fresh).toBe(1);
  });

  it('lets a session unused for 30 days go, whatever its cookie says', async () => {
    await account('ravi');
    const laptop = await login('ravi', MAC_CHROME);
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = datetime('now', '-31 days')`).run();
    expect(await signedIn(laptop)).toBe(false);
    expect(await (await send('/account', await login('ravi', IPHONE))).text()).not.toContain('Chrome · macOS'); // and it's swept
    expect(await rows<{ device: string }>('SELECT device FROM sessions')).toEqual([{ device: 'Safari · iPhone' }]);
  });
});

describe('what ends every device', () => {
  it('Sign out other devices: every row goes, this device signs in again in the new generation', async () => {
    await account('ravi');
    const phone = await login('ravi', IPHONE);
    const laptop = await login('ravi', MAC_CHROME);
    const res = await send('/account/sign-out-others', laptop, { form: {} });
    const now = cookieOf(res)!;
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(now)).toBe(true);
    expect((await rows('SELECT id FROM sessions')).length).toBe(1);
  });

  it('a password change, and an admin’s reset', async () => {
    await account('ravi');
    const phone = await login('ravi', IPHONE);
    const laptop = await login('ravi', MAC_CHROME);
    const changed = await send('/account/password', laptop, { form: { current: 'a-good-password', next: 'new-password-1', confirm: 'new-password-1' } });
    expect(await signedIn(phone)).toBe(false);
    const now = cookieOf(changed)!;
    expect(await signedIn(now)).toBe(true);
    const admin = await member('asha', 'admin');
    const ravi = (await rows<{ id: number }>(`SELECT id FROM users WHERE username = 'ravi'`))[0]!.id;
    await send(`/settings/users/${ravi}/reset`, admin.cookie, { form: {} });
    expect(await signedIn(now)).toBe(false);
    expect(await rows('SELECT id FROM sessions WHERE user_id = ?1', ravi)).toEqual([]);
  });
});

describe('a cookie from before device sessions', () => {
  it('still signs in until it expires, lists no device, and Sign out other devices ends it', async () => {
    const ravi = await member('ravi'); // a cookie with no session in it, as every cookie was before
    expect(await signedIn(ravi.cookie)).toBe(true);
    expect(await rows('SELECT id FROM sessions')).toEqual([]);
    const phone = ravi.cookie;
    const res = await send('/account/sign-out-others', ravi.cookie, { form: {} });
    expect(await signedIn(phone)).toBe(false);
    expect(await signedIn(cookieOf(res)!)).toBe(true);
  });
});

describe('a device’s name', () => {
  it('is the browser and the system, and nothing else of the User-Agent', () => {
    expect(deviceName(MAC_CHROME)).toBe('Chrome · macOS');
    expect(deviceName(IPHONE)).toBe('Safari · iPhone');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge · Windows');
    expect(deviceName('Mozilla/5.0 (Android 15; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0')).toBe('Firefox · Android');
    expect(deviceName('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36')).toBe('Samsung Internet · Android');
    expect(deviceName('curl/8.7.1')).toBe('');
    expect(deviceName(undefined)).toBe('');
  });
});
