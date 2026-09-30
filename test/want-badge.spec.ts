// The "Wanted" badge, the wording beside "Not owned", duplicates from "Want", and the export's calls (ARCH.md §16 #53):
// a derived boolean — someone in the household wants it and it isn't owned — on every page "Not owned" shows on, to
// connections as an optional field an older household ignores, and never whose want it is.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLibrary,
  createShare,
  exportCellsForIdRange,
  existingForWant,
  mergeImportItems,
  progressForIdRange,
  readsForIdRange,
  reviewsForIdRange,
  setDisplayName,
  setItemTags,
  setWant,
  tagsForIdRange,
  updateItem,
  addProgress,
  addPastRead,
  startRead,
} from '../src/db/queries';
import { createConnectionView } from '../src/db/federation';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { clearSharedViewsCache } from '../src/federation/routes';
import { parseFeedEntry, parseItemDetail, parseShelfItem, toConnectionItem, toFeedItem, toItemDetail, toShelfItem } from '../src/federation/items';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import * as before from './fixtures/items-before-names';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, setUpA, sqlAgo, type Peer } from './federation-helpers';
import { as, book, html, member, rows } from './member-helpers';

const BADGE = '<span class="pill wanted">Wanted</span>';

async function scene() {
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  await setDisplayName(env.DB, ravi.id, 'Ravi K.');
  const shelf = await createLibrary(env.DB, 'Fiction');
  const wanted = await book(asha, { libraryId: shelf.id, title: 'Wanted and not owned', copies: 0 });
  const ownedWanted = await book(asha, { libraryId: shelf.id, title: 'Wanted but owned', copies: 1 });
  const plain = await book(asha, { libraryId: shelf.id, title: 'Not owned, nobody wants it', copies: 0 });
  await setWant(env.DB, wanted.id, ravi.id, true);
  await setWant(env.DB, ownedWanted.id, ravi.id, true);
  return { asha, ravi, shelf, wanted, ownedWanted, plain };
}

/** The HTML of the card, row or page part that names `title`. */
const around = (page: string, title: string) => {
  const i = page.indexOf(title);
  return i < 0 ? '' : page.slice(Math.max(0, i - 900), i + 900);
};

describe('the Wanted badge inside the app', () => {
  it('shows beside Not owned on shelves, tags, search and the item page — and only while wanted and not owned', async () => {
    const s = await scene();
    await setItemTags(env.DB, s.wanted.id, ['gift']);
    await setItemTags(env.DB, s.plain.id, ['gift']);
    const table = await html(s.asha, `/libraries/${s.shelf.id}`);
    const grid = await html(s.asha, `/libraries/${s.shelf.id}?view=grid`);
    const tag = await html(s.asha, '/tags/gift');
    const search = await html(s.asha, '/search?q=owned');
    for (const page of [table, grid, search]) {
      expect(page.match(/pill wanted/g), 'one badge a page').toHaveLength(1);
      expect(around(page, 'Wanted and not owned')).toContain(BADGE);
    }
    expect(tag.match(/pill wanted/g)).toHaveLength(1);
    expect(await html(s.asha, `/items/${s.wanted.id}`)).toContain(BADGE);
    expect(await html(s.asha, `/items/${s.ownedWanted.id}`)).not.toContain(BADGE); // owned: no badge
    expect(await html(s.asha, `/items/${s.plain.id}`)).not.toContain(BADGE); // nobody wants it

    // it goes when nobody wants it, or when the household gets a copy
    await setWant(env.DB, s.wanted.id, s.ravi.id, false);
    expect(await html(s.asha, `/libraries/${s.shelf.id}`)).not.toContain('pill wanted');
    await setWant(env.DB, s.wanted.id, s.ravi.id, true);
    await updateItem(env.DB, s.wanted.id, { copies: 1 });
    expect(await html(s.asha, `/libraries/${s.shelf.id}`)).not.toContain('pill wanted');
  });
});

