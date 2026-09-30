// The installed app's service worker (ARCH.md §16 #48): it keeps the scanner working with no signal, and lives by
// three rules — it never keeps a page or an API answer, never touches a share page, and a new version clears out the
// old one's files. Static files are read through the test-only ASSETS binding (vitest.config.ts); the worker's own
// logic runs here too: its source is evaluated against a stand-in `self`, `caches` and `fetch`, and fed requests.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import appJs from '../public/app.js?raw';
import swSource from '../public/sw.js?raw';
import { scanQueueOwner } from '../src/lib/auth';
import app from '../src/index';
import { member } from './member-helpers';

const ORIGIN = 'http://nalanda.test';

/** A static file as a browser gets it. */
const asset = (path: string) => env.ASSETS.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });

/** What production does with a path: the static file if there is one, else the Worker. */
async function served(path: string, cookie?: string): Promise<Response> {
  const file = await asset(path);
  if (file.status !== 404) return file;
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('the service worker, as served', () => {
  it('is a script at the root — so its scope is the whole app — and is revalidated on every check', async () => {
    const res = await asset('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    // never cached for long: the browser must see a new worker as soon as it's deployed
    expect(res.headers.get('cache-control')).toMatch(/max-age=0|no-cache/);
    // nothing restricts where it may run or what it may load
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('is registered by app.js from the root, for the root, bypassing the HTTP cache', () => {
    expect(appJs).toContain("navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })");
  });

  it('is allowed by the secure headers on app pages: no CSP, no Permissions-Policy taking the camera', async () => {
    const admin = await member('ravi', 'admin');
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${ORIGIN}/add`, { headers: { cookie: admin.cookie } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('permissions-policy')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff'); // still hardened
  });

  it('leaves the caching headers of signed-in pages as they were: none', async () => {
    const admin = await member('ravi', 'admin');
    for (const path of ['/', '/add', '/loans', '/search?q=x']) {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie: admin.cookie } }), env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBeNull();
    }
  });

  it('serves the offline page as a static file under its own name, and it holds nothing about anyone', async () => {
    const res = await asset('/offline.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain('data-scan-mode="hold"');
    expect(html).toContain('src="/scan-queue.js"');
    expect(html).toContain('src="/scanner.js"');
    expect(html).not.toContain('data-scan-owner');
  });
});

describe('a missing file is still a plain 404, whoever asks — never the login page', () => {
  it('for the worker, the offline page, the manifest and icons of another version', async () => {
    const admin = await member('ravi', 'admin');
    for (const cookie of [undefined, admin.cookie]) {
      for (const path of ['/sw-v2.js', '/offline-v2.html', '/app.webmanifest', '/icons/icon-maskable-192.png', '/offline']) {
        const res = await served(path, cookie);
        if (path === '/offline') {
          // no extension: a page path like any other, so it isn't a file — signed out it goes to log in
          expect(res.status, path).toBe(cookie ? 404 : 302);
          continue;
        }
        expect(res.status, `${path} ${cookie ? 'signed in' : 'signed out'}`).toBe(404);
        expect(res.headers.get('location'), path).toBeNull();
        expect(await res.text(), path).toBe('Not found');
      }
    }
  });
});

// ── the service worker's behaviour ──────────────────────────────────────────────────────────────────────────────

type FakeInit = { cache?: string; credentials?: string };
type FakeRequest = { url: string; method: string; mode: string };
type Handler = (event: Record<string, unknown>) => void;

/** Runs sw.js against a stand-in service-worker global. `network` answers its fetches; null means offline. */
function worker(network: (path: string, init?: FakeInit) => Promise<Response> | null) {
  const listeners = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const puts: string[] = [];
  const fetched: { path: string; init?: FakeInit }[] = [];
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const keyOf = (key: string | FakeRequest) => (typeof key === 'string' ? key : new URL(key.url).pathname);
  const caches = {
    open: async (name: string) => ({
      put: async (key: string | FakeRequest, res: Response) => {
        puts.push(`${name} ${keyOf(key)}`);
        store(name).set(keyOf(key), res);
      },
    }),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (key: string, options?: { cacheName?: string }) => {
      const found = options?.cacheName ? stores.get(options.cacheName)?.get(key) : undefined;
      return found?.clone();
    },
  };
  const fetchStub = (input: string | FakeRequest, init?: FakeInit) => {
    const url = typeof input === 'string' ? new URL(input, ORIGIN) : new URL(input.url);
    fetched.push({ path: url.pathname + url.search, init });
    const answer = url.origin === ORIGIN ? network(url.pathname + url.search, init) : null;
    return answer ?? Promise.reject(new TypeError('Failed to fetch'));
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Handler) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function('self', 'caches', 'fetch', swSource)(self, caches, fetchStub);

  async function lifecycle(type: 'install' | 'activate') {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (work = p) });
    await work;
  }

  /** Dispatches a fetch event. Resolves the worker's answer, or null when it left the request alone. */
  async function request(path: string, init: { method?: string; mode?: string; origin?: string } = {}) {
    let answer = null as Promise<Response> | null;
    const waits: Promise<unknown>[] = [];
    listeners.get('fetch')!({
      request: { url: `${init.origin ?? ORIGIN}${path}`, method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
      respondWith: (p: Promise<Response>) => (answer = Promise.resolve(p)),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    const res = answer ? await answer : null;
    await Promise.all(waits);
    return res;
  }

  return { lifecycle, request, stores, puts, fetched };
}

const CACHE = /^nalanda-static-v\d+$/;
const STATIC = JSON.parse(
  (/const STATIC = (\[[\s\S]*?\]);/.exec(swSource)?.[1] ?? '[]').replace(/'/g, '"').replace(/,\s*\]/, ']'),
) as string[];

/** The network as production answers: public/ first, then the Worker (signed in as `cookie`, if given). */
const production = (cookie?: string) => (path: string) => served(path, cookie);

describe('the service worker keeps static files, never pages', () => {
  it('lists only static files — each with an extension, none of them a page, an API or a share — including the offline page', () => {
    expect(STATIC).toContain('/offline.html');
    expect(STATIC).toContain('/scanner.js');
    expect(STATIC).toContain('/scan-queue.js');
    for (const path of STATIC) {
      expect(path, path).toMatch(/^\/[^?#]*\.(html|css|js|svg|png|woff2|wasm)$/);
      expect(path, path).not.toMatch(/^\/(share|api|covers|items|libraries|add|federation)\b/);
    }
  });

  it('installs from the files as served — every listed file exists — into a versioned cache, past the HTTP cache', async () => {
    const sw = worker(production());
    await sw.lifecycle('install');
    const name = [...sw.stores.keys()][0] ?? "";
    expect(name).toMatch(CACHE);
    expect([...sw.stores.get(name)!.keys()].sort()).toEqual([...STATIC].sort());
    for (const f of sw.fetched) {
      expect(f.init?.cache, f.path).toBe('reload');
      expect(f.init?.credentials, f.path).toBe('omit');
    }
  });

  it('refuses to install when a listed file answers with anything but itself — a 404, or a redirect to log in', async () => {
    for (const status of [404, 302]) {
      const sw = worker((path) =>
        path === '/offline.html' ? Promise.resolve(new Response('nope', { status, headers: status === 302 ? { location: '/login' } : {} })) : served(path),
      );
      await expect(sw.lifecycle('install'), String(status)).rejects.toThrow('/offline.html');
    }
  });

  it('deletes every older version of its cache when it takes over, and nobody else’s', async () => {
    const sw = worker(production());
    await sw.lifecycle('install');
    const [current] = [...sw.stores.keys()];
    sw.stores.set('nalanda-static-v0', new Map([['/app.css', new Response('old')]]));
    sw.stores.set('someone-elses-cache', new Map());
    await sw.lifecycle('activate');
    expect([...sw.stores.keys()].sort()).toEqual([current, 'someone-elses-cache'].sort());
  });

  it('passes a signed-in page straight from the network and keeps no copy of it', async () => {
    const admin = await member('ravi', 'admin');
    const sw = worker(production(admin.cookie));
    await sw.lifecycle('install');
    const installed = sw.puts.length;
    for (const path of ['/', '/add', '/loans', '/items/1', '/search?q=dune', '/account']) {
      const res = await sw.request(path, { mode: 'navigate' });
      expect(res, path).not.toBeNull();
      expect(res!.headers.get('content-type') ?? '', path).toMatch(/^text\/html/); // the network's own answer
    }
    // the only thing stored after six signed-in pages: the offline page's hourly refresh, fetched without a cookie
    expect(sw.puts.slice(installed).map((p) => p.split(' ')[1])).toEqual(['/offline.html']);
    for (const kept of sw.stores.values()) {
      for (const [key, res] of kept) {
        expect(STATIC, key).toContain(key);
        expect(await res.clone().text(), key).not.toContain('<body data-scan-owner=');
      }
    }
  });

  it('brings its copy of the offline page up to date after a page load, at most hourly, never with a cookie', async () => {
    let version = 'first';
    const sw = worker((path, init) =>
      path === '/offline.html' ? Promise.resolve(new Response(`<h1>No signal</h1>${version}${init?.credentials ?? ''}`)) : served(path),
    );
    await sw.lifecycle('install');
    version = 'second';
    await sw.request('/loans', { mode: 'navigate' });
    await sw.request('/add', { mode: 'navigate' });
    const kept = [...sw.stores.values()][0]!.get('/offline.html')!;
    expect(await kept.clone().text()).toBe('<h1>No signal</h1>secondomit');
    expect(sw.fetched.filter((f) => f.path === '/offline.html')).toHaveLength(2); // install, then one refresh
  });

  it('shows the offline page — from its cache — for any page the network can’t reach', async () => {
    let online = true;
    const sw = worker((path) => (online ? served(path) : null));
    await sw.lifecycle('install');
    online = false;
    for (const path of ['/', '/add', '/items/12']) {
      const res = await sw.request(path, { mode: 'navigate' });
      expect(res!.status, path).toBe(200);
      expect(await res!.text(), path).toContain('No signal');
    }
  });

  it('leaves share pages entirely alone: not answered, not kept, no offline stand-in', async () => {
    let online = true;
    const sw = worker((path) => (online ? served(path) : null));
    await sw.lifecycle('install');
    const installed = sw.puts.length;
    for (const up of [true, false]) {
      online = up;
      for (const path of ['/share', '/share/abc123', '/share/abc123/items/4']) {
        expect(await sw.request(path, { mode: 'navigate' }), path).toBeNull();
        expect(await sw.request(path), path).toBeNull();
      }
    }
    expect(sw.puts.length).toBe(installed);
  });

  it('leaves API calls, htmx partials, covers, other origins and every POST to the browser', async () => {
    const sw = worker(production());
    await sw.lifecycle('install');
    for (const path of ['/api/lookup?barcode=9780306406157', '/add/review?barcode=9780306406157', '/add/results?q=x', '/covers/abc', '/export.csv', '/app.css?v=2', '/vendor/htmx.min.js']) {
      expect(await sw.request(path), path).toBeNull();
    }
    for (const path of ['/items', '/auth/logout', '/api/import', '/app.css']) {
      expect(await sw.request(path, { method: 'POST' }), `POST ${path}`).toBeNull();
    }
    expect(await sw.request('/app.css', { origin: 'https://elsewhere.example' })).toBeNull();
  });

  it('fetches a listed file from the network first, refreshes its copy, and falls back to it offline', async () => {
    let online = true;
    let css = 'body{v:1}';
    const sw = worker((path) => (!online ? null : path === '/app.css' ? Promise.resolve(new Response(css, { status: 200 })) : served(path)));
    await sw.lifecycle('install');
    css = 'body{v:2}';
    const fresh = await sw.request('/app.css');
    expect(await fresh!.text()).toBe('body{v:2}'); // the deploy, not the kept copy
    online = false;
    expect(await (await sw.request('/app.css'))!.text()).toBe('body{v:2}');
  });

  it('keeps no copy of a listed file that came back as an error', async () => {
    const sw = worker((path) => (path === '/app.css' ? Promise.resolve(new Response('down', { status: 503 })) : served(path)));
    await sw.lifecycle('install').catch(() => undefined); // install fails on the 503 too
    const before = sw.puts.filter((p) => p.endsWith(' /app.css')).length;
    const res = await sw.request('/app.css');
    expect(res!.status).toBe(503);
    expect(sw.puts.filter((p) => p.endsWith(' /app.css')).length).toBe(before);
  });
});

describe('the scan-queue stamp', () => {
  it('is on every signed-in page, differs between accounts, and says nothing about who', async () => {
    const ravi = await member('ravi', 'admin');
    const priya = await member('priya');
    const stamps: string[] = [];
    for (const who of [ravi, priya]) {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`${ORIGIN}/loans`, { headers: { cookie: who.cookie } }), env, ctx);
      await waitOnExecutionContext(ctx);
      const stamp = /<body data-scan-owner="([^"]+)"/.exec(await res.text())?.[1];
      expect(stamp).toBe(await scanQueueOwner(env.SESSION_SECRET, who.id));
      expect(stamp).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(stamp).not.toContain(who.name);
      stamps.push(stamp!);
    }
    expect(stamps[0]).not.toBe(stamps[1]);
  });

  it('is not on the login page, where nobody is signed in', async () => {
    await member('ravi', 'admin');
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${ORIGIN}/login`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await res.text()).not.toContain('data-scan-owner');
  });
});
