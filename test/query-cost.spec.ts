// Rows read are what D1's free plan rations — 5 million a day — and D1 counts every row a statement steps through,
// then every row a sort or a grouping passes through again, even under LIMIT 1 (ARCH.md §16 #68). A page that sorts
// the whole catalogue to show a few dozen items reads it twice. These hold the busiest pages to what they read since
// #68, per item in a catalogue of 2,000: each budget sits well below what the page read before (noted beside it), so
// an index lost or a query written back fails here, not on the bill.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary } from '../src/db/queries';
import app from '../src/index';
import { member, type Member } from './member-helpers';

const READ_ONLY = /^\s*(select|with)\b/i;

/**
 * A D1 handle that adds up D1's own `rows_read` for every statement a request runs, background work included. `first()`
 * and `raw()` return no meta, so a read made through them is run again through `all()` for its count: D1 runs the whole
 * statement for `first()` (it adds no LIMIT), so the count is the same.
 */
function counting(d1: D1Database, total: { rows: number }): D1Database {
  const recount = async (sql: string, binds: unknown[]) => {
    if (!READ_ONLY.test(sql)) return;
    // awaited before adding: `total.rows += await …` reads the total first, and a page's concurrent reads would lose counts
    const { meta } = await d1.prepare(sql).bind(...binds).all();
    total.rows += meta.rows_read;
  };
  type Wrapped = { inner: D1PreparedStatement };
  const wrap = (inner: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement =>
    ({
      inner,
      bind: (...values: unknown[]) => wrap(inner.bind(...values), sql, values),
      first: async (...args: unknown[]) => {
        const r = await (inner.first as (...a: unknown[]) => Promise<unknown>)(...args);
        await recount(sql, binds);
        return r;
      },
      raw: async (...args: unknown[]) => {
        const r = await (inner.raw as (...a: unknown[]) => Promise<unknown>)(...args);
        await recount(sql, binds);
        return r;
      },
      all: async () => {
        const r = await inner.all();
        total.rows += r.meta.rows_read;
        return r;
      },
      run: async () => {
        const r = await inner.run();
        total.rows += r.meta.rows_read;
        return r;
      },
    }) as unknown as D1PreparedStatement;
  return {
    prepare: (sql: string) => wrap(d1.prepare(sql), sql, []),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await d1.batch(statements.map((st) => (st as unknown as Wrapped).inner ?? st));
      for (const r of results) total.rows += r.meta.rows_read;
      return results;
    },
    exec: (sql: string) => d1.exec(sql),
    dump: () => d1.dump(),
  } as unknown as D1Database;
}

async function rowsRead(who: Member | null, path: string): Promise<number> {
  const total = { rows: 0 };
  const ctx = createExecutionContext();
  const headers: Record<string, string> = who ? { cookie: who.cookie } : {};
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers }), { ...env, DB: counting(env.DB, total) }, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status, path).toBe(200);
  await res.text();
  return total.rows;
}

const ITEMS = 2000;

/**
 * A household with 2,000 items on one shelf and a second, small one — newest first in id order, as a long-used catalogue
 * is — 300 books finished and 5 being read by asha, a tag on 300 items and another on 5, one want, and a share link of
 * the shelf's owned books.
 */
async function household() {
  const asha = await member('asha', 'admin');
  const shelf = await createLibrary(env.DB, 'Books');
  const small = await createLibrary(env.DB, 'Records');
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ITEMS - 20})
       INSERT INTO items (library_id, media_type, title, creators, copies, length, details, added_at)
       SELECT ?1, 'book', 'Book ' || (i % 700), 'Author ' || (i % 97), i % 2, 100 + i % 400, '{}', datetime('2020-01-01', '+' || i || ' hours') FROM n`,
    ).bind(shelf.id),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
       INSERT INTO items (library_id, media_type, title, details) SELECT ?1, 'vinyl', 'Record ' || i, '{}' FROM n`,
    ).bind(small.id),
    env.DB.prepare(
      `INSERT INTO reads (item_id, reader_id, status, began_on, ended_on)
       SELECT id, ?1, 'completed', date('2024-01-01', '+' || (id % 360) || ' days'), date('2024-01-05', '+' || (id % 360) || ' days')
       FROM items WHERE media_type = 'book' AND id % 6 = 0 LIMIT 300`,
    ).bind(asha.id),
    env.DB.prepare(
      `INSERT INTO reads (item_id, reader_id, status, began_on) SELECT id, ?1, 'in_progress', '2026-09-01'
       FROM items WHERE media_type = 'book' AND id % 6 = 1 LIMIT 5`,
    ).bind(asha.id),
    env.DB.prepare("INSERT INTO tags (name) VALUES ('big'), ('small')"),
    env.DB.prepare("INSERT INTO item_tags (item_id, tag_id) SELECT id, (SELECT id FROM tags WHERE name = 'big') FROM items WHERE id % 6 = 3 LIMIT 300"),
    env.DB.prepare("INSERT INTO item_tags (item_id, tag_id) SELECT id, (SELECT id FROM tags WHERE name = 'small') FROM items WHERE id % 7 = 2 LIMIT 5"),
    env.DB.prepare("INSERT INTO wants (user_id, item_id) SELECT ?1, id FROM items WHERE copies = 0 LIMIT 1").bind(asha.id),
    env.DB.prepare("INSERT INTO shares (token, name, library_id, media_type, owned, sort) VALUES ('0123456789abcdef0123456789abcdef', 'Owned', ?1, 'book', 1, 'added')").bind(shelf.id),
  ]);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM items').first<{ n: number }>())!.n).toBe(ITEMS);
  return { asha, shelf };
}

describe('rows read per page, on 2,000 items', () => {
  it('stays inside each page’s budget', async () => {
    const { asha, shelf } = await household();
    const pages: Array<[string, Member | null, string, number]> = [
      // [page, who, path, rows read per item at most] — beside each, what it read per item before §16 #68 and since,
      // measured on this household
      ['Overview', asha, '/', 6.5], // 11.0 → 5.2
      ['a shelf, newest first', asha, `/libraries/${shelf.id}`, 3], // 8.2 → 2.2
      ['a shelf, by title', asha, `/libraries/${shelf.id}?sort=title`, 3], // 8.2 → 2.3
      ['a shelf in covers, page 10', asha, `/libraries/${shelf.id}?view=grid&page=10`, 3.5], // 8.1 → 2.5
      ['a shelf, being read by me', asha, `/libraries/${shelf.id}?readBy=now-me`, 4], // 7.0 → 3.0
      ['a tag', asha, '/tags/big', 3], // 5.6 → 2.2
      ['wants', asha, '/wants', 1.5], // 3.0 → 1.0
      ['an item’s edit form', asha, '/items/1/edit', 1.5], // 2.0 → 1.0
      ['a shelf’s share page', null, '/share/0123456789abcdef0123456789abcdef', 1.5], // 2.5 → 1.05
    ];
    for (const [name, who, path, perItem] of pages) {
      const read = await rowsRead(who, path);
      expect(read, `${name}: ${read} rows read, ${(read / ITEMS).toFixed(2)} per item`).toBeLessThanOrEqual(ITEMS * perItem);
    }
  });
});
