// How often a book was read, as share pages and connections see it (ARCH.md §16 #41): "Read N times" from twice
// on through the share whitelist, a finished-read count on connection items, finishes of re-reads recorded and
// dated like any finish, and a Feed that says "re-reading" and "finished again".
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, createSubscription, storeEntries, type NewRemoteActivity } from '../src/db/federation';
import {
  addProgress,
  closeRead,
  createItem,
  createLibrary,
  createShare,
  mergeImportItems,
  startRead,
} from '../src/db/queries';
import type { Item } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { parseFeedPage } from '../src/federation/feed';
import { parseFeedEntry, parseItemDetail, toConnectionItem, toFeedItem, type ItemFeedEntry } from '../src/federation/items';

/** An entry about an item — every kind these tests send is one (goal entries, §16 #49, have none). */
const parseItemEntry = (v: unknown) => parseFeedEntry(v) as ItemFeedEntry | null;
import { clearSharedViewsCache } from '../src/federation/routes';
import { newShareToken, toPublicItem } from '../src/lib/share';
import { clearSharePageCache } from '../src/routes/share';
import app from '../src/index';
import {
  answerOutbound,
  connectPeer,
  instanceA,
  json,
  makeKeys,
  makePeer,
  sessionCookie,
  setUpA,
  sqlAgo,
  type Keys,
  type Peer,
} from './federation-helpers';

// The DB layer's own callers here act for the whole household, as an admin would (§16 #43).
const HOUSEHOLD = { id: null, admin: true };

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const recent = (at: string) => Date.now() - Date.parse(`${at.replace(' ', 'T')}Z`) < 5 * 60_000;

async function finishedBook(title = 'The Dispossessed', completedOn = '2019-03-20') {
  const shelf = await createLibrary(env.DB, `Shelf ${title}`);
  return createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title, length: 300, status: 'completed', completedOn, details: '{}' });
}
const openRead = async (itemId: number) =>
  (await rows<{ id: number }>("SELECT id FROM reads WHERE item_id = ?1 AND status = 'in_progress'", itemId))[0]!.id;

async function readTwice(item: Item) {
  await startRead(env.DB, item.id, daysAgo(10));
  await closeRead(env.DB, item.id, await openRead(item.id), 'completed', daysAgo(2), HOUSEHOLD);
}

// ---------- share pages ----------

