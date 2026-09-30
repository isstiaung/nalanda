// Each member's reading and reviews through everything that moves data (ARCH.md §16 #43): the export and its
// re-import, Goodreads, removing a member, the upgrade's migration — and a household of one, which must see nothing new.
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  addPastRead,
  addProgress,
  createLibrary,
  deleteUser,
  mergeImportItems,
  refreshReadState,
  refreshReviewState,
  startRead,
} from '../src/db/queries';
import { mapLibibRow, mapNalandaRow } from '../src/lib/csv';
import { displayOrderSql, formatReadsCell, parseReadsCell } from '../src/lib/reads';
import { parseReviewsCell } from '../src/lib/reviews';
import { as, book, html, member, readsOf, reviewsOf, rows, summaryOf } from './member-helpers';

/** RFC 4180, as public/import.js parses it in the browser. */
function parseCsv(text: string): Record<string, string>[] {
  const out: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) out.push([...row, field]);
  const [header, ...body] = out;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
}

/**
 * Everything per-member about an item, with people as names, so two items compare across instances. Reads in the
 * order the page and the export show them — a re-import inserts them in that order, so its ids follow it.
 */
async function people(itemId: number) {
  const names = new Map((await rows<{ id: number; username: string }>('SELECT id, username FROM users')).map((u) => [u.id, u.username]));
  const who = (id: number | null) => (id === null ? null : (names.get(id) ?? '?'));
  const reads = await rows<{ readerId: number | null; status: string; beganOn: string | null; endedOn: string | null }>(
    `SELECT reader_id AS readerId, status, began_on AS beganOn, ended_on AS endedOn FROM reads r WHERE item_id = ?1 ORDER BY ${displayOrderSql('r')}`,
    itemId,
  );
  return {
    reads: reads.map((r) => ({ reader: who(r.readerId), status: r.status, beganOn: r.beganOn, endedOn: r.endedOn })),
    reviews: (
      await rows<{ userId: number | null; rating: number | null; review: string | null; reviewedAt: string | null; ratedAt: string | null }>(
        'SELECT user_id AS userId, rating, review, reviewed_at AS reviewedAt, rated_at AS ratedAt FROM reviews WHERE item_id = ?1 ORDER BY id',
        itemId,
      )
    ).map((r) => ({ by: who(r.userId), rating: r.rating, review: r.review, reviewedAt: r.reviewedAt, ratedAt: r.ratedAt })),
    summary: await summaryOf(itemId),
  };
}

// ---------- export and import ----------

