// Each read of a book (ARCH.md §16 #41): reads are the source of truth, and the item columns every page reads
// are derived from them by one statement that rides in the same batch as each write.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import backupScript from '../scripts/backup.mjs?raw';
import { createConnectionView } from '../src/db/federation';
import {
  addPastRead,
  addProgress,
  closeRead,
  createItem,
  createItemWithTags,
  createLibrary,
  deleteItem,
  deleteProgress,
  deleteRead,
  getItem,
  importItems,
  listProgress,
  mergeImportItems,
  readingLog,
  refreshReadState,
  startRead,
  updateItemWithTags,
  updateRead,
} from '../src/db/queries';
import type { Item, ReadStatus } from '../src/db/schema';
import {
  inDisplayOrder,
  ordinal,
  readDateProblem,
  readsFromColumns,
  reconcileGoodreads,
  summarizeReads,
  topUpReads,
  type GoodreadsReading,
  type ReadDraft,
  type ReadRow,
} from '../src/lib/reads';

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

async function book(overrides: Partial<Item> = {}) {
  const shelf = await createLibrary(env.DB, 'Reads shelf');
  return createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'The Dispossessed', length: 387, details: '{}', ...overrides });
}

const readsOf = (itemId: number) =>
  rows<ReadRow>('SELECT id, status, began_on AS beganOn, ended_on AS endedOn FROM reads WHERE item_id = ?1 ORDER BY id', itemId);

/**
 * The item row says what its reads say. Recomputed here from the reads in TypeScript (summarizeReads), so it is
 * checking the SQL refresh against its twin, not against itself.
 */
async function expectCacheMatchesReads(itemId: number) {
  const item = await getItem(env.DB, itemId);
  const state = summarizeReads(await readsOf(itemId));
  expect(
    { status: item?.status, beganOn: item?.beganOn, completedOn: item?.completedOn, readCount: item?.readCount, rereading: item?.rereading },
    `item ${itemId}`,
  ).toEqual(state);
}

const d = (status: ReadStatus, beganOn: string | null = null, endedOn: string | null = null): ReadDraft => ({ status, beganOn, endedOn });

// ---------- the derivation ----------

