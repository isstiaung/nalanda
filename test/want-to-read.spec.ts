// Want lists, purchase links and gift lists (ARCH.md §16 #53): each member's own want list, the household's pasted
// "where to buy" links, and an admin publishing one member's list as a share link — exactly that list, nothing else.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  addPastRead,
  addProgress,
  closeRead,
  countMatchingItems,
  createLibrary,
  createLoan,
  createShare,
  deleteItem,
  deleteUser,
  getShareByToken,
  listItems,
  listShares,
  setDisplayName,
  setItemTags,
  setWant,
  startRead,
  updateItemWithTags,
  updateRead,
  updateSiteSettings,
} from '../src/db/queries';
import type { Item, Share } from '../src/db/schema';
import { budgeted } from '../src/federation/budget';
import { toConnectionItem } from '../src/federation/items';
import { mapLibibRow } from '../src/lib/csv';
import { checkPurchaseLink, parseLinksCell, parseWantsCell } from '../src/lib/links';
import { isWholeShelfShare, itemMatchesShare, newShareToken, shareFilters, shareVisibility, toGiftItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import { actor, as, book, html, member, rows, type Member } from './member-helpers';

const wantsOf = (userId: number) =>
  rows<{ itemId: number }>('SELECT item_id AS itemId FROM wants WHERE user_id = ?1 ORDER BY item_id', userId).then((r) => r.map((w) => w.itemId));
const linksOf = (itemId: number) => rows<{ id: number; label: string; url: string }>('SELECT id, label, url FROM purchase_links WHERE item_id = ?1 ORDER BY id', itemId);
const want = (who: Member, item: Item, on = true, htmx = false) =>
  as(who, `/items/${item.id}/want`, { body: { want: on ? '1' : '0' }, htmx });

/** A signed-out GET of a share page, from a fresh page cache — what a gift-giver sees. */
async function publicPage(path: string) {
  clearSharePageCache();
  const res = await as(null, path);
  return { status: res.status, text: await res.text() };
}

async function household() {
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  const shelf = await createLibrary(env.DB, 'Fiction');
  const other = await createLibrary(env.DB, 'Records');
  return { asha, ravi, shelf, other };
}

async function giftList(of: Member, by: Member): Promise<Share> {
  const res = await as(by, '/shares', { body: { wantUserId: String(of.id), wantUsername: of.name } });
  expect(res.status).toBe(302);
  const shares = await listShares(env.DB);
  return shares.at(-1)!;
}

// ---------- the want toggle ----------

describe('the want toggle', () => {
  it('puts a book on the signed-in member’s own list and takes it off, idempotently', async () => {
    const { asha, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    const page = await html(asha, `/items/${b.id}`);
    expect(page).toContain('aria-pressed="false"');
    expect(page).toContain('Want to read');

    expect((await want(asha, b)).status).toBe(302);
    expect(await wantsOf(asha.id)).toEqual([b.id]);
    const first = (await rows<{ at: string }>('SELECT created_at AS at FROM wants'))[0]!.at;
    await env.DB.prepare("UPDATE wants SET created_at = '2020-01-01 00:00:00'").run();
    await want(asha, b); // a double submit keeps the date it was first wanted, and one row
    expect(await rows('SELECT created_at AS at FROM wants')).toEqual([{ at: '2020-01-01 00:00:00' }]);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2} /);

    const partial = await (await want(asha, b, true, true)).text();
    expect(partial).toContain('aria-pressed="true"');
    expect(partial).not.toContain('<html'); // htmx gets the bar alone

    await want(asha, b, false);
    await want(asha, b, false);
    expect(await wantsOf(asha.id)).toEqual([]);
    expect((await want(asha, { ...b, id: 999_999 })).status).toBe(404);
  });

  it('says “Want” for a record or a game', async () => {
    const { asha, other } = await household();
    const lp = await book(asha, { libraryId: other.id, mediaType: 'vinyl', title: 'Blue' });
    const page = await html(asha, `/items/${lp.id}`);
    expect(page).toMatch(/<\/span> Want<\/button>/);
    expect(page).not.toContain('Want to read</button>');
  });

  it('adds a result that isn’t in the catalog as Not owned, on the adder’s list, in one go', async () => {
    const { asha, ravi, shelf } = await household();
    const candidate = {
      mediaType: 'book',
      title: 'The Fifth Season',
      creators: 'N. K. Jemisin',
      isbn13: '9780316229296',
      libraryId: String(shelf.id),
      details: '{}',
    };
    const res = await as(ravi, '/items', { body: { ...candidate, want: '1' } });
    expect(res.status).toBe(302);
    const [added] = await rows<{ id: number; copies: number; addedBy: number }>('SELECT id, copies, added_by AS addedBy FROM items');
    expect(added).toMatchObject({ copies: 0, addedBy: ravi.id });
    expect(res.headers.get('location')).toBe(`/items/${added!.id}`); // the item page, not the edit form
    expect(await wantsOf(ravi.id)).toEqual([added!.id]);
    expect(await wantsOf(asha.id)).toEqual([]);
    expect(await html(ravi, `/items/${added!.id}`)).toContain('Not owned');

    // the same ISBN again, by someone else: the want goes on the item already there, no second copy
    const again = await as(asha, '/items', { body: { ...candidate, want: '1' } });
    expect(again.headers.get('location')).toBe(`/items/${added!.id}`);
    expect(await rows('SELECT id FROM items')).toHaveLength(1);
    expect(await wantsOf(asha.id)).toEqual([added!.id]);

    // negative control: the ordinary "Add to shelf" button still adds an owned copy and no want
    await as(asha, '/items', { body: { ...candidate, isbn13: '' } });
    expect(await rows('SELECT copies FROM items ORDER BY id')).toEqual([{ copies: 0 }, { copies: 1 }]);
    expect(await wantsOf(asha.id)).toEqual([added!.id]);
  });

  it('is offered on every scan and search result', async () => {
    const { asha } = await household();
    const { CandidateCard } = await import('../src/views/components');
    const card = String(
      CandidateCard({
        candidate: { provider: 'openlibrary', mediaType: 'book', title: 'X', creators: null, publisher: null, published: null, description: null, length: null, isbn13: null, isbn10Upc: null, coverUrl: null, details: {} },
        libraries: [{ id: 1, name: 'Fiction', position: 0, shareToken: null, createdAt: '' }],
      } as never),
    );
    expect(card).toContain('name="want" value="1"');
    expect(asha).toBeTruthy();
  });
});