describe('the export and a re-import', () => {
  it('carry every reader and every review, a former member’s included', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const gone = await member('gone');
    const item = await book(asha, { title: 'Piranesi', status: 'completed', beganOn: '2021-01-01', completedOn: '2021-02-01', rating: 9, review: 'Hers, "quoted", with a comma' });
    await addPastRead(env.DB, item.id, { status: 'completed', beganOn: null, endedOn: '2023-03-03' }, ravi.id);
    await startRead(env.DB, item.id, '2026-09-01', ravi.id);
    await addPastRead(env.DB, item.id, { status: 'abandoned', beganOn: '2022-01-01', endedOn: '2022-01-09' }, gone.id);
    for (const [who, rating, review, at, ratedAt] of [
      [ravi, 4, 'His,\nover two lines', '2024-01-01 09:00:00', '2023-12-31 08:00:00'],
      [gone, 7, null, null, '2022-01-10 00:00:00'],
    ] as const) {
      await env.DB.prepare('INSERT INTO reviews (item_id, user_id, rating, review, reviewed_at, rated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(item.id, who.id, rating, review, at, ratedAt)
        .run();
    }
    await env.DB.prepare("UPDATE reviews SET reviewed_at = '2021-02-02 00:00:00', rated_at = '2021-02-01 00:00:00' WHERE user_id = ?1").bind(asha.id).run();
    await env.DB.batch([refreshReviewState(env.DB, [item.id])]);
    await deleteUser(env.DB, gone.id);
    const before = await people(item.id);
    expect(before.summary).toMatchObject({ rating: 7, review: 'His,\nover two lines', readCount: 2, rereading: 1 });

    const [row] = parseCsv(await (await as(asha, '/export.csv')).text());
    expect(row!.reads).toBe('completed:2021-01-01..2021-02-01@asha;abandoned:2022-01-01..2022-01-09@;completed:..2023-03-03@ravi;in_progress:2026-09-01..@ravi');
    expect(JSON.parse(row!.reviews!)).toEqual([
      { by: 'asha', rating: 9, review: 'Hers, "quoted", with a comma', at: '2021-02-02 00:00:00', ratedAt: '2021-02-01 00:00:00' },
      { by: 'ravi', rating: 4, review: 'His,\nover two lines', at: '2024-01-01 09:00:00', ratedAt: '2023-12-31 08:00:00' },
      { by: null, rating: 7, review: null, at: null, ratedAt: '2022-01-10 00:00:00' },
    ]);
    expect(row).toMatchObject({ rating: '7', review: 'His,\nover two lines' }); // the household summary, as before

    const target = await createLibrary(env.DB, 'Restored');
    const preview = await (await as(asha, '/api/import', { json: { libraryId: target.id, rows: [row], dryRun: true } })).json<{
      people: Array<{ name: string | null; former: boolean; reads: number; reviews: number; as: string | null; known: boolean }>;
    }>();
    expect(preview.people).toEqual(
      expect.arrayContaining([
        { name: 'asha', former: false, reads: 1, reviews: 1, as: 'asha', known: true },
        { name: 'ravi', former: false, reads: 2, reviews: 1, as: 'ravi', known: true },
        { name: null, former: true, reads: 1, reviews: 1, as: null, known: false },
      ]),
    );
    expect((await as(asha, '/api/import', { json: { libraryId: target.id, rows: [row] } })).status).toBe(200);
    const copy = (await rows<{ id: number }>('SELECT id FROM items WHERE library_id = ?1', target.id))[0]!.id;
    expect(await people(copy)).toEqual(before);
  });

  it('give names that aren’t members here to the importer, and say so in the preview', async () => {
    const asha = await member('asha', 'admin');
    const admin = await member('root', 'admin'); // an admin's import keeps the names it knows
    const shelf = await createLibrary(env.DB, 'In');
    const base = { library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '', completed_on: '' };
    const row = {
      ...base,
      title: 'Kindred',
      reads: 'completed:..2020-01-01@carol;in_progress:2026-09-01..@carol;in_progress:2026-09-02..@dan;completed:..2019-01-01@asha',
      reviews: JSON.stringify([
        { by: 'carol', rating: 6, review: 'Carol’s', at: '2020-01-02 00:00:00' },
        { by: 'dan', rating: 2, review: 'Dan’s', at: '2021-01-02 00:00:00' },
      ]),
    };
    const preview = await (await as(admin, '/api/import', { json: { libraryId: shelf.id, rows: [row], dryRun: true } })).json<{ importer: string; keepsNames: boolean; people: unknown[] }>();
    expect(preview).toMatchObject({ importer: 'root', keepsNames: true });
    expect(preview.people).toEqual(
      expect.arrayContaining([
        { name: 'carol', former: false, reads: 2, reviews: 1, as: 'root', known: false },
        { name: 'asha', former: false, reads: 1, reviews: 0, as: 'asha', known: true },
      ]),
    );
    expect((await as(admin, '/api/import', { json: { libraryId: shelf.id, rows: [row] } })).status).toBe(200);
    const id = (await rows<{ id: number }>('SELECT id FROM items'))[0]!.id;
    // carol's and dan's both land on the importer: one open read each person, one review each — the one written last
    expect((await readsOf(id)).map((r) => [r.readerId, r.status])).toEqual([
      [admin.id, 'completed'],
      [admin.id, 'in_progress'],
      [asha.id, 'completed'],
    ]);
    expect((await reviewsOf(id)).map((r) => [r.userId, r.review])).toEqual([[admin.id, 'Dan’s']]);
  });

  it('keep names only in an admin’s import: a member’s is all theirs, whatever the file says', async () => {
    await member('asha', 'admin'); // a member the file names
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'In');
    const row = {
      library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '', completed_on: '',
      title: 'Planted',
      reads: 'completed:..2024-01-01@asha;abandoned:..2024-02-01@',
      reviews: JSON.stringify([{ by: 'asha', rating: 1, review: 'Asha says: awful', at: '2024-01-02 00:00:00' }, { by: null, rating: 3, review: null, at: null }]),
    };
    const preview = await (await as(ravi, '/api/import', { json: { libraryId: shelf.id, rows: [row], dryRun: true } })).json<{ keepsNames: boolean; people: Array<{ name: string | null; as: string | null }> }>();
    expect(preview.keepsNames).toBe(false);
    expect(preview.people.map((p) => p.as)).toEqual(['ravi', 'ravi']);
    await as(ravi, '/api/import', { json: { libraryId: shelf.id, rows: [row] } });
    const id = (await rows<{ id: number }>('SELECT id FROM items'))[0]!.id;
    expect((await readsOf(id)).map((r) => r.readerId)).toEqual([ravi.id, ravi.id]);
    // his one review: the one written last of the two that landed on him
    expect((await reviewsOf(id)).map((r) => [r.userId, r.review])).toEqual([[ravi.id, 'Asha says: awful']]);
  });

  it('keep the preview as it was for a household of one importing its own file', async () => {
    const solo = await member('solo', 'admin');
    const shelf = await createLibrary(env.DB, 'In');
    const row = { library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '', completed_on: '', title: 'Mine', reads: 'completed:..2024-01-01@solo' };
    const preview = await (await as(solo, '/api/import', { json: { libraryId: shelf.id, rows: [row], dryRun: true } })).json<Record<string, unknown>>();
    expect(preview).not.toHaveProperty('importer');
    // negative control: a name that isn't the importer's is reported
    const other = await (await as(solo, '/api/import', { json: { libraryId: shelf.id, rows: [{ ...row, reads: 'completed:..2024-01-01@carol' }], dryRun: true } })).json<Record<string, unknown>>();
    expect(other).toHaveProperty('importer', 'solo');
  });

  it('round-trip every former member’s open read, and more than 100 reads of a book across readers', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const one = await member('gone-one');
    const two = await member('gone-two');
    const item = await book(null, { title: 'Well loved' });
    await startRead(env.DB, item.id, '2026-01-01', one.id);
    await startRead(env.DB, item.id, '2026-02-01', two.id);
    for (const who of [asha, ravi]) {
      for (let i = 0; i < 60; i++) await addPastRead(env.DB, item.id, { status: 'completed', beganOn: null, endedOn: null }, who.id);
    }
    await deleteUser(env.DB, one.id);
    await deleteUser(env.DB, two.id);
    const before = await people(item.id);
    expect(before.summary).toMatchObject({ readCount: 120 });

    const [row] = parseCsv(await (await as(asha, '/export.csv')).text());
    const target = await createLibrary(env.DB, 'Restored');
    await as(asha, '/api/import', { json: { libraryId: target.id, rows: [row] } });
    const copy = (await rows<{ id: number }>('SELECT id FROM items WHERE library_id = ?1', target.id))[0]!.id;
    expect(await people(copy)).toEqual(before);
  });

  it('give a review with no "by" to the importer, as a read with no "@" — only an explicit null or empty one is a former member’s', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'In');
    const row = {
      library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '', completed_on: '',
      title: 'Hand-made',
      reviews: JSON.stringify([
        { rating: 7, review: 'no by' },
        { by: null, rating: 3, review: 'null by' },
        { by: '', rating: 5, review: 'empty by' },
      ]),
    };
    await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: [row] } });
    const id = (await rows<{ id: number }>('SELECT id FROM items'))[0]!.id;
    expect((await reviewsOf(id)).map((r) => [r.review, r.userId])).toEqual([
      ['no by', asha.id],
      ['null by', null],
      ['empty by', null],
    ]);
  });

  it('import a reviews cell from before rating times, dating each rating by its review, else by the import', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'In');
    const row = {
      library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '', completed_on: '',
      title: 'Older file',
      reviews: JSON.stringify([
        { by: 'asha', rating: 6, review: 'Written in 2020', at: '2020-03-03 03:03:03' },
        { by: null, rating: 4, review: null, at: null },
      ]),
    };
    await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: [row] } });
    const got = await rows<{ ratedAt: string | null }>('SELECT rated_at AS ratedAt FROM reviews ORDER BY id');
    expect(got[0]!.ratedAt).toBe('2020-03-03 03:03:03');
    expect(got[1]!.ratedAt?.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });

  it('still import an export from before readers and reviews, as the importer’s', async () => {
    await member('asha', 'admin');
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Old');
    const row = {
      library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '2020-01-01',
      completed_on: '2020-02-01', status: 'completed', title: 'Beloved', rating: '8', review: 'From 1.2', reads: 'completed:2020-01-01..2020-02-01',
    };
    await as(ravi, '/api/import', { json: { libraryId: shelf.id, rows: [row] } });
    const id = (await rows<{ id: number }>('SELECT id FROM items'))[0]!.id;
    expect(await readsOf(id)).toMatchObject([{ readerId: ravi.id, status: 'completed', endedOn: '2020-02-01' }]);
    expect(await reviewsOf(id)).toMatchObject([{ userId: ravi.id, rating: 8, review: 'From 1.2' }]);
  });

  it('never let a reviews or reads column fall into public details, whatever the file is taken for', () => {
    const libib = mapLibibRow(
      { title: 'A Nalanda export missing a column', reads: 'completed:..2020-01-01@asha', reviews: '[{"by":"asha","rating":8,"review":"x","at":null}]' },
      { defaultType: 'book', musicAsVinyl: true },
    )!;
    expect(JSON.parse(libib.item.details as string)).toEqual({});
  });

  it('read cells leniently: names encoded both ways, an unreadable reviews cell falls back to the columns', () => {
    const reads = [
      { status: 'completed' as const, beganOn: null, endedOn: '2020-01-01', reader: 'a;b@c:d..e' },
      { status: 'in_progress' as const, beganOn: '2026-09-01', endedOn: null, reader: null },
    ];
    expect(parseReadsCell(formatReadsCell(reads))).toEqual(reads);
    expect(parseReadsCell('in_progress:..@x;in_progress:..@x;in_progress:..@y')).toHaveLength(2); // one open read each
    expect(parseReviewsCell('not json')).toBeNull();
    expect(parseReviewsCell('[{"by":"x","rating":0,"review":"  "}]')).toEqual([]); // nothing in it to keep
    const row = mapNalandaRow({ title: 'T', media_type: 'book', isbn10_upc: '', began_on: '', completed_on: '', added_at: '', details: '', rating: '6', review: 'Kept', reviews: '{oops' })!;
    expect(row.reviews).toBeUndefined();
    expect(row.item).toMatchObject({ rating: 6, review: 'Kept' });
  });
});