describe('the Wanted badge on share pages', () => {
  it('shows on a share list and item page as a boolean — no name, and no key for anything else', async () => {
    const s = await scene();
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Fiction', libraryId: s.shelf.id });
    clearSharePageCache();
    const list = await (await as(null, `/share/${share.token}`)).text();
    expect(list.match(/pill wanted/g)).toHaveLength(1);
    expect(around(list, 'Wanted and not owned')).toContain(BADGE);
    clearSharePageCache();
    const item = await (await as(null, `/share/${share.token}/items/${s.wanted.id}`)).text();
    expect(item).toContain(`${BADGE} wanted, not on these shelves yet`);
    for (const page of [list, item]) {
      for (const leak of ['Ravi K.', 'ravi', 'asha']) expect(page).not.toContain(leak);
    }
    clearSharePageCache();
    const owned = await (await as(null, `/share/${share.token}/items/${s.ownedWanted.id}`)).text();
    expect(owned).not.toContain('pill wanted');
  });

  it('never says a Not owned item was read — a Goodreads to-read entry included', async () => {
    const s = await scene();
    const shelfShare = await createShare(env.DB, { token: newShareToken(), name: 'Fiction', libraryId: s.shelf.id });
    // a Goodreads to-read row: not owned, never started
    await mergeImportItems(env.DB, [
      { item: { libraryId: s.shelf.id, title: 'To read someday', creators: 'A. Writer', status: 'not_started', copies: 0, details: '{}', addedBy: s.asha.id }, tags: [], goodreads: { shelf: 'not_started', dateRead: null, dateStarted: null, readCount: null } },
    ]);
    const toRead = (await rows<{ id: number }>("SELECT id FROM items WHERE title = 'To read someday'"))[0]!.id;
    for (const id of [toRead, s.plain.id]) {
      clearSharePageCache();
      const page = await (await as(null, `/share/${shelfShare.token}/items/${id}`)).text();
      expect(page).toContain('in the catalogue, not on these shelves');
      expect(page).not.toMatch(/read, not on these shelves/i);
      expect(page).not.toContain('pill wanted');
    }
  });

  it('adds nothing to toPublicItem unless asked, and only `wanted: true` then', async () => {
    const s = await scene();
    const plain = toPublicItem(s.wanted);
    expect(plain).not.toHaveProperty('wanted');
    expect(JSON.stringify(toPublicItem(s.wanted, { wanted: false }))).toBe(JSON.stringify(plain));
    const badged = toPublicItem(s.wanted, { wanted: true });
    expect(Object.keys(badged).filter((k) => !(k in plain))).toEqual(['wanted']);
    expect(badged.wanted).toBe(true);
    expect(toPublicItem(s.ownedWanted, { wanted: true })).not.toHaveProperty('wanted'); // owned: never
  });
});

// ---------- connections ----------

