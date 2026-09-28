// A Nalanda export must come back through import as it went out — CLAUDE.md's round-trip promise. It used to
// be read as a libib file: the media type, UPC and dates were lost, details came back nested as a string (and
// public on share pages), and a rating of 7 returned as 10 through libib's 0–5 scale.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  addPastRead,
  addProgress,
  closeRead,
  createItem,
  createLibrary,
  createUser,
  getItem,
  setItemTags,
  startRead,
  tagsForItem,
} from '../src/db/queries';
import { mapLibibRow, mapNalandaRow } from '../src/lib/csv';
import { parseReadsCell } from '../src/lib/reads';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

/** RFC 4180, as public/import.js parses it in the browser: quoted fields, "" escapes, newlines inside quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
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
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i] ?? ''])));
}

async function call(path: string, cookie: string, json?: unknown) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: 'http://nalanda.test', ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    }),
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, text };
}

const FIELDS = [
  'mediaType', 'title', 'creators', 'isbn13', 'isbn10Upc', 'publisher', 'published', 'description', 'length',
  'status', 'rating', 'review', 'notes', 'copies', 'beganOn', 'completedOn', 'readCount', 'rereading', 'addedAt', 'details',
] as const;

describe('a Nalanda export, imported again', () => {
  it('comes back field for field', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000))}`;
    const shelf = await createLibrary(env.DB, 'Records');
    const record = await createItem(env.DB, {
      libraryId: shelf.id,
      mediaType: 'vinyl',
      title: 'Kind of Blue',
      creators: 'Miles Davis',
      isbn10Upc: '074646493922',
      publisher: 'Columbia',
      published: '1959',
      status: 'completed',
      rating: 7,
      review: 'Modal, patient, "perfect" —\nstill, after all these years.',
      notes: 'Bought at the fair, 2019',
      copies: 1,
      beganOn: '2026-01-02',
      completedOn: '2026-01-03',
      details: JSON.stringify({ discogs_id: 123, format: 'LP' }),
    });
    await setItemTags(env.DB, record.id, ['jazz', 'favourites']);
    const book = await createItem(env.DB, {
      libraryId: shelf.id,
      mediaType: 'book',
      title: 'The Left Hand of Darkness',
      creators: 'Ursula K. Le Guin',
      isbn13: '9780441478125',
      description: 'Genly Ai, an envoy, on a world of "ambisexual" people, in winter.',
      length: 304,
      status: 'in_progress',
      rating: 10,
      copies: 0,
      beganOn: '2026-09-20',
      details: '{}',
    });
    await env.DB.prepare("UPDATE items SET added_at = '2019-05-01 12:34:56' WHERE id = ?1").bind(book.id).run();

    const csv = await call('/export.csv', cookie);
    const rows = parseCsv(csv.text);
    expect(rows).toHaveLength(2);

    const target = await createLibrary(env.DB, 'Restored');
    const preview = JSON.parse((await call('/api/import', cookie, { libraryId: target.id, rows, dryRun: true })).text);
    expect(preview.format).toBe('nalanda');
    const done = JSON.parse((await call('/api/import', cookie, { libraryId: target.id, rows })).text);
    expect(done).toMatchObject({ inserted: 2, skipped: 0 });

    const restored = (await env.DB.prepare('SELECT id FROM items WHERE library_id = ?1 ORDER BY id').bind(target.id).all<{ id: number }>()).results;
    for (const [original, copy] of [[record.id, restored[0]!.id], [book.id, restored[1]!.id]] as const) {
      const before = (await getItem(env.DB, original))!;
      const after = (await getItem(env.DB, copy))!;
      for (const field of FIELDS) expect(after[field], `${before.title}: ${field}`).toEqual(before[field]);
      expect(await tagsForItem(env.DB, copy)).toEqual(await tagsForItem(env.DB, original));
    }
  });

  it('still reads a libib file as libib', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000))}`;
    const shelf = await createLibrary(env.DB, 'Main');
    const libib = [{ item_type: 'book', title: 'Dune', creators: 'Frank Herbert', rating: '4.5', ean_isbn13: '9780441013593' }];

    const preview = JSON.parse((await call('/api/import', cookie, { libraryId: shelf.id, rows: libib, dryRun: true })).text);

    expect(preview.format).toBe('libib');
    await call('/api/import', cookie, { libraryId: shelf.id, rows: libib });
    const row = await env.DB.prepare('SELECT rating FROM items WHERE title = ?1').bind('Dune').first<{ rating: number }>();
    expect(row?.rating).toBe(9); // libib's 4.5 of 5 is 9 of 10 here
  });

  it('refuses numbers and dates that no export of ours could hold', async () => {
    const { mapNalandaRow } = await import('../src/lib/csv');
    const row = (over: Record<string, string>) =>
      mapNalandaRow({ title: 'T', media_type: 'book', isbn10_upc: '', began_on: '', completed_on: '', added_at: '', details: '', ...over })!.item;

    expect(row({ copies: '99999999999999999999' }).copies).toBe(1); // was 1e20, stored as a REAL
    expect(row({ copies: '3' }).copies).toBe(3);
    expect(row({ length: '1e5' }).length).toBeNull();
    expect(row({ rating: '11' }).rating).toBeNull();
    expect(row({ began_on: 'not a date', completed_on: '2026-09-28' })).toMatchObject({ beganOn: null, completedOn: '2026-09-28' });
  });
});

// ---------- each read (ARCH.md §16 #41) ----------

const readsOf = async (itemId: number) =>
  (
    await env.DB.prepare(
      `SELECT status, began_on AS beganOn, ended_on AS endedOn FROM reads WHERE item_id = ?1
       ORDER BY status = 'in_progress', coalesce(ended_on, began_on) IS NOT NULL, coalesce(ended_on, began_on), id`,
    )
      .bind(itemId)
      .all()
  ).results;

async function signedIn() {
  const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
  return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000))}`;
}

describe('reads through the export and back', () => {
  it('carries every read, in order, with its pages named by read', async () => {
    const cookie = await signedIn();
    const shelf = await createLibrary(env.DB, 'Fiction');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'The Dispossessed', length: 387, status: 'completed', beganOn: '2019-03-01', completedOn: '2019-03-20', details: '{}' });
    await addPastRead(env.DB, book.id, { status: 'completed', beganOn: null, endedOn: null });
    await addPastRead(env.DB, book.id, { status: 'abandoned', beganOn: '2023-02-01', endedOn: '2023-02-10' });
    await startRead(env.DB, book.id, '2026-09-01');
    await addProgress(env.DB, book.id, 142, null);

    const csv = parseCsv((await call('/export.csv', cookie)).text);
    expect(csv[0]).toMatchObject({
      status: 'completed',
      began_on: '2019-03-01',
      completed_on: '2019-03-20',
      read_count: '2',
      reads: 'completed:..;completed:2019-03-01..2019-03-20;abandoned:2023-02-01..2023-02-10;in_progress:2026-09-01..',
    });
    expect(csv[0]!.progress_history).toMatch(/^142@\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}#4$/); // the 4th read, the open one

    const target = await createLibrary(env.DB, 'Restored');
    expect(JSON.parse((await call('/api/import', cookie, { libraryId: target.id, rows: csv })).text)).toMatchObject({ inserted: 1 });
    const copy = (await env.DB.prepare('SELECT id FROM items WHERE library_id = ?1').bind(target.id).first<{ id: number }>())!.id;
    expect(await readsOf(copy)).toEqual(await readsOf(book.id));
    expect(await getItem(env.DB, copy)).toMatchObject({ status: 'completed', readCount: 2, rereading: true, completedOn: '2019-03-20' });
  });

  it('still imports an export from before reads, from its status and dates', async () => {
    const cookie = await signedIn();
    const shelf = await createLibrary(env.DB, 'Old');
    const base = { library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '' };
    const rows = [
      { ...base, title: 'Finished', status: 'completed', began_on: '2020-01-01', completed_on: '2020-02-01' },
      { ...base, title: 'Reading again', status: 'in_progress', began_on: '2026-09-01', completed_on: '2020-02-01' },
      { ...base, title: 'Unread', status: 'not_started', began_on: '', completed_on: '' },
    ];
    const preview = JSON.parse((await call('/api/import', cookie, { libraryId: shelf.id, rows, dryRun: true })).text);
    expect(preview.format).toBe('nalanda');
    await call('/api/import', cookie, { libraryId: shelf.id, rows });
    const byTitle = async (title: string) => (await env.DB.prepare('SELECT * FROM items WHERE title = ?1').bind(title).first<{ id: number; status: string; rereading: number }>())!;
    expect(await readsOf((await byTitle('Finished')).id)).toEqual([{ status: 'completed', beganOn: '2020-01-01', endedOn: '2020-02-01' }]);
    expect(await readsOf((await byTitle('Reading again')).id)).toEqual([
      { status: 'completed', beganOn: null, endedOn: '2020-02-01' },
      { status: 'in_progress', beganOn: '2026-09-01', endedOn: null },
    ]);
    expect(await byTitle('Reading again')).toMatchObject({ status: 'completed', rereading: 1 });
    expect(await readsOf((await byTitle('Unread')).id)).toEqual([]);
  });

  it('keeps the summary columns an older version reads: status, and the last finish', async () => {
    const cookie = await signedIn();
    const shelf = await createLibrary(env.DB, 'Shelf');
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'Kindred', status: 'completed', completedOn: '2020-01-01', details: '{}' });
    await startRead(env.DB, book.id, '2026-09-01');
    const open = (await env.DB.prepare("SELECT id FROM reads WHERE status = 'in_progress'").first<{ id: number }>())!.id;
    await closeRead(env.DB, book.id, open, 'completed', '2026-09-20');
    const [row] = parseCsv((await call('/export.csv', cookie)).text);
    // an older Nalanda drops the columns it doesn't know and keeps these: one finished read, the latest
    expect(row).toMatchObject({ status: 'completed', began_on: '2026-09-01', completed_on: '2026-09-20' });
    const { reads: _r, read_count: _n, ...older } = row!;
    expect(mapNalandaRow(older)!.reads).toEqual([{ status: 'completed', beganOn: '2026-09-01', endedOn: '2026-09-20' }]);
  });

  it('reads a cell back leniently: bad parts dropped, unknown dates kept as unknown, one open read, at most 100', () => {
    expect(parseReadsCell('completed:2020-01-01..2020-02-01;garbage;abandoned:..;in_progress:2026-09-01..;in_progress:2026-09-02..')).toEqual([
      { status: 'completed', beganOn: '2020-01-01', endedOn: '2020-02-01' },
      { status: 'abandoned', beganOn: null, endedOn: null },
      { status: 'in_progress', beganOn: '2026-09-01', endedOn: null },
    ]);
    expect(parseReadsCell('completed:spring 2019..2019-13-01')).toEqual([{ status: 'completed', beganOn: null, endedOn: null }]);
    expect(parseReadsCell(Array.from({ length: 500 }, () => 'completed:..').join(';'))).toHaveLength(100);
    expect(parseReadsCell('')).toEqual([]);
  });

  it('tops up a read count raised by hand, and caps it', () => {
    const row = (over: Record<string, string>) =>
      mapNalandaRow({ title: 'T', media_type: 'book', isbn10_upc: '', began_on: '', completed_on: '', added_at: '', details: '', ...over })!;
    expect(row({ reads: 'completed:..2020-01-01', read_count: '3' }).reads).toHaveLength(3);
    expect(row({ reads: 'completed:..2020-01-01', read_count: '3' }).item).toMatchObject({ status: 'completed', completedOn: '2020-01-01' });
    expect(row({ status: 'not_started', read_count: '999999' }).reads).toHaveLength(100);
  });

  it('never lets reads fall into details, where share pages would show their dates', () => {
    const m = mapLibibRow({ title: 'A Nalanda export missing a column', reads: 'completed:2020-01-01..2020-02-01', read_count: '1' }, { defaultType: 'book', musicAsVinyl: true })!;
    expect(JSON.parse(m.item.details as string)).toEqual({});
  });
});