describe('what reads make of an item', () => {
  const cases: Array<[string, ReadDraft[], Partial<ReturnType<typeof summarizeReads>>]> = [
    ['no reads', [], { status: 'not_started', beganOn: null, completedOn: null, readCount: 0, rereading: false }],
    ['one open read', [d('in_progress', '2026-09-01')], { status: 'in_progress', beganOn: '2026-09-01', completedOn: null, rereading: false }],
    [
      'finished, and being read again: stays Completed, re-reading',
      [d('completed', '2019-03-01', '2019-03-20'), d('in_progress', '2026-09-01')],
      { status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20', readCount: 1, rereading: true },
    ],
    [
      'the re-read finished: completed_on moves to it',
      [d('completed', '2019-03-01', '2019-03-20'), d('completed', '2026-09-01', '2026-09-28')],
      { status: 'completed', beganOn: '2026-09-01', completedOn: '2026-09-28', readCount: 2, rereading: false },
    ],
    [
      'a re-read stopped: still Completed, from the last finish',
      [d('completed', '2019-03-01', '2019-03-20'), d('abandoned', '2026-09-01', '2026-09-10')],
      { status: 'completed', completedOn: '2019-03-20', readCount: 1, rereading: false },
    ],
    ['stopped, never finished', [d('abandoned', '2024-01-01', '2024-02-01')], { status: 'abandoned', completedOn: '2024-02-01', readCount: 0 }],
    [
      'stopped once, trying again: in progress',
      [d('abandoned', '2024-01-01', '2024-02-01'), d('in_progress', '2026-09-01')],
      { status: 'in_progress', beganOn: '2026-09-01', completedOn: null, rereading: false },
    ],
    [
      'a dated finish outranks an undated one, whatever the order',
      [d('completed', null, '2024-02-01'), d('completed')],
      { completedOn: '2024-02-01', readCount: 2 },
    ],
    ['two undated finishes: the newer one', [d('completed', '2001-01-01'), d('completed')], { beganOn: '2001-01-01' }],
  ];

  for (const [label, reads, expected] of cases) {
    it(`${label} — in TypeScript and in SQL alike`, async () => {
      expect(summarizeReads(reads)).toMatchObject(expected);
      const item = await book();
      await env.DB.batch([
        ...reads.map((r) =>
          env.DB.prepare('INSERT INTO reads (item_id, status, began_on, ended_on) VALUES (?1, ?2, ?3, ?4)').bind(item.id, r.status, r.beganOn, r.endedOn),
        ),
        refreshReadState(env.DB, [item.id]),
      ]);
      await expectCacheMatchesReads(item.id);
    });
  }

  it('shows reads oldest first, undated ones first of all, the open read last', () => {
    const reads: ReadRow[] = [
      { id: 1, ...d('in_progress', '2026-09-01') },
      { id: 2, ...d('completed', '2024-01-01', '2024-02-01') },
      { id: 3, ...d('completed') },
      { id: 4, ...d('abandoned', '2019-01-01', '2019-02-01') },
    ];
    expect(inDisplayOrder(reads).map((r) => r.id)).toEqual([3, 4, 2, 1]);
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  });
});

describe('the legacy mapping — one status and two dates as reads', () => {
  it('maps each status, and lets a date speak for a book marked not started', () => {
    expect(readsFromColumns('not_started', null, null)).toEqual([]);
    expect(readsFromColumns('not_started', '', '  ')).toEqual([]);
    expect(readsFromColumns('not_started', null, '2020-01-01')).toEqual([d('completed', null, '2020-01-01')]);
    expect(readsFromColumns('not_started', '2020-01-01', null)).toEqual([d('in_progress', '2020-01-01')]);
    expect(readsFromColumns('completed', '2020-01-01', '2020-02-01')).toEqual([d('completed', '2020-01-01', '2020-02-01')]);
    expect(readsFromColumns('abandoned', null, '2020-02-01')).toEqual([d('abandoned', null, '2020-02-01')]);
    expect(readsFromColumns('in_progress', '2026-09-01', null)).toEqual([d('in_progress', '2026-09-01')]);
  });

  it('reads "in progress with a completion date" as finished before and being read again', () => {
    // the start date goes with the read it precedes
    expect(readsFromColumns('in_progress', '2026-09-01', '2020-01-01')).toEqual([d('completed', null, '2020-01-01'), d('in_progress', '2026-09-01')]);
    expect(readsFromColumns('in_progress', '2019-12-01', '2020-01-01')).toEqual([d('completed', '2019-12-01', '2020-01-01'), d('in_progress')]);
  });

  it('tops a count up with undated finishes, never past 100 reads', () => {
    expect(topUpReads([d('completed', null, '2020-01-01')], 3)).toEqual([d('completed', null, '2020-01-01'), d('completed'), d('completed')]);
    expect(topUpReads([d('completed')], 1)).toHaveLength(1);
    expect(topUpReads([], 0)).toEqual([]);
    expect(topUpReads([], null)).toEqual([]);
    expect(topUpReads([], 1_000_000_000)).toHaveLength(100);
  });

  it('says why dates can’t stand', () => {
    expect(readDateProblem(d('completed', '2020-01-01', '2020-02-01'))).toBeNull();
    expect(readDateProblem(d('completed', '2020-02-30'))).toMatch(/calendar date/);
    expect(readDateProblem(d('completed', '2020-02-01', '2020-01-01'))).toMatch(/end before/);
    expect(readDateProblem(d('in_progress', '2020-02-01', '2020-03-01'))).toMatch(/no end date/);
    expect(readDateProblem(d('completed', '2999-01-01'))).toMatch(/future/);
  });
});

// ---------- every write keeps the item in step ----------

describe('every write path keeps the item columns in step with the reads', () => {
  it('fails on an item whose status was written directly — the check can fail', async () => {
    const item = await book({ status: 'completed', completedOn: '2020-01-01' });
    await expectCacheMatchesReads(item.id);
    await env.DB.prepare("UPDATE items SET status = 'in_progress' WHERE id = ?1").bind(item.id).run();
    await expect(expectCacheMatchesReads(item.id)).rejects.toThrow();
  });

  it('holds through creating, editing, and every read and page action', async () => {
    const shelf = await createLibrary(env.DB, 'Shelf');
    const id = await createItemWithTags(
      env.DB,
      { libraryId: shelf.id, mediaType: 'book', title: 'Kindred', status: 'completed', completedOn: '2020-01-01', details: '{}' },
      [],
    );
    await expectCacheMatchesReads(id);
    expect(await readsOf(id)).toHaveLength(1);

    await updateItemWithTags(env.DB, id, { title: 'Kindred' }, [], { status: 'completed', beganOn: '2019-12-01', completedOn: '2020-01-02' });
    await expectCacheMatchesReads(id);
    expect(await readsOf(id)).toMatchObject([d('completed', '2019-12-01', '2020-01-02')]); // edited, not added

    expect(await startRead(env.DB, id, '2026-09-01')).toBe(true);
    await expectCacheMatchesReads(id);
    expect(await addProgress(env.DB, id, 40, null)).toBe(true);
    await expectCacheMatchesReads(id);
    const [page] = await listProgress(env.DB, id);
    await deleteProgress(env.DB, id, page!.id);
    await expectCacheMatchesReads(id);

    const open = (await readsOf(id)).find((r) => r.status === 'in_progress')!;
    expect(await closeRead(env.DB, id, open.id, 'completed', '2026-09-28')).toBe(true);
    await expectCacheMatchesReads(id);
    expect(await getItem(env.DB, id)).toMatchObject({ status: 'completed', completedOn: '2026-09-28', readCount: 2, rereading: false });

    expect(await addPastRead(env.DB, id, d('completed', '2010-05-01', '2010-06-01'))).toBe(true);
    await expectCacheMatchesReads(id);
    const past = (await readsOf(id)).find((r) => r.beganOn === '2010-05-01')!;
    expect(await updateRead(env.DB, id, past.id, d('abandoned', '2010-05-01', '2010-05-20'))).toBe(true);
    await expectCacheMatchesReads(id);
    await deleteRead(env.DB, id, past.id);
    await expectCacheMatchesReads(id);
    expect(await getItem(env.DB, id)).toMatchObject({ readCount: 2 });
  });

  it('holds through imports and a Goodreads merge', async () => {
    const shelf = await createLibrary(env.DB, 'Shelf');
    await importItems(env.DB, [
      { item: { libraryId: shelf.id, title: 'libib, not begun but finished', status: 'not_started', completedOn: '2021-01-01' }, tags: [] },
      { item: { libraryId: shelf.id, title: 'From a file with reads' }, tags: [], reads: [d('completed', null, '2020-01-01'), d('in_progress', '2026-09-01')] },
    ]);
    await mergeImportItems(env.DB, [
      {
        item: { libraryId: shelf.id, title: 'libib, not begun but finished' },
        tags: [],
        goodreads: { shelf: 'completed', dateRead: '2024-05-01', dateStarted: null, readCount: 3 },
      },
    ]);
    for (const { id } of await rows<{ id: number }>('SELECT id FROM items')) await expectCacheMatchesReads(id);
    const [first, second] = await rows<Item>('SELECT id FROM items ORDER BY id');
    expect(await getItem(env.DB, first!.id)).toMatchObject({ status: 'completed', completedOn: '2024-05-01', readCount: 3 });
    expect(await getItem(env.DB, second!.id)).toMatchObject({ status: 'completed', rereading: true, readCount: 1 });
  });
});

// ---------- reading again ----------

describe('reading a finished book again', () => {
  it('opens one read however often "Read again" is pressed', async () => {
    const item = await book({ status: 'completed', completedOn: '2020-01-01' });
    const results = await Promise.all([startRead(env.DB, item.id, '2026-09-01'), startRead(env.DB, item.id, '2026-09-01')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readsOf(item.id)).filter((r) => r.status === 'in_progress')).toHaveLength(1);
  });

  it('keeps the book Completed while re-reading, and in the same views', async () => {
    const item = await book({ status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20', rating: 8 });
    await startRead(env.DB, item.id, '2026-09-01');
    // status, the dates the edit form shows and the Completed column all still describe the last finish
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20', rereading: true });
  });

  it('stopping a re-read keeps it as a stopped read, and the book goes back to how it was', async () => {
    const item = await book({ status: 'completed', completedOn: '2019-03-20' });
    await startRead(env.DB, item.id, '2026-09-01');
    await addProgress(env.DB, item.id, 80, null);
    const open = (await readsOf(item.id)).find((r) => r.status === 'in_progress')!;
    expect(await closeRead(env.DB, item.id, open.id, 'abandoned', '2026-09-10')).toBe(true);

    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'completed', completedOn: '2019-03-20', readCount: 1, rereading: false });
    expect((await readsOf(item.id)).map((r) => r.status)).toEqual(['completed', 'abandoned']);
    expect(await listProgress(env.DB, item.id)).toHaveLength(1); // its page stays with it
  });

  it('won’t close a read on a date before it began, or one that isn’t open', async () => {
    const item = await book();
    await startRead(env.DB, item.id, '2026-09-10');
    const [open] = await readsOf(item.id);
    expect(await closeRead(env.DB, item.id, open!.id, 'completed', '2026-09-01')).toBe(false);
    expect(await closeRead(env.DB, item.id, open!.id, 'completed', '2026-09-12')).toBe(true);
    expect(await closeRead(env.DB, item.id, open!.id, 'completed', '2026-09-13')).toBe(false); // already closed
    expect(await getItem(env.DB, item.id)).toMatchObject({ completedOn: '2026-09-12' });
  });

  it('won’t reopen a read while another is open', async () => {
    const item = await book({ status: 'completed', completedOn: '2020-01-01' });
    await startRead(env.DB, item.id, '2026-09-01');
    const finished = (await readsOf(item.id)).find((r) => r.status === 'completed')!;
    expect(await updateRead(env.DB, item.id, finished.id, d('in_progress', '2019-12-01'))).toBe(false);
    expect((await readsOf(item.id)).filter((r) => r.status === 'in_progress')).toHaveLength(1);
  });

  it('won’t touch another item’s read', async () => {
    const mine = await book({ status: 'completed', completedOn: '2020-01-01' });
    const other = await book({ status: 'completed', completedOn: '2021-01-01' });
    const [theirs] = await readsOf(other.id);
    expect(await updateRead(env.DB, mine.id, theirs!.id, d('abandoned'))).toBe(false);
    await deleteRead(env.DB, mine.id, theirs!.id);
    expect(await readsOf(other.id)).toHaveLength(1);
  });

  it('lists an item’s reads and pages in one call', async () => {
    const item = await book({ status: 'completed', completedOn: '2020-01-01' });
    await startRead(env.DB, item.id, '2026-09-01');
    await addProgress(env.DB, item.id, 12, null);
    const log = await readingLog(env.DB, item.id);
    expect(log.reads.map((r) => r.status)).toEqual(['completed', 'in_progress']);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.readId).toBe(log.reads[1]!.id);
  });
});

