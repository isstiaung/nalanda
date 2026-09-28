// Migration 0023 (ARCH.md §16 #41): the reading so far, as reads. Seeded as rows looked before it — one status,
// two dates, Goodreads' Read Count in details — then migrated, and checked against the same mapping imports use.
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { refreshReadState } from '../src/db/queries';
import { readsFromColumns, summarizeReads, topUpReads } from '../src/lib/reads';

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

type Legacy = { id: number; title: string; status: string; began?: string | null; completed?: string | null; details?: string };

// every shape the old columns can hold, and the Read Count values production's Goodreads import left in details
const LEGACY: Legacy[] = [
  { id: 1, title: 'not started', status: 'not_started' },
  { id: 2, title: 'not started, but finished', status: 'not_started', completed: '2019-06-01' },
  { id: 3, title: 'not started, but begun', status: 'not_started', began: '2019-06-01' },
  { id: 4, title: 'in progress', status: 'in_progress', began: '2026-09-01' },
  { id: 5, title: 'in progress, finished before', status: 'in_progress', began: '2026-09-01', completed: '2020-01-01' },
  { id: 6, title: 'in progress, one read', status: 'in_progress', began: '2019-12-01', completed: '2020-01-01' },
  { id: 7, title: 'completed', status: 'completed', began: '2020-01-01', completed: '2020-02-01' },
  { id: 8, title: 'completed, undated', status: 'completed' },
  { id: 9, title: 'abandoned', status: 'abandoned', began: '2021-01-01', completed: '2021-02-01' },
  { id: 10, title: 'read twice', status: 'completed', completed: '2024-03-10', details: '{"read_count":"2","date_added":"2024/01/02"}' },
  { id: 11, title: 'to-read, read once', status: 'not_started', details: '{"read_count":"1"}' },
  { id: 12, title: 'currently reading, read once', status: 'in_progress', details: '{"read_count":"1"}' },
  { id: 13, title: 'never read', status: 'not_started', details: '{"read_count":"0"}' },
  { id: 14, title: 'count that isn’t one', status: 'completed', completed: '2020-01-01', details: '{"read_count":"abc"}' },
  { id: 15, title: 'absurd count', status: 'completed', details: '{"read_count":"500"}' },
  { id: 16, title: 'broken details', status: 'completed', completed: '2020-01-01', details: 'not json{' },
  { id: 17, title: 'blank dates', status: 'completed', began: '', completed: '  ' },
  { id: 18, title: 'a date that isn’t ISO', status: 'completed', completed: 'last spring' },
  { id: 19, title: 'not started, with pages', status: 'not_started' },
];

/** Resets to just before 0023, seeds the legacy rows, and migrates. */
async function migrateFromLegacy(opts: { view?: boolean } = {}) {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < '0023'));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO libraries (id, name) VALUES (1, 'Shelf')"),
    ...LEGACY.map((l) =>
      env.DB.prepare(
        `INSERT INTO items (id, library_id, title, status, began_on, completed_on, details, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, '2000-01-01 00:00:00')`,
      ).bind(l.id, l.title, l.status, l.began ?? null, l.completed ?? null, l.details ?? '{}'),
    ),
    ...(opts.view
      ? [env.DB.prepare("INSERT INTO connection_views (name) VALUES ('Everything')")]
      : []),
    // pages recorded before reads existed
    env.DB.prepare("INSERT INTO reading_progress (item_id, page, at) VALUES (5, 40, '2026-09-10 10:00:00'), (5, 90, '2026-09-12 10:00:00')"),
    env.DB.prepare("INSERT INTO reading_progress (item_id, page, at) VALUES (7, 200, '2020-01-20 10:00:00')"),
    env.DB.prepare("INSERT INTO reading_progress (item_id, page, at) VALUES (19, 15, '2026-09-01 10:00:00')"),
    env.DB.prepare('UPDATE items SET progress_page = 90 WHERE id = 5'),
    env.DB.prepare('UPDATE items SET progress_page = 200 WHERE id = 7'),
    env.DB.prepare('UPDATE items SET progress_page = 15 WHERE id = 19'),
  ]);
  const before = await rows<Record<string, unknown>>('SELECT * FROM items ORDER BY id');
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const after = await rows<Record<string, unknown>>('SELECT * FROM items ORDER BY id');
  return { before, after };
}

const readsOf = (itemId: number) =>
  rows<{ status: string; beganOn: string | null; endedOn: string | null }>(
    'SELECT status, began_on AS beganOn, ended_on AS endedOn FROM reads WHERE item_id = ?1 ORDER BY id',
    itemId,
  );