// ---------- each member's own list ----------

describe('each member’s want list', () => {
  it('is their own: one member’s toggle never touches another’s list', async () => {
    const { asha, ravi, shelf } = await household();
    const a = await book(asha, { libraryId: shelf.id, title: 'Asha wants this' });
    const r = await book(asha, { libraryId: shelf.id, title: 'Ravi wants this' });
    const both = await book(asha, { libraryId: shelf.id, title: 'Both want this' });
    await want(asha, a);
    await want(ravi, r);
    await want(asha, both);
    await want(ravi, both);
    await want(ravi, both, false); // ravi's change of mind leaves asha's want
    // a hand-made request can't name someone else: the route has no member to take
    await as(ravi, `/items/${a.id}/want`, { body: { want: '0', userId: String(asha.id), member: String(asha.id) } });
    expect(await wantsOf(asha.id)).toEqual([a.id, both.id]);
    expect(await wantsOf(ravi.id)).toEqual([r.id]);

    const mine = await html(ravi, '/wants');
    expect(mine).toContain('Ravi wants this');
    expect(mine).not.toContain('Asha wants this');
    expect(mine).toContain('Take off my list');
    // someone else's list can be looked at, not changed
    const hers = await html(ravi, `/wants?member=${asha.id}`);
    expect(hers).toContain('Asha wants this');
    expect(hers).toContain('Both want this');
    expect(hers).not.toContain('Ravi wants this');
    expect(hers).not.toContain('Take off my list');
    expect(hers).not.toContain('Publish as a gift list'); // members don't publish
    expect(await html(asha, `/wants?member=${ravi.id}`)).toContain('Publish as a gift list');

    // the item page says who else wants it, inside the app
    await want(ravi, both);
    expect(await html(asha, `/items/${both.id}`)).toContain('also wanted by ravi');
  });

  it('loses a book its member finishes — only theirs, only a book, and only a finish', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Kindred' });
    await setWant(env.DB, b.id, asha.id, true);
    await setWant(env.DB, b.id, ravi.id, true);
    await startRead(env.DB, b.id, '2026-09-01', ravi.id);
    const read = (await rows<{ id: number }>('SELECT id FROM reads WHERE reader_id = ?1', ravi.id))[0]!.id;

    // a finish refused — a member closing someone else's read — takes nothing off
    const mira = await member('mira');
    expect(await closeRead(env.DB, b.id, read, 'completed', '2026-09-20', actor(mira))).toBe(false);
    expect(await wantsOf(ravi.id)).toEqual([b.id]);

    expect(await closeRead(env.DB, b.id, read, 'abandoned', '2026-09-10', actor(ravi))).toBe(true);
    expect(await wantsOf(ravi.id)).toEqual([b.id]); // stopping isn't finishing: they still mean to read it

    await startRead(env.DB, b.id, '2026-09-11', ravi.id);
    const again = (await rows<{ id: number }>("SELECT id FROM reads WHERE reader_id = ?1 AND status = 'in_progress'", ravi.id))[0]!.id;
    expect(await closeRead(env.DB, b.id, again, 'completed', '2026-09-20', actor(ravi))).toBe(true);
    expect(await wantsOf(ravi.id)).toEqual([]);
    expect(await wantsOf(asha.id)).toEqual([b.id]); // someone else finishing it leaves hers
  });

  it('loses a book whose open read is corrected to Completed — by its reader, not by a refused hand', async () => {
    const { asha, ravi, shelf } = await household();
    const mira = await member('mira');
    const b = await book(asha, { libraryId: shelf.id, title: 'Beloved' });
    await setWant(env.DB, b.id, ravi.id, true);
    await startRead(env.DB, b.id, '2026-09-01', ravi.id);
    const read = (await rows<{ id: number }>('SELECT id FROM reads WHERE reader_id = ?1', ravi.id))[0]!.id;
    const done = { status: 'completed' as const, beganOn: '2026-09-01', endedOn: '2026-09-20' };
    expect(await updateRead(env.DB, b.id, read, done, actor(mira))).toBe(false); // not hers to correct
    expect(await wantsOf(ravi.id)).toEqual([b.id]);
    expect(await updateRead(env.DB, b.id, read, { ...done, status: 'abandoned' }, actor(ravi))).toBe(true); // a stop keeps it
    expect(await wantsOf(ravi.id)).toEqual([b.id]);
    expect(await updateRead(env.DB, b.id, read, done, actor(ravi))).toBe(true); // stopped → completed: a correction, not a finish now
    expect(await wantsOf(ravi.id)).toEqual([b.id]);
    await startRead(env.DB, b.id, '2026-09-21', ravi.id);
    const open = (await rows<{ id: number }>("SELECT id FROM reads WHERE reader_id = ?1 AND status = 'in_progress'", ravi.id))[0]!.id;
    expect(await updateRead(env.DB, b.id, open, { status: 'completed', beganOn: '2026-09-21', endedOn: '2026-09-25' }, actor(ravi))).toBe(true);
    expect(await wantsOf(ravi.id)).toEqual([]);
  });

  it('loses a book marked Completed on the edit form, but keeps a want to read a finished one again', async () => {
    const { asha, shelf, other } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Dune' });
    await setWant(env.DB, b.id, asha.id, true);
    await updateItemWithTags(env.DB, b.id, {}, [], { status: 'completed', beganOn: null, completedOn: '2026-09-01' }, asha.id);
    expect(await wantsOf(asha.id)).toEqual([]);

    // finished before: wanting to read it again survives saving the form, which describes that finish
    await setWant(env.DB, b.id, asha.id, true);
    await updateItemWithTags(env.DB, b.id, {}, [], { status: 'completed', beganOn: null, completedOn: '2026-09-02' }, asha.id);
    expect(await wantsOf(asha.id)).toEqual([b.id]);
    // …and a past read added from its page is history, not a finish now
    await addPastRead(env.DB, b.id, { status: 'completed', beganOn: null, endedOn: '2010-01-01' }, asha.id);
    expect(await wantsOf(asha.id)).toEqual([b.id]);

    // a record marked Completed was heard, which isn't having it: the want stays
    const lp = await book(asha, { libraryId: other.id, mediaType: 'vinyl', title: 'Blue' });
    await setWant(env.DB, lp.id, asha.id, true);
    await updateItemWithTags(env.DB, lp.id, {}, [], { status: 'completed', beganOn: null, completedOn: '2026-09-01' }, asha.id);
    expect(await wantsOf(asha.id)).toEqual([b.id, lp.id]);
  });
});