// ---------- Goodreads ----------

describe('a Goodreads import is its importer’s', () => {
  it('adds the importer’s reads and review to a book someone else has read, touching none of theirs', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const item = await book(asha, { title: 'Kindred', creators: 'Octavia E. Butler', status: 'completed', completedOn: '2019-05-01', rating: 8, review: 'Hers' });
    const row = (by: number) => ({
      item: { libraryId: item.libraryId, title: 'Kindred', creators: 'Octavia E. Butler', rating: 4, review: 'His', addedBy: by },
      tags: [],
      goodreads: { shelf: 'completed' as const, dateRead: '2018-02-01', dateStarted: null, readCount: 2 },
    });
    expect(await mergeImportItems(env.DB, [row(ravi.id)])).toMatchObject({ merged: 1 });
    const reads = await readsOf(item.id);
    expect(reads.filter((r) => r.readerId === asha.id)).toMatchObject([{ status: 'completed', endedOn: '2019-05-01' }]);
    expect(reads.filter((r) => r.readerId === ravi.id).map((r) => [r.status, r.endedOn])).toEqual([
      ['completed', '2018-02-01'],
      ['completed', null],
    ]);
    expect((await reviewsOf(item.id)).map((r) => [r.userId, r.rating, r.review])).toEqual([
      [asha.id, 8, 'Hers'],
      [ravi.id, 4, 'His'],
    ]);
    expect(await summaryOf(item.id)).toMatchObject({ readCount: 3, completedOn: '2019-05-01', rating: 6 });

    // the same file again adds nothing, and leaves the book's updated time alone
    await env.DB.prepare("UPDATE items SET updated_at = '2000-01-01 00:00:00'").run();
    expect(await mergeImportItems(env.DB, [row(ravi.id)])).toMatchObject({ reads: 0 });
    expect(await readsOf(item.id)).toEqual(reads);
    expect((await rows<{ updated_at: string }>('SELECT updated_at FROM items'))[0]!.updated_at).toBe('2000-01-01 00:00:00');

    // her own Goodreads file is reconciled with her reads alone: his finish on 2018-02-01 isn't hers, so she gets one
    await mergeImportItems(env.DB, [{ ...row(asha.id), item: { ...row(asha.id).item, rating: null, review: null } }]);
    expect((await readsOf(item.id)).filter((r) => r.readerId === asha.id).map((r) => r.endedOn)).toEqual(['2019-05-01', '2018-02-01']);
    expect((await reviewsOf(item.id)).find((r) => r.userId === asha.id)).toMatchObject({ rating: 8, review: 'Hers' }); // never blanked
  });

  it('counts, in its preview, only the importer’s reads as there already', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const item = await book(asha, { title: 'Kindred', creators: 'Octavia E. Butler', status: 'completed', completedOn: '2018-02-01' });
    const preview = await mergeImportItems(
      env.DB,
      [{ item: { libraryId: item.libraryId, title: 'Kindred', creators: 'Octavia E. Butler', addedBy: ravi.id }, tags: [], goodreads: { shelf: 'completed', dateRead: '2018-02-01', dateStarted: null, readCount: null } }],
      true,
    );
    expect(preview.reads).toBe(1); // her finish on that date isn't his
    expect(await readsOf(item.id)).toHaveLength(1); // a dry run writes nothing
  });
});