describe('migration 0023', () => {
  it('makes the reads imports would make from the same columns and count', async () => {
    await migrateFromLegacy();
    for (const l of LEGACY) {
      const count = /^\d+$/.test((() => {
        try {
          return String(JSON.parse(l.details ?? '{}').read_count ?? '');
        } catch {
          return '';
        }
      })())
        ? Number(JSON.parse(l.details!).read_count)
        : null;
      const expected = topUpReads(readsFromColumns(l.status as never, l.began, l.completed), count);
      // a date that isn't a calendar date is kept as written — reads never reformat what was recorded
      expect(await readsOf(l.id), l.title).toEqual(expected);
    }
  });

  it('changes nothing else about an item, except what a date or a count says', async () => {
    const { before, after } = await migrateFromLegacy();
    const changed: Record<string, Record<string, [unknown, unknown]>> = {};
    for (const [i, b] of before.entries()) {
      const a = after[i]!;
      for (const key of Object.keys(b)) {
        if (key === 'details' || key === 'read_count' || key === 'rereading') continue; // checked below
        if (b[key] !== a[key]) (changed[String(b.title)] ??= {})[key] = [b[key], a[key]];
      }
    }
    expect(changed).toEqual({
      'not started, but finished': { status: ['not_started', 'completed'] },
      'not started, but begun': { status: ['not_started', 'in_progress'] },
      // finished before and being read again: Completed, re-reading, its start date with the open read
      'in progress, finished before': { status: ['in_progress', 'completed'], began_on: ['2026-09-01', null] },
      'in progress, one read': { status: ['in_progress', 'completed'] },
      'to-read, read once': { status: ['not_started', 'completed'] },
      'currently reading, read once': { status: ['in_progress', 'completed'] },
      'blank dates': { began_on: ['', null], completed_on: ['  ', null] },
    });
    // the new columns
    const byTitle = new Map(after.map((a) => [a.title, a]));
    expect(byTitle.get('read twice')).toMatchObject({ read_count: 2, rereading: 0 });
    expect(byTitle.get('in progress, finished before')).toMatchObject({ read_count: 1, rereading: 1, progress_page: 90 });
    expect(byTitle.get('currently reading, read once')).toMatchObject({ read_count: 1, rereading: 1 });
    expect(byTitle.get('absurd count')).toMatchObject({ read_count: 100 });
    expect(byTitle.get('never read')).toMatchObject({ read_count: 0, status: 'not_started' });
    // the updated_at every item was seeded with: the migration isn't an edit
    expect(after.every((a) => a.updated_at === '2000-01-01 00:00:00')).toBe(true);
  });

  it('moves a whole-number read count out of details, and leaves everything else there', async () => {
    const { after } = await migrateFromLegacy();
    const details = new Map(after.map((a) => [a.title, a.details]));
    expect(details.get('read twice')).toBe('{"date_added":"2024/01/02"}');
    expect(details.get('to-read, read once')).toBe('{}');
    expect(details.get('never read')).toBe('{}');
    expect(details.get('count that isn’t one')).toBe('{"read_count":"abc"}');
    expect(details.get('broken details')).toBe('not json{');
  });

  it('puts pages recorded so far in their item’s current read', async () => {
    await migrateFromLegacy();
    const pages = await rows<{ item_id: number; status: string | null }>(
      'SELECT p.item_id, r.status FROM reading_progress p LEFT JOIN reads r ON r.id = p.read_id ORDER BY p.id',
    );
    expect(pages).toEqual([
      { item_id: 5, status: 'in_progress' },
      { item_id: 5, status: 'in_progress' },
      { item_id: 7, status: 'completed' },
      { item_id: 19, status: null }, // no read to belong to: the page keeps its place, as before
    ]);
  });

  it('leaves every item exactly as the app’s own refresh would, and no import marker behind', async () => {
    await migrateFromLegacy();
    const migrated = await rows('SELECT * FROM items ORDER BY id');
    await refreshReadState(env.DB, LEGACY.map((l) => l.id)).run();
    expect(await rows('SELECT * FROM items ORDER BY id')).toEqual(migrated);
    // and the TypeScript twin agrees on each
    for (const l of LEGACY) {
      const item = migrated.find((m) => m.id === l.id)!;
      const reads = await readsOf(l.id);
      if (!reads.length) continue;
      const s = summarizeReads(reads as never);
      expect({ status: item.status, began_on: item.began_on, completed_on: item.completed_on, read_count: item.read_count }, l.title).toEqual({
        status: s.status,
        began_on: s.beganOn,
        completed_on: s.completedOn,
        read_count: s.readCount,
      });
    }
    expect(await rows('SELECT * FROM import_in_progress')).toEqual([]);
    // the search index followed every update
    await env.DB.prepare("INSERT INTO items_fts(items_fts) VALUES('integrity-check')").run();
  });

  it('records nothing as news while a view is shared: an old date is dated then, no date records nothing', async () => {
    await migrateFromLegacy({ view: true });
    const log = await rows<{ title: string; kind: string; at: string }>(
      // progress entries are the seeded pages' own (migration 0015's trigger), from before the migration
      "SELECT i.title, a.kind, a.at FROM activity_log a JOIN items i ON i.id = a.item_id WHERE a.kind <> 'progress' ORDER BY i.title",
    );
    // only the status changes fire the trigger; the undated ones record nothing
    expect(log).toEqual([
      { title: 'in progress, finished before', kind: 'finished', at: '2020-01-01 00:00:00' },
      { title: 'in progress, one read', kind: 'finished', at: '2020-01-01 00:00:00' },
      { title: 'not started, but finished', kind: 'finished', at: '2019-06-01 00:00:00' },
    ]);
  });
});