describe('deleting', () => {
  it('deletes a read with shared pages: its pages and their feed entries go first, so no foreign key fails', async () => {
    await createConnectionView(env.DB, { name: 'Shared', libraryId: null, mediaType: null, status: null, owned: null });
    const item = await book();
    await addProgress(env.DB, item.id, 20, null);
    await addProgress(env.DB, item.id, 40, null);
    expect(await rows("SELECT * FROM activity_log WHERE kind = 'progress'")).toHaveLength(2);

    // the negative control: removing the pages alone, with their feed entries still pointing at them, fails
    await expect(env.DB.prepare('DELETE FROM reading_progress WHERE item_id = ?1').bind(item.id).run()).rejects.toThrow(/FOREIGN KEY/);

    const [read] = await readsOf(item.id);
    await deleteRead(env.DB, item.id, read!.id);
    expect(await readsOf(item.id)).toEqual([]);
    expect(await listProgress(env.DB, item.id)).toEqual([]);
    expect(await rows("SELECT * FROM activity_log WHERE kind = 'progress'")).toEqual([]);
    expect(await getItem(env.DB, item.id)).toMatchObject({ status: 'not_started', progressPage: null });
  });

  it('deletes a book with reads, pages and shared activity cleanly', async () => {
    await createConnectionView(env.DB, { name: 'Shared', libraryId: null, mediaType: null, status: null, owned: null });
    const item = await book({ status: 'completed', completedOn: '2020-01-01' });
    await startRead(env.DB, item.id, '2026-09-01');
    await addProgress(env.DB, item.id, 20, null);
    await deleteItem(env.DB, item.id);
    expect(await rows('SELECT * FROM reads')).toEqual([]);
    expect(await rows('SELECT * FROM reading_progress')).toEqual([]);
  });
});

