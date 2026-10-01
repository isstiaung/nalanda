// Borrowed from someone not on Nalanda (ARCH.md §16 #82): an item not owned with a borrow record — recorded from its
// page, shown as a pill and on the Borrowed page, a Holding filter, a CSV cell shaped like `loans`, in the trash's
// snapshot — and private like loans: never on a share page.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  activeBorrows,
  borrowHistory,
  borrowIfNotOwned,
  bulkSetOwned,
  createItem,
  createLibrary,
  createShare,
  exportCellsForIdRange,
  getItem,
  listMembersWithKeys,
  listTrash,
  memberKeys,
  restoreFromTrash,
  returnBorrow,
  trashItems,
} from '../src/db/queries';
import type { NewItem } from '../src/db/schema';
import { formatLoansCell, parseLoansCell } from '../src/lib/loans';
import { mapNalandaRow } from '../src/lib/csv';
import { newShareToken } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import app from '../src/index';
import { as, html, member, rows } from './member-helpers';

async function shelf() {
  const lib = await createLibrary(env.DB, 'Books');
  const item = (values: Partial<NewItem>) => createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'x', ...values });
  return { lib, item };
}

const borrowed = (itemId: number) => rows<{ id: number; lender: string; returned_on: string | null; due_on: string | null }>('SELECT id, lender, returned_on, due_on FROM borrows WHERE item_id = ?1 ORDER BY id', itemId);

