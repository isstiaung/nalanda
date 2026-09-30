// htmx failures are shown app-wide; an expired session redirects the whole page (ARCH.md §16 #65).
// An htmx request follows a 302 itself and swaps whatever it lands on — the whole login page — into the section it
// targets. Every way the session middleware sends someone elsewhere answers htmx with HX-Redirect instead, which htmx
// turns into a page load; a browser's own navigation keeps the 302 it always had. A failed htmx request is said in the
// layout's one message region, by app.js, in fixed sentences.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createShare, createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';
import { as, book, member, rows } from './member-helpers';

type Init = { cookie?: string; htmx?: boolean; post?: boolean; headers?: Record<string, string>; bindings?: Partial<Bindings> };

async function request(path: string, init: Init = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: 'http://nalanda.test', ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.htmx) headers['HX-Request'] = 'true';
  if (init.post) headers['content-type'] = 'application/x-www-form-urlencoded';
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, { method: init.post ? 'POST' : 'GET', headers, body: init.post ? '' : undefined, redirect: 'manual' }),
    { ...env, ...init.bindings } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** An htmx request sent to a whole page: HX-Redirect, no Location (nothing for htmx to follow and swap), not a 2xx. */
async function sentAsPage(res: Response, to: string, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get('HX-Redirect')).toBe(to);
  expect(res.headers.get('location')).toBeNull();
  const body = await res.text();
  expect(body).not.toContain('<html'); // never a page to swap in: a sentence, for a script's own fetch
  return body;
}

/** A browser's navigation, exactly as before: a 302 and nothing htmx would read. */
function redirected(res: Response, to: string) {
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe(to);
  expect(res.headers.get('HX-Redirect')).toBeNull();
}

describe('a request with no session', () => {
  it('sends an htmx GET and POST to log in with HX-Redirect, and a browser with the 302 it always had', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    for (const [path, post] of [
      ['/', false],
      ['/?not=1', false], // Read next's Another
      [`/items/${b.id}`, false],
      ['/play?pick=1', false],
      [`/items/${b.id}/mark-not-owned`, true], // the Holding toggle
      [`/items/${b.id}/reads/start`, true],
      [`/items/${b.id}/want`, true],
      [`/items/${b.id}/discogs`, true], // PR #85's Refresh: it used to swap the login page into #pressing-body
    ] as const) {
      const body = await sentAsPage(await request(path, { htmx: true, post }), '/login', 401);
      expect(body).toBe('Signed out — reload and sign in.');
      redirected(await request(path, { post }), '/login');
    }
    expect(await rows('SELECT id FROM reads')).toEqual([]); // nothing ran behind the refusal
  });

  it('sends an htmx request on a fresh instance to /setup, as a page', async () => {
    await sentAsPage(await request('/items/1', { htmx: true }), '/setup', 401);
    redirected(await request('/items/1'), '/setup');
  });

  it('treats an expired cookie, a rotated session key and a removed member alike', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    const user = { id: asha.id, sessionKey: asha.sessionKey };
    const expired = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user, Math.floor(Date.now() / 1000) - 31 * 86400)}`;
    await sentAsPage(await request(`/items/${b.id}/mark-not-owned`, { htmx: true, post: true, cookie: expired }), '/login', 401);
    redirected(await request(`/items/${b.id}/mark-not-owned`, { post: true, cookie: expired }), '/login');

    // the cookie names a key the account no longer has (§16 #56): someone else's id now, or a key rotated by hand
    await env.DB.prepare('UPDATE users SET session_key = ?1 WHERE id = ?2').bind('f'.repeat(32), asha.id).run();
    await sentAsPage(await request(`/items/${b.id}`, { htmx: true, cookie: asha.cookie }), '/login', 401);
    redirected(await request(`/items/${b.id}`, { cookie: asha.cookie }), '/login');

    const ravi = await member('ravi');
    await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(ravi.id).run();
    await sentAsPage(await request('/?not=1', { htmx: true, cookie: ravi.cookie }), '/login', 401);
  });

  it('keeps the front door’s share for a visitor, and sends an htmx request from the app to log in', async () => {
    await member('asha', 'admin');
    const lib = await createLibrary(env.DB, 'Front shelf');
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Our library', libraryId: lib.id });
    const bindings = { HOME_SHARE_TOKEN: share.token };
    redirected(await request('/', { bindings }), `/share/${share.token}`);
    // Read next's Another after the session lapsed: someone in the app, not a visitor — never the share in the card
    await sentAsPage(await request('/?not=1', { htmx: true, bindings }), '/login', 401);
  });
});

describe('a member who must change their password', () => {
  it('is sent to /account as a page by htmx, as by a browser, and the account page still answers', async () => {
    const user = await createUser(env.DB, { username: 'new', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: true });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user, Math.floor(Date.now() / 1000))}`;
    const lib = await createLibrary(env.DB, 'Shelf');
    const b = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'Kindred', details: '{}' });
    const body = await sentAsPage(await request(`/items/${b.id}/mark-not-owned`, { htmx: true, post: true, cookie }), '/account', 403);
    expect(body).toBe('Choose a new password first — reload the page.');
    await sentAsPage(await request('/?not=1', { htmx: true, cookie }), '/account', 403);
    redirected(await request(`/items/${b.id}`, { cookie }), '/account');
    expect((await request('/account', { cookie })).status).toBe(200);
    expect((await request('/account', { cookie, htmx: true })).status).toBe(200);
  });
});

