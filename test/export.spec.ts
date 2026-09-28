// The CSV export streams items 500 at a time and looks up each page's tags in one query. D1 allows
// 100 bound parameters per statement, so a page of 500 ids has to be chunked — unchunked, the tag
// lookup throws inside waitUntil and the download silently ends early.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { activeLoanItemIds, createItem, createLibrary, createUser, setItemTags, tagsForItems } from '../src/db/queries';
import { budgeted } from '../src/federation/budget';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

const COUNT = 230; // more than two chunks' worth, well past the 100-parameter cap

async function seed() {
  const lib = await createLibrary(env.DB, 'Big shelf');
  const ids: number[] = [];
  for (let n = 1; n <= COUNT; n++) {
    const item = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: `Book ${n}`, details: '{}' });
    await setItemTags(env.DB, item.id, [`tag-${n % 7}`]);
    ids.push(item.id);
  }
  return ids;
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
    const token = await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000));
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
    const token = await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000));
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
    const token = await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000));
    // enough for the page and the first page of items, not the second: the stream is cut off partway
    const budget = { left: 5 };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://nalanda.test/export.csv', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
      { ...env, DB: budgeted(env.DB, budget) },
      ctx,
    );

    expect(res.status).toBe(200); // headers were sent before the failure — which is exactly why it must abort
    await expect(res.text()).rejects.toThrow();
    await waitOnExecutionContext(ctx).catch(() => {});
  });
});