// ---------- purchase links ----------

describe('purchase links', () => {
  it('take only absolute http(s) addresses', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com/x',
      '/relative/path',
      'relative/path',
      '//evil.example/x',
      '?q=1',
      'https://user:pass@shop.example/x',
      'https://shop.example/a b',
      'https://shop.example/\nx',
      '',
      `https://shop.example/${'a'.repeat(2000)}`,
    ]) {
      expect(typeof checkPurchaseLink('Shop', bad), bad).toBe('string');
    }
    expect(checkPurchaseLink('', 'https://www.bookshop.example/p/123')).toEqual({ label: 'bookshop.example', url: 'https://www.bookshop.example/p/123' });
    expect(checkPurchaseLink('  Book\u202eshop   UK ', 'http://shop.example')).toEqual({ label: 'Bookshop UK', url: 'http://shop.example/' });
    // joiners stay — Persian and Indic text and emoji sequences need them — and a label is never cut inside a character
    expect(checkPurchaseLink('می\u200cخرم 👨\u200d👩\u200d👧', 'https://x.example/')).toMatchObject({ label: 'می\u200cخرم 👨\u200d👩\u200d👧' });
    const cut = (checkPurchaseLink(`${'a'.repeat(59)}😀😀`, 'https://x.example/') as { label: string }).label;
    expect(cut).toBe(`${'a'.repeat(59)}😀`);
    // quotes and angle brackets in a query are percent-encoded by the parser — nothing to break out of an attribute with
    const tricky = checkPurchaseLink('x', 'https://shop.example/?q="><script>alert(1)</script>');
    expect(tricky).toEqual({ label: 'x', url: 'https://shop.example/?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E' });
  });

  it('are the household’s: any member adds or removes one, and every one is checked', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    const add = (who: Member, label: string, url: string, htmx = false) => as(who, `/items/${b.id}/links`, { body: { label, url }, htmx });

    expect((await add(ravi, 'Bookshop', 'https://bookshop.example/piranesi')).status).toBe(302);
    for (const bad of ['javascript:alert(document.cookie)', 'data:text/html;base64,PHNjcmlwdD4=', '/items/1/delete', '//evil.example']) {
      const res = await add(ravi, 'Evil', bad, true);
      expect(res.status, bad).toBe(200); // htmx swaps only a 2xx by default: the section must come back with the reason
      const section = await res.text();
      expect(section).toContain('class="error"');
      expect(section).toContain('id="buy"');
    }
    // without htmx a refusal is the item page again, with the reason and what was sent
    const refused = await add(ravi, 'Evil', 'javascript:alert(1)');
    expect(refused.status).toBe(400);
    const refusedPage = await refused.text();
    expect(refusedPage).toContain('Only web links');
    expect(refusedPage).not.toContain('href="javascript:');
    expect(await (await add(asha, 'Again', 'https://bookshop.example/piranesi', true)).text()).toContain('That link is here already.');
    expect(await linksOf(b.id)).toEqual([{ id: expect.any(Number), label: 'Bookshop', url: 'https://bookshop.example/piranesi' }]);

    // escaped wherever it shows, and opened safely
    await add(asha, '<img src=x onerror=alert(1)>', 'https://shop.example/?q="><script>alert(1)</script>');
    const page = await html(ravi, `/items/${b.id}`);
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('"><script>');
    expect(page).toContain('href="https://bookshop.example/piranesi" target="_blank" rel="noopener noreferrer"');
    expect([...page.matchAll(/<a href="[^"]*" target="_blank" rel="([^"]*)"/g)].map((m) => m[1])).toEqual(['noopener noreferrer', 'noopener noreferrer']);

    // anyone removes one — the one named, on this item only
    const [first, second] = await linksOf(b.id);
    const elsewhere = await book(asha, { libraryId: shelf.id, title: 'Elsewhere' });
    await as(ravi, `/items/${elsewhere.id}/links/${second!.id}/delete`, { body: {} });
    expect(await linksOf(b.id)).toHaveLength(2);
    await as(ravi, `/items/${b.id}/links/${first!.id}/delete`, { body: {} });
    expect((await linksOf(b.id)).map((l) => l.id)).toEqual([second!.id]);
  });

  it('stop at twenty an item', async () => {
    const { asha, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id });
    for (let i = 0; i < 20; i++) await as(asha, `/items/${b.id}/links`, { body: { label: `Shop ${i}`, url: `https://shop${i}.example/` } });
    const over = await as(asha, `/items/${b.id}/links`, { body: { label: 'One more', url: 'https://more.example/' }, htmx: true });
    expect(over.status).toBe(200);
    expect(await over.text()).toContain('at most 20');
    expect(await linksOf(b.id)).toHaveLength(20);
  });

  it('go with their item, as its wants do', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id });
    await setWant(env.DB, b.id, ravi.id, true);
    await as(asha, `/items/${b.id}/links`, { body: { label: 'Shop', url: 'https://shop.example/' } });
    await deleteItem(env.DB, b.id);
    expect(await rows('SELECT * FROM wants')).toEqual([]);
    expect(await rows('SELECT * FROM purchase_links')).toEqual([]);
  });
});

