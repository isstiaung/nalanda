// The CSV export streams items 500 at a time and looks up each page's tags in one query. D1 allows
// 100 bound parameters per statement, so a page of 500 ids has to be chunked — unchunked, the tag
// lookup throws inside waitUntil and the download silently ends early.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { activeLoanItemIds, createItem, createLibrary, createUser, setItemTags, tagsForItems } from '../src/db/queries';
import { budgeted } from '../src/federation/budget';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';
import { EXPORT_PAGE } from '../src/routes/importexport';

const COUNT = 230; // more than two chunks' worth, well past the 100-parameter cap

/**
 * Book n (1…COUNT), tagged tag-(n % 7). Seeded in three statements rather than one call per item: ~1,150
 * separate queries took long enough to trip vitest's 5 s timeout on a loaded CI runner.
 */
async function seed() {
  const lib = await createLibrary(env.DB, 'Big shelf');
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${COUNT})
     INSERT INTO items (library_id, media_type, title, status, copies, details)
     SELECT ?1, 'book', 'Book ' || i, 'not_started', 1, '{}' FROM n`,
  ).bind(lib.id).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tags (name) VALUES ('tag-0'), ('tag-1'), ('tag-2'), ('tag-3'), ('tag-4'), ('tag-5'), ('tag-6')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO item_tags (item_id, tag_id)
     SELECT items.id, tags.id FROM items
     JOIN tags ON tags.name = 'tag-' || (CAST(substr(items.title, 6) AS INTEGER) % 7)
     WHERE items.library_id = ?1`,
  ).bind(lib.id).run();
  const rows = await env.DB.prepare('SELECT id FROM items WHERE library_id = ?1 ORDER BY id').bind(lib.id).all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

describe('id lists longer than D1 allows in one statement', () => {
  it('tagsForItems answers for every id', async () => {
    const ids = await seed();
    const tags = await tagsForItems(env.DB, ids);
    expect(tags.size).toBe(COUNT);
    expect(tags.get(ids.at(-1)!)).toEqual([`tag-${COUNT % 7}`]);
  });

  it('activeLoanItemIds accepts them', async () => {
    const ids = await seed();
    await expect(activeLoanItemIds(env.DB, ids)).resolves.toEqual(new Set());
  });

  it('the CSV export includes every item, with its tags', async () => {
    await seed();
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const token = await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000));
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request('http://nalanda.test/export.csv', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), env, ctx);
    const body = await res.text();
    await waitOnExecutionContext(ctx);

    const rows = body.trim().split('\r\n');
    expect(rows.length).toBe(COUNT + 1); // header + every item
    expect(rows.at(-1)).toContain(`Book ${COUNT}`);
    expect(rows.at(-1)).toContain(`tag-${COUNT % 7}`);
  });
});

describe('a large export within the free plan', () => {
  it('streams a larger catalog than this was found on, within 50 D1 queries', async () => {
    const TOTAL = 2600; // above the 1,998 this was found on
    const lib = await createLibrary(env.DB, 'Everything');
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TOTAL})
       INSERT INTO items (library_id, media_type, title, status, copies, details)
       SELECT ?1, 'book', 'Book ' || i, 'not_started', 1, '{}' FROM n`,
    ).bind(lib.id).run();
    await env.DB.prepare("INSERT INTO tags (name) VALUES ('alpha'), ('beta'), ('gamma')").run();
    await env.DB.prepare('INSERT INTO item_tags (item_id, tag_id) SELECT id, (id % 3) + 1 FROM items').run();
    // a reading log on every tenth book, two entries each, so the progress lookup has work to do too
    await env.DB.prepare("INSERT INTO reading_progress (item_id, page, at) SELECT id, 40, '2026-09-01 09:00:00' FROM items WHERE id % 10 = 0").run();
    await env.DB.prepare("INSERT INTO reading_progress (item_id, page, at) SELECT id, 120, '2026-09-08 21:00:00' FROM items WHERE id % 10 = 0").run();

    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const token = await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000));
    // the page's own queries and the streaming work in waitUntil share one invocation's budget
    const budget = { left: 50 };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://nalanda.test/export.csv', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      { ...env, DB: budgeted(env.DB, budget) },
      ctx,
    );
    const body = await res.text();
    await waitOnExecutionContext(ctx);

    const rows = body.trim().split('\r\n');
    expect(rows.length).toBe(TOTAL + 1);
    expect(rows.at(-1)).toContain(`Book ${TOTAL}`);
    expect(rows.every((r, i) => i === 0 || /alpha|beta|gamma/.test(r))).toBe(true); // every row kept its tag
    expect(rows.filter((r) => r.includes('40@2026-09-01 09:00:00;120@2026-09-08 21:00:00')).length).toBe(TOTAL / 10);
    console.log(`export of ${TOTAL} items used ${50 - budget.left} of 50 D1 queries`);
    expect(50 - budget.left).toBeLessThan(25); // room for the progress lookup and for growth
  });
});

describe('an export that fails partway', () => {
  it('fails the download instead of handing over a file that just stops', async () => {
    const lib = await createLibrary(env.DB, 'Everything');
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
       INSERT INTO items (library_id, media_type, title, status, copies, details)
       SELECT ?1, 'book', 'Book ' || i, 'not_started', 1, '{}' FROM n`,
    ).bind(lib.id).run();
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const token = await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000));
    // enough for the page and the first page of items, not the second: the stream is cut off partway
    const budget = { left: 5 };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://nalanda.test/export.csv', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      { ...env, DB: budgeted(env.DB, budget) },
      ctx,
    );

    expect(res.status).toBe(200); // headers were sent before the failure — which is exactly why it must fail
    // Read it the way a download does, chunk by chunk. (res.text() would also reject, but workerd leaves its
    // internal reader's closed promise unhandled when the body errors, which vitest reports as a failure.)
    const reader = res.body!.getReader();
    reader.closed.catch(() => {});
    let failed = false;
    try {
      while (!(await reader.read()).done);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    await waitOnExecutionContext(ctx);
  });
});

