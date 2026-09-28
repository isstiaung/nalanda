// The Export button fetches /export.csv a page at a time and joins the pages into one file in the browser
// (public/import.js, ARCH.md §16 #38). This runs that script against the Worker with just enough browser around
// it: fetch goes to the app, and the saved file is whatever Blob the script hands to URL.createObjectURL.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLibrary, createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';
import { EXPORT_PAGE } from '../src/routes/importexport';

type Click = (event: { preventDefault(): void }) => Promise<void>;

const browser = {
  click: undefined as Click | undefined,
  status: { textContent: '' },
  saved: [] as Array<{ blob: Blob; filename: string }>,
  /** How each fetch reaches the app; a test may swap it. */
  fetch: (req: Request) => {
    void req;
    return Promise.resolve(new Response(null, { status: 599 }));
  },
};
let pending: Blob | null = null;

beforeAll(async () => {
  const link = {
    href: 'http://nalanda.test/export.csv',
    addEventListener: (_type: string, handler: Click) => (browser.click = handler),
    setAttribute() {},
    removeAttribute() {},
  };
  Object.assign(globalThis, {
    document: {
      querySelector: (selector: string) => (selector === 'a[data-export]' ? link : null),
      getElementById: (id: string) => (id === 'export-status' ? browser.status : null),
      createElement: () => {
        const a = {
          href: '',
          download: '',
          click: () => browser.saved.push({ blob: pending!, filename: a.download }),
          remove() {},
        };
        return a;
      },
      body: { append() {} },
    },
    window: { Blob, URL },
  });
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => ((pending = blob), 'blob:export'),
    revokeObjectURL() {},
  });
  // @ts-expect-error -- a browser script with no types, run here for what it attaches to the page
  await import('../public/import.js');
});

afterEach(() => {
  browser.status.textContent = '';
  browser.saved = [];
});

async function signedIn() {
  const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
  return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000))}`;
}

function viaApp(cookie: string, bindings: (n: number) => Bindings = () => env as Bindings) {
  let n = 0;
  return async (req: Request) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(req, { headers: { cookie } }), bindings(n++), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

/** Presses the button with the script's fetch going to `browser.fetch`, and waits for the export to finish. */
async function press() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    // workerd's Request refuses redirect: 'error', which browsers take — so it's done here, as a browser does it:
    // a lapsed session answers with a redirect to /login, and the fetch fails rather than follow it
    const { redirect, cache, ...rest } = init;
    void cache;
    const res = await browser.fetch(new Request(input, { ...rest, redirect: 'manual' }));
    if (redirect === 'error' && res.status >= 300 && res.status < 400) throw new TypeError('Failed to fetch');
    return res;
  }) as typeof fetch;
  try {
    await browser.click!({ preventDefault() {} });
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function seed(total: number) {
  const lib = await createLibrary(env.DB, 'Everything');
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${total})
     INSERT INTO items (library_id, media_type, title, status, copies, details)
     SELECT ?1, 'book', 'Book ' || i, 'not_started', 1, '{}' FROM n`,
  ).bind(lib.id).run();
}

describe('the Export button', () => {
  it('saves one file, the same one the plain link streams, fetched a page at a time', async () => {
    await seed(EXPORT_PAGE * 2 + 3);
    const cookie = await signedIn();
    const requests: string[] = [];
    const app$ = viaApp(cookie);
    browser.fetch = (req) => (requests.push(new URL(req.url).search), app$(req));

    await press();

    expect(requests).toEqual(['?after=0', `?after=${EXPORT_PAGE}`, `?after=${EXPORT_PAGE * 2}`]);
    expect(browser.saved).toHaveLength(1);
    const [{ blob, filename }] = browser.saved as [{ blob: Blob; filename: string }];
    expect(filename).toMatch(/^nalanda-export-\d{4}-\d{2}-\d{2}\.csv$/);
    const whole = await (await viaApp(cookie)(new Request('http://nalanda.test/export.csv'))).text();
    expect(await blob.text()).toBe(whole);
    expect(browser.status.textContent).toBe(`Exported ${EXPORT_PAGE * 2 + 3} items to ${filename}.`);
  });

  it('saves nothing, and says so, when a page fails partway', async () => {
    await seed(EXPORT_PAGE * 2 + 3);
    const cookie = await signedIn();
    // the second request gets too few queries to read its page, so the Worker answers 500
    browser.fetch = viaApp(cookie, (n) => ({ ...env, DB: n === 1 ? budgeted(env.DB, { left: 2 }) : env.DB }) as Bindings);

    await press();

    expect(browser.saved).toEqual([]);
    expect(browser.status.textContent).toBe('Export failed partway (the server answered 500), so nothing was saved. Try again.');
  });

  it('keeps a login page out of the file when the session lapses partway', async () => {
    await seed(EXPORT_PAGE + 1);
    const cookie = await signedIn();
    const app$ = viaApp(cookie);
    const anonymous = viaApp('');
    let n = 0;
    browser.fetch = (req) => (n++ === 0 ? app$(req) : anonymous(req));

    await press();

    expect(browser.saved).toEqual([]);
    expect(browser.status.textContent).toMatch(/^Export failed partway \(Failed to fetch\), so nothing was saved/);
  });
});