// ---------- removing a member ----------

describe('removing a member', () => {
  it('keeps their reads, pages and review, unattributed, and the book as the household sees it', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const item = await book(ravi, { status: 'completed', completedOn: '2020-01-01', rating: 6, review: 'His' });
    await startRead(env.DB, item.id, '2026-09-01', ravi.id);
    await addProgress(env.DB, item.id, 25, ravi.id);
    const before = await summaryOf(item.id);

    expect((await as(asha, `/settings/users/${ravi.id}/delete`, { body: {} })).status).toBe(302);
    expect(await rows('SELECT * FROM users WHERE id = ?1', ravi.id)).toEqual([]);
    expect((await readsOf(item.id)).map((r) => r.readerId)).toEqual([null, null]);
    expect(await rows('SELECT added_by FROM reading_progress')).toEqual([{ added_by: null }]);
    expect(await reviewsOf(item.id)).toMatchObject([{ userId: null, rating: 6, review: 'His' }]);
    expect(await summaryOf(item.id)).toEqual(before);

    const page = await html(asha, `/items/${item.id}`);
    expect(page).toContain('<p class="reader-name">Former member</p>');
    expect(page).toContain('<span class="reviewer">Former member</span>');
    // an admin can give them to someone still here
    const read = (await readsOf(item.id))[0]!.id;
    await as(asha, `/items/${item.id}/reads/${read}/move`, { body: { to: String(asha.id) }, htmx: true });
    expect((await readsOf(item.id))[0]!.readerId).toBe(asha.id);
  });
});