// ---------- Goodreads ----------

describe('a Goodreads row meeting the reads already here', () => {
  const g = (over: Partial<GoodreadsReading>): GoodreadsReading => ({ shelf: 'completed', dateRead: null, dateStarted: null, readCount: null, ...over });
  const apply = (existing: ReadRow[], reading: GoodreadsReading): ReadRow[] => {
    const out = existing.map((r) => ({ ...r }));
    for (const op of reconcileGoodreads(out, reading)) {
      if (op.op === 'insert') out.push({ id: 1000 + out.length, ...op.read });
      else Object.assign(out.find((r) => r.id === op.id)!, op.read);
    }
    return out;
  };
  const row = (id: number, read: ReadDraft): ReadRow => ({ id, ...read });

  const scenarios: Array<[string, ReadRow[], GoodreadsReading, ReadDraft[]]> = [
    ['a new finished book', [], g({ dateRead: '2024-03-10', dateStarted: '2024-03-01' }), [d('completed', '2024-03-01', '2024-03-10')]],
    ['a new book read twice', [], g({ dateRead: '2024-03-10', readCount: 2 }), [d('completed', null, '2024-03-10'), d('completed')]],
    ['currently reading, finished once before', [], g({ shelf: 'in_progress', dateRead: '2020-01-01', readCount: 1 }), [d('completed', null, '2020-01-01'), d('in_progress')]],
    ['to-read, but counted as read once', [], g({ shelf: 'not_started', readCount: 1 }), [d('completed')]],
    ['to-read with nothing', [], g({ shelf: 'not_started', readCount: 0 }), []],
    ['a DNF', [], g({ shelf: 'abandoned', dateRead: '2024-01-01' }), [d('abandoned', null, '2024-01-01')]],
    [
      'finished over there while open here: the open read closes',
      [row(1, d('in_progress', '2024-03-01'))],
      g({ dateRead: '2024-03-10' }),
      [d('completed', '2024-03-01', '2024-03-10')],
    ],
    [
      'an undated finish here takes the date',
      [row(1, d('completed'))],
      g({ dateRead: '2024-03-10' }),
      [d('completed', null, '2024-03-10')],
    ],
    [
      'to-read over there never removes a read made here',
      [row(1, d('completed', null, '2020-01-01')), row(2, d('in_progress', '2026-09-01'))],
      g({ shelf: 'not_started', readCount: 0 }),
      [d('completed', null, '2020-01-01'), d('in_progress', '2026-09-01')],
    ],
    [
      'currently reading: the previous finish doesn’t close the open read',
      [row(1, d('in_progress', '2026-09-01'))],
      g({ shelf: 'in_progress', dateRead: '2020-01-01' }),
      [d('in_progress', '2026-09-01'), d('completed', null, '2020-01-01')],
    ],
  ];

  for (const [label, existing, reading, expected] of scenarios) {
    it(`${label} — and a second run adds nothing`, () => {
      const once = apply(existing, reading);
      expect(once.map(({ status, beganOn, endedOn }) => ({ status, beganOn, endedOn }))).toEqual(expected);
      expect(reconcileGoodreads(once, reading)).toEqual([]);
    });
  }

  it('importing the same Goodreads rows twice leaves the reads exactly as the first run did', async () => {
    const shelf = await createLibrary(env.DB, 'Shelf');
    await createItem(env.DB, { libraryId: shelf.id, title: 'Here first', creators: 'Octavia Butler', isbn13: '9780807083697' });
    const file = [
      { item: { libraryId: shelf.id, title: 'Here first', creators: 'Octavia Butler', isbn13: '9780807083697' }, tags: [], goodreads: g({ dateRead: '2024-03-10', readCount: 2 }) },
      { item: { libraryId: shelf.id, title: 'New here', isbn13: '9780000000002' }, tags: [], goodreads: g({ shelf: 'in_progress', dateRead: '2020-01-01', readCount: 1 }) },
    ];
    // a new book's reads come from the same rules, starting from none
    file[1]!.item = { ...file[1]!.item, ...summarizeReads(apply([], file[1]!.goodreads)) };
    const withReads = file.map((f) => ({ ...f, reads: apply([], f.goodreads) }));

    const first = await mergeImportItems(env.DB, withReads);
    const snapshot = await rows('SELECT item_id, status, began_on, ended_on FROM reads ORDER BY id');
    const second = await mergeImportItems(env.DB, withReads);

    expect(first).toMatchObject({ merged: 1, inserted: 1 });
    expect(second).toEqual({ merged: 2, inserted: 0, reads: 0 });
    expect(await rows('SELECT item_id, status, began_on, ended_on FROM reads ORDER BY id')).toEqual(snapshot);
    expect(snapshot).toHaveLength(4);
  });
});

