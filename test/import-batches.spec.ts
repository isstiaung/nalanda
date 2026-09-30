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
};
const button = (name: 'run' | 'preview') => ({
  disabled: false,
  addEventListener: (_type: string, handler: Handler) => (page[name] = handler),
});

beforeAll(async () => {
  const elements: Record<string, unknown> = {
    'import-file': { files: [page.file], addEventListener: (_type: string, handler: () => void) => (page.picked = handler) },
    'import-preview': button('preview'),
    'import-run': button('run'),
    'import-status': page.status,
    'import-library': page.library,
    'import-default-type': { value: 'book' },
    'import-music-as-vinyl': { checked: true },
  };
  Object.assign(globalThis, {
    document: { getElementById: (id: string) => elements[id] ?? null, querySelector: () => null },
    window: {},
  });
  // @ts-expect-error -- a browser script with no types, run here for what it attaches to the page
  await import('../public/import.js');
});

/** Presses Import with `csv` as the chosen file; returns each batch's rows and loans as posted. */
async function importFile(csv: string, cookie: string) {
  page.file.text = async () => csv;
  page.picked!();
  const posted: Array<{ rows: number; loans: number }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { rows: Array<Record<string, string>> };
    posted.push({ rows: body.rows.length, loans: body.rows.reduce((n, r) => n + (r.loans ? r.loans.split(';').length : 0), 0) });
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
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000))}`;
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

  it('still posts 200 rows a batch when there are no loans', async () => {
    const admin = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
    const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, admin.id, Math.floor(Date.now() / 1000))}`;
    const shelf = await createLibrary(env.DB, 'Main');
    page.library.value = String(shelf.id);
    await createItem(env.DB, { libraryId: shelf.id, title: 'Already here', details: '{}' });
    const lines = ['item_type,title', ...Array.from({ length: 450 }, (_, i) => `book,Book ${i}`)];
    const posted = await importFile(lines.join('\n'), cookie);
    expect(posted.map((b) => b.rows)).toEqual([200, 200, 50]);
  });
});