// ---------- the upgrade ----------

describe('migration 0025', () => {
  async function upgrade(users: Array<[number, string, 'admin' | 'member']>) {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < '0024'));
    await env.DB.batch([
      ...users.map(([id, name, role]) =>
        env.DB.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?1, ?2, 'x', ?3)").bind(id, name, role),
      ),
      env.DB.prepare("INSERT INTO libraries (id, name) VALUES (1, 'Shelf')"),
      env.DB.prepare(
        `INSERT INTO items (id, library_id, title, status, began_on, completed_on, rating, review, read_count, rereading, updated_at) VALUES
         (1, 1, 'Rated and reviewed', 'completed', '2020-01-01', '2020-02-01', 8, 'Loved it', 1, 0, '2024-05-05 05:05:05'),
         (2, 1, 'Rated only', 'completed', NULL, '2021-01-01', 4, NULL, 1, 0, '2024-06-06 06:06:06'),
         (3, 1, 'Reviewed only', 'abandoned', NULL, '2022-01-01', NULL, 'Gave up', 0, 0, '2024-07-07 07:07:07'),
         (4, 1, 'Re-reading', 'completed', '2019-01-01', '2019-02-01', NULL, NULL, 1, 1, '2024-08-08 08:08:08'),
         (5, 1, 'Untouched', 'not_started', NULL, NULL, NULL, NULL, 0, 0, '2024-09-09 09:09:09')`,
      ),
      env.DB.prepare(
        `INSERT INTO reads (id, item_id, status, began_on, ended_on) VALUES
         (1, 1, 'completed', '2020-01-01', '2020-02-01'), (2, 2, 'completed', NULL, '2021-01-01'), (3, 3, 'abandoned', NULL, '2022-01-01'),
         (4, 4, 'completed', '2019-01-01', '2019-02-01'), (5, 4, 'in_progress', '2026-09-01', NULL)`,
      ),
      // a page recorded by a member, before anyone said whose reads were whose
      env.DB.prepare("INSERT INTO reading_progress (item_id, page, at, added_by, read_id) VALUES (4, 40, '2026-09-02 10:00:00', ?1, 5)").bind(users[0]![0]),
      env.DB.prepare('UPDATE items SET progress_page = 40 WHERE id = 4'),
    ]);
    const before = await rows('SELECT * FROM items ORDER BY id');
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    return before;
  }

  it('credits every read, page and review to the first admin, and leaves every item as it was', async () => {
    // a member with the lowest id, and two admins: the first admin is the lowest-id admin, not the first user
    const before = await upgrade([
      [2, 'member-first', 'member'],
      [5, 'second-admin', 'admin'],
      [3, 'first-admin', 'admin'],
    ]);
    expect(await rows('SELECT DISTINCT reader_id FROM reads')).toEqual([{ reader_id: 3 }]);
    expect(await rows('SELECT added_by FROM reading_progress')).toEqual([{ added_by: 3 }]);
    expect(await rows('SELECT item_id, user_id, rating, review, reviewed_at, rated_at, created_at FROM reviews ORDER BY item_id')).toEqual([
      { item_id: 1, user_id: 3, rating: 8, review: 'Loved it', reviewed_at: '2024-05-05 05:05:05', rated_at: '2024-05-05 05:05:05', created_at: '2024-05-05 05:05:05' },
      { item_id: 2, user_id: 3, rating: 4, review: null, reviewed_at: null, rated_at: '2024-06-06 06:06:06', created_at: '2024-06-06 06:06:06' },
      { item_id: 3, user_id: 3, rating: null, review: 'Gave up', reviewed_at: '2024-07-07 07:07:07', rated_at: null, created_at: '2024-07-07 07:07:07' },
    ]);
    // every column the items had before, unchanged; one a later migration adds (location's, series') isn't 0025's concern
    const had = Object.keys(before[0]!);
    const items = async () => (await rows('SELECT * FROM items ORDER BY id')).map((r) => Object.fromEntries(had.map((k) => [k, r[k]])));
    expect(await items()).toEqual(before);

    // and the summaries, recomputed from the new rows, say what the items already said
    await env.DB.batch([refreshReadState(env.DB, [1, 2, 3, 4, 5]), refreshReviewState(env.DB, [1, 2, 3, 4, 5])]);
    expect(await items()).toEqual(before);
  });

  it('leaves everything unattributed on an instance with no admin', async () => {
    await upgrade([[1, 'only-member', 'member']]);
    expect(await rows('SELECT DISTINCT reader_id FROM reads')).toEqual([{ reader_id: null }]);
    expect(await rows('SELECT added_by FROM reading_progress')).toEqual([{ added_by: 1 }]); // not overwritten with nobody
    expect(await rows('SELECT DISTINCT user_id FROM reviews')).toEqual([{ user_id: null }]);
  });
});