// ---------- gift lists: a want list, published ----------

describe('a gift list', () => {
  it('is published, rotated and removed by an admin only, and listed in the inventory', async () => {
    const { asha, ravi } = await household();
    expect((await as(ravi, '/shares', { body: { wantUserId: String(ravi.id), wantUsername: 'ravi' } })).status).toBe(403);
    expect((await as(asha, '/shares', { body: { wantUserId: '999999', wantUsername: 'ravi' } })).status).toBe(400);
    // a form made for someone else — an id reused after a removal — publishes nothing
    expect((await as(asha, '/shares', { body: { wantUserId: String(ravi.id), wantUsername: 'zoe' } })).status).toBe(400);
    expect((await as(asha, '/shares', { body: { wantUserId: String(ravi.id) } })).status).toBe(400);
    expect(await listShares(env.DB)).toEqual([]);
    const share = await giftList(ravi, asha);
    expect(share).toMatchObject({ wantUserId: ravi.id, libraryId: null, mediaType: null, status: null, owned: null, tag: null, sort: 'title' });
    expect(share.token).toMatch(/^[0-9a-f]{32}$/);
    expect((await publicPage(`/share/${share.token}`)).status).toBe(200);

    const inventory = await html(asha, '/shares');
    expect(inventory).toContain(`/share/${share.token}`);
    expect(inventory).toContain('Want list · ravi'); // inside the app, the admin sees whose

    // rotate: a new token, the old one dead
    expect((await as(ravi, `/shares/${share.id}`, { body: { action: 'rotate' } })).status).toBe(403);
    const back = await as(asha, `/shares/${share.id}`, { body: { action: 'rotate', wantUserId: String(ravi.id) } });
    expect(back.headers.get('location')).toBe(`/wants?member=${ravi.id}`);
    const rotated = (await listShares(env.DB))[0]!;
    expect(rotated.token).not.toBe(share.token);
    expect((await publicPage(`/share/${share.token}`)).status).toBe(404);
    expect((await publicPage(`/share/${rotated.token}`)).status).toBe(200);

    // remove
    await as(asha, `/shares/${share.id}`, { body: { action: 'delete' } });
    expect(await listShares(env.DB)).toEqual([]);
    expect((await publicPage(`/share/${rotated.token}`)).status).toBe(404);
  });

  it('shows exactly its member’s want list as it stands, from any shelf, and nothing else', async () => {
    const { asha, ravi, shelf, other } = await household();
    const hisBook = await book(asha, { libraryId: shelf.id, title: 'On Ravi’s list' });
    const hisRecord = await book(asha, { libraryId: other.id, mediaType: 'vinyl', title: 'Ravi’s record, another shelf' });
    const hers = await book(asha, { libraryId: shelf.id, title: 'Only on Asha’s list' });
    const nobody = await book(asha, { libraryId: shelf.id, title: 'On nobody’s list' });
    const later = await book(asha, { libraryId: shelf.id, title: 'Taken off later' });
    for (const i of [hisBook, hisRecord, later]) await setWant(env.DB, i.id, ravi.id, true);
    await setWant(env.DB, hers.id, asha.id, true);
    const share = await giftList(ravi, asha);

    let page = (await publicPage(`/share/${share.token}`)).text;
    for (const t of ['On Ravi’s list', 'Ravi’s record, another shelf', 'Taken off later']) expect(page).toContain(t);
    for (const t of ['Only on Asha’s list', 'On nobody’s list']) expect(page).not.toContain(t);
    expect(page).toContain('3 items');

    // the item route admits exactly those, by id
    expect((await publicPage(`/share/${share.token}/items/${hisRecord.id}`)).status).toBe(200);
    for (const outside of [hers.id, nobody.id, 999_999]) expect((await publicPage(`/share/${share.token}/items/${outside}`)).status).toBe(404);

    // it follows the list: taken off, it leaves the page and the item route
    await want(ravi, later, false);
    page = (await publicPage(`/share/${share.token}`)).text;
    expect(page).not.toContain('Taken off later');
    expect((await publicPage(`/share/${share.token}/items/${later.id}`)).status).toBe(404);

    // and a shelf's own share never reaches ravi's list, nor a gift list a shelf
    const shelfShare = await createShare(env.DB, { token: newShareToken(), name: 'Fiction', libraryId: shelf.id });
    expect((await publicPage(`/share/${shelfShare.token}/items/${hisRecord.id}`)).status).toBe(404);
  });

  it('names its member only by display name, and only with names on for share pages', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'A gift' });
    await setWant(env.DB, b.id, ravi.id, true);
    const share = await giftList(ravi, asha);
    const pages = async () => [(await publicPage(`/share/${share.token}`)).text, (await publicPage(`/share/${share.token}/items/${b.id}`)).text];

    // names off, no display name: unnamed
    const plain = await pages();
    for (const p of plain) {
      expect(p).toContain('A want list');
      expect(p).not.toMatch(/ravi|asha/i);
    }
    // a display name alone changes nothing while the switch is off — byte for byte
    await setDisplayName(env.DB, ravi.id, 'Ravi K.');
    expect(await pages()).toEqual(plain);
    // switched on: the display name, never the login
    await updateSiteSettings(env.DB, { namesOnShares: true });
    for (const p of await pages()) {
      expect(p).toContain('Ravi K.’s want list');
      expect(p).not.toMatch(/\bravi\b/);
      expect(p).not.toContain('asha');
    }
    // on, but no display name: still unnamed
    await setDisplayName(env.DB, ravi.id, null);
    for (const p of await pages()) {
      expect(p).toContain('A want list');
      expect(p).not.toMatch(/ravi/i);
    }
    // a display name that is markup is text
    await setDisplayName(env.DB, ravi.id, '<b>R</b>');
    const [list] = await pages();
    expect(list).toContain('&lt;b&gt;R&lt;/b&gt;’s want list');
    expect(list).not.toContain('<b>R</b>');
  });

  it('leaks nothing the whitelist keeps back, and shows the links only here', async () => {
    const { asha, ravi, shelf } = await household();
    await setDisplayName(env.DB, ravi.id, 'Ravi K.');
    await setDisplayName(env.DB, asha.id, 'Asha M.');
    await updateSiteSettings(env.DB, { namesOnShares: true, progressOnShares: true });
    const b = await book(asha, {
      libraryId: shelf.id,
      title: 'Everything private',
      notes: 'SECRET-NOTE',
      copies: 3,
      rating: 8,
      review: 'SECRET-REVIEW',
      status: 'completed',
      beganOn: '2019-05-01',
      completedOn: '2019-06-01',
      details: JSON.stringify({ secret_detail: 'SECRET-DETAIL' }),
    });
    await addPastRead(env.DB, b.id, { status: 'completed', beganOn: '2020-07-01', endedOn: '2020-08-01' }, ravi.id);
    await startRead(env.DB, b.id, '2026-09-01', ravi.id);
    await addProgress(env.DB, b.id, 123, ravi.id);
    await createLoan(env.DB, { itemId: b.id, borrower: 'SECRET-BORROWER', contact: 'secret@example.com' });
    await setItemTags(env.DB, b.id, ['secret-tag']);
    await setWant(env.DB, b.id, ravi.id, true);
    await as(asha, `/items/${b.id}/links`, { body: { label: 'Bookshop', url: 'https://bookshop.example/everything' } });
    const share = await giftList(ravi, asha);

    for (const path of [`/share/${share.token}`, `/share/${share.token}/items/${b.id}`]) {
      const { status, text } = await publicPage(path);
      expect(status).toBe(200);
      expect(text).toContain('Everything private');
      expect(text).toContain('href="https://bookshop.example/everything" target="_blank" rel="noopener noreferrer"');
      expect(text).toContain('noindex');
      for (const leak of [
        'SECRET-NOTE',
        'SECRET-REVIEW',
        'SECRET-DETAIL',
        'SECRET-BORROWER',
        'secret@example.com',
        'secret-tag',
        '2019-05-01',
        '2019-06-01',
        '2020-07-01',
        '2020-08-01',
        '2026-09-01',
        'p. 123',
        '★',
        'Read 2 times',
        'read 2×',
        'Asha M.',
        'asha',
        '>ravi',
        'copies',
        'Lent',
        'href="/items/',
        'href="/libraries',
        'href="/wants',
      ]) {
        expect(text, `${path}: ${leak}`).not.toContain(leak);
      }
      // the one member it names is its own, by display name
      expect(text).toContain('Ravi K.’s want list');
    }

    // a shelf's share page of the same item: its usual fields, never the links (§16 #53)
    const shelfShare = await createShare(env.DB, { token: newShareToken(), name: 'Fiction', libraryId: shelf.id });
    for (const path of [`/share/${shelfShare.token}`, `/share/${shelfShare.token}/items/${b.id}`]) {
      const { text } = await publicPage(path);
      expect(text).toContain('Everything private'); // negative control: the page is there
      expect(text).not.toContain('bookshop.example');
      expect(text).not.toContain('Where to buy');
    }
    // nor to a connection: its item whitelist has no room for them
    expect(Object.keys(toConnectionItem(b)).filter((k) => /link|want|buy/i.test(k))).toEqual([]);
    // and the gift whitelist is exactly its fields
    expect(Object.keys(toGiftItem(b, [])).sort()).toEqual(
      ['coverKey', 'creators', 'description', 'id', 'inCollection', 'length', 'mediaType', 'publisher', 'published', 'purchaseLinks', 'title'].sort(),
    );
  });

  it('re-checks every link on the way out, whatever the table holds', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Planted' });
    await setWant(env.DB, b.id, ravi.id, true);
    // written past the route, as a restore of a hand-edited backup could
    await env.DB.prepare("INSERT INTO purchase_links (item_id, label, url) VALUES (?1, 'Evil', 'javascript:alert(1)'), (?1, 'Fine', 'https://fine.example/')").bind(b.id).run();
    const share = await giftList(ravi, asha);
    const { text } = await publicPage(`/share/${share.token}`);
    expect(text).toContain('https://fine.example/');
    expect(text).not.toContain('javascript:');
  });

  it('is not a shelf: it never makes a shelf look shared', async () => {
    const { ravi } = await household();
    const gift: Share = {
      id: 1,
      token: 't',
      name: 'Want list',
      libraryId: null,
      mediaType: null,
      status: null,
      owned: null,
      tag: null,
      sort: 'title',
      createdAt: '',
      wantUserId: ravi.id,
    };
    expect(isWholeShelfShare(gift)).toBe(false);
    expect(isWholeShelfShare({ ...gift, wantUserId: null })).toBe(true); // negative control: the same row without a member is
    expect(shareVisibility([gift])).toEqual({ kind: 'private', links: 0 });
    expect(shareVisibility([gift, { ...gift, wantUserId: null, libraryId: 1 }])).toEqual({ kind: 'shelf', links: 1 });
  });
});