describe('recording a borrow', () => {
  it('is any member’s, on an item not owned, one open at a time — and refused on an owned copy', async () => {
    const { item } = await shelf();
    const ravi = await member('ravi');
    const book = await item({ title: 'Borrowed book', copies: 0 });
    const own = await item({ title: 'Own book' });
    const res = await as(ravi, `/items/${book.id}/borrow`, { body: { lender: '  Priya ', contact: 'priya@example.org', dueOn: '2099-01-15', note: 'Hardback' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/items/${book.id}`);
    expect((await borrowed(book.id)).map((b) => [b.lender, b.due_on, b.returned_on])).toEqual([['Priya', '2099-01-15', null]]);
    // a second open borrow is refused with a reason; a nameless post records nothing and goes back to the page
    expect((await as(ravi, `/items/${book.id}/borrow`, { body: { lender: 'Someone else' } })).status).toBe(409);
    expect((await as(ravi, `/items/${book.id}/borrow`, { body: { lender: '  ' } })).status).toBe(302);
    expect(await borrowed(book.id)).toHaveLength(1);
    // never on an owned copy, and a due date that isn't a calendar date is none
    expect((await as(ravi, `/items/${own.id}/borrow`, { body: { lender: 'Priya' } })).status).toBe(400);
    expect(await borrowIfNotOwned(env.DB, { itemId: own.id, lender: 'Priya', borrowedOn: '2026-10-01', contact: null, dueOn: null, note: null })).toBe(false);
    const loose = await item({ title: 'Loose date', copies: 0 });
    await as(ravi, `/items/${loose.id}/borrow`, { body: { lender: 'Asha', dueOn: 'next week' } });
    expect((await borrowed(loose.id))[0]!.due_on).toBeNull();
  });

  it('shows on the item page — the line, the pill, the history once returned, and the form again', async () => {
    const { item } = await shelf();
    const ravi = await member('ravi');
    const book = await item({ title: 'Borrowed book', copies: 0 });
    const before = await html(ravi, `/items/${book.id}`);
    expect(before).toContain('name="lender"');
    expect(before).not.toContain('Borrowed from <strong>');
    await as(ravi, `/items/${book.id}/borrow`, { body: { lender: 'Priya', dueOn: '2020-01-01', note: 'Hardback' } });
    const page = await html(ravi, `/items/${book.id}`);
    expect(page).toContain('Borrowed from <strong>Priya</strong>');
    expect(page).toContain('due back <span class="mono">2020-01-01</span>');
    expect(page).toContain('— overdue'); // said in words, the date long past
    expect(page).toContain('Hardback');
    expect(page).toContain('<span class="pill borrowed">Borrowed</span>');
    expect(page).not.toContain('name="lender"'); // one open borrow at a time: no form
    expect(page).toContain('Mark returned');
    // returned from the page: back to the page, the history line, the form again, the pill gone
    const id = (await borrowed(book.id))[0]!.id;
    const back = await as(ravi, `/borrows/${id}/return`, { body: {} });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/borrowed'); // no Referer in the test: the Borrowed page
    const after = await html(ravi, `/items/${book.id}`);
    expect(after).toMatch(/Borrowed from Priya, <span class="mono">\d{4}-\d{2}-\d{2}<\/span> to <span class="mono">\d{4}-\d{2}-\d{2}<\/span>/);
    expect(after).toContain('name="lender"');
    expect(after).not.toContain('pill borrowed');
    // returning twice keeps the first date
    const returned_on = (await borrowed(book.id))[0]!.returned_on;
    await returnBorrow(env.DB, id, '2030-01-01');
    expect((await borrowed(book.id))[0]!.returned_on).toBe(returned_on);
  });

  it('badges the item on the shelf, in search and on cards — and only while not owned', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const book = await item({ title: 'Borrowed Earthsea', copies: 0 });
    const plain = await item({ title: 'Plain Earthsea', copies: 0 });
    await as(ravi, `/items/${book.id}/borrow`, { body: { lender: 'Priya' } });
    const table = await html(ravi, `/libraries/${lib.id}`);
    const row = (page: string, id: number) => page.slice(page.indexOf(`/items/${id}`), page.indexOf('</tr>', page.indexOf(`/items/${id}`)));
    expect(row(table, book.id)).toContain('pill borrowed');
    expect(row(table, plain.id)).not.toContain('pill borrowed');
    expect((await html(ravi, `/libraries/${lib.id}?view=grid`)).match(/pill borrowed/g)).toHaveLength(1);
    expect(row(await html(ravi, '/search?q=earthsea'), book.id)).toContain('pill borrowed');
    // it can't be marked owned while borrowed (below); once returned and then owned, the pill goes with Not owned
    await as(ravi, `/items/${book.id}/mark-owned`, { body: {} });
    expect(await html(ravi, `/libraries/${lib.id}`)).toContain('pill borrowed');
    await returnBorrow(env.DB, (await borrowed(book.id))[0]!.id, '2026-10-01');
    expect(await html(ravi, `/libraries/${lib.id}`)).not.toContain('pill borrowed');
    await as(ravi, `/items/${book.id}/mark-owned`, { body: {} });
    expect(await html(ravi, `/libraries/${lib.id}`)).not.toContain('pill borrowed');
    expect(await borrowed(book.id)).toHaveLength(1); // the record stays
  });
});

describe('the Borrowed page and the Holding filter', () => {
  it('is for every household: lists what is borrowed from people, overdue flagged, returns from there, and keeps the history', async () => {
    const { item } = await shelf();
    const ravi = await member('ravi');
    const late = await item({ title: 'Late book', copies: 0 });
    const fine = await item({ title: 'Fine book', copies: 0 });
    await as(ravi, `/items/${late.id}/borrow`, { body: { lender: 'Priya', contact: 'priya@example.org', dueOn: '2020-01-01' } });
    await as(ravi, `/items/${fine.id}/borrow`, { body: { lender: 'Asha', dueOn: '2099-12-31' } });
    // the sidebar links it without connections
    expect(await html(ravi, '/')).toContain('href="/borrowed"');
    const page = await html(ravi, '/borrowed');
    expect(page).toContain('2 FROM PEOPLE');
    expect(page).not.toContain('FROM CONNECTIONS'); // no connections here: only the people sections
    expect(page).toContain('Priya');
    expect(page).toContain('priya@example.org');
    const lateRow = page.slice(page.indexOf(`/items/${late.id}`), page.indexOf('</tr>', page.indexOf(`/items/${late.id}`)));
    expect(lateRow).toContain('pill overdue');
    const fineRow = page.slice(page.indexOf(`/items/${fine.id}`), page.indexOf('</tr>', page.indexOf(`/items/${fine.id}`)));
    expect(fineRow).not.toContain('pill overdue');
    expect((await activeBorrows(env.DB)).map((b) => b.itemTitle)).toEqual(['Fine book', 'Late book']);
    // returned from the page
    const id = (await borrowed(late.id))[0]!.id;
    const back = await as(ravi, `/borrows/${id}/return`, { body: {} });
    expect(back.headers.get('location')).toBe('/borrowed');
    const after = await html(ravi, '/borrowed');
    expect(after).toContain('1 FROM PEOPLE');
    expect(after).toContain('Returned to people');
    expect((await borrowHistory(env.DB)).map((b) => b.itemTitle)).toEqual(['Late book']);
  });

  it('filters a shelf to what is borrowed, alone or beside Owned — in the app only, never a key of the publish form', async () => {
    const { lib, item } = await shelf();
    const admin = await member('admin', 'admin');
    const owned = await item({ title: 'Owned one' });
    const notOwned = await item({ title: 'Logged one', copies: 0 });
    const fromPriya = await item({ title: 'Borrowed one', copies: 0 });
    const returned = await item({ title: 'Returned one', copies: 0 });
    await as(admin, `/items/${fromPriya.id}/borrow`, { body: { lender: 'Priya' } });
    await as(admin, `/items/${returned.id}/borrow`, { body: { lender: 'Asha' } });
    await returnBorrow(env.DB, (await borrowed(returned.id))[0]!.id, '2026-09-01');
    const titles = (page: string) => [owned, notOwned, fromPriya, returned].filter((i) => page.includes(`/items/${i.id}`)).map((i) => i.title);
    expect(titles(await html(admin, `/libraries/${lib.id}?owned=b`))).toEqual(['Borrowed one']);
    expect(titles(await html(admin, `/libraries/${lib.id}?owned=1&owned=b`))).toEqual(['Owned one', 'Borrowed one']);
    expect(titles(await html(admin, `/libraries/${lib.id}?owned=0&owned=b`))).toEqual(['Logged one', 'Borrowed one', 'Returned one']);
    expect(titles(await html(admin, `/libraries/${lib.id}?owned=0`))).toEqual(['Logged one', 'Borrowed one', 'Returned one']);
    const page = await html(admin, `/libraries/${lib.id}?owned=b`);
    expect(page).toMatch(/name="owned" value="b" checked/);
    const publish = page.slice(page.indexOf('action="/shares"'), page.indexOf('</form>', page.indexOf('action="/shares"')));
    expect(publish).not.toContain('name="owned"'); // a share captures owned alone; with Borrowed among the choices it captures nothing
  });
});

describe('theirs until returned', () => {
  it('refuses to count a copy as yours while a borrow is open — the Holding toggle and the edit form — and allows it once returned', async () => {
    const { lib, item } = await shelf();
    const ravi = await member('ravi');
    const book = await item({ title: 'Lent to us', copies: 0 });
    await as(ravi, `/items/${book.id}/borrow`, { body: { lender: 'Priya' } });
    const toggled = await as(ravi, `/items/${book.id}/mark-owned`, { body: {}, htmx: true });
    expect(toggled.status).toBe(200);
    const swap = await toggled.text();
    expect(swap).toContain('Borrowed from Priya — mark it returned first.');
    expect(swap).toContain('mark-owned'); // the same button again, not the owned one
    expect((await getItem(env.DB, book.id))!.copies).toBe(0);
    const edited = await as(ravi, `/items/${book.id}`, { body: { title: 'Lent to us', libraryId: String(lib.id), mediaType: 'book', copies: '1' } });
    expect(edited.status).toBe(400);
    expect(await edited.text()).toContain('Borrowed from Priya — mark it returned before counting a copy as yours.');
    expect((await getItem(env.DB, book.id))!.copies).toBe(0);
    // a save that keeps it not owned goes through
    expect((await as(ravi, `/items/${book.id}`, { body: { title: 'Lent to us, renamed', libraryId: String(lib.id), mediaType: 'book', copies: '0' } })).status).toBe(302);
    // returned: the toggle and the form both take it
    await returnBorrow(env.DB, (await borrowed(book.id))[0]!.id, '2026-10-01');
    expect(await (await as(ravi, `/items/${book.id}/mark-owned`, { body: {}, htmx: true })).text()).toContain('mark-not-owned');
    expect((await getItem(env.DB, book.id))!.copies).toBe(1);
  });

  it('is skipped by bulk edit’s "Mark owned", and counted as skipped', async () => {
    const { item } = await shelf();
    const ravi = await member('ravi');
    const lent = await item({ title: 'Lent to us', copies: 0 });
    const plain = await item({ title: 'Plain', copies: 0 });
    await as(ravi, `/items/${lent.id}/borrow`, { body: { lender: 'Priya' } });
    expect(await bulkSetOwned(env.DB, [lent.id, plain.id], true)).toMatchObject({ found: 2, changed: 1, skipped: 1 });
    expect((await getItem(env.DB, lent.id))!.copies).toBe(0);
    expect((await getItem(env.DB, plain.id))!.copies).toBe(1);
    // the other direction is untouched by a borrow
    expect(await bulkSetOwned(env.DB, [plain.id], false)).toMatchObject({ changed: 1, skipped: 0 });
  });

  it('reads nothing of connections on a household without a key: the Borrowed page is its own two reads', async () => {
    const ravi = await member('ravi');
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request('http://nalanda.test/borrowed', { headers: { cookie: ravi.cookie } }), { ...env, DB: budgeted(env.DB, budget) } as Bindings, ctx);
    expect(res.status).toBe(200);
    await res.text();
    await waitOnExecutionContext(ctx);
    // the session's member and the sidebar's shelves, then what is borrowed from people and what was returned —
    // the connections' three reads (borrowed items, requests, connections) would make it seven
    expect(1000 - budget.left).toBe(4);
  });
});

describe('what leaves the app', () => {
  it('round-trips as the export’s borrowed cell, shaped like loans, and comes back through the import and the trash', async () => {
    const { lib, item } = await shelf();
    const admin = await member('admin', 'admin');
    const book = await item({ title: 'Borrowed book', copies: 0 });
    await borrowIfNotOwned(env.DB, { itemId: book.id, lender: 'Priya; the first', borrowedOn: '2026-01-10', contact: 'priya@example.org', dueOn: '2026-02-01', note: 'Hardback|signed' });
    await returnBorrow(env.DB, (await borrowed(book.id))[0]!.id, '2026-01-30');
    await borrowIfNotOwned(env.DB, { itemId: book.id, lender: 'Asha', borrowedOn: '2026-09-10', contact: null, dueOn: null, note: null });
    const cells = await exportCellsForIdRange(env.DB, book.id, book.id);
    const drafts = cells.borrows.get(book.id)!;
    expect(drafts.map((d) => [d.borrower, d.loanedOn, d.returnedOn])).toEqual([
      ['Priya; the first', '2026-01-10', '2026-01-30'],
      ['Asha', '2026-09-10', null],
    ]);
    const cell = formatLoansCell(drafts);
    expect(cell).toBe('2026-01-10..2026-01-30@Priya%3B%20the%20first|due:2026-02-01|contact:priya%40example.org|note:Hardback%7Csigned;2026-09-10..@Asha');
    expect(parseLoansCell(cell)).toEqual(drafts.map((d) => ({ ...d })));
    // the CSV carries it after quotes, and the import maps it back
    const csv = await (await as(admin, '/export.csv')).text();
    const header = csv.split('\n')[0]!.split(',');
    expect(header.indexOf('borrowed')).toBe(header.indexOf('quotes') + 1);
    const mapped = mapNalandaRow({ title: 'Borrowed book', media_type: 'book', copies: '0', borrowed: cell }, 'en');
    expect(mapped!.borrows).toEqual(parseLoansCell(cell));
    // an owned row keeps only the returned borrow: a copy of yours is never also someone's
    const owned = mapNalandaRow({ title: 'Borrowed book', media_type: 'book', copies: '1', borrowed: cell }, 'en');
    expect(owned!.borrows.map((b) => b.borrower)).toEqual(['Priya; the first']);
    expect(mapNalandaRow({ title: 'Borrowed book', media_type: 'book', borrowed: cell }, 'en')!.borrows).toHaveLength(1); // no copies cell reads as one copy
    // the trash snapshot carries them, and a restore brings them back
    await trashItems(env.DB, [book.id], { id: admin.id, sessionKey: admin.sessionKey });
    const [row] = await listTrash(env.DB);
    const outcome = await restoreFromTrash(env.DB, row!.id, memberKeys(await listMembersWithKeys(env.DB)));
    if ('refused' in outcome) throw new Error(outcome.refused);
    expect((await borrowed(outcome.id)).map((b) => [b.lender, b.returned_on])).toEqual([
      ['Priya; the first', '2026-01-30'],
      ['Asha', null],
    ]);
  });

  it('changes no byte of a share page, which has no key for it', async () => {
    const { lib, item } = await shelf();
    const admin = await member('admin', 'admin');
    const book = await item({ title: 'A friend’s book', copies: 0 });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Everything', libraryId: lib.id });
    const before = await (await as(null, `/share/${token}/items/${book.id}`)).text();
    const listBefore = await (await as(null, `/share/${token}`)).text();
    await as(admin, `/items/${book.id}/borrow`, { body: { lender: 'Priya', contact: 'priya@example.org', note: 'secret' } });
    clearSharePageCache();
    expect(await (await as(null, `/share/${token}/items/${book.id}`)).text()).toBe(before);
    expect(await (await as(null, `/share/${token}`)).text()).toBe(listBefore);
    expect(before).toContain('Not owned');
    expect(before).not.toContain('Priya');
    expect(before).not.toContain('pill borrowed');
  });
});
