// Reading progress: the log, the copy kept on `items`, the side effects of recording a page, and
// the section the item page swaps in. Percentages and the CSV cell are pure functions, tested here too.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  addProgress,
  createItem,
  createLibrary,
  createUser,
  deleteProgress,
  deleteUser,
  getItem,
  listProgress,
  startRead,
  progressForIdRange,
} from '../src/db/queries';
import { EXPORT_COLUMNS, mapLibibRow, progressHistoryCell } from '../src/lib/csv';
import { SESSION_COOKIE } from '../src/lib/auth';
import { sessionTokenFor } from './session-helpers';
import { MAX_PROGRESS_PER_READ, progressPercent } from '../src/lib/progress';
import app from '../src/index';

// The DB layer's own callers here act for the whole household, as an admin would (§16 #43).
const HOUSEHOLD = { id: null, admin: true };

async function seedBook(overrides: Record<string, unknown> = {}) {
  const lib = await createLibrary(env.DB, 'Progress shelf');
  return createItem(env.DB, {
    libraryId: lib.id,
    mediaType: 'book',
    title: 'The Left Hand of Darkness',
    creators: 'Ursula K. Le Guin',
    length: 300,
    details: '{}',
    ...overrides,
  });
}

async function admin() {
  return createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
}

async function post(path: string, userId: number, body: Record<string, string> = {}) {
  const token = await sessionTokenFor(userId);
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'HX-Request': 'true',
        origin: 'http://nalanda.test',
        cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: new URLSearchParams(body).toString(),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('recording progress', () => {
  it('logs the page, copies it onto the item, and starts the book', async () => {
    const book = await seedBook();
    const user = await admin();
    expect(book.status).toBe('not_started');

    await addProgress(env.DB, book.id, 36, user.id);

    const after = await getItem(env.DB, book.id);
    expect(after?.progressPage).toBe(36);
    expect(after?.status).toBe('in_progress'); // recording a page means you've started it
    expect(after?.beganOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const log = await listProgress(env.DB, book.id);
    expect(log.map((e) => e.page)).toEqual([36]);
    expect(log[0]!.addedBy).toBe(user.id);
  });

  it('records nothing on a finished book until it is read again, then records into the re-read (§16 #41)', async () => {
    const book = await seedBook({ status: 'completed', beganOn: '2020-01-01', completedOn: '2020-02-01' });
    expect(await addProgress(env.DB, book.id, 120, null)).toBe(false);

    expect(await getItem(env.DB, book.id)).toMatchObject({ status: 'completed', beganOn: '2020-01-01', progressPage: null, rereading: false });
    expect(await listProgress(env.DB, book.id)).toEqual([]);

    // "Read again" opens a read; the page goes to it, and the book stays Completed, re-reading
    expect(await startRead(env.DB, book.id, '2026-09-01')).toBe(true);
    expect(await addProgress(env.DB, book.id, 120, null)).toBe(true);
    expect(await getItem(env.DB, book.id)).toMatchObject({
      status: 'completed',
      beganOn: '2020-01-01',
      completedOn: '2020-02-01',
      rereading: true,
      progressPage: 120,
    });
  });

  it('keeps the whole log in order, newest page on the item', async () => {
    const book = await seedBook();
    for (const page of [36, 124, 187]) await addProgress(env.DB, book.id, page, null);

    expect((await listProgress(env.DB, book.id)).map((e) => e.page)).toEqual([36, 124, 187]);
    expect((await getItem(env.DB, book.id))?.progressPage).toBe(187);
  });
});

describe('removing an entry', () => {
  it('falls back to the newest remaining page', async () => {
    const book = await seedBook();
    for (const page of [36, 124, 187]) await addProgress(env.DB, book.id, page, null);
    const log = await listProgress(env.DB, book.id);

    await deleteProgress(env.DB, book.id, log.at(-1)!.id, HOUSEHOLD);

    expect((await getItem(env.DB, book.id))?.progressPage).toBe(124);
    expect((await listProgress(env.DB, book.id)).map((e) => e.page)).toEqual([36, 124]);
  });

  it('clears the page when the last entry goes, but not the status', async () => {
    const book = await seedBook();
    await addProgress(env.DB, book.id, 36, null);
    const [only] = await listProgress(env.DB, book.id);

    await deleteProgress(env.DB, book.id, only!.id, HOUSEHOLD);

    const after = await getItem(env.DB, book.id);
    expect(after?.progressPage).toBeNull();
    // a mistyped page is not a claim that the book was never opened
    expect(after?.status).toBe('in_progress');
    expect(after?.beganOn).not.toBeNull();
  });

  it("won't remove an entry belonging to another item", async () => {
    const mine = await seedBook();
    const theirs = await seedBook({ title: 'Another book' });
    await addProgress(env.DB, theirs.id, 50, null);
    const [entry] = await listProgress(env.DB, theirs.id);

    await deleteProgress(env.DB, mine.id, entry!.id, HOUSEHOLD);

    expect((await listProgress(env.DB, theirs.id)).length).toBe(1);
  });
});

describe('POST /items/:id/progress', () => {
  it('records a page and swaps in the section showing it', async () => {
    const book = await seedBook();
    const user = await admin();

    const res = await post(`/items/${book.id}/progress`, user.id, { page: '150' });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('p. 150');
    expect(html).toContain('50%'); // 150 of 300
    expect((await getItem(env.DB, book.id))?.progressPage).toBe(150);
  });

  it('refuses junk without recording anything, and says why', async () => {
    const book = await seedBook();
    const user = await admin();

    for (const page of ['0', '-4', 'twelve', '12.5', '', '100001', '1500000']) {
      const res = await post(`/items/${book.id}/progress`, user.id, { page });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('whole page number');
    }
    expect((await getItem(env.DB, book.id))?.progressPage).toBeNull();
    expect(await listProgress(env.DB, book.id)).toEqual([]);
  });

  it('is books only', async () => {
    const record = await seedBook({ mediaType: 'vinyl', title: 'Kind of Blue', length: null });
    const user = await admin();

    const res = await post(`/items/${record.id}/progress`, user.id, { page: '3' });

    expect(res.status).toBe(400);
    expect(await listProgress(env.DB, record.id)).toEqual([]);
  });

  it('holds at most 1,000 pages on one read, checked where it writes, and says so', async () => {
    const book = await seedBook();
    const user = await admin();
    expect(await addProgress(env.DB, book.id, 1, user.id)).toBe(true);
    const read = (await env.DB.prepare('SELECT id FROM reads WHERE item_id = ?1').bind(book.id).first<{ id: number }>())!.id;
    await env.DB.prepare('INSERT INTO reading_progress (item_id, page, added_by, read_id) SELECT ?1, value + 1, ?2, ?3 FROM json_each(?4)')
      .bind(book.id, user.id, read, JSON.stringify(Array.from({ length: MAX_PROGRESS_PER_READ - 1 }, (_, i) => i + 1)))
      .run();
    expect(await addProgress(env.DB, book.id, 1001, user.id)).toBe(false);
    const res = await post(`/items/${book.id}/progress`, user.id, { page: '1001' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('as many pages recorded as it can hold (1,000)');
    expect(await listProgress(env.DB, book.id)).toHaveLength(MAX_PROGRESS_PER_READ);
    // the cap is the read's: another reader's read of the book takes their page
    const other = await createUser(env.DB, { username: 'ravi', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    expect(await addProgress(env.DB, book.id, 5, other.id)).toBe(true);
  });

  it('removes an entry through its own route', async () => {
    const book = await seedBook();
    const user = await admin();
    await addProgress(env.DB, book.id, 36, user.id);
    await addProgress(env.DB, book.id, 90, user.id);
    const log = await listProgress(env.DB, book.id);

    const res = await post(`/items/${book.id}/progress/${log.at(-1)!.id}/delete`, user.id);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('p. 36');
    expect((await getItem(env.DB, book.id))?.progressPage).toBe(36);
  });
});

describe('percentages', () => {
  it('rounds, and clamps at 100 when the page count is out of date', () => {
    expect(progressPercent(150, 300)).toBe(50);
    expect(progressPercent(1, 300)).toBe(0);
    expect(progressPercent(320, 300)).toBe(100); // a longer edition than the provider knew
  });

  it('is unknowable without both numbers', () => {
    expect(progressPercent(null, 300)).toBeNull();
    expect(progressPercent(150, null)).toBeNull();
    expect(progressPercent(150, 0)).toBeNull();
  });
});

describe('export', () => {
  it('carries the whole log in one cell, oldest first', () => {
    expect(progressHistoryCell([])).toBe('');
    expect(
      progressHistoryCell([
        { page: 36, at: '2026-09-20 08:00:00' },
        { page: 187, at: '2026-09-22 21:30:00' },
      ]),
    ).toBe('36@2026-09-20 08:00:00;187@2026-09-22 21:30:00');
  });

  it('groups history by item for a page of the export', async () => {
    const one = await seedBook();
    const two = await seedBook({ title: 'Second book' });
    await addProgress(env.DB, one.id, 36, null);
    await addProgress(env.DB, one.id, 124, null);
    await addProgress(env.DB, two.id, 12, null);

    const map = await progressForIdRange(env.DB, one.id, two.id);

    expect(map.get(one.id)?.map((e) => e.page)).toEqual([36, 124]);
    expect(map.get(two.id)?.map((e) => e.page)).toEqual([12]);
    expect((await progressForIdRange(env.DB, two.id + 1, two.id + 50)).size).toBe(0);
  });
});

// Found by the adversarial pass on this phase; each test pins the failure it proved.
describe('regressions', () => {
  it('lets a member who recorded progress be deleted, keeping the log unattributed', async () => {
    const book = await seedBook();
    const member = await createUser(env.DB, { username: 'kid', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    await addProgress(env.DB, book.id, 36, member.id);

    await deleteUser(env.DB, member.id); // was: FOREIGN KEY constraint failed

    const [entry] = await listProgress(env.DB, book.id);
    expect(entry?.page).toBe(36);
    expect(entry?.addedBy).toBeNull();
  });

  it('lets a member who both added an item and recorded progress be deleted', async () => {
    // pins the merge of two fixes: each cleared one of the two references to users, and either alone fails here
    const member = await createUser(env.DB, { username: 'both', passwordHash: 'pbkdf2$1$x$y', role: 'member', mustChangePassword: false });
    const book = await seedBook({ addedBy: member.id });
    await addProgress(env.DB, book.id, 36, member.id);

    await deleteUser(env.DB, member.id);

    expect((await getItem(env.DB, book.id))?.addedBy).toBeNull();
    expect((await listProgress(env.DB, book.id))[0]?.addedBy).toBeNull();
  });

  it('never stamps a start date after a finish', async () => {
    // a Goodreads "read" import: finished, no start date recorded
    const book = await seedBook({ status: 'completed', completedOn: '2019-05-01' });
    await addProgress(env.DB, book.id, 120, null);

    const after = await getItem(env.DB, book.id);
    expect(after?.beganOn).toBeNull();
    expect(after?.status).toBe('completed');
  });

  it('leaves updated_at alone — connections see it, and the backfill dates activity by it', async () => {
    const book = await seedBook();
    await env.DB.prepare("UPDATE items SET updated_at = '2000-01-01 00:00:00' WHERE id = ?1").bind(book.id).run();

    await addProgress(env.DB, book.id, 36, null);
    const [entry] = await listProgress(env.DB, book.id);
    await deleteProgress(env.DB, book.id, entry!.id, HOUSEHOLD);
    await deleteProgress(env.DB, book.id, 999_999, HOUSEHOLD); // an entry that isn't there

    expect((await getItem(env.DB, book.id))?.updatedAt).toBe('2000-01-01 00:00:00');
  });

  it("doesn't let a re-imported export put progress into details, where share pages would show it", () => {
    const row = Object.fromEntries(EXPORT_COLUMNS.map((c) => [c, '']));
    Object.assign(row, {
      title: 'The Dispossessed',
      media_type: 'book',
      progress_page: '150',
      progress_history: '150@2026-09-28 03:59:00',
    });
    const mapped = mapLibibRow(row, { defaultType: 'book', musicAsVinyl: true });
    expect(mapped?.item.details ?? '{}').not.toMatch(/progress/);
  });
});
