// Signing in a device from another one (ARCH.md §16 #99), both ways round: a code a signed-in device shows, typed or
// scanned on the new one; and a QR the new device shows, scanned by a signed-in phone that must pick the same digits.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser } from '../src/db/queries';
import { hashLinkToken, hashPassword, SESSION_COOKIE } from '../src/lib/auth';
import { matchChoices, normalizePairCode } from '../src/lib/pairing';
import app from '../src/index';
import { rows } from './member-helpers';

const ORIGIN = 'http://nalanda.test';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TV = 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function send(path: string, init: { cookie?: string; form?: Record<string, string>; ua?: string; htmx?: boolean; ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: init.cookie ?? '', 'user-agent': init.ua ?? TV, 'cf-connecting-ip': init.ip ?? '203.0.113.9' };
  if (init.htmx) headers['HX-Request'] = 'true';
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

const cookieNamed = (res: Response, name: string): string | null => {
  const m = new RegExp(`${name}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '');
  return m && m[1] ? `${name}=${m[1]}` : null;
};
const signedInAs = async (cookie: string) => {
  const res = await send('/account', { cookie });
  return res.status === 200 ? await res.text() : null;
};

async function ravi(): Promise<string> {
  await createUser(env.DB, { username: 'ravi', passwordHash: await hashPassword('a-good-password'), role: 'member', mustChangePassword: false });
  const res = await send('/auth/login', { form: { username: 'ravi', password: 'a-good-password' }, ua: IPHONE });
  return cookieNamed(res, SESSION_COOKIE)!;
}

/** A code made on Account: as shown, and as the QR carries it. */
async function makeCode(phone: string) {
  const html = await (await send('/account/pair', { cookie: phone, form: {} })).text();
  const shown = /class="pair-digits mono">([A-Z2-9]{4}-[A-Z2-9]{4})</.exec(html)![1]!;
  const url = /data-qr="(http:\/\/nalanda\.test\/pair\?code=[A-Z2-9]{8})"/.exec(html)![1]!;
  return { html, shown, url, code: shown.replace('-', '') };
}

describe('a code from a signed-in device', () => {
  it('is shown once with its QR, kept as a hash, and signs the new device in, once', async () => {
    const phone = await ravi();
    const { html, code, url } = await makeCode(phone);
    expect(html).toContain('works once, for five minutes');
    expect(url).toBe(`${ORIGIN}/pair?code=${code}`);
    expect(await rows<{ codeHash: string }>(`SELECT code_hash AS codeHash FROM device_pairings`)).toEqual([{ codeHash: await hashLinkToken(code) }]);
    // the QR's page only fills the form in: nothing is signed in until it's sent
    const opened = await send(`/pair?code=${code}`);
    expect(opened.headers.get('cache-control')).toBe('no-store');
    expect(await opened.text()).toContain(`value="${code.slice(0, 4)}-${code.slice(4)}"`);
    expect(cookieNamed(opened, SESSION_COOKIE)).toBeNull();

    const tv = await send('/pair', { form: { code: code.toLowerCase().replace(/(....)/, '$1 ') } });
    expect(tv.status).toBe(302);
    const tvCookie = cookieNamed(tv, SESSION_COOKIE)!;
    expect(await signedInAs(tvCookie)).toContain('ravi');
    expect(await rows<{ device: string }>(`SELECT device FROM sessions ORDER BY created_at, rowid`)).toContainEqual({ device: 'Chrome · Android' });
    // used: a second device gets nowhere
    expect(await (await send('/pair', { form: { code } })).text()).toContain('That code didn’t work');
    expect(await rows('SELECT * FROM device_pairings')).toEqual([]);
  });

  it('dies past its minutes, when a new one is made, and when the account moves on', async () => {
    const phone = await ravi();
    const first = await makeCode(phone);
    const second = await makeCode(phone); // replaces the first
    expect(await (await send('/pair', { form: { code: first.code } })).text()).toContain('That code didn’t work');
    await env.DB.prepare(`UPDATE device_pairings SET expires_at = datetime('now', '-1 minute')`).run();
    expect(await (await send('/pair', { form: { code: second.code } })).text()).toContain('That code didn’t work');
    const third = await makeCode(phone);
    await send('/account/sign-out-others', { cookie: phone, form: {} }); // the generation moves on
    expect(await (await send('/pair', { form: { code: third.code } })).text()).toContain('That code didn’t work');
  });

  it('allows ten wrong codes an address in ten minutes, whatever else that address tries', async () => {
    await ravi();
    for (let i = 0; i < 10; i++) expect((await send('/pair', { form: { code: 'ABCD-EFGH' }, ip: '198.51.100.7' })).status).toBe(200);
    expect((await send('/pair', { form: { code: 'ABCD-EFGH' }, ip: '198.51.100.7' })).status).toBe(429);
    expect((await send('/pair', { form: { code: 'ABCD-EFGH' }, ip: '198.51.100.8' })).status).toBe(200); // another address
  });
});

describe('a QR the new device shows, scanned by a signed-in phone', () => {
  async function ask(ua = MAC_CHROME) {
    const res = await send('/pair/scan', { form: {}, ua });
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = /data-qr="http:\/\/nalanda\.test\/pair\/approve\/([A-Za-z0-9_-]{43})"/.exec(html)![1]!;
    const digits = /class="pair-digits mono"[^>]*>(\d\d)</.exec(html)![1]!;
    return { pollCookie: cookieNamed(res, 'nalanda_pair')!, token, digits, setCookie: res.headers.get('set-cookie') ?? '' };
  }

  it('shows the phone which device is asking, signs it in only with the right digits, and lets the new device claim it once', async () => {
    const phone = await ravi();
    const laptop = await ask();
    expect(laptop.setCookie).toMatch(/nalanda_pair=[^;]+; Max-Age=300; Path=\/pair; HttpOnly; SameSite=Lax/);
    const waiting = await send('/pair/scan/status', { cookie: laptop.pollCookie, htmx: true });
    expect(await waiting.text()).toContain('Waiting for your phone');

    const approve = await (await send(`/pair/approve/${laptop.token}`, { cookie: phone })).text();
    expect(approve).toContain('Chrome · macOS is asking to be signed in as ravi');
    const offered = [...approve.matchAll(/name="pick" value="(\d\d)"/g)].map((m) => m[1]);
    expect(offered).toHaveLength(3);
    expect(offered).toContain(laptop.digits);
    // the same three on every load: reloading never narrows them down
    expect([...(await (await send(`/pair/approve/${laptop.token}`, { cookie: phone })).text()).matchAll(/name="pick" value="(\d\d)"/g)].map((m) => m[1])).toEqual(offered);
    expect(await (await send(`/pair/approve/${laptop.token}`, { cookie: phone, form: { pick: laptop.digits } })).text()).toContain('the other device is signing in');

    const claimed = await send('/pair/scan/status', { cookie: laptop.pollCookie, htmx: true });
    expect(claimed.headers.get('HX-Redirect')).toBe('/');
    expect(claimed.headers.get('set-cookie')).toContain('nalanda_pair=;');
    expect(await signedInAs(cookieNamed(claimed, SESSION_COOKIE)!)).toContain('ravi');
    expect(await rows('SELECT * FROM device_pairings')).toEqual([]);
    expect(await (await send('/pair/scan/status', { cookie: laptop.pollCookie, htmx: true })).text()).toContain('This request is over');
  });

  it('ends the request on the wrong digits, or Don’t sign it in, and signs nothing in', async () => {
    const phone = await ravi();
    for (const pick of ['wrong', '']) {
      const laptop = await ask();
      const wrong = pick === 'wrong' ? String(((Number(laptop.digits) - 10 + 1) % 90) + 10) : '';
      const answer = await (await send(`/pair/approve/${laptop.token}`, { cookie: phone, form: { pick: wrong } })).text();
      expect(answer).toContain(pick === 'wrong' ? 'nothing was signed in' : 'Nothing was signed in.');
      const status = await send('/pair/scan/status', { cookie: laptop.pollCookie, htmx: true });
      expect(await status.text()).toContain('This request is over');
      expect(cookieNamed(status, SESSION_COOKIE)).toBeNull();
      expect((await send(`/pair/approve/${laptop.token}`, { cookie: phone })).status).toBe(410);
    }
  });

  it('needs the poll cookie to claim: the QR’s secret alone signs nobody in, and the phone must be signed in to approve', async () => {
    const phone = await ravi();
    const laptop = await ask();
    expect((await send(`/pair/approve/${laptop.token}`)).status).toBe(302); // signed out: to log in
    await send(`/pair/approve/${laptop.token}`, { cookie: phone, form: { pick: laptop.digits } });
    const stranger = await send('/pair/scan/status', { htmx: true });
    expect(cookieNamed(stranger, SESSION_COOKIE)).toBeNull();
    expect(await stranger.text()).toContain('This request is over');
  });

  it('of two claims racing, signs one in', async () => {
    const phone = await ravi();
    const laptop = await ask();
    await send(`/pair/approve/${laptop.token}`, { cookie: phone, form: { pick: laptop.digits } });
    const claims = await Promise.all([1, 2].map(() => send('/pair/scan/status', { cookie: laptop.pollCookie, htmx: true })));
    expect(claims.filter((r) => r.headers.get('HX-Redirect') === '/').length).toBe(1);
  });

  it('lapses after its five minutes, approved or not', async () => {
    const phone = await ravi();
    const laptop = await ask();
    await env.DB.prepare(`UPDATE device_pairings SET expires_at = datetime('now', '-1 minute')`).run();
    expect((await send(`/pair/approve/${laptop.token}`, { cookie: phone })).status).toBe(410);
    const late = await ask();
    await send(`/pair/approve/${late.token}`, { cookie: phone, form: { pick: late.digits } });
    await env.DB.prepare(`UPDATE device_pairings SET expires_at = datetime('now', '-1 minute')`).run();
    const claimed = await send('/pair/scan/status', { cookie: late.pollCookie, htmx: true });
    expect(cookieNamed(claimed, SESSION_COOKIE)).toBeNull();
    expect(await claimed.text()).toContain('This request is over');
  });

  it('can’t be approved, nor a code made, by a session still on a temporary password', async () => {
    await createUser(env.DB, { username: 'asha', passwordHash: await hashPassword('temporary-pass'), role: 'member', mustChangePassword: true });
    const temp = cookieNamed(await send('/auth/login', { form: { username: 'asha', password: 'temporary-pass' }, ua: IPHONE }), SESSION_COOKIE)!;
    const laptop = await ask();
    for (const res of [await send(`/pair/approve/${laptop.token}`, { cookie: temp, form: { pick: laptop.digits } }), await send('/account/pair', { cookie: temp, form: {} })]) {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/account');
    }
    expect(await rows(`SELECT approved_at FROM device_pairings`)).toEqual([{ approved_at: null }]);
    expect(await (await send('/account', { cookie: temp })).text()).not.toContain('Sign in another device');
  });

  it('opens ten requests an address in ten minutes, counted apart from its logins', async () => {
    await ravi();
    for (let i = 0; i < 10; i++) expect((await send('/pair/scan', { form: {}, ip: '198.51.100.7' })).status).toBe(200);
    expect((await send('/pair/scan', { form: {}, ip: '198.51.100.7' })).status).toBe(429);
    // the address's password tries are all still there
    const login = await send('/auth/login', { form: { username: 'ravi', password: 'a-good-password' }, ip: '198.51.100.7' });
    expect(cookieNamed(login, SESSION_COOKIE)).not.toBeNull();
  });

  it('dies with its approver’s generation: approved, then signed out everywhere, it signs nobody in', async () => {
    const phone = await ravi();
    const laptop = await ask();
    await send(`/pair/approve/${laptop.token}`, { cookie: phone, form: { pick: laptop.digits } });
    await send('/account/sign-out-others', { cookie: phone, form: {} });
    const claimed = await send('/pair/scan/status', { cookie: laptop.pollCookie, htmx: true });
    expect(cookieNamed(claimed, SESSION_COOKIE)).toBeNull();
  });
});

describe('the codes', () => {
  it('are read back as typed — case, spaces, the dash — and nothing else passes', () => {
    expect(normalizePairCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairCode(' ABCD EFGH ')).toBe('ABCDEFGH');
    expect(normalizePairCode('ABCD-EFG')).toBe('');
    expect(normalizePairCode('ABCD-EFG0')).toBe(''); // 0 and O are never in a code
    expect(normalizePairCode(undefined)).toBe('');
  });

  it('offers the right digits among three, the same three for the same request', () => {
    const seed = 'a1'.repeat(32);
    const choices = matchChoices('42', seed);
    expect(choices).toHaveLength(3);
    expect(choices).toContain('42');
    expect(new Set(choices).size).toBe(3);
    expect(matchChoices('42', seed)).toEqual(choices);
    expect(matchChoices('42', '')).toEqual(['10', '11', '42']); // a seed that runs out still makes three
  });
});