describe('share pages', () => {
  it('say how often a book was read from twice on — the count, never the reads or their dates', async () => {
    const item = await finishedBook();
    expect(toPublicItem(item)).not.toHaveProperty('readCount'); // once is what "finished" means already

    await readTwice(item);
    const again = (await rows<Item>('SELECT * FROM items WHERE id = ?1', item.id))[0]!;
    const pub = toPublicItem({ ...again, readCount: 2, rereading: false }) as unknown as Record<string, unknown>;
    expect(pub.readCount).toBe(2);
    for (const forbidden of ['reads', 'rereading', 'beganOn', 'completedOn', 'status', 'progressPage']) expect(pub).not.toHaveProperty(forbidden);
  });

  it('show "Read N times" on the item page and the listing, for a book read more than once', async () => {
    const twice = await finishedBook('Kindred');
    await readTwice(twice);
    const once = await createItem(env.DB, { libraryId: twice.libraryId, mediaType: 'book', title: 'Once only', status: 'completed', completedOn: '2020-01-01', details: '{}' });
    const share = await createShare(env.DB, { token: newShareToken(), name: 'Ours', libraryId: twice.libraryId });
    const get = async (path: string) => {
      clearSharePageCache();
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`http://nalanda.test${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      return res.text();
    };
    const itemPage = await get(`/share/${share.token}/items/${twice.id}`);
    expect(itemPage).toContain('2 times');
    expect(itemPage).not.toContain(daysAgo(10)); // the re-read's dates stay private
    expect(await get(`/share/${share.token}/items/${once.id}`)).not.toContain(' times</dd>');
    const listing = await get(`/share/${share.token}`);
    expect(listing).toContain('read 2×');
    expect(listing.match(/read \d+×/g)).toHaveLength(1);
  });
});

// ---------- connections ----------

describe('what connections are sent', () => {
  it('a finished-read count on every connection item, never the reads', async () => {
    const item = await finishedBook();
    const c = toConnectionItem(item) as unknown as Record<string, unknown>;
    expect(c.readCount).toBe(1);
    expect(Object.keys(c).filter((k) => /began|ended|reads|rereading/i.test(k))).toEqual([]);
  });

  it('the count on a finish, and on a page the finished reads before its own read', async () => {
    const item = await finishedBook();
    await startRead(env.DB, item.id, daysAgo(10));
    // on a page, the finished reads before its own read — whatever the book's total is by now
    expect(toFeedItem({ ...item, readCount: 1, rereading: true }, 'progress', '0123456789abcdef', 40, 1).readCount).toBe(1);
    expect(toFeedItem({ ...item, readCount: 2 }, 'progress', '0123456789abcdef', 40, 0).readCount).toBe(0);
    expect(toFeedItem({ ...item, readCount: 2 }, 'finished', '0123456789abcdef').readCount).toBe(2);
    expect(toFeedItem({ ...item, readCount: 2 }, 'rated', '0123456789abcdef').readCount).toBeNull(); // not what a rating shows
  });
});

describe('recording a re-read for connections', () => {
  beforeEach(() => createConnectionView(env.DB, { name: 'Everything', libraryId: null, mediaType: null, status: null, owned: null }));

  const finishes = (itemId: number) => rows<{ id: number; at: string }>("SELECT id, at FROM activity_log WHERE item_id = ?1 AND kind = 'finished'", itemId);

  it('records a finish when a re-read finishes, though the status was Completed all along', async () => {
    const item = await finishedBook();
    const [first] = await finishes(item.id);

    await startRead(env.DB, item.id, daysAgo(10));
    expect(await finishes(item.id)).toEqual([first]); // starting is no news, and the old finish stands
    await closeRead(env.DB, item.id, await openRead(item.id), 'completed', daysAgo(0), HOUSEHOLD);

    const [latest] = await finishes(item.id);
    expect(latest!.id).toBeGreaterThan(first!.id); // replaced under a new id, so followers drop the old copy
    expect(recent(latest!.at), latest!.at).toBe(true); // finished today: dated now
  });

  it('dates a back-dated finish by its date, per §16 #40', async () => {
    const item = await finishedBook();
    await startRead(env.DB, item.id, daysAgo(10));
    await closeRead(env.DB, item.id, await openRead(item.id), 'completed', daysAgo(3), HOUSEHOLD);
    expect((await finishes(item.id))[0]!.at).toBe(`${daysAgo(3)} 00:00:00`);
  });

  it('records nothing when a re-read is stopped: the book was, and stays, finished as before', async () => {
    const item = await finishedBook();
    const before = await finishes(item.id);
    await startRead(env.DB, item.id, daysAgo(10));
    await closeRead(env.DB, item.id, await openRead(item.id), 'abandoned', daysAgo(1), HOUSEHOLD);
    expect(await finishes(item.id)).toEqual(before);
  });

  it('isn’t news when an import brings a re-read: dated by its finish, and an undated one records nothing', async () => {
    const item = await finishedBook('Here already', '2018-01-01');
    const [first] = await finishes(item.id);
    await mergeImportItems(env.DB, [
      { item: { libraryId: item.libraryId, title: 'Here already' }, tags: [], goodreads: { shelf: 'completed', dateRead: '2019-05-01', dateStarted: null, readCount: 4 } },
    ]);
    const [after] = await finishes(item.id);
    expect(after!.id).not.toBe(first!.id);
    expect(after!.at).toBe('2019-05-01 00:00:00'); // not today
    expect(await rows('SELECT * FROM import_in_progress')).toEqual([]);

    // topping the count up again adds only undated reads: no finish changes, nothing recorded
    await mergeImportItems(env.DB, [
      { item: { libraryId: item.libraryId, title: 'Here already' }, tags: [], goodreads: { shelf: 'completed', dateRead: null, dateStarted: null, readCount: 6 } },
    ]);
    expect(await finishes(item.id)).toEqual([after]);
    expect((await rows<{ read_count: number }>('SELECT read_count FROM items WHERE id = ?1', item.id))[0]!.read_count).toBe(6);
  });
});

describe('serving a re-read to a connection', () => {
  let keysA: Keys;
  let a: ReturnType<typeof instanceA>;
  let peer: Peer;
  beforeEach(async () => {
    keysA = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
    clearSharedViewsCache();
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('marks a re-read’s pages, and not the first read’s, and never moves the book out of a Completed view', async () => {
    const view = await createConnectionView(env.DB, { name: 'Read', libraryId: null, mediaType: 'book', status: 'completed', owned: null });
    const first = await createItem(env.DB, { libraryId: (await createLibrary(env.DB, 'S')).id, mediaType: 'book', title: 'First read', length: 300, details: '{}' });
    await addProgress(env.DB, first.id, 100, null); // starts its first read
    await closeRead(env.DB, first.id, await openRead(first.id), 'completed', daysAgo(0), HOUSEHOLD);

    const again = await finishedBook('Read again');
    await startRead(env.DB, again.id, daysAgo(5));
    await addProgress(env.DB, again.id, 60, null);

    // read twice here, pages in both: each page counts the finishes before its own read, not the book's total
    const twice = await createItem(env.DB, { libraryId: first.libraryId, mediaType: 'book', title: 'Twice', length: 300, details: '{}' });
    await addProgress(env.DB, twice.id, 50, null);
    await env.DB.prepare("UPDATE reading_progress SET at = ?2 WHERE item_id = ?1").bind(twice.id, `${daysAgo(20)} 10:00:00`).run();
    await env.DB.prepare('UPDATE reads SET began_on = ?2 WHERE item_id = ?1').bind(twice.id, daysAgo(21)).run();
    await closeRead(env.DB, twice.id, await openRead(twice.id), 'completed', daysAgo(19), HOUSEHOLD);
    await startRead(env.DB, twice.id, daysAgo(5));
    await addProgress(env.DB, twice.id, 70, null);
    await closeRead(env.DB, twice.id, await openRead(twice.id), 'completed', daysAgo(0), HOUSEHOLD);

    const body = (await (await a.signedGet(`/federation/feed?view=${view.id}&since=0`, peer)).json()) as { entries: Array<{ kind: string; item: { title: string; readCount: number | null; progress: { page: number } | null } }> };
    const pagesOf = (title: string) =>
      body.entries.filter((e) => e.kind === 'progress' && e.item.title === title).map((e) => [e.item.progress!.page, e.item.readCount]);
    expect(pagesOf('Read again')).toEqual([[60, 1]]);
    expect(pagesOf('First read')).toEqual([[100, 0]]);
    expect(pagesOf('Twice').sort()).toEqual([
      [50, 0],
      [70, 1],
    ]);
    expect(body.entries.find((e) => e.kind === 'finished' && e.item.title === 'Read again')?.item.readCount).toBe(1);
  });
});

// ---------- the wire, both ways ----------

const sentItem = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  mediaType: 'book',
  title: 'Piranesi',
  creators: 'Susanna Clarke',
  published: '2020',
  coverKey: null,
  rating: null,
  review: null,
  reviewTruncated: false,
  inCollection: true,
  completedOn: null,
  stamp: '0123456789abcdef',
  ...overrides,
});

describe('the wire format', () => {
  it('reads an entry from a household on an older version, which sends no count', () => {
    expect(parseItemEntry({ id: 1, kind: 'finished', published: sqlAgo(1), item: sentItem() })?.item.readCount).toBeNull();
    expect(parseItemEntry({ id: 1, kind: 'finished', published: sqlAgo(1), item: sentItem({ readCount: 3 }) })?.item.readCount).toBe(3);
  });

  it('rejects a malformed count as it would any malformed field, keeping the rest of the page', () => {
    for (const bad of ['3', -1, 1.5, 1_000_001, true]) {
      expect(parseItemEntry({ id: 1, kind: 'finished', published: sqlAgo(1), item: sentItem({ readCount: bad }) }), String(bad)).toBeNull();
    }
    const page = parseFeedPage({
      latest: 2,
      more: false,
      entries: [
        { id: 1, kind: 'finished', published: sqlAgo(2), item: sentItem({ readCount: 'many' }) },
        { id: 2, kind: 'finished', published: sqlAgo(1), item: sentItem({ readCount: 2 }) },
      ],
    });
    expect(page?.entries.map((e) => e.id)).toEqual([2]);
  });

  it('reads an item page with or without the count', () => {
    const detail = {
      ...sentItem(),
      publisher: null,
      description: null,
      length: null,
      details: {},
      updatedAt: '2026-09-01 10:00:00',
      available: true,
      tags: [],
    };
    expect(parseItemDetail(detail)?.readCount).toBeNull();
    expect(parseItemDetail({ ...detail, readCount: 4 })?.readCount).toBe(4);
    expect(parseItemDetail({ ...detail, readCount: 'four' })).toBeNull();
  });
});

// ---------- the Feed page ----------

describe('the Feed page', () => {
  let subscriptionId: number;
  let a: ReturnType<typeof instanceA>;
  beforeEach(async () => {
    const keys = await makeKeys();
    a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keys.secret } as Bindings);
    await setUpA();
    const peer = await makePeer('Riverbank library');
    const connectionId = (await connectPeer(peer)).id;
    subscriptionId = (await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'Read', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 }))!.id;
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/feed/check'
        ? json({ invalid: [], viewGone: false })
        : json({ view: 7, latest: 0, more: false, entries: [] }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const stored = (remoteId: number, kind: string, minutesAgo: number, item: Record<string, unknown>): NewRemoteActivity => {
    const body = JSON.stringify(sentItem(item));
    return { remoteId, itemRemoteId: 5, itemStamp: '0123456789abcdef', kind: kind as NewRemoteActivity['kind'], publishedAt: sqlAgo(minutesAgo), item: body, bytes: body.length };
  };
  const feed = async () => (await (await a.get('/feed', await sessionCookie('member'))).text()).replace(/\s+/g, ' ');

  it('says "re-reading" for pages after a finish, with a bar and only the re-read’s pages', async () => {
    await storeEntries(env.DB, subscriptionId, [
      stored(1, 'progress', 40 * 24 * 60, { progress: { page: 280, percent: 93 }, readCount: 0 }),
      stored(2, 'finished', 30 * 24 * 60, { readCount: 1 }),
      stored(3, 'progress', 60, { progress: { page: 90, percent: 30 }, readCount: 1 }),
    ]);
    const html = await feed();
    expect(html).toContain('re-reading</span> <strong>Piranesi');
    expect(html).toContain('width:30%');
    expect(html).toContain('p. 90');
    expect(html).not.toContain('p. 280'); // the first read's page isn't this read's timeline
  });

  it('says "finished again" for a second finish, and plain "finished" for a first', async () => {
    await storeEntries(env.DB, subscriptionId, [stored(1, 'finished', 60, { readCount: 2 })]);
    expect(await feed()).toContain('finished again</span> <strong>Piranesi');
  });

  it('reads a household on an older version exactly as before', async () => {
    await storeEntries(env.DB, subscriptionId, [
      stored(1, 'finished', 30 * 24 * 60, {}),
      stored(2, 'progress', 60, { progress: { page: 90, percent: 30 } }),
    ]);
    const html = await feed();
    // no count, no claim of a re-read: finished stands, its bar stays hidden, as it always has
    expect(html).toContain('finished</span> <strong>Piranesi');
    expect(html).not.toContain('re-reading');
    expect(html).not.toContain('progress-fill');
  });
});