// ---------- the item-side and query-side twins ----------

describe('itemMatchesShare and shareFilters', () => {
  it('agree on every item, for gift lists and every other kind of share', async () => {
    const { asha, ravi, shelf, other } = await household();
    const items = [
      await book(asha, { libraryId: shelf.id, title: 'a', status: 'completed', completedOn: '2020-01-01' }),
      await book(asha, { libraryId: shelf.id, title: 'b', copies: 0 }),
      await book(asha, { libraryId: other.id, title: 'c', mediaType: 'vinyl' }),
      await book(asha, { libraryId: other.id, title: 'd', copies: 0, mediaType: 'vinyl' }),
      await book(asha, { libraryId: shelf.id, title: 'e' }),
    ];
    await setItemTags(env.DB, items[0]!.id, ['gift']);
    await setItemTags(env.DB, items[2]!.id, ['gift']);
    for (const i of [items[0]!, items[2]!, items[3]!]) await setWant(env.DB, i.id, ravi.id, true);
    for (const i of [items[1]!, items[3]!]) await setWant(env.DB, i.id, asha.id, true);
    const base = { token: '', name: 'x', libraryId: null as number | null };
    const views: Share[] = [];
    for (const v of [
      { ...base, wantUserId: ravi.id },
      { ...base, wantUserId: asha.id },
      { ...base, libraryId: shelf.id },
      { ...base, libraryId: other.id, owned: false },
      { ...base, tag: 'gift' },
      { ...base, libraryId: shelf.id, status: 'completed' as const },
    ]) {
      views.push(await createShare(env.DB, { ...v, token: newShareToken() }));
    }
    for (const view of views) {
      const listed = (await listItems(env.DB, view.libraryId, shareFilters(view))).items.map((i) => i.id).sort();
      const admitted = [];
      for (const item of items) {
        const tags = (await rows<{ name: string }>('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ?1', item.id)).map((t) => t.name);
        const wanters = (await rows<{ id: number }>('SELECT user_id AS id FROM wants WHERE item_id = ?1', item.id)).map((w) => w.id);
        const fresh = (await rows<Item>('SELECT id, library_id AS libraryId, media_type AS mediaType, status, copies FROM items WHERE id = ?1', item.id))[0]!;
        if (itemMatchesShare(view, { ...item, ...fresh }, tags, wanters)) admitted.push(item.id);
      }
      expect(admitted.sort(), JSON.stringify(view)).toEqual(listed);
      expect(await countMatchingItems(env.DB, view.libraryId, shareFilters(view))).toBe(listed.length);
    }
    // the gift lists are exactly each member's wants
    expect((await listItems(env.DB, null, shareFilters(views[0]!))).items.map((i) => i.title).sort()).toEqual(['a', 'c', 'd']);
    expect((await listItems(env.DB, null, shareFilters(views[1]!))).items.map((i) => i.title).sort()).toEqual(['b', 'd']);
  });
});

