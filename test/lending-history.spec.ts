// "Lent before" on an item's page: its returned loans, newest first, with how long each was out — local loans and
// loans to connected households alike, since both are ordinary loans kept with returned_on set. In-app only: a
// borrower is on the never-render list for share pages and connections.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, deleteConnection } from '../src/db/federation';
import { createItem, createLibrary, createLoan, createShare, createUser, LENDING_HISTORY_LIMIT } from '../src/db/queries';
import type { Item } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { itemStamp } from '../src/federation/items';
import { borrowRequest } from '../src/federation/messages';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import { newShareToken } from '../src/lib/share';
import { loanDays } from '../src/views/components';
import app from '../src/index';
import { expectOnlyBudgetErrors } from './console';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA, type Peer } from './federation-helpers';

async function adminCookie(): Promise<string> {
  const u = await createUser(env.DB, { username: 'admin', passwordHash: 'pbkdf2$1$x$y', role: 'admin', mustChangePassword: false });
  return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, u.id, Math.floor(Date.now() / 1000))}`;
}

async function get(path: string, cookie?: string, bindings: Bindings = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: cookie ? { cookie } : {} }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A loan with the dates given, returned or still out. */
async function loan(itemId: number, borrower: string, loanedOn: string, returnedOn: string | null) {
  await env.DB.prepare('INSERT INTO loans (item_id, borrower, loaned_on, returned_on) VALUES (?1, ?2, ?3, ?4)')
    .bind(itemId, borrower, loanedOn, returnedOn)
    .run();
}

const SECTION = /<div class="detail-section lending-history">([\s\S]*?)<\/div>/;
const section = (html: string) => SECTION.exec(html)?.[1] ?? null;
/** Each line of the history as its text: "borrower | from → to | length". */
const lines = (html: string) =>
  [...(section(html) ?? '').matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) =>
    [...m[1]!.matchAll(/<(?:strong|span)[^>]*>([\s\S]*?)<\/(?:strong|span)>/g)].map((p) => p[1]!.trim()).join(' | '),
  );

let shelf: number;
let cookie: string;
beforeEach(async () => {
  shelf = (await createLibrary(env.DB, 'Main')).id;
  cookie = await adminCookie();
});

describe('loanDays', () => {
  it('counts whole days, 0 for the same day, and gives up on anything that is not a plain date', () => {
    expect(loanDays('2026-01-01', '2026-01-19')).toBe(18);
    expect(loanDays('2026-02-27', '2026-03-01')).toBe(2); // across a month end
    expect(loanDays('2024-02-28', '2024-03-01')).toBe(2); // and a leap day
    expect(loanDays('2026-03-28', '2026-03-30')).toBe(2); // UTC days: no DST hour to round away
    expect(loanDays('2026-05-05', '2026-05-05')).toBe(0);
    expect(loanDays('2026-05-05', '2026-05-04')).toBeNull(); // back before it went out
    expect(loanDays('2026-05-05', 'yesterday')).toBeNull();
    expect(loanDays('2026-05-05 10:00:00', '2026-05-06')).toBeNull();
    expect(loanDays('2026-02-27', '2026-02-30')).toBeNull(); // not a day, rather than 3 days into March
    expect(loanDays('2026-13-01', '2027-01-02')).toBeNull();
  });
});

describe('Lent before, on the item page', () => {
  it('lists returned loans newest first, each with its span and how many days it was out', async () => {
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Wingspan', copies: 1 });
    await loan(item.id, 'Asha', '2025-11-02', '2025-11-20');
    await loan(item.id, 'Bilal', '2026-03-10', '2026-03-11');
    await loan(item.id, 'Chitra', '2026-01-05', '2026-01-05');
    await loan(item.id, 'Dev', '2026-06-01', '2026-07-01');

    const html = await (await get(`/items/${item.id}`, cookie)).text();

    expect(html).toContain('<p class="eyebrow">Lent before</p>');
    expect(lines(html)).toEqual([
      'Dev | 2026-06-01 → 2026-07-01 | 30 days',
      'Bilal | 2026-03-10 → 2026-03-11 | 1 day',
      'Chitra | 2026-01-05 → 2026-01-05 | same day',
      'Asha | 2025-11-02 → 2025-11-20 | 18 days',
    ]);
    expect(html).not.toContain('earlier</p>');
  });

  it('orders two loans lent the same day by which was made last', async () => {
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Two copies', copies: 2 });
    await loan(item.id, 'First', '2026-04-01', '2026-04-03');
    await loan(item.id, 'Second', '2026-04-01', '2026-04-02');
    expect(lines(await (await get(`/items/${item.id}`, cookie)).text()).map((l) => l.split(' | ')[0])).toEqual(['Second', 'First']);
  });

  it('leaves a loan still out to the Circulation box, and lists it once it comes back', async () => {
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Catan', copies: 2 });
    await loan(item.id, 'Returned Ravi', '2026-01-01', '2026-01-08');
    await createLoan(env.DB, { itemId: item.id, borrower: 'Current Cara', dueOn: '2099-01-01' });

    const html = await (await get(`/items/${item.id}`, cookie)).text();
    expect(lines(html)).toEqual(['Returned Ravi | 2026-01-01 → 2026-01-08 | 7 days']);
    expect(section(html)).not.toContain('Current Cara');
    expect(html.match(/Current Cara/g)).toHaveLength(1); // once, in Circulation — the current-loan UI as before
    expect(html).toContain('Lent to <strong>Current Cara</strong>');

    const [{ id }] = (await env.DB.prepare("SELECT id FROM loans WHERE borrower = 'Current Cara'").all<{ id: number }>()).results as [{ id: number }];
    const ctx = createExecutionContext();
    await app.fetch(
      new Request(`http://nalanda.test/loans/${id}/return`, { method: 'POST', headers: { cookie, origin: 'http://nalanda.test' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const after = await (await get(`/items/${item.id}`, cookie)).text();
    const today = new Date().toISOString().slice(0, 10);
    expect(lines(after)).toContain(`Current Cara | ${today} → ${today} | same day`);
    expect(after).not.toContain('Lent to <strong>Current Cara</strong>');
  });

  it(`shows the latest ${LENDING_HISTORY_LIMIT} of a long history, and counts the rest`, async () => {
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Much lent', copies: 1 });
    const statements = Array.from({ length: 27 }, (_, i) =>
      env.DB.prepare('INSERT INTO loans (item_id, borrower, loaned_on, returned_on) VALUES (?1, ?2, ?3, ?4)').bind(
        item.id,
        `Borrower ${String(i + 1).padStart(2, '0')}`,
        `2025-${String(Math.floor(i / 3) + 1).padStart(2, '0')}-${String((i % 3) * 10 + 1).padStart(2, '0')}`,
        `2025-${String(Math.floor(i / 3) + 1).padStart(2, '0')}-${String((i % 3) * 10 + 5).padStart(2, '0')}`,
      ),
    );
    await env.DB.batch(statements);

    const html = await (await get(`/items/${item.id}`, cookie)).text();
    const shown = lines(html).map((l) => l.split(' | ')[0]);
    expect(shown).toHaveLength(LENDING_HISTORY_LIMIT);
    expect(shown[0]).toBe('Borrower 27');
    expect(shown.at(-1)).toBe('Borrower 08');
    expect(html).not.toContain('Borrower 07');
    expect(html).toContain('<p class="muted loan-history-more">and 7 earlier</p>');
  });

  it('has no section, not even an empty one, without a past loan', async () => {
    const never = await createItem(env.DB, { libraryId: shelf, title: 'Never lent', copies: 1 });
    const outNow = await createItem(env.DB, { libraryId: shelf, title: 'Out now', copies: 1 });
    await createLoan(env.DB, { itemId: outNow.id, borrower: 'First borrower' });
    for (const item of [never, outNow]) {
      const html = await (await get(`/items/${item.id}`, cookie)).text();
      expect(html, item.title).toContain('<p class="eyebrow">Circulation</p>'); // the page rendered
      expect(html, item.title).not.toContain('Lent before');
      expect(html, item.title).not.toContain('lending-history');
    }
  });

  it('keeps its history once the item is no longer in the physical collection', async () => {
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Given away', copies: 0 });
    await loan(item.id, 'Old friend', '2024-05-01', '2024-06-01');
    const html = await (await get(`/items/${item.id}`, cookie)).text();
    expect(html).toContain('Not in the physical collection');
    expect(lines(html)).toEqual(['Old friend | 2024-05-01 → 2024-06-01 | 31 days']);
  });

  it('costs one D1 call however long the history, and the page stays inside the budget', async () => {
    const calls = async (id: number) => {
      const budget = { left: 1000 };
      const res = await get(`/items/${id}`, cookie, { ...env, DB: budgeted(env.DB, budget) } as Bindings);
      expect(res.status).toBe(200);
      return 1000 - budget.left;
    };
    const none = await createItem(env.DB, { libraryId: shelf, title: 'None', copies: 1 });
    const one = await createItem(env.DB, { libraryId: shelf, title: 'One', copies: 1 });
    const many = await createItem(env.DB, { libraryId: shelf, title: 'Many', copies: 1 });
    await loan(one.id, 'Solo', '2026-01-01', '2026-01-02');
    for (let i = 0; i < 30; i++) await loan(many.id, `B${i}`, '2026-01-01', '2026-01-02');

    const counts = { none: await calls(none.id), one: await calls(one.id), many: await calls(many.id) };
    console.info(`item page D1 calls: ${JSON.stringify(counts)}`);
    expect(counts.one).toBe(counts.none);
    expect(counts.many).toBe(counts.none);
    expect(counts.many).toBeLessThanOrEqual(50);

    // the count is exact: one call short and the page can't be built (a control on the count above)
    expectOnlyBudgetErrors();
    const short = { left: counts.none - 1 };
    const failed = await get(`/items/${many.id}`, cookie, { ...env, DB: budgeted(env.DB, short) } as Bindings);
    expect(failed.status).toBe(500);
  });
});

