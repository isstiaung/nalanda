// Loans through the export and back (ARCH.md §16 #57): every loan of an item, open and returned, in its row's `loans`
// cell, restored by a Nalanda import onto the item the row makes — and never anywhere outside the app.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import { createItem, createLibrary, createShare, createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { borrowRequest } from '../src/federation/messages';
import { itemStamp } from '../src/federation/items';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { EXPORT_COLUMNS, mapLibibRow, mapNalandaRow } from '../src/lib/csv';
import { formatLoansCell, MAX_LOANS_PER_CELL, parseLoansCell, type LoanDraft } from '../src/lib/loans';
import { newShareToken } from '../src/lib/share';
import app from '../src/index';
import { EXPORT_LOANS, EXPORT_PAGE } from '../src/routes/importexport';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA } from './federation-helpers';

/** RFC 4180, as public/import.js parses it in the browser. */
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

async function call(path: string, cookie?: string, body?: unknown, bindings: Bindings = env) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { cookie } : {}), origin: 'http://nalanda.test', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    }),
    bindings,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, text, headers: res.headers };
}

async function signIn(role: 'admin' | 'member' = 'admin', username: string = role) {
  const u = await createUser(env.DB, { username, passwordHash: 'pbkdf2$1$x$y', role, mustChangePassword: false });
  return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, u, Math.floor(Date.now() / 1000))}`;
}

/** The export as the Export button fetches it: page by page, joined. */
async function exportRows(cookie: string) {
  let text = '';
  let after = '0';
  for (;;) {
    const page = await call(`/export.csv?after=${after}`, cookie);
    expect(page.status).toBe(200);
    text += page.text;
    const next = page.headers.get('x-export-next');
    if (!next) break;
    after = next;
  }
  return parseCsv(text);
}

const importRows = async (cookie: string, libraryId: number, rows: Record<string, string>[], dryRun = false) =>
  JSON.parse((await call('/api/import', cookie, { libraryId, rows, dryRun })).text);

async function addLoan(itemId: number, l: Partial<LoanDraft> & { borrower: string; loanedOn: string }) {
  await env.DB.prepare(
    'INSERT INTO loans (item_id, borrower, loaned_on, due_on, returned_on, contact, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(itemId, l.borrower, l.loanedOn, l.dueOn ?? null, l.returnedOn ?? null, l.contact ?? null, l.note ?? null)
    .run();
}

/** An item's loans as the database holds them, in the order they were made. */
const loansOf = async (itemId: number) =>
  (
    await env.DB.prepare(
      `SELECT borrower, loaned_on AS loanedOn, due_on AS dueOn, returned_on AS returnedOn, contact, note
       FROM loans WHERE item_id = ?1 ORDER BY id`,
    )
      .bind(itemId)
      .all<LoanDraft>()
  ).results;

const idOf = async (title: string, libraryId: number) =>
  (await env.DB.prepare('SELECT id FROM items WHERE title = ?1 AND library_id = ?2').bind(title, libraryId).first<{ id: number }>())!.id;

// Everything a borrower, contact or note could hold that might break a cell: its separators, CSV's quoting, a
// newline, the encoding's own `%`, and scripts other than Latin.
const ODD = {
  borrower: 'O\'Brien, "Jo" | @home; 100%\nரவி (ಕನ್ನಡ) राम',
  contact: 'jo@example.com, +91 98450 12345; ext. 7 | "desk"',
  note: 'Signed copy — 50% off, "handle with care"\r\nsecond line; a|b @ c:d %41 نسخة',
};

describe('the loans cell', () => {
  it('writes every text so nothing in it needs CSV quoting, and reads it back exactly', () => {
    const loans: LoanDraft[] = [
      { borrower: ODD.borrower, loanedOn: '2024-03-01', dueOn: '2024-03-15', returnedOn: '2024-03-20', contact: ODD.contact, note: ODD.note },
      { borrower: 'Ravi', loanedOn: '2026-09-10', dueOn: null, returnedOn: null, contact: null, note: null },
      { borrower: 'Ravi', loanedOn: '2026-09-10', dueOn: null, returnedOn: null, contact: null, note: null }, // two copies, one borrower
    ];
    const cell = formatLoansCell(loans);
    expect(cell).not.toMatch(/[",\r\n]/);
    expect(cell.split(';')).toHaveLength(3);
    expect(cell.split(';')[1]).toBe('2026-09-10..@Ravi');
    expect(parseLoansCell(cell)).toEqual(loans);
    expect(formatLoansCell([])).toBe('');
  });

  it('reads leniently: bad parts dropped, a due date kept as written, unknown parts ignored, at most the cap', () => {
    expect(
      parseLoansCell(
        [
          'garbage',
          '2026-01-01..@', // no borrower
          '..@Nobody', // no lending date
          '2026-02-30..@Leap', // not a calendar date
          '2026-01-01..soon@Maybe', // a return date that isn't one: not read as still out
          '2026-01-01..2026-01-05@Asha|due:someday|colour:blue|note:%E0%A4%A',
          ' 2026-03-01 .. @ Bob%20 |due:2026-03-10 ',
          '2026-04-01..@100% sure|contact:50%off',
        ].join(';'),
      ),
    ).toEqual([
      { borrower: 'Asha', loanedOn: '2026-01-01', dueOn: 'someday', returnedOn: '2026-01-05', contact: null, note: '%E0%A4%A' },
      { borrower: 'Bob ', loanedOn: '2026-03-01', dueOn: '2026-03-10', returnedOn: null, contact: null, note: null },
      { borrower: '100% sure', loanedOn: '2026-04-01', dueOn: null, returnedOn: null, contact: '50%off', note: null },
    ]);
    expect(parseLoansCell(Array.from({ length: MAX_LOANS_PER_CELL + 50 }, () => '2020-01-01..2020-01-02@A').join(';'))).toHaveLength(MAX_LOANS_PER_CELL);
    expect(parseLoansCell('')).toEqual([]);
    expect(parseLoansCell(undefined)).toEqual([]);
  });

  it('round-trips a legacy free-text due date, and never lets one start a loan of its own', () => {
    // lent before the form checked due dates: whatever was stored comes back as it was, and its `;` stays inside the loan
    for (const dueOn of ['x;2020-01-01..@Mallory', 'next week', '2025-02-30']) {
      const cell = formatLoansCell([{ borrower: 'Ann', loanedOn: '2026-01-01', dueOn, returnedOn: null, contact: null, note: null }]);
      expect(parseLoansCell(cell)).toEqual([{ borrower: 'Ann', loanedOn: '2026-01-01', dueOn, returnedOn: null, contact: null, note: null }]);
    }
    const long = formatLoansCell([{ borrower: 'Ann', loanedOn: '2026-01-01', dueOn: 'x'.repeat(5000), returnedOn: null, contact: null, note: null }]);
    expect(parseLoansCell(long)[0]!.dueOn).toHaveLength(200);
  });

  it('never lets loans fall into details, where share pages and connections would show them', () => {
    const m = mapLibibRow({ title: 'A Nalanda export missing a column', loans: '2026-01-01..@Secret Sunita' }, { defaultType: 'book', musicAsVinyl: true })!;
    expect(JSON.parse(m.item.details as string)).toEqual({});
    expect(m.loans).toBeUndefined();
  });
});

describe('loans through the export and back', () => {
  it('come back identical after a wipe: open and returned, with contact, note and any text', async () => {
    const cookie = await signIn();
    const shelf = (await createLibrary(env.DB, 'Games')).id;
    const game = await createItem(env.DB, { libraryId: shelf, mediaType: 'boardgame', title: 'Wingspan', copies: 2, details: '{}' });
    await createItem(env.DB, { libraryId: shelf, title: 'Never lent', copies: 1, details: '{}' });
    await addLoan(game.id, { borrower: ODD.borrower, loanedOn: '2024-03-01', dueOn: '2024-03-15', returnedOn: '2024-03-20', contact: ODD.contact, note: ODD.note });
    await addLoan(game.id, { borrower: 'Asha', loanedOn: '2026-09-01', returnedOn: '2026-09-01' }); // back the same day…
    await addLoan(game.id, { borrower: 'Asha', loanedOn: '2026-09-01', dueOn: '2026-10-01', contact: 'asha@example.com' }); // …and lent again
    await addLoan(game.id, { borrower: ODD.borrower, loanedOn: '2026-09-20', note: ODD.note });
    const before = await loansOf(game.id);

    const rows = await exportRows(cookie);
    expect(Object.keys(rows[0]!)).toContain('loans');
    const gameRow = rows.find((r) => r.title === 'Wingspan')!;
    expect(gameRow.loans!.split(';')).toHaveLength(4);
    expect(rows.find((r) => r.title === 'Never lent')!.loans).toBe('');

    await env.DB.prepare('DELETE FROM items').run(); // the wipe: loans go with their items
    expect((await env.DB.prepare('SELECT count(*) AS n FROM loans').first<{ n: number }>())!.n).toBe(0);

    const preview = await importRows(cookie, shelf, rows, true);
    expect(preview).toMatchObject({ format: 'nalanda', loans: 4, loansOut: 2 });
    expect(await importRows(cookie, shelf, rows)).toMatchObject({ inserted: 2, skipped: 0 });

    expect(await loansOf(await idOf('Wingspan', shelf))).toEqual(before);
    expect(await loansOf(await idOf('Never lent', shelf))).toEqual([]);
    // and a second export writes the same cell
    expect((await exportRows(cookie)).find((r) => r.title === 'Wingspan')!.loans).toBe(gameRow.loans);
  });

  it('imports an export from before loans unchanged, with no loans', async () => {
    const cookie = await signIn();
    const shelf = (await createLibrary(env.DB, 'Main')).id;
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Kindred', creators: 'Octavia Butler', copies: 1, details: '{"binding":"Paperback"}' });
    await addLoan(item.id, { borrower: 'Asha', loanedOn: '2026-01-01' });
    const [row] = await exportRows(cookie);
    const { loans: _dropped, ...older } = row!;

    const target = (await createLibrary(env.DB, 'Restored')).id;
    const preview = await importRows(cookie, target, [older], true);
    expect(preview).toMatchObject({ format: 'nalanda', mapped: 1, loans: 0 });
    expect(await importRows(cookie, target, [older])).toMatchObject({ inserted: 1 });
    const copy = await idOf('Kindred', target);
    expect(await loansOf(copy)).toEqual([]);
    const restored = await env.DB.prepare('SELECT creators, copies, details FROM items WHERE id = ?1').bind(copy).first();
    expect(restored).toEqual({ creators: 'Octavia Butler', copies: 1, details: '{"binding":"Paperback"}' });
    // mapped the same with or without the column, but for the loans themselves
    const { loans: withLoans, ...withRest } = mapNalandaRow(row!)!;
    const { loans: withoutLoans, ...withoutRest } = mapNalandaRow(older)!;
    expect(withLoans).toHaveLength(1);
    expect(withoutLoans).toEqual([]);
    expect(withoutRest).toEqual(withRest);
  });

  it('never gives an item a loan twice when the same file is imported twice, and never touches an item already here', async () => {
    const cookie = await signIn();
    const shelf = (await createLibrary(env.DB, 'Main')).id;
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Dune', copies: 1, details: '{}' });
    await addLoan(item.id, { borrower: 'Asha', loanedOn: '2025-01-01', returnedOn: '2025-02-01' });
    await addLoan(item.id, { borrower: 'Ravi', loanedOn: '2026-09-01', dueOn: '2026-10-01' });
    const before = await loansOf(item.id);
    const rows = await exportRows(cookie);

    // into the same shelf, twice: a Nalanda import adds rows, never merges them (the preview says so)
    await importRows(cookie, shelf, rows);
    await importRows(cookie, shelf, rows);

    const copies = (await env.DB.prepare("SELECT id FROM items WHERE title = 'Dune' ORDER BY id").all<{ id: number }>()).results.map((r) => r.id);
    expect(copies).toHaveLength(3);
    for (const id of copies) expect(await loansOf(id), `item ${id}`).toEqual(before);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM loans').first<{ n: number }>())!.n).toBe(before.length * 3);
  });

  it('keeps every open loan in the file, even more than there are copies, and then lends nothing more', async () => {
    const cookie = await signIn();
    const shelf = (await createLibrary(env.DB, 'Main')).id;
    // a two-copy game lent twice, then counted down to one copy: the app holds two open loans on one copy
    const game = await createItem(env.DB, { libraryId: shelf, mediaType: 'boardgame', title: 'Azul', copies: 2, details: '{}' });
    await addLoan(game.id, { borrower: 'Ann', loanedOn: '2026-09-01' });
    await addLoan(game.id, { borrower: 'Bob', loanedOn: '2026-09-02' });
    await env.DB.prepare('UPDATE items SET copies = 1 WHERE id = ?1').bind(game.id).run();
    const rows = await exportRows(cookie);

    const target = (await createLibrary(env.DB, 'Restored')).id;
    await importRows(cookie, target, rows);
    const copy = await idOf('Azul', target);
    expect((await loansOf(copy)).map((l) => [l.borrower, l.returnedOn])).toEqual([
      ['Ann', null],
      ['Bob', null],
    ]);
    const refused = await (async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`http://nalanda.test/items/${copy}/loan`, {
          method: 'POST',
          headers: { cookie, origin: 'http://nalanda.test', 'content-type': 'application/x-www-form-urlencoded' },
          body: 'borrower=Cy',
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res.status;
    })();
    expect(refused).toBe(409); // every copy is out
    expect(await loansOf(copy)).toHaveLength(2);
  });

  it('restores the history and the open loan of a book marked Not owned while it was out', async () => {
    const cookie = await signIn();
    const shelf = (await createLibrary(env.DB, 'Main')).id;
    const book = await createItem(env.DB, { libraryId: shelf, title: 'Given away', copies: 1, details: '{}' });
    await addLoan(book.id, { borrower: 'Asha', loanedOn: '2024-01-01', returnedOn: '2024-02-01' });
    await addLoan(book.id, { borrower: 'Ravi', loanedOn: '2026-09-01' });
    // the Holding toggle refuses a copy out on loan now (§16 #13); older data can still hold copies = 0 with a loan
    // out, as the toggle once left it, and the export must carry that as it is
    const ctx = createExecutionContext();
    await app.fetch(
      new Request(`http://nalanda.test/items/${book.id}/mark-not-owned`, { method: 'POST', headers: { cookie, origin: 'http://nalanda.test' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect((await env.DB.prepare('SELECT copies FROM items WHERE id = ?1').bind(book.id).first<{ copies: number }>())!.copies).toBe(1);
    await env.DB.prepare('UPDATE items SET copies = 0 WHERE id = ?1').bind(book.id).run();
    const before = await loansOf(book.id);
    const rows = await exportRows(cookie);

    const target = (await createLibrary(env.DB, 'Restored')).id;
    await importRows(cookie, target, rows);
    const copy = await idOf('Given away', target);
    expect((await env.DB.prepare('SELECT copies FROM items WHERE id = ?1').bind(copy).first<{ copies: number }>())!.copies).toBe(0);
    expect(await loansOf(copy)).toEqual(before);
    // and it shows on the item page with its return button, as the original did
    const page = await call(`/items/${copy}`, cookie);
    expect(page.text).toContain('Lent to <strong>Ravi</strong>');
  });

  it("restores a member's import too: loans aren't anyone's", async () => {
    const admin = await signIn('admin');
    const member = await signIn('member', 'ravi');
    const shelf = (await createLibrary(env.DB, 'Main')).id;
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Catan', copies: 1, details: '{}' });
    await addLoan(item.id, { borrower: 'Neighbour', loanedOn: '2026-08-01', contact: 'next door' });
    const rows = await exportRows(admin);

    const target = (await createLibrary(env.DB, 'Restored')).id;
    await importRows(member, target, rows);
    expect(await loansOf(await idOf('Catan', target))).toEqual(await loansOf(item.id));
  });

  /** Every page the Export button would fetch, each with the D1 calls it made and the loans it carried. */
  async function pages(cookie: string) {
    const out: { rows: Record<string, string>[]; queries: number; loans: number; next: string | null }[] = [];
    let after = '0';
    let text = '';
    for (;;) {
      const budget = { left: 50 };
      const page = await call(`/export.csv?after=${after}`, cookie, undefined, { ...env, DB: budgeted(env.DB, budget) } as Bindings);
      expect(page.status).toBe(200);
      text += page.text;
      const rows = parseCsv((after === '0' ? '' : `${EXPORT_COLUMNS.join(',')}\r\n`) + page.text);
      const next = page.headers.get('x-export-next');
      expect(Number(page.headers.get('x-export-rows'))).toBe(rows.length);
      // counted as written: an import reads at most MAX_LOANS_PER_CELL of an item's
      const loans = rows.reduce((n, r) => n + (r.loans ? r.loans.split(';').length : 0), 0);
      out.push({ rows, queries: 50 - budget.left, loans, next });
      if (!next) break;
      after = next;
    }
    return { pages: out, text };
  }

  async function manyItems(count: number) {
    const shelf = (await createLibrary(env.DB, 'Everything')).id;
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
       INSERT INTO items (library_id, media_type, title, status, copies, details)
       SELECT ?1, 'boardgame', 'Game ' || i, 'not_started', 1, '{}' FROM n`,
    ).bind(shelf).run();
  }

  /** `perItem` loans on every item (or those given), each with a contact and a note to encode; the last still out. */
  const lend = (perItem: number, where = '1') =>
    env.DB.prepare(
      `WITH RECURSIVE k(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM k WHERE j < ${perItem})
       INSERT INTO loans (item_id, borrower, loaned_on, due_on, returned_on, contact, note)
       SELECT items.id, 'Borrower, "number" ' || j, '2025-01-01', '2025-02-01', CASE WHEN j < ${perItem} THEN '2025-01-20' END,
              'friend' || j || '@example.com', 'note; with | odd @ text ' || j
       FROM items, k WHERE ${where} ORDER BY items.id, j`,
    ).run();

  it('keeps each page within the budget, ending a page early once it holds a thousand loans', async () => {
    const cookie = await signIn();
    await manyItems(EXPORT_PAGE + 10);
    const without = await pages(cookie);
    expect(without.pages.map((p) => p.rows.length)).toEqual([EXPORT_PAGE, 10]);

    await lend(20); // 5,200 loans: twenty on every item
    const { pages: withLoans, text } = await pages(cookie);
    // 1,000 loans a page is fifty items; the last page is what's left
    expect(withLoans.map((p) => p.rows.length)).toEqual([50, 50, 50, 50, 50, 10]);
    expect(withLoans.every((p) => p.loans <= EXPORT_LOANS)).toBe(true);
    expect(withLoans.flatMap((p) => p.rows).every((r) => parseLoansCell(r.loans).length === 20)).toBe(true);
    // however many loans, one query for them: a page costs what it did with none
    expect(new Set(withLoans.map((p) => p.queries))).toEqual(new Set([without.pages[0]!.queries]));
    expect(withLoans[0]!.queries).toBeLessThanOrEqual(10); // with plays beside loans since #54 met #57
    // and the pages join into what the one-request export streams
    expect(text).toBe((await call('/export.csv', cookie)).text);
  });

  it('sends an item with more than a page of loans alone, with every one of them, for one query more', async () => {
    const cookie = await signIn();
    await manyItems(3);
    const second = (await env.DB.prepare("SELECT id FROM items WHERE title = 'Game 2'").first<{ id: number }>())!.id;
    await lend(2, `items.id <> ${second}`);
    await lend(EXPORT_LOANS + 5, `items.id = ${second}`);

    const { pages: got, text } = await pages(cookie);
    expect(got.map((p) => p.rows.map((r) => r.title))).toEqual([['Game 1'], ['Game 2'], ['Game 3']]);
    expect(got.map((p) => p.loans)).toEqual([2, EXPORT_LOANS + 5, 2]);
    expect(got[1]!.queries).toBe(got[0]!.queries + 1);
    expect(got[2]!.next).toBeNull();
    expect(text).toBe((await call('/export.csv', cookie)).text);
    // an import keeps the latest thousand of them, the one still out among them
    const restored = parseLoansCell(got[1]!.rows[0]!.loans);
    expect(restored).toHaveLength(MAX_LOANS_PER_CELL);
    expect(restored[0]!.borrower).toBe('Borrower, "number" 6');
    expect(restored.at(-1)).toMatchObject({ borrower: `Borrower, "number" ${EXPORT_LOANS + 5}`, returnedOn: null });
  });

  it('streams without a cursor in the same few queries however many loans, since smaller pages would save it no CPU', async () => {
    const cookie = await signIn();
    await manyItems(EXPORT_PAGE + 10);
    const stream = async () => {
      const budget = { left: 50 };
      const res = await call('/export.csv', cookie, undefined, { ...env, DB: budgeted(env.DB, budget) } as Bindings);
      return { queries: 50 - budget.left, text: res.text };
    };
    const without = await stream();
    await lend(20);
    const withLoans = await stream();
    expect(withLoans.queries).toBe(without.queries);
    expect(parseCsv(withLoans.text).every((r) => parseLoansCell(r.loans).length === 20)).toBe(true);
  });

  it("counts only the shelf's own loans when scoped, however the shelves interleave", async () => {
    const cookie = await signIn();
    const [mine, theirs] = [(await createLibrary(env.DB, 'Mine')).id, (await createLibrary(env.DB, 'Theirs')).id];
    // alternate shelves, so every page's id range spans the other shelf's items and their many loans
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
       INSERT INTO items (library_id, media_type, title, status, copies, details)
       SELECT CASE WHEN i % 2 THEN ?1 ELSE ?2 END, 'boardgame', 'Game ' || i, 'not_started', 1, '{}' FROM n`,
    ).bind(mine, theirs).run();
    await lend(30, `items.library_id = ${theirs}`);
    await lend(1, `items.library_id = ${mine}`);

    const res = await call(`/export.csv?library=${mine}&after=0`, cookie);
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(60); // not cut by the 1,800 loans on the other shelf
    expect(res.headers.get('x-export-next')).toBeNull();
    expect(rows.every((r) => parseLoansCell(r.loans).length === 1)).toBe(true);
  });
});