describe('the Wanted badge to connections', () => {
  let a: ReturnType<typeof instanceA>;
  let peer: Peer;
  beforeEach(async () => {
    const keys = await makeKeys();
    clearSharedViewsCache();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is served as an optional `wanted: true` on shelves, item pages and feed entries — nothing else, and no name', async () => {
    const s = await scene();
    const view = await createConnectionView(env.DB, { name: 'All', libraryId: s.shelf.id, mediaType: null, status: null, owned: null });
    const shelf = (await (await a.signedGet(`/federation/shelf?view=${view.id}&page=1`, peer)).json()) as { items: Array<Record<string, unknown>> };
    const byTitle = new Map(shelf.items.map((i) => [i.title, i]));
    expect(byTitle.get('Wanted and not owned')!.wanted).toBe(true);
    expect(byTitle.get('Wanted but owned')).not.toHaveProperty('wanted');
    expect(byTitle.get('Not owned, nobody wants it')).not.toHaveProperty('wanted');
    const item = (await (await a.signedGet(`/federation/item?view=${view.id}&id=${s.wanted.id}`, peer)).json()) as Record<string, unknown>;
    expect(item.wanted).toBe(true);
    const other = (await (await a.signedGet(`/federation/item?view=${view.id}&id=${s.plain.id}`, peer)).json()) as Record<string, unknown>;
    expect(other).not.toHaveProperty('wanted');
    for (const body of [JSON.stringify(shelf), JSON.stringify(item)]) {
      for (const leak of ['Ravi K.', 'ravi', 'asha']) expect(body).not.toContain(leak);
    }
    // a feed entry about a wanted book says so
    await addPastRead(env.DB, s.wanted.id, { status: 'completed', beganOn: null, endedOn: new Date().toISOString().slice(0, 10) }, s.asha.id);
    const feed = (await (await a.signedGet(`/federation/feed?view=${view.id}&since=0`, peer)).json()) as { entries: Array<{ item: Record<string, unknown> }> };
    const entry = feed.entries.find((e) => e.item.title === 'Wanted and not owned');
    expect(entry, 'a finish of the wanted book is an entry').toBeTruthy();
    expect(entry!.item.wanted).toBe(true);
  });

  it('keeps every other item’s bytes as they were', async () => {
    const s = await scene();
    for (const i of [s.plain, s.ownedWanted]) {
      expect(JSON.stringify(toConnectionItem(i))).toBe(JSON.stringify(toConnectionItem(i, { wanted: false })));
      expect(JSON.stringify(toShelfItem(i, true, '0123456789abcdef'))).toBe(JSON.stringify(toShelfItem(i, true, '0123456789abcdef', false)));
    }
    expect(toShelfItem(s.ownedWanted, true, '0123456789abcdef', true)).not.toHaveProperty('wanted'); // owned: never
  });

  it('parses here, is ignored by a household on an older version, and rejects a malformed value', async () => {
    const s = await scene();
    const stamp = '0123456789abcdef';
    const shelfItem = JSON.parse(JSON.stringify(toShelfItem(s.wanted, false, stamp, true)));
    const detail = JSON.parse(JSON.stringify(toItemDetail(s.wanted, false, [], stamp, undefined, true)));
    const feedEntry = { id: 9, kind: 'finished', published: sqlAgo(5), item: JSON.parse(JSON.stringify(toFeedItem(s.wanted, 'finished', stamp, null, 0, undefined, true))) };
    expect(shelfItem.wanted).toBe(true);
    expect(detail.wanted).toBe(true);
    expect(feedEntry.item.wanted).toBe(true);
    // this version keeps it
    expect(parseShelfItem(shelfItem)!.wanted).toBe(true);
    expect(parseItemDetail(detail)!.wanted).toBe(true);
    expect(parseFeedEntry(feedEntry)!.item.wanted).toBe(true);
    // an older household reads the same bytes, and simply doesn't have the field
    expect(before.parseShelfItem(shelfItem)).toMatchObject({ title: 'Wanted and not owned' });
    expect(before.parseShelfItem(shelfItem)).not.toHaveProperty('wanted');
    expect(before.parseItemDetail(detail)).toMatchObject({ title: 'Wanted and not owned' });
    expect(before.parseItemDetail(detail)).not.toHaveProperty('wanted');
    expect(before.parseFeedEntry(feedEntry)).toMatchObject({ kind: 'finished' });
    expect(before.parseFeedEntry(feedEntry)!.item).not.toHaveProperty('wanted');
    // an older household's own bytes, with no field, read here as not wanted
    expect(parseShelfItem({ ...shelfItem, wanted: undefined })).not.toHaveProperty('wanted');
    // malformed rejects, as any malformed field does; false is none; an owned item is never badged
    expect(parseShelfItem({ ...shelfItem, wanted: 'yes' })).toBeNull();
    expect(parseItemDetail({ ...detail, wanted: 1 })).toBeNull();
    expect(parseFeedEntry({ ...feedEntry, item: { ...feedEntry.item, wanted: 'true' } })).toBeNull();
    expect(parseShelfItem({ ...shelfItem, wanted: false })).not.toHaveProperty('wanted');
    expect(parseShelfItem({ ...shelfItem, inCollection: true, wanted: true })).not.toHaveProperty('wanted');
  });

  it('renders on their shelf and item page as our own fixed text', async () => {
    const connectionId = (await rows<{ id: number }>('SELECT id FROM connections'))[0]!.id;
    const card = (id: number, title: string, over: Record<string, unknown>) => ({
      id, mediaType: 'book', title, creators: null, published: null, coverKey: null, rating: null, inCollection: false, available: false, stamp: '0123456789abcdef', ...over,
    });
    answerOutbound((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/federation/shelf') {
        return json({ view: { id: 7, name: 'Theirs' }, total: 2, page: 1, pages: 1, items: [card(70, 'Their wanted one', { wanted: true }), card(71, 'Their plain one', {})] });
      }
      if (path === '/federation/item') {
        return json({ ...card(70, 'Their wanted one', { wanted: true }), publisher: null, description: null, length: null, review: null, details: {}, completedOn: null, updatedAt: '2026-09-01 10:00:00', tags: [] });
      }
      return json({}, 404);
    });
    const cookie = await (await import('./federation-helpers')).sessionCookie('member');
    const shelf = await (await a.get(`/households/${connectionId}/views/7`, cookie)).text();
    expect(shelf.match(/pill wanted/g)).toHaveLength(1);
    expect(around(shelf, 'Their wanted one')).toContain(BADGE);
    const item = await (await a.get(`/households/${connectionId}/views/7/items/70`, cookie)).text();
    expect(item).toContain('Wanted, not on their shelves yet');
    expect(item).not.toMatch(/Read, but not on their shelves/);
  });

  it('renders on the Feed as fixed text', async () => {
    const connectionId = (await rows<{ id: number }>('SELECT id FROM connections'))[0]!.id;
    const { createSubscription, storeEntries } = await import('../src/db/federation');
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/feed/check' ? json({ invalid: [], viewGone: false }) : json({ view: 7, latest: 0, more: false, entries: [] }),
    );
    const sub = (await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'Read', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 }))!.id;
    const body = (title: string, over: Record<string, unknown>) =>
      JSON.stringify({
        id: 5, mediaType: 'book', title, creators: null, published: null, coverKey: null, rating: null, review: null,
        reviewTruncated: false, inCollection: false, completedOn: null, stamp: '0123456789abcdef', progress: null, readCount: 1, ...over,
      });
    const b1 = body('Feed wanted', { wanted: true });
    await storeEntries(env.DB, sub, [{ remoteId: 1, itemRemoteId: 5, itemStamp: '0123456789abcdef', kind: 'finished', publishedAt: sqlAgo(1), item: b1, bytes: b1.length }]);
    const cookie = await (await import('./federation-helpers')).sessionCookie('member');
    const feed = await (await a.get('/feed', cookie)).text();
    expect(feed).toContain(BADGE);
  });
});

