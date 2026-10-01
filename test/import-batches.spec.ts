// The import page parses a CSV in the browser and posts it in batches (public/import.js). A Nalanda export's loans cost
// the server about what a row does each, so a batch also stops at a thousand of them (ARCH.md §16 #57). This runs the
// script against the Worker with just enough browser around it: the file is a string, and fetch goes to the app.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createItem, createLibrary, createUser } from '../src/db/queries';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

type Handler = () => Promise<void>;
const page = {
  file: { text: async () => '' },
  status: { textContent: '' },
  library: { value: '' },
  run: undefined as Handler | undefined,
  preview: undefined as Handler | undefined,
  picked: undefined as (() => void) | undefined, // the file input's change: a new file drops the rows parsed before
  dates: { checked: false }, // the box: a matched book's date added from the file too (§16 #90)
  buttons: { run: { disabled: false }, preview: { disabled: false } }, // Import and Preview, as the script enables and disables them
};
const button = (name: 'run' | 'preview') => Object.assign(page.buttons[name], { addEventListener: (_type: string, handler: Handler) => (page[name] = handler) });

beforeAll(async () => {
  const elements: Record<string, unknown> = {
    'import-file': { files: [page.file], addEventListener: (_type: string, handler: () => void) => (page.picked = handler) },
    'import-preview': button('preview'),
    'import-run': button('run'),
    'import-status': page.status,
    'import-library': page.library,
    'import-default-type': { value: 'book' },
    'import-music-as-vinyl': { checked: true },
    'import-dates': page.dates,
  };
  Object.assign(globalThis, {
    document: { getElementById: (id: string) => elements[id] ?? null, querySelector: () => null },
    window: {},
  });
  // @ts-expect-error -- a browser script with no types, run here for what it attaches to the page
  await import('../public/import.js');
});

/**
 * Presses Import with `csv` as the chosen file; returns each batch's rows and loans as posted. With `failAt`, that batch
 * (counting from 0) is answered with a 500 instead of reaching the app, as a batch the server refused would be.
 */
async function importFile(csv: string, cookie: string, failAt?: number) {
  page.file.text = async () => csv;
  page.picked!();
  const posted: Array<{ rows: number; loans: number }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { rows: Array<Record<string, string>> };
    const n = posted.length;
    posted.push({ rows: body.rows.length, loans: body.rows.reduce((n, r) => n + (r.loans ? r.loans.split(';').length : 0), 0) });
    if (n === failAt) return new Response('{"error":"refused"}', { status: 500, headers: { 'content-type': 'application/json' } });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(new URL(String(input), 'http://nalanda.test'), { ...init, headers: { ...(init.headers as object), cookie, origin: 'http://nalanda.test' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }) as typeof fetch;
  try {
    await page.run!();
  } finally {
    globalThis.fetch = realFetch;
  }
  return posted;
}

const HEADER = 'library,media_type,title,copies,loans,isbn10_upc,began_on,completed_on,added_at,details';
const loans = (n: number, who: string) => Array.from({ length: n }, (_, j) => `2025-01-${String((j % 28) + 1).padStart(2, '0')}..2025-02-01@${who}${j}`).join(';');

describe('importing a Nalanda export with many loans', () => {
  it('posts batches of at most 200 rows and a thousand loans, a row with more alone, and every loan arrives', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000))}`;
    page.library.value = String((await createLibrary(env.DB, 'Restored')).id);
    const lines = [HEADER];
    for (let i = 1; i <= 300; i++) lines.push(`x,boardgame,Game ${i},1,${i === 150 ? loans(1200, 'Big') : loans(i <= 100 ? 15 : 0, 'Asha')},,,,,{}`);
    const posted = await importFile(lines.join('\r\n') + '\r\n', cookie);

    expect(page.status.textContent).toMatch(/^Done: 300 items added/);
    // rows 1–100 carry 15 loans each: 66 rows a batch (990 loans), then the rest of them, then row 150 alone
    expect(posted).toEqual([
      { rows: 66, loans: 990 },
      { rows: 83, loans: 510 },
      { rows: 1, loans: 1200 },
      { rows: 150, loans: 0 },
    ]);
    expect(posted.every((b) => b.rows <= 200)).toBe(true);
    const total = await env.DB.prepare('SELECT count(*) AS n FROM loans').first<{ n: number }>();
    expect(total!.n).toBe(100 * 15 + 1000); // row 150 keeps its latest thousand (MAX_LOANS_PER_CELL)
  });

  it('finds the loans column whatever its case, as the server does', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000))}`;
    page.library.value = String((await createLibrary(env.DB, 'Restored')).id);
    const lines = [HEADER.replace('loans', 'Loans ')];
    for (let i = 1; i <= 3; i++) lines.push(`x,boardgame,Game ${i},1,${loans(600, 'Asha')},,,,,{}`);
    const posted = await importFile(lines.join('\n'), cookie);
    expect(posted.map((b) => b.rows)).toEqual([1, 1, 1]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM loans').first<{ n: number }>())!.n).toBe(1800);
  });

  it('still posts 200 rows a batch when there are no loans', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000))}`;
    const shelf = await createLibrary(env.DB, 'Main');
    page.library.value = String(shelf.id);
    await createItem(env.DB, { libraryId: shelf.id, title: 'Already here', details: '{}' });
    const lines = ['item_type,title', ...Array.from({ length: 450 }, (_, i) => `book,Book ${i}`)];
    const posted = await importFile(lines.join('\n'), cookie);
    expect(posted.map((b) => b.rows)).toEqual([200, 200, 50]);
  });
});

describe('a Goodreads re-import with "also set the date added" ticked (§16 #90)', () => {
  it('dates a new book from the file always, a book already here only when asked, and says how many', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000))}`;
    const shelf = await createLibrary(env.DB, 'Main');
    page.library.value = String(shelf.id);
    await createItem(env.DB, { libraryId: shelf.id, title: 'Piranesi', creators: 'Susanna Clarke', isbn13: '9781635575637', details: '{}' });
    const csv = ['Title,Author,ISBN13,Exclusive Shelf,Date Added', 'Piranesi,Susanna Clarke,9781635575637,to-read,2019/03/12', 'Jonathan Strange & Mr Norrell,Susanna Clarke,9781582344164,to-read,2017/06/01'].join('\n');
    const dates = async () => (await env.DB.prepare('SELECT title, added_at AS at, created_at AS made FROM items ORDER BY id').all<{ title: string; at: string; made: string | null }>()).results;

    page.dates.checked = false;
    await importFile(csv, cookie);
    expect(page.status.textContent).toMatch(/^Done: 1 item added, 1 merged onto existing items, 0 rows skipped/);
    let rows = await dates();
    expect(rows[0]!.at).not.toBe('2019-03-12 00:00:00'); // the box was clear: the book here keeps its date
    expect(rows[0]!.made).toBeNull();
    expect(rows[1]).toMatchObject({ title: 'Jonathan Strange & Mr Norrell', at: '2017-06-01 00:00:00' }); // new: the file's
    expect(rows[1]!.made).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // and its own time, for its stamp
    const before = rows[0]!.at;

    page.dates.checked = true;
    await importFile(csv, cookie);
    expect(page.status.textContent).toMatch(/^Done: 0 items added, 2 merged onto existing items \(1 dated from the file\), 0 rows skipped/);
    rows = await dates();
    expect(rows[0]).toEqual({ title: 'Piranesi', at: '2019-03-12 00:00:00', made: before });
    page.dates.checked = false;
  });
});

