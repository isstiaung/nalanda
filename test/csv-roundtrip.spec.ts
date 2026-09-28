// A Nalanda export must come back through import as it went out — CLAUDE.md's round-trip promise. It used to
// be read as a libib file: the media type, UPC and dates were lost, details came back nested as a string (and
// public on share pages), and a rating of 7 returned as 10 through libib's 0–5 scale.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary, createUser, getItem, setItemTags, tagsForItem } from '../src/db/queries';
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
  'status', 'rating', 'review', 'notes', 'copies', 'beganOn', 'completedOn', 'addedAt', 'details',
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
});