describe('the CSRF check', () => {
  it('marks its refusal of an htmx request for app.js, and answers a browser exactly as before', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    for (const headers of [{ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, { origin: 'https://evil.example' }]) {
      const htmx = await request(`/items/${b.id}/mark-not-owned`, { htmx: true, post: true, cookie: asha.cookie, headers });
      expect(htmx.status).toBe(403);
      expect(htmx.headers.get('X-Nalanda-Refused')).toBe('origin');
      expect(htmx.headers.get('HX-Redirect')).toBeNull();
      expect(await htmx.text()).toBe('Forbidden');

      const plain = await request(`/items/${b.id}/mark-not-owned`, { post: true, cookie: asha.cookie, headers });
      expect(plain.status).toBe(403);
      expect(plain.headers.get('X-Nalanda-Refused')).toBeNull();
      expect(await plain.text()).toBe('Forbidden');
    }
    expect(await rows('SELECT copies FROM items WHERE id = ?1', b.id)).toEqual([{ copies: 1 }]);
    // a route's own 403 isn't the CSRF check's: it carries no mark, so app.js says its generic sentence
    const ravi = await member('ravi');
    const refused = await as(ravi, '/settings/users', { htmx: true });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('X-Nalanda-Refused')).toBeNull();
  });
});

describe('the message region', () => {
  const REGION = '<output id="app-status" class="app-status" aria-live="polite"></output>';
  const count = (html: string) => html.split('id="app-status"').length - 1;

  it('is on every signed-in page once, empty, right after <main>', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    for (const path of ['/', `/items/${b.id}`, '/loans', '/tags', '/wants', '/account', '/settings/users', '/add', '/play', '/no-such-page']) {
      const html = await (await as(asha, path)).text();
      expect(count(html), path).toBe(1);
      expect(html, path).toContain(`</main>${REGION}`);
    }
  });

  it('is never in a partial, on the login page or on a share page', async () => {
    const asha = await member('asha', 'admin');
    const b = await book(asha);
    expect(count(await (await as(asha, '/?not=1', { htmx: true })).text())).toBe(0);
    expect(count(await (await as(asha, `/items/${b.id}/mark-not-owned`, { body: {}, htmx: true })).text())).toBe(0);
    expect(count(await (await request('/login')).text())).toBe(0);

    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: b.libraryId });
    const want = await createShare(env.DB, { token: newShareToken(), name: 'Wants', wantUserId: asha.id });
    for (const path of [`/share/${share.token}`, `/share/${share.token}/items/${b.id}`, `/share/${want.token}`]) {
      const res = await request(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(count(html), path).toBe(0);
      expect(html, path).not.toContain('app-status');
      expect(html, path).not.toContain('/app.js'); // nor the script that fills it
    }
  });
});

describe('app.js', () => {
  const asset = async (path: string) => (await env.ASSETS.fetch(`http://nalanda.test${path}`)).text();

  it('says a failed htmx request in the region, in fixed sentences chosen by its kind, and never the answer', async () => {
    const js = await asset('/app.js');
    const block = js.slice(js.indexOf('Every other htmx control'));
    expect(block.length).toBeGreaterThan(100);
    // on the window: after every handler on the document, so a scoped one that said it (preventDefault) wins
    for (const event of ['htmx:responseError', 'htmx:sendError', 'htmx:timeout', 'htmx:beforeRequest', 'htmx:afterRequest']) {
      expect(block).toContain(`window.addEventListener('${event}'`);
    }
    expect(block).toContain('e.defaultPrevented');
    expect(block).toContain("getElementById('app-status')");
    for (const sentence of [
      'Couldn’t reach Nalanda — check your connection and try again.',
      'Something went wrong — try again.',
      'You can’t do that here.',
      'That’s no longer here — reload the page.',
      'That didn’t go through — reload the page and try again.',
    ]) {
      expect(block).toContain(`'${sentence}'`);
    }
    expect(block).toContain("getResponseHeader('X-Nalanda-Refused') === 'origin'");
    // it reads a status and one header's value — never a body, the URL or the path
    for (const never of ['responseText', 'xhr.response', '.responseURL', 'pathInfo', 'innerHTML', 'serverResponse']) {
      expect(block).not.toContain(never);
    }
    expect(block).toContain('textContent = text');
    // after the page left by HX-Redirect, back from the page cache it loads again rather than stay stuck
    expect(block).toContain("getResponseHeader('HX-Redirect')");
    expect(block).toContain('e.persisted && redirected');
  });

  it('lets the scoped handlers say their own failure: Refresh’s status and the scanner’s held scan', async () => {
    const js = await asset('/app.js');
    const scoped = js.slice(js.indexOf('form[data-refresh-status]'), js.indexOf('Every other htmx control'));
    // said in the form's own region, and marked said: a statement, not a comment
    expect(scoped).toMatch(/found\.status\.textContent = 'Something went wrong — try again\.';\n\s*e\.preventDefault\(\);/);
    const scanner = await asset('/scanner.js');
    const held = scanner.slice(scanner.indexOf("'htmx:sendError'"));
    expect(held.slice(0, held.indexOf('});'))).toMatch(/hold\(code\);\n\s*e\.preventDefault\(\);/);
  });

  it('styles the region, empty taking no room', async () => {
    const css = await asset('/app.css');
    expect(css).toMatch(/\.app-status \{[^}]*position: sticky;/);
    expect(css).toMatch(/\.app-status:empty \{ padding: 0; margin-block: 0; border: 0;/);
  });
});