describe('a batch that fails partway', () => {
  it('says what a re-run would do for the format — only the reading-site imports merge — and leaves Import pressable', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin, Math.floor(Date.now() / 1000))}`;
    page.library.value = String((await createLibrary(env.DB, 'Main')).id);
    const count = async () => (await env.DB.prepare('SELECT count(*) AS n FROM items').first<{ n: number }>())!.n;

    // a libib file, three batches, the second refused: the first 200 rows landed, and a re-run would add them again
    const libib = ['item_type,title', ...Array.from({ length: 450 }, (_, i) => `book,Book ${i}`)].join('\n');
    expect((await importFile(libib, cookie, 1)).map((b) => b.rows)).toEqual([200, 200]); // stopped there
    expect(page.status.textContent).toContain('Batch at row 200 failed (500) — stopped. 200 rows added so far, from the first 200 rows of the file; re-running the whole file would add them again');
    expect(page.status.textContent).not.toContain('merge');
    expect(page.buttons.run.disabled).toBe(false); // it stayed greyed out before
    expect(page.buttons.preview.disabled).toBe(false);
    expect(await count()).toBe(200);

    // a Goodreads file: the rows that landed match on a re-run, so it says so
    const goodreads = ['Title,Author,Exclusive Shelf', ...Array.from({ length: 250 }, (_, i) => `Read ${i},Someone,to-read`)].join('\n');
    await importFile(goodreads, cookie, 1);
    expect(page.status.textContent).toContain('Batch at row 200 failed (500) — stopped. 200 rows added and 0 merged so far; re-run after fixing — rows already imported match and merge rather than duplicate.');
    expect(page.buttons.run.disabled).toBe(false);
    expect(await count()).toBe(400);

    // the first batch refused: nothing landed, whatever the format
    await importFile(goodreads, cookie, 0);
    expect(page.status.textContent).toContain('Batch at row 0 failed (500) — stopped. Nothing was imported; re-run after fixing.');
    expect(page.buttons.run.disabled).toBe(false);
    expect(await count()).toBe(400);

    // and a run that goes through still ends with both pressable
    await importFile(goodreads, cookie);
    expect(page.status.textContent).toMatch(/^Done: 50 items added, 200 merged onto existing items/);
    expect(page.buttons.run.disabled).toBe(false);
  });
});