describe('an export in pages, as the Export button fetches it', () => {
  async function adminCookie() {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000))}`;
  }

  async function get(path: string, cookie: string, budget = { left: 50 }) {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: { cookie } }), { ...env, DB: budgeted(env.DB, budget) }, ctx);
    const body = await res.text();
    await waitOnExecutionContext(ctx);
    return { res, body, queries: 50 - budget.left };
  }

  /** Follows x-export-next the way public/import.js does, checking every page on the way. */
  async function paged(query: string, cookie: string) {
    const pages: string[] = [];
    let after = '0';
    for (;;) {
      const { res, body, queries } = await get(`/export.csv?${query}${query ? '&' : ''}after=${after}`, cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
      expect(queries, `page after ${after}`).toBeLessThanOrEqual(10); // one bounded slice per request: items, tags, reads, reviews, loans, progress, plays, and the session
      const rows = Number(res.headers.get('x-export-rows'));
      expect(rows).toBeLessThanOrEqual(EXPORT_PAGE);
      expect(body.split('\r\n').filter(Boolean).length).toBe(rows + (after === '0' ? 1 : 0)); // the header leads page one only
      pages.push(body);
      const next = res.headers.get('x-export-next');
      if (!next) break;
      after = next;
    }
    return pages;
  }

  it('joins into exactly the file the one-request export streams', async () => {
    const TOTAL = EXPORT_PAGE * 4 + 17; // a short last page
    const lib = await createLibrary(env.DB, 'Everything');
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TOTAL})
       INSERT INTO items (library_id, media_type, title, status, copies, details)
       SELECT ?1, 'book', 'Book ' || i, 'not_started', 1, '{}' FROM n`,
    ).bind(lib.id).run();
    await env.DB.prepare("INSERT INTO tags (name) VALUES ('alpha'), ('beta'), ('gamma')").run();
    await env.DB.prepare('INSERT INTO item_tags (item_id, tag_id) SELECT id, (id % 3) + 1 FROM items').run();
    await env.DB.prepare("INSERT INTO reading_progress (item_id, page, at) SELECT id, 40, '2026-09-01 09:00:00' FROM items WHERE id % 10 = 0").run();
    const cookie = await adminCookie();

    const pages = await paged('', cookie);
    const whole = (await get('/export.csv', cookie)).body;

    expect(pages).toHaveLength(5);
    expect(pages.join('')).toBe(whole);
    expect(whole.trim().split('\r\n')).toHaveLength(TOTAL + 1);
  });

  it('asks once more after a page that came back exactly full, and gets the header alone for an empty catalog', async () => {
    const lib = await createLibrary(env.DB, 'Exact');
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${EXPORT_PAGE})
       INSERT INTO items (library_id, media_type, title, status, copies, details)
       SELECT ?1, 'book', 'Book ' || i, 'not_started', 1, '{}' FROM n`,
    ).bind(lib.id).run();
    const cookie = await adminCookie();

    const pages = await paged('', cookie);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toBe('');
    expect(pages.join('')).toBe((await get('/export.csv', cookie)).body);

    await env.DB.prepare('DELETE FROM items').run();
    expect(await paged('', cookie)).toEqual([(await get('/export.csv', cookie)).body]); // the header row, nothing else
  });

  it('keeps to one shelf across pages when shelves interleave', async () => {
    const [a, b] = [await createLibrary(env.DB, 'A'), await createLibrary(env.DB, 'B')];
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${EXPORT_PAGE * 3})
       INSERT INTO items (library_id, media_type, title, status, copies, details)
       SELECT CASE WHEN i % 2 THEN ?2 ELSE ?1 END, 'book', 'Book ' || i, 'not_started', 1, '{}' FROM n`,
    ).bind(a.id, b.id).run();
    const cookie = await adminCookie();

    const pages = await paged(`library=${a.id}`, cookie);
    const rows = pages.join('').trim().split('\r\n').slice(1);

    expect(pages.length).toBeGreaterThan(1);
    expect(rows).toHaveLength((EXPORT_PAGE * 3) / 2);
    expect(rows.every((r) => r.startsWith('A,'))).toBe(true);
    expect(pages.join('')).toBe((await get(`/export.csv?library=${a.id}`, cookie)).body);
  });

  it('refuses a cursor that is not an item id', async () => {
    const cookie = await adminCookie();
    for (const after of ['-1', 'abc', '1.5', '9999999999999999999']) {
      expect((await get(`/export.csv?after=${after}`, cookie)).res.status, after).toBe(400);
    }
  });
});

describe('an export scoped to one shelf', () => {
  it('carries only that shelf, with its own tags, when shelves interleave', async () => {
    const a = await createLibrary(env.DB, 'A');
    const b = await createLibrary(env.DB, 'B');
    for (let n = 0; n < 6; n++) {
      const item = await createItem(env.DB, { libraryId: n % 2 ? b.id : a.id, title: `Item ${n}`, details: '{}' });
      await setItemTags(env.DB, item.id, [n % 2 ? 'from-b' : 'from-a']);
    }
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const token = await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000));
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test/export.csv?library=${a.id}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), env, ctx);
    const body = await res.text();
    await waitOnExecutionContext(ctx);

    const rows = body.trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.includes('from-a') && !r.includes('from-b'))).toBe(true);
  });
});