// ---------- export and import ----------

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

describe('the export and a re-import', () => {
  it('carry every want list and every purchase link', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Round trip', copies: 0 });
    await setWant(env.DB, b.id, ravi.id, true);
    await setWant(env.DB, b.id, asha.id, true);
    await env.DB.prepare("UPDATE wants SET created_at = CASE user_id WHEN ?1 THEN '2026-01-02 03:04:05' ELSE '2026-02-03 04:05:06' END").bind(ravi.id).run();
    await as(asha, `/items/${b.id}/links`, { body: { label: 'Shop, "quoted"', url: 'https://shop.example/a?b=1&c=2' } });
    await as(asha, `/items/${b.id}/links`, { body: { label: 'Second', url: 'http://second.example/' } });

    const [row] = parseCsv(await (await as(asha, '/export.csv')).text());
    expect(row!.wanted_by).toBe('2026-01-02 03:04:05@ravi;2026-02-03 04:05:06@asha');
    expect(JSON.parse(row!.purchase_links!)).toEqual([
      { label: 'Shop, "quoted"', url: 'https://shop.example/a?b=1&c=2' },
      { label: 'Second', url: 'http://second.example/' },
    ]);
    expect(row!.details).toBe(''); // neither leaks into details

    const target = await createLibrary(env.DB, 'Restored');
    const preview = await (await as(asha, '/api/import', { json: { libraryId: target.id, rows: [row], dryRun: true } })).json<{ people: Array<{ name: string; wants?: number }> }>();
    expect(preview.people).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ravi', wants: 1 }), expect.objectContaining({ name: 'asha', wants: 1 })]));
    expect((await as(asha, '/api/import', { json: { libraryId: target.id, rows: [row] } })).status).toBe(200);
    const copy = (await rows<{ id: number }>('SELECT id FROM items WHERE library_id = ?1', target.id))[0]!.id;
    expect(await rows('SELECT user_id AS userId, created_at AS at FROM wants WHERE item_id = ?1 ORDER BY created_at', copy)).toEqual([
      { userId: ravi.id, at: '2026-01-02 03:04:05' },
      { userId: asha.id, at: '2026-02-03 04:05:06' },
    ]);
    expect((await linksOf(copy)).map(({ label, url }) => ({ label, url }))).toEqual((await linksOf(b.id)).map(({ label, url }) => ({ label, url })));
  });

  it('give a member’s import all its wants, a stranger’s name to the importer, and drop a link that isn’t http(s)', async () => {
    const { asha, ravi, shelf } = await household();
    const base = { library: 'x', media_type: 'book', isbn10_upc: '', added_at: '', details: '', progress_history: '', began_on: '', completed_on: '' };
    const row = {
      ...base,
      title: 'Imported',
      wanted_by: '2026-01-01 00:00:00@asha;2026-01-02 00:00:00@carol;garbage@',
      purchase_links: JSON.stringify([
        { label: 'Evil', url: 'javascript:alert(1)' },
        { label: 'Data', url: 'data:text/html,x' },
        { label: 'Relative', url: '/x' },
        { label: 'Good', url: 'https://good.example/' },
        { label: 'Good again', url: 'https://good.example/' },
      ]),
    };
    // a member's import: every want is theirs, whatever the file says
    await as(ravi, '/api/import', { json: { libraryId: shelf.id, rows: [row] } });
    const [mine] = await rows<{ id: number }>('SELECT id FROM items');
    expect(await rows('SELECT user_id AS userId, created_at AS at FROM wants WHERE item_id = ?1', mine!.id)).toEqual([{ userId: ravi.id, at: '2026-01-01 00:00:00' }]);
    expect((await linksOf(mine!.id)).map((l) => l.url)).toEqual(['https://good.example/']);
    // an admin's: a member's name keeps them, a stranger's is the importer's
    await as(asha, '/api/import', { json: { libraryId: shelf.id, rows: [{ ...row, wanted_by: '2026-01-01 00:00:00@ravi;2026-01-02 00:00:00@carol' }] } });
    const theirs = (await rows<{ id: number }>('SELECT id FROM items ORDER BY id'))[1]!.id;
    expect(await rows('SELECT user_id AS userId FROM wants WHERE item_id = ?1 ORDER BY user_id', theirs)).toEqual([{ userId: asha.id }, { userId: ravi.id }]);

    expect(parseWantsCell('2026-01-01 00:00:00@a%3Bb;@;x@%E0%A4;nodate')).toEqual([{ by: 'a;b', at: '2026-01-01 00:00:00' }, { at: null }]);
    expect(parseLinksCell('not json')).toEqual([]);
    // a libib or Goodreads file never puts these into details, which every share page renders
    expect(mapLibibRow({ title: 'x', wanted_by: '@asha', purchase_links: '[]' }, { defaultType: 'book', musicAsVinyl: true })!.item.details).toBe('{}');
  });
});