describe('never outside the app', () => {
  it('stays off a share page of the same item, which the app page shows it on', async () => {
    const item = await createItem(env.DB, { libraryId: shelf, title: 'Shared and lent', copies: 1 });
    await loan(item.id, 'Secret Sunita', '2026-02-01', '2026-02-14');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Everything', libraryId: shelf });

    const inApp = await (await get(`/items/${item.id}`, cookie)).text();
    expect(inApp).toContain('Secret Sunita'); // control: there is history to leak
    for (const path of [`/share/${token}`, `/share/${token}/items/${item.id}`]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('Shared and lent');
      for (const secret of ['Secret Sunita', 'Lent before', 'lending-history', '2026-02-01', '2026-02-14', '13 days']) {
        expect(html, `${path}: ${secret}`).not.toContain(secret);
      }
    }
  });
});

describe('loans to connected households', () => {
  let a: ReturnType<typeof instanceA>;
  let peer: Peer;
  let connectionId: number;
  let item: Item;

  beforeEach(async () => {
    const keys = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    answerOutbound(() => json({}, 404)); // pushes and pulls go nowhere
    await setUpA();
    peer = await makePeer('Riverbank library');
    connectionId = (await connectPeer(peer)).id;
    await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelf, mediaType: null, status: null, owned: null });
    item = await createItem(env.DB, { libraryId: shelf, title: 'The Overstory', copies: 1 });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Their member asks, a member here lends, and the book comes back. */
  async function lendAndReturn(requester: string) {
    await a.signedPost('/federation/inbox', peer, borrowRequest(peer.url, item.id, await itemStamp(item), requester, null));
    const member = await sessionCookie('member');
    const { id: requestId } = (await env.DB.prepare('SELECT id FROM borrow_requests ORDER BY id DESC').first<{ id: number }>())!;
    await a.postForm(`/borrow-requests/${requestId}/accept`, {}, member);
    const { id: loanId } = (await env.DB.prepare('SELECT id FROM loans WHERE returned_on IS NULL').first<{ id: number }>())!;
    await a.postForm(`/loans/${loanId}/return`, {}, member);
    return loanId;
  }

  it('keeps their loans once returned, and names them "household (their member)"', async () => {
    await loan(item.id, 'Local Lata', '2025-01-01', '2025-01-10');
    await lendAndReturn('narain');
    // the loan the connection made, as stored — the history renders it the other way round
    expect(await env.DB.prepare('SELECT borrower FROM loans WHERE returned_on IS NOT NULL ORDER BY id DESC').first()).toEqual({
      borrower: 'narain (Riverbank library)',
    });

    const html = await (await a.get(`/items/${item.id}`, cookie)).text();
    const today = new Date().toISOString().slice(0, 10);
    expect(lines(html)).toEqual([`Riverbank library (narain) | ${today} → ${today} | same day`, 'Local Lata | 2025-01-01 → 2025-01-10 | 9 days']);
  });

  it('shows their names as text, and falls back to the borrower it was lent to once the connection is gone', async () => {
    await lendAndReturn('<img src=x onerror=alert(1)>');
    const html = await (await a.get(`/items/${item.id}`, cookie)).text();
    expect(section(html)).toContain('Riverbank library (&lt;img src=x onerror=alert(1)&gt;)');
    expect(section(html)).not.toContain('<img');

    await deleteConnection(env.DB, connectionId); // connection_loans cascades; the loan stays
    const after = await (await a.get(`/items/${item.id}`, cookie)).text();
    expect(lines(after)[0]).toMatch(/^&lt;img src=x onerror=alert\(1\)&gt; \(Riverbank library\) \| /);
  });

  it('never reaches the connection: its item page and shelf carry no borrower, dates or history', async () => {
    await loan(item.id, 'Secret Sunita', '2026-02-01', '2026-02-14');
    await lendAndReturn('narain');
    expect(await (await a.get(`/items/${item.id}`, cookie)).text()).toContain('Secret Sunita'); // control: there is history

    for (const path of [`/federation/item?view=1&id=${item.id}`, '/federation/shelf?view=1&page=1']) {
      const res = await a.signedGet(path, peer);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).toContain('The Overstory');
      for (const secret of ['Secret Sunita', 'narain', 'Lent before', '2026-02-01', '2026-02-14', 'borrower', 'returned']) {
        expect(body, `${path}: ${secret}`).not.toContain(secret);
      }
    }
  });
});