describe('loans never leave the app', () => {
  it('the export is for the signed-in only', async () => {
    const cookie = await signIn(); // someone exists, so the app isn't asking to be set up
    const shelf = (await createLibrary(env.DB, 'Main')).id;
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Private', copies: 1, details: '{}' });
    await addLoan(item.id, { borrower: 'Secret Sunita', loanedOn: '2026-01-01' });
    for (const path of ['/export.csv', '/export.csv?after=0']) {
      const res = await call(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toMatch(/^\/login/);
      expect(res.text, path).not.toContain('Sunita');
    }
    expect((await call('/export.csv', cookie)).text).toContain('@Secret%20Sunita'); // control: signed in, it's there
  });

  describe('imported loans on share pages and to connections', () => {
    afterEach(() => vi.unstubAllGlobals());
    let shelf: number;
    let cookie: string;
    let copy: number;
    // in the clear or as the cell writes them
    const SECRETS = ['Sunita', 'sunita', 'Left at the door', 'Left%20at', '2026-02-01', '2026-02-14', '2026-09-03', 'Lent before'];

    beforeEach(async () => {
      cookie = await signIn();
      shelf = (await createLibrary(env.DB, 'Main')).id;
      const item = await createItem(env.DB, { libraryId: shelf, title: 'Shared and lent', copies: 1, details: '{}' });
      await addLoan(item.id, { borrower: 'Secret Sunita', loanedOn: '2026-02-01', returnedOn: '2026-02-14', contact: 'sunita@example.com', note: 'Left at the door' });
      await addLoan(item.id, { borrower: 'Secret Sunita', loanedOn: '2026-09-03' });
      const rows = await exportRows(cookie);
      await env.DB.prepare('DELETE FROM items').run();
      await importRows(cookie, shelf, rows);
      copy = await idOf('Shared and lent', shelf);
      expect(await loansOf(copy)).toHaveLength(2);
      expect((await env.DB.prepare('SELECT details FROM items WHERE id = ?1').bind(copy).first<{ details: string }>())!.details).toBe('{}');
    });

    it('stay off the share pages of the item they came back on', async () => {
      const token = newShareToken();
      await createShare(env.DB, { token, name: 'Everything', libraryId: shelf });
      expect((await call(`/items/${copy}`, cookie)).text).toContain('Secret Sunita'); // control: the app shows them
      for (const path of [`/share/${token}`, `/share/${token}/items/${copy}`]) {
        const res = await call(path);
        expect(res.status, path).toBe(200);
        expect(res.text, path).toContain('Shared and lent');
        for (const secret of SECRETS) expect(res.text, `${path}: ${secret}`).not.toContain(secret);
      }
    });

    it("stay out of a connection's shelf and item page, which see only that it's out", async () => {
      const keys = await makeKeys();
      const a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
      answerOutbound(() => json({}, 404));
      await setUpA();
      const peer = await makePeer('Riverbank library');
      await connectPeer(peer);
      await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelf, mediaType: null, status: null, owned: null });
      for (const path of [`/federation/item?view=1&id=${copy}`, '/federation/shelf?view=1&page=1']) {
        const res = await a.signedGet(path, peer);
        expect(res.status, path).toBe(200);
        const body = await res.text();
        expect(body, path).toContain('Shared and lent');
        expect(body, path).toContain('"available":false'); // the open loan it came back with
        for (const secret of [...SECRETS, 'borrower', 'contact']) expect(body, `${path}: ${secret}`).not.toContain(secret);
      }
    });
  });
});