describe('two rows for the same book in one Goodreads file', () => {
  it('lets the second date a read the first one added, rather than lose the date', async () => {
    const shelf = await createLibrary(env.DB, 'Shelf');
    const item = await createItem(env.DB, { libraryId: shelf.id, title: 'The Hobbit', creators: 'J. R. R. Tolkien' });
    // two editions shelved on Goodreads, both matching this one item by title and author
    const row = (goodreads: GoodreadsReading) => ({ item: { libraryId: shelf.id, title: 'The Hobbit', creators: 'J.R.R. Tolkien' }, tags: [], goodreads });
    const result = await mergeImportItems(env.DB, [
      row({ shelf: 'completed', dateRead: null, dateStarted: null, readCount: 1 }),
      row({ shelf: 'completed', dateRead: '2021-07-01', dateStarted: null, readCount: 1 }),
    ]);
    expect(await readsOf(item.id)).toMatchObject([d('completed', null, '2021-07-01')]);
    expect(result).toMatchObject({ merged: 2, reads: 1 });
    await expectCacheMatchesReads(item.id);
  });
});

// ---------- backups ----------

describe('backups', () => {
  it('export every table that holds data, in an order that restores', async () => {
    const listed = [...backupScript.slice(backupScript.indexOf('export const TABLES'), backupScript.indexOf('];')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const transient = ['login_attempts', 'federation_seen', 'connection_push_counts', 'import_in_progress', 'd1_migrations'];
    const tables = (await rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'"))
      .map((t) => t.name)
      .filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_') && !n.startsWith('items_fts') && !transient.includes(n));
    expect([...listed].sort()).toEqual([...tables].sort());
    // reading_progress references reads, which references items
    expect(listed.indexOf('items')).toBeLessThan(listed.indexOf('reads'));
    expect(listed.indexOf('reads')).toBeLessThan(listed.indexOf('reading_progress'));
  });
});