// ---------- a household of one ----------

describe('a household of one', () => {
  it('sees the book page, the edit form and the shelf as before: no names, no "yours", no Read by', async () => {
    const solo = await member('solo', 'admin');
    const item = await book(solo, { status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20', rating: 8, review: 'Mine alone' });
    await startRead(env.DB, item.id, '2026-09-01', solo.id);
    await addProgress(env.DB, item.id, 12, solo.id);

    const page = await html(solo, `/items/${item.id}`);
    for (const absent of ['reader-name', 'You <span', 'Former member', 'Ratings and reviews', '/move', 'average of']) expect(page).not.toContain(absent);
    expect(page).toContain('<p class="eyebrow">Review</p>');
    expect(page).toContain('Mine alone');
    expect(page).toContain('<p class="eyebrow read-history-head">Reads</p>');
    expect(page).toContain('Re-reading, since 2026-09-01 · finished once before');

    const form = await html(solo, `/items/${item.id}/edit`);
    for (const absent of ['Your status', 'Your rating', 'Your review', 'are yours']) expect(form).not.toContain(absent);
    expect(await html(solo, `/libraries/${item.libraryId}`)).not.toContain('name="readBy"');
    expect(await summaryOf(item.id)).toMatchObject({ status: 'completed', rereading: 1, readCount: 1, rating: 8, review: 'Mine alone', progressPage: 12 });
  });
});
