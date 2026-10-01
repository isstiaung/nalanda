// The circulation-side UI sweep (1.6.1): an overdue loan keeps its date, Loans says when its history is capped,
// Year in review's plurals and key, an expired invitation that can be removed, and a shared item's length unit.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInvite } from '../src/db/federation';
import { addPastRead, createItem, createLibrary, createShare, logPlay } from '../src/db/queries';
import { MEDIA_TYPES, type MediaType } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { todayUtc } from '../src/lib/reads';
import { newShareToken } from '../src/lib/share';
import { LENGTH_UNIT } from '../src/views/components';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA } from './federation-helpers';
import { as, book, member, rows } from './member-helpers';

const squash = (s: string) => s.replace(/\s+/g, ' ');
const dayOffset = (days: number) => new Date(Date.parse(`${todayUtc()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The Due cell of the row naming `title`. */
function dueCell(html: string, title: string): string {
  const row = squash(html)
    .split('<tr>')
    .find((r) => r.includes(title));
  expect(row, title).toBeTruthy();
  return row!.match(/<td class="date due-cell"[^>]*>(.*?)<\/td>/)![1]!;
}

describe('an overdue loan keeps its due date', () => {
  it('on Loans: due yesterday shows the date and the pill, due today the date only', async () => {
    const admin = await member('asha', 'admin');
    const late = await book(admin, { title: 'Late book', copies: 1 });
    const today = await book(admin, { title: 'Today book', copies: 1 });
    await env.DB.prepare('INSERT INTO loans (item_id, borrower, due_on) VALUES (?1, ?2, ?3), (?4, ?2, ?5)')
      .bind(late.id, 'Priya', dayOffset(-1), today.id, todayUtc())
      .run();
    const html = await (await as(admin, '/loans')).text();

    const lateCell = dueCell(html, 'Late book');
    expect(lateCell).toContain(`<span>${dayOffset(-1)}</span>`);
    expect(lateCell).toContain('<span class="pill overdue">Overdue</span>');
    const todayCell = dueCell(html, 'Today book');
    expect(todayCell).toContain(`<span>${todayUtc()}</span>`);
    expect(todayCell).not.toContain('Overdue');
  });

  describe('on Borrowed', () => {
    let fed: ReturnType<typeof instanceA>;
    beforeEach(async () => {
      const keys = await makeKeys();
      fed = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
      answerOutbound(() => json({}, 404));
      await setUpA();
    });
    afterEach(() => vi.unstubAllGlobals());

    it('due yesterday shows the date and the pill, due today the date only', async () => {
      const connection = await connectPeer(await makePeer('The Okafor Household'));
      await env.DB.prepare(
        `INSERT INTO borrowed_items (connection_id, request_activity_id, their_item_id, title, borrowed_on, due_on)
         VALUES (?1, 'act-late', 1, 'Late book', ?2, ?3), (?1, 'act-today', 2, 'Today book', ?2, ?4)`,
      )
        .bind(connection.id, dayOffset(-10), dayOffset(-1), todayUtc())
        .run();
      const html = await (await fed.get('/borrowed', await sessionCookie('admin'))).text();

      const lateCell = dueCell(html, 'Late book');
      expect(lateCell).toContain(`<span>${dayOffset(-1)}</span>`);
      expect(lateCell).toContain('<span class="pill overdue">Overdue</span>');
      const todayCell = dueCell(html, 'Today book');
      expect(todayCell).toContain(`<span>${todayUtc()}</span>`);
      expect(todayCell).not.toContain('Overdue');
    });
  });
});

describe('the loan counts past the 200 the Loans page lists', () => {
  it('count every open loan and every overdue one in SQL, on the Overview and on Loans, where the table stays capped', async () => {
    const admin = await member('asha', 'admin');
    const item = await book(admin, { title: 'Lent everywhere', copies: 1 });
    // 205 open loans long overdue, made first — the oldest, which a list of the newest 200 drops — and one due later
    const late = Array.from({ length: 205 }, (_, i) => `(${item.id}, 'Borrower ${i}', '2026-01-01', '2000-01-01')`).join(', ');
    await env.DB.prepare(`INSERT INTO loans (item_id, borrower, loaned_on, due_on) VALUES ${late}`).run();
    await env.DB.prepare(`INSERT INTO loans (item_id, borrower, loaned_on, due_on) VALUES (?1, 'On time', '2026-01-01', ?2)`).bind(item.id, dayOffset(30)).run();
    const overview = squash(await (await as(admin, '/')).text());
    expect(overview).toMatch(/<div class="stat-n">206<\/div>\s*<div class="stat-label">On loan<\/div>/);
    expect(overview).toMatch(/<div class="stat-n warn">205<\/div>\s*<div class="stat-label">Overdue<\/div>/);
    expect(overview).toContain('206 items out · <span class="error">205 overdue</span>');
    const loans = squash(await (await as(admin, '/loans')).text());
    expect(loans).toContain('206 OUT · 0 RETURNED');
    expect(loans).toContain('<p class="eyebrow">Out now · newest 200</p>');
    expect(loans.match(/Mark returned/g)).toHaveLength(200);
    // a return moves both counts
    const [oldest] = await rows<{ id: number }>('SELECT id FROM loans WHERE returned_on IS NULL ORDER BY id LIMIT 1');
    expect((await as(admin, `/loans/${oldest!.id}/return`, { body: {} })).status).toBe(302);
    const after = squash(await (await as(admin, '/loans')).text());
    expect(after).toContain('205 OUT · 1 RETURNED');
    expect(after).toContain('<p class="eyebrow">Out now · newest 200</p>');
    expect(await (await as(admin, '/')).text()).toMatch(/<div class="stat-n warn">204<\/div>\s*<div class="stat-label">Overdue<\/div>/);
  });

  it('say nothing of a cap while the table lists everything', async () => {
    const admin = await member('asha', 'admin');
    const item = await book(admin, { title: 'Lent once', copies: 1 });
    await env.DB.prepare("INSERT INTO loans (item_id, borrower, loaned_on, due_on) VALUES (?1, 'Priya', '2026-01-01', ?2)").bind(item.id, dayOffset(-1)).run();
    const loans = squash(await (await as(admin, '/loans')).text());
    expect(loans).toContain('1 OUT · 0 RETURNED');
    expect(loans).toContain('<p class="eyebrow">Out now</p>');
    const overview = squash(await (await as(admin, '/')).text());
    expect(overview).toMatch(/<div class="stat-n">1<\/div>\s*<div class="stat-label">On loan<\/div>/);
    expect(overview).toMatch(/<div class="stat-n warn">1<\/div>\s*<div class="stat-label">Overdue<\/div>/);
    expect(overview).toContain('1 item out · <span class="error">1 overdue</span>');
  });
});

describe('Loans says when its history is capped', () => {
  async function returned(n: number) {
    const admin = await member('asha', 'admin');
    const item = await book(admin, { title: 'Often lent', copies: 1 });
    const values = Array.from({ length: n }, (_, i) => `(${item.id}, 'Borrower ${i}', '2026-01-01', '2026-01-02')`).join(', ');
    await env.DB.prepare(`INSERT INTO loans (item_id, borrower, loaned_on, returned_on) VALUES ${values}`).run();
    return squash(await (await as(admin, '/loans')).text());
  }

  it.each([
    [99, '99 RETURNED', false],
    [100, '100 RETURNED', false],
    [101, '100+ RETURNED', true],
  ])('%i returned loans: "%s"', async (n, count, capped) => {
    const html = await returned(n);
    expect(html).toContain(`0 OUT · ${count}`);
    if (capped) expect(html).toContain('<p class="eyebrow">History · latest 100</p>');
    else expect(html).toContain('<p class="eyebrow">History</p>');
    // the table lists at most 100, whatever the count says
    expect(html.match(/Borrower \d+/g)).toHaveLength(Math.min(n, 100));
  });
});

describe('Year in review', () => {
  it('says "Spin" for one spin and "Plays" for two plays, and hides the You/Household key with plays but no books', async () => {
    const admin = await member('asha', 'admin');
    const record = await book(admin, { title: 'Kind of Blue', mediaType: 'vinyl' });
    const game = await book(admin, { title: 'Wingspan', mediaType: 'boardgame' });
    const year = todayUtc().slice(0, 4);
    await logPlay(env.DB, record.id, `${year}-01-05`, admin.id);
    await logPlay(env.DB, game.id, `${year}-01-05`, admin.id);
    await logPlay(env.DB, game.id, `${year}-01-06`, admin.id);

    const html = squash(await (await as(admin, `/year-in-review?year=${year}`)).text());
    const labels = [...html.matchAll(/<div class="stat-label">([^<]*)<\/div>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Spin', 'Plays']);
    expect(html).not.toContain('yr-intro');

    // a finished book brings the key back
    const dune = await book(admin, { title: 'Dune' });
    await addPastRead(env.DB, dune.id, { status: 'completed', beganOn: null, endedOn: `${year}-01-07` }, admin.id);
    expect(squash(await (await as(admin, `/year-in-review?year=${year}`)).text())).toContain('yr-intro');
  });
});

describe('an expired connection invitation', () => {
  let fed: ReturnType<typeof instanceA>;
  beforeEach(async () => {
    const keys = await makeKeys();
    fed = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    answerOutbound(() => json({}, 404));
    await setUpA();
  });
  afterEach(() => vi.unstubAllGlobals());

  const invites = () => rows<{ id: number }>('SELECT id FROM connection_invites ORDER BY id');

  async function expiredInvite() {
    const by = await member(`admin-${crypto.randomUUID().slice(0, 6)}`, 'admin');
    const invite = await createInvite(env.DB, { tokenHash: `hash-${crypto.randomUUID()}`, createdBy: by.id, ttlDays: 7 });
    await env.DB.prepare("UPDATE connection_invites SET expires_at = datetime('now', '-1 day') WHERE id = ?1").bind(invite.id).run();
    return invite;
  }

  it('has a Remove button, and an admin removes it', async () => {
    const admin = await sessionCookie('admin');
    const invite = await expiredInvite();
    const page = squash(await (await fed.get('/connections', admin)).text());
    expect(page).toContain(`action="/connections/invites/${invite.id}/revoke"`);
    expect(page).toMatch(/Expired<\/td>\s*<td class="actions-cell">.*?>\s*Remove\s*<\/button>/);

    const res = await fed.postForm(`/connections/invites/${invite.id}/revoke`, {}, admin);
    expect(res.status).toBe(302);
    expect(await invites()).toEqual([]);
  });

  it('is refused to a member, with 403', async () => {
    const invite = await expiredInvite();
    const res = await fed.postForm(`/connections/invites/${invite.id}/revoke`, {}, await sessionCookie('member'));
    expect(res.status).toBe(403);
    expect(await invites()).toEqual([{ id: invite.id }]);
  });

  it('never deletes a used one, and offers it no button', async () => {
    const admin = await sessionCookie('admin');
    const invite = await expiredInvite();
    await env.DB.prepare("UPDATE connection_invites SET used_at = datetime('now', '-2 days') WHERE id = ?1").bind(invite.id).run();
    expect(await (await fed.get('/connections', admin)).text()).not.toContain(`/connections/invites/${invite.id}/revoke`);

    await fed.postForm(`/connections/invites/${invite.id}/revoke`, {}, admin);
    expect(await invites()).toEqual([{ id: invite.id }]);
  });
});

describe("a shared item's length", () => {
  const lengthOf = (html: string) => squash(html).match(/<dt>Length<\/dt>\s*<dd class="mono">(.*?)<\/dd>/)?.[1]?.trim();

  it.each(MEDIA_TYPES.map((t) => [t]))('%s: the share page says what the item page says', async (mediaType: MediaType) => {
    const admin = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Shelf');
    const item = await createItem(env.DB, { libraryId: shelf.id, mediaType, title: `A ${mediaType}`, length: 304, details: '{}', addedBy: admin.id });
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Everything', libraryId: shelf.id });

    const expected = `304 ${LENGTH_UNIT[mediaType] ?? ''}`.trim();
    expect(lengthOf(await (await as(admin, `/items/${item.id}`)).text())).toBe(expected);
    expect(lengthOf(await (await as(null, `/share/${token}/items/${item.id}`)).text())).toBe(expected);
  });
});