// ---------- duplicates from "Want" ----------

describe('Want on a result that is already in the catalog', () => {
  it('finds a record by barcode or Discogs id, and a game by BGG id, as a book by ISBN-13', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'All');
    const lp = await book(asha, { libraryId: shelf.id, mediaType: 'vinyl', title: 'Blue Train', isbn10Upc: '0724349532922', details: JSON.stringify({ discogs_id: 1234567 }) });
    const game = await book(asha, { libraryId: shelf.id, mediaType: 'boardgame', title: 'Cascadia', details: JSON.stringify({ bgg_id: 314040 }) });
    const novel = await book(asha, { libraryId: shelf.id, title: 'Kindred', isbn13: '9780807083697' });
    const post = (fields: Record<string, string>) => as(asha, '/items', { body: { libraryId: String(shelf.id), details: '{}', want: '1', ...fields } });

    // by barcode (as a scan sends it), by Discogs id (as a search sends it, a string or a number), by BGG id
    for (const [fields, id] of [
      [{ mediaType: 'vinyl', title: 'Blue Train (scan)', isbn10Upc: '0 724349 532922' }, lp.id],
      [{ mediaType: 'vinyl', title: 'Blue Train (search)', details: JSON.stringify({ discogs_id: '1234567' }) }, lp.id],
      [{ mediaType: 'vinyl', title: 'Blue Train (search)', details: JSON.stringify({ discogs_id: 1234567 }) }, lp.id],
      [{ mediaType: 'boardgame', title: 'Cascadia (BGG)', details: JSON.stringify({ bgg_id: 314040 }) }, game.id],
      [{ mediaType: 'book', title: 'Kindred', isbn13: '9780807083697' }, novel.id],
    ] as const) {
      const res = await post(fields);
      expect(res.headers.get('location'), JSON.stringify(fields)).toBe(`/items/${id}`);
    }
    expect(await rows('SELECT id FROM items')).toHaveLength(3); // no second copy of any of them
    expect((await rows<{ itemId: number }>('SELECT item_id AS itemId FROM wants ORDER BY item_id')).map((w) => w.itemId)).toEqual([lp.id, game.id, novel.id]);

    // negative controls: another game, another release, and a book's ISBN on a record — each is new
    const others: Array<Record<string, string>> = [
      { mediaType: 'boardgame', title: 'Wingspan', details: JSON.stringify({ bgg_id: 266192 }) },
      { mediaType: 'vinyl', title: 'Giant Steps', details: JSON.stringify({ discogs_id: 999 }) },
      { mediaType: 'vinyl', title: 'Odd record', isbn10Upc: '9780807083697' },
    ];
    for (const fields of others) {
      expect((await post(fields)).headers.get('location')).not.toMatch(new RegExp(`/items/(${lp.id}|${game.id}|${novel.id})$`));
    }
    expect(await rows('SELECT id FROM items')).toHaveLength(6);
    expect(await existingForWant(env.DB, { mediaType: 'boardgame', details: {} })).toBeNull();
  });
});