// ---------- removing a member ----------

describe('removing a member', () => {
  it('clears their want list and kills every gift list of it; everyone else’s stays', async () => {
    const { asha, ravi, shelf } = await household();
    const b = await book(asha, { libraryId: shelf.id, title: 'Theirs' });
    await setWant(env.DB, b.id, ravi.id, true);
    await setWant(env.DB, b.id, asha.id, true);
    await as(asha, `/items/${b.id}/links`, { body: { label: 'Shop', url: 'https://shop.example/' } });
    const his = await giftList(ravi, asha);
    const hers = await giftList(asha, asha);
    expect((await publicPage(`/share/${his.token}`)).status).toBe(200);

    const res = await as(asha, `/settings/users/${ravi.id}/delete`, { body: {} });
    expect(res.status).toBeLessThan(400);
    expect(await rows('SELECT id FROM users WHERE id = ?1', ravi.id)).toEqual([]);
    expect(await wantsOf(ravi.id)).toEqual([]);
    expect(await getShareByToken(env.DB, his.token)).toBeNull();
    expect((await publicPage(`/share/${his.token}`)).status).toBe(404);
    // the item, its links, and asha's want and gift list stay
    expect(await wantsOf(asha.id)).toEqual([b.id]);
    expect(await linksOf(b.id)).toHaveLength(1);
    expect((await publicPage(`/share/${hers.token}`)).text).toContain('Theirs');
  });

  it('works through the database layer too, with a foreign key in the way otherwise', async () => {
    const { asha, ravi } = await household();
    await giftList(ravi, asha);
    await deleteUser(env.DB, ravi.id); // shares.want_user_id has no ON DELETE: deleteUser clears it first
    expect(await listShares(env.DB)).toEqual([]);
  });
});