describe('loans to connected households', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('export as ordinary loans under the name they were lent to, and come back as local loans', async () => {
    const shelf = (await createLibrary(env.DB, 'Main')).id;
    const keys = await makeKeys();
    const a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    answerOutbound(() => json({}, 404));
    await setUpA();
    const peer = await makePeer('Riverbank library');
    await connectPeer(peer);
    await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelf, mediaType: null, status: null, owned: null });
    const item = await createItem(env.DB, { libraryId: shelf, title: 'The Overstory', copies: 2, details: '{}' });

    // their member asks twice and a member here lends both copies; one comes back
    const admin = await sessionCookie('admin');
    for (const requester of ['narain', 'O\'Hara; "the | elder" @ home']) {
      await a.signedPost('/federation/inbox', peer, borrowRequest(peer.url, item.id, await itemStamp(item), requester, null));
      const { id } = (await env.DB.prepare("SELECT id FROM borrow_requests WHERE status = 'pending' ORDER BY id DESC").first<{ id: number }>())!;
      await a.postForm(`/borrow-requests/${id}/accept`, { dueOn: '2026-12-01' }, admin);
    }
    const first = (await env.DB.prepare('SELECT min(id) AS id FROM loans').first<{ id: number }>())!.id;
    await a.postForm(`/loans/${first}/return`, {}, admin);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM connection_loans').first<{ n: number }>())!.n).toBe(2); // control: linked
    const before = await loansOf(item.id);
    expect(before.map((l) => l.borrower)).toEqual(['narain (Riverbank library)', 'O\'Hara; "the | elder" @ home (Riverbank library)']);

    const rows = await exportRows(admin);
    const outbox = (await env.DB.prepare('SELECT count(*) AS n FROM outbox').first<{ n: number }>())!.n;
    const target = (await createLibrary(env.DB, 'Restored')).id;
    await importRows(admin, target, rows);
    const copy = await idOf('The Overstory', target);

    expect(await loansOf(copy)).toEqual(before);
    // local loans: no link to the household, and nothing queued for it — returning one tells nobody
    const links = await env.DB.prepare('SELECT count(*) AS n FROM connection_loans WHERE loan_id IN (SELECT id FROM loans WHERE item_id = ?1)').bind(copy).first<{ n: number }>();
    expect(links!.n).toBe(0);
    const open = (await env.DB.prepare('SELECT id FROM loans WHERE item_id = ?1 AND returned_on IS NULL').bind(copy).first<{ id: number }>())!.id;
    await a.postForm(`/loans/${open}/return`, {}, admin);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM outbox').first<{ n: number }>())!.n).toBe(outbox);
  });
});