// ---------- the export's D1 calls ----------

describe('the export', () => {
  it('reads every cell beside a page of items in one call, and the same rows its single-purpose queries do', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const one = await createLibrary(env.DB, 'One');
    const two = await createLibrary(env.DB, 'Two');
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const b = await book(asha, { libraryId: i % 2 ? two.id : one.id, title: `B${i}`, status: 'completed', completedOn: '2020-01-0' + (i + 1), rating: 6, review: `R${i}` });
      ids.push(b.id);
      await setItemTags(env.DB, b.id, [`t${i}`, 'shared']);
      await startRead(env.DB, b.id, '2026-09-01', ravi.id);
      await addProgress(env.DB, b.id, 10 + i, ravi.id);
      await setWant(env.DB, b.id, ravi.id, true);
      await env.DB.prepare('INSERT INTO purchase_links (item_id, label, url) VALUES (?1, ?2, ?3)').bind(b.id, `L${i}`, `https://l${i}.example/`).run();
    }
    for (const scope of [undefined, one.id]) {
      const [from, to] = [ids[0]!, ids.at(-1)!];
      const cells = await exportCellsForIdRange(env.DB, from, to, scope);
      const sortTags = (m: Map<number, string[]>) => new Map([...m].map(([k, v]) => [k, [...v].sort()]));
      expect(sortTags(cells.tags)).toEqual(sortTags(await tagsForIdRange(env.DB, from, to, scope)));
      expect(cells.progress).toEqual(await progressForIdRange(env.DB, from, to, scope));
      expect(cells.reads).toEqual(await readsForIdRange(env.DB, from, to, scope));
      expect(cells.reviews).toEqual(await reviewsForIdRange(env.DB, from, to, scope));
      expect(cells.wants.size).toBe(scope ? 3 : 6);
      expect(cells.links.size).toBe(scope ? 3 : 6);
    }

    // the streamed export: two calls a page, plus the session and the shelf names
    const budget = { left: 1000 };
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request('http://nalanda.test/export.csv', { headers: { cookie: asha.cookie } }), { ...env, DB: budgeted(env.DB, budget) }, ctx);
    await res.text();
    await waitOnExecutionContext(ctx);
    const streamed = 1000 - budget.left;
    const paged = { left: 1000 };
    const ctx2 = createExecutionContext();
    const res2 = await app.fetch(new Request('http://nalanda.test/export.csv?after=0', { headers: { cookie: asha.cookie } }), { ...env, DB: budgeted(env.DB, paged) }, ctx2);
    await res2.text();
    await waitOnExecutionContext(ctx2);
    console.info(`D1 calls — streamed export ${streamed}, one page of the Export button ${1000 - paged.left}`);
    expect(1000 - paged.left).toBeLessThanOrEqual(5); // session, shelf names (2), items, the one batch
    expect(streamed).toBeLessThanOrEqual(6);
  });
});

describe('a record scanned by its barcode', () => {
  it('keeps the barcode on the result, so a second "Want" on the same scan finds the record', async () => {
    const { activateFetchMock, assertNoPendingInterceptors, intercept, json: reply } = await import('./fetch-mock');
    const { lookupByBarcode } = await import('../src/metadata');
    activateFetchMock();
    try {
      intercept('https://api.discogs.com', (path) => path.startsWith('/database/search?barcode=5099750442229'), reply({ results: [{ id: 42, title: 'Miles Davis - Kind of Blue' }] }));
      const { candidates } = await lookupByBarcode({ ...env, DISCOGS_TOKEN: 't' } as Bindings, '5099750442229');
      expect(candidates[0]).toMatchObject({ mediaType: 'vinyl', isbn10Upc: '5099750442229', details: { discogs_id: 42 } });
      assertNoPendingInterceptors();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