// ---------- the D1 budget ----------

describe('D1 calls', () => {
  async function count(path: string, cookie?: string) {
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://nalanda.test${path}`, { headers: cookie ? { cookie } : {} }), { ...env, DB: budgeted(env.DB, budget) }, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, calls: 1000 - budget.left };
  }

  it('keep a gift list, its items and a want-list page well inside the budget, however long the list', async () => {
    const { asha, ravi, shelf } = await household();
    await setDisplayName(env.DB, ravi.id, 'Ravi K.');
    await updateSiteSettings(env.DB, { namesOnShares: true });
    let last: Item | null = null;
    for (let i = 0; i < 70; i++) {
      last = await book(asha, { libraryId: shelf.id, title: `Wanted ${String(i).padStart(2, '0')}` });
      await setWant(env.DB, last.id, ravi.id, true);
      await env.DB.prepare('INSERT INTO purchase_links (item_id, label, url) VALUES (?1, ?2, ?3), (?1, ?4, ?5)')
        .bind(last.id, 'A', `https://a.example/${i}`, 'B', `https://b.example/${i}`)
        .run();
    }
    const share = await giftList(ravi, asha);
    clearSharePageCache();
    const list = await count(`/share/${share.token}`);
    expect(list.status).toBe(200);
    expect(list.calls).toBeLessThanOrEqual(5);
    clearSharePageCache();
    const second = await count(`/share/${share.token}?page=2`);
    expect(second.status).toBe(200);
    expect(second.calls).toBeLessThanOrEqual(5);
    clearSharePageCache();
    const item = await count(`/share/${share.token}/items/${last!.id}`);
    expect(item.status).toBe(200);
    expect(item.calls).toBeLessThanOrEqual(6);
    const wants = await count(`/wants?member=${ravi.id}`, asha.cookie);
    expect(wants.status).toBe(200);
    expect(wants.calls).toBeLessThanOrEqual(10);
    const itemPage = await count(`/items/${last!.id}`, ravi.cookie);
    expect(itemPage.status).toBe(200);
    expect(itemPage.calls).toBeLessThanOrEqual(15);
    console.info(`D1 calls — gift list ${list.calls}, its page 2 ${second.calls}, a gift item ${item.calls}, a want-list page ${wants.calls}, an item page ${itemPage.calls}`);
  });
});
