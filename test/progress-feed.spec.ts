// Reading progress in the connections feed (ARCH.md §16 #35): every update its own entry, carrying its
// own page; withdrawn when the update is deleted or the household stops sharing progress; readable by a
// household still on an older version; gathered into one card per book on the Feed page.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, createSubscription, storeEntries, type NewRemoteActivity } from '../src/db/federation';
import {
  addProgress,
  createItem,
  createLibrary,
  deleteItem,
  deleteProgress,
  getSiteSettings,
  listProgress,
  updateItem,
  updateSiteSettings,
} from '../src/db/queries';
import type { Bindings } from '../src/env';
import { parseFeedPage } from '../src/federation/feed';
import { keepForKind, MAX_FEED_PAGE, parseFeedEntry, parseFeedItem, toFeedItem } from '../src/federation/items';
import { clearSharedViewsCache } from '../src/federation/routes';
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
import { upgradedSwitches } from './member-helpers';

// The DB layer's own callers here act for the whole household, as an admin would (§16 #43).
const HOUSEHOLD = { id: null, admin: true };

let keysA: Keys;
let a: ReturnType<typeof instanceA>;

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  clearSharedViewsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

const shareView = () => createConnectionView(env.DB, { name: 'Shared', libraryId: null, mediaType: null, status: null, owned: null });

async function book(title = 'The Left Hand of Darkness', length: number | null = 300) {
  const shelf = await createLibrary(env.DB, `Shelf ${title}`);
  return createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title, length, details: '{}' });
}

const progressRows = () =>
  rows<{ item_id: number; progress_id: number | null }>("SELECT item_id, progress_id FROM activity_log WHERE kind = 'progress' ORDER BY id");

// ---------- recording ----------

describe('recording progress for connections', () => {
  it('records nothing until a view is shared', async () => {
    const b = await book();
    await addProgress(env.DB, b.id, 36, null);
    expect(await rows('SELECT * FROM activity_log')).toHaveLength(0);
  });

  it('records every update as its own entry, while ratings and reviews still collapse', async () => {
    await shareView();
    const b = await book();
    for (const page of [36, 124, 187]) await addProgress(env.DB, b.id, page, null);

    const updates = await listProgress(env.DB, b.id);
    expect((await progressRows()).map((r) => r.progress_id)).toEqual(updates.map((u) => u.id));

    // migration 0014 made the (item, kind) index partial: 0007's INSERT OR REPLACE must still collapse these
    await updateItem(env.DB, b.id, { rating: 6 });
    await updateItem(env.DB, b.id, { rating: 8 });
    await updateItem(env.DB, b.id, { review: 'First thoughts' });
    await updateItem(env.DB, b.id, { review: 'Second thoughts' });
    expect(await rows("SELECT kind FROM activity_log WHERE kind IN ('rated', 'reviewed') ORDER BY kind")).toEqual([
      { kind: 'rated' },
      { kind: 'reviewed' },
    ]);
    expect(await progressRows()).toHaveLength(3); // untouched by the rating and review churn
  });

  it('records nothing new once the household stops sharing progress', async () => {
    await shareView();
    const b = await book();
    await addProgress(env.DB, b.id, 36, null);
    await updateSiteSettings(env.DB, { progressToConnections: false });
    await addProgress(env.DB, b.id, 90, null);
    expect(await progressRows()).toHaveLength(1);
  });

  it('removes an update and its entry together — no foreign-key error', async () => {
    await shareView();
    const b = await book();
    await addProgress(env.DB, b.id, 36, null);
    await addProgress(env.DB, b.id, 90, null);
    const [first, second] = await listProgress(env.DB, b.id);

    await deleteProgress(env.DB, b.id, second!.id, HOUSEHOLD);

    expect((await progressRows()).map((r) => r.progress_id)).toEqual([first!.id]);
  });

  it('deletes a book with shared progress cleanly', async () => {
    await shareView();
    const b = await book();
    await addProgress(env.DB, b.id, 36, null);

    await deleteItem(env.DB, b.id);

    expect(await rows('SELECT * FROM activity_log')).toHaveLength(0);
    expect(await rows('SELECT * FROM reading_progress')).toHaveLength(0);
  });

  it('backfills recent progress when the first view is shared', async () => {
    const b = await book();
    await addProgress(env.DB, b.id, 36, null);
    await addProgress(env.DB, b.id, 124, null);
    expect(await rows('SELECT * FROM activity_log')).toHaveLength(0);

    await shareView();

    expect(await progressRows()).toHaveLength(2);
  });
});

// ---------- serving ----------

type FeedBody = {
  latest: number;
  entries: Array<{ id: number; kind: string; item: { title: string; rating: number | null; review: string | null; progress: unknown } }>;
};

describe('serving progress to a connection', () => {
  beforeEach(upgradedSwitches); // the household's stream, names off (§16 #49)
  let peer: Peer;
  beforeEach(async () => {
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
  });

  const feedOf = async (viewId: number) => (await (await a.signedGet(`/federation/feed?view=${viewId}&since=0`, peer)).json()) as FeedBody;
  const check = async (viewId: number, ids: number[]) =>
    (await (await a.signedPost('/federation/feed/check', peer, { view: viewId, ids })).json()) as { invalid: number[] };

  it('sends each update with its own page, not where the book has got to since', async () => {
    const view = await shareView();
    const b = await book('The Dispossessed', 300);
    await addProgress(env.DB, b.id, 60, null);
    await addProgress(env.DB, b.id, 150, null);

    const body = await feedOf(view.id);
    const progress = body.entries.filter((e) => e.kind === 'progress');

    // newest first on a first pull
    expect(progress.map((e) => e.item.progress)).toEqual([
      { page: 150, percent: 50 },
      { page: 60, percent: 20 },
    ]);
    for (const e of progress) {
      expect(e.item.rating).toBeNull();
      expect(e.item.review).toBeNull();
    }
  });

  it('withdraws entries already sent when progress sharing is switched off, or an update is deleted', async () => {
    const view = await shareView();
    const b = await book();
    await addProgress(env.DB, b.id, 60, null);
    await addProgress(env.DB, b.id, 150, null);
    const ids = (await feedOf(view.id)).entries.map((e) => e.id);
    expect((await check(view.id, ids)).invalid).toEqual([]);

    const [firstUpdate] = await listProgress(env.DB, b.id);
    await deleteProgress(env.DB, b.id, firstUpdate!.id, HOUSEHOLD);
    expect((await check(view.id, ids)).invalid).toHaveLength(1);

    await updateSiteSettings(env.DB, { progressToConnections: false });
    expect((await check(view.id, ids)).invalid.sort()).toEqual([...ids].sort());
  });
});

// ---------- the wire format ----------

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
  it('carries progress only on a progress entry', async () => {
    const b = await book('Piranesi', 272);
    const item = { ...b, progressPage: 136 };
    expect(toFeedItem(item, 'progress', '0123456789abcdef', 136).progress).toEqual({ page: 136, percent: 50 });
    expect(toFeedItem(item, 'rated', '0123456789abcdef', 136).progress).toBeNull();
    const withProgress = toFeedItem(item, 'progress', '0123456789abcdef', 136);
    expect(keepForKind(withProgress, 'finished').progress).toBeNull(); // the receiver re-applies the owner's rule
  });

  it('reads an entry from a household on an older version, which sends no progress field', () => {
    const parsed = parseFeedItem(sentItem());
    expect(parsed).not.toBeNull();
    expect(parsed!.progress).toBeNull();
  });

  it('rejects malformed progress', () => {
    for (const progress of [
      { page: 0, percent: null },
      { page: -3, percent: 10 },
      { page: 1.5, percent: 10 },
      { page: MAX_FEED_PAGE + 1, percent: 10 },
      { page: 10, percent: 101 },
      { page: 10, percent: -1 },
      { page: '10', percent: 5 },
      'p. 10',
      [10, 5],
    ]) {
      expect(parseFeedItem(sentItem({ progress }))).toBeNull();
    }
    expect(parseFeedItem(sentItem({ progress: { page: 10, percent: null } }))?.progress).toEqual({ page: 10, percent: null });
  });

  it('drops a progress entry with no page to show', () => {
    expect(parseFeedEntry({ id: 9, kind: 'progress', published: sqlAgo(1), item: sentItem() })).toBeNull();
    expect(
      parseFeedEntry({ id: 9, kind: 'progress', published: sqlAgo(1), item: sentItem({ progress: { page: 40, percent: 15 } }) }),
    ).not.toBeNull();
  });

  it('keeps the rest of a page when an entry has a kind it does not know — how an older household meets progress', () => {
    const page = parseFeedPage({
      latest: 12,
      more: false,
      entries: [
        { id: 11, kind: 'some-future-kind', published: sqlAgo(2), item: sentItem() },
        { id: 12, kind: 'finished', published: sqlAgo(1), item: sentItem() },
      ],
    });
    expect(page?.entries.map((e) => e.id)).toEqual([12]);
    expect(page?.latest).toBe(12); // the cursor still moves past what it skipped
  });
});

// ---------- the Feed page ----------

describe('the Feed page', () => {
  let connectionId: number;
  let subscriptionId: number;
  beforeEach(async () => {
    await setUpA();
    const peer = await makePeer('Riverbank library');
    connectionId = (await connectPeer(peer)).id;
    const sub = await createSubscription(env.DB, {
      connectionId,
      viewId: 7,
      viewName: 'Reading',
      intervalMinutes: 60,
      retentionDays: 90,
      maxEntries: 500,
    });
    subscriptionId = sub!.id;
    // the page pulls anything due after responding; answer with nothing new
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/feed/check'
        ? json({ invalid: [], viewGone: false })
        : json({ view: 7, latest: 0, more: false, entries: [] }),
    );
  });

  const stored = (remoteId: number, kind: string, minutesAgo: number, item: Record<string, unknown>): NewRemoteActivity => {
    const body = JSON.stringify(sentItem(item));
    return {
      remoteId,
      itemRemoteId: (item.id as number) ?? 5,
      itemStamp: '0123456789abcdef',
      kind: kind as NewRemoteActivity['kind'],
      publishedAt: sqlAgo(minutesAgo),
      item: body,
      bytes: body.length,
    };
  };

  it("gathers a book's updates into one card, newest first", async () => {
    await storeEntries(env.DB, subscriptionId, [
      stored(1, 'progress', 3 * 24 * 60, { progress: { page: 36, percent: 12 } }),
      stored(2, 'progress', 24 * 60, { progress: { page: 124, percent: 41 } }),
      stored(3, 'progress', 120, { progress: { page: 187, percent: 62 } }),
    ]);

    const html = await (await a.get('/feed', await sessionCookie('member'))).text();

    expect(html.match(/class="feed-card"/g)).toHaveLength(1);
    expect(html).toContain('reading');
    const order = ['p. 187', 'p. 124', 'p. 36'].map((p) => html.indexOf(p));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(html).toContain('width:62%'); // the bar shows the latest
  });

  it("shows one entry's date once — the card's — and every entry's date when there are several", async () => {
    const card = (html: string) => html.replace(/\s+/g, ' ').match(/<article class="feed-card">.*?<\/article>/)![0];
    const logDates = (html: string) => [...card(html).matchAll(/<li>.*?<\/li>/g)].map((li) => li[0].match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null);

    await storeEntries(env.DB, subscriptionId, [stored(1, 'progress', 1, { progress: { page: 36, percent: 12 } })]);
    let html = await (await a.get('/feed', await sessionCookie('member'))).text();
    const day = sqlAgo(1).slice(0, 10);
    expect(card(html)).toContain(`<span class="feed-date">${day}</span>`);
    expect(card(html).match(new RegExp(day, 'g'))).toHaveLength(1); // not repeated beside p. 36
    expect(logDates(html)).toEqual([null]);

    await storeEntries(env.DB, subscriptionId, [
      stored(2, 'progress', 2 * 24 * 60, { progress: { page: 10, percent: 3 } }),
      stored(3, 'progress', 3 * 24 * 60, { progress: { page: 5, percent: 2 } }),
    ]);
    html = await (await a.get('/feed', await sessionCookie('member'))).text();
    expect(logDates(html)).toEqual([day, sqlAgo(2 * 24 * 60).slice(0, 10), sqlAgo(3 * 24 * 60).slice(0, 10)]);
  });

  it('says finished once the book is, and keeps the timeline as the record', async () => {
    await storeEntries(env.DB, subscriptionId, [
      stored(1, 'progress', 600, { progress: { page: 150, percent: 50 } }),
      stored(2, 'finished', 60, { completedOn: '2026-09-28' }),
    ]);

    const html = (await (await a.get('/feed', await sessionCookie('member'))).text()).replace(/\s+/g, ' ');

    expect(html).toContain('finished</span> <strong>Piranesi');
    expect(html).not.toMatch(/reading<\/span> <strong>Piranesi/);
    expect(html).toContain('p. 150');
    expect(html).not.toContain('progress-fill'); // no bar stuck at its last percent under "finished"
  });
});

// ---------- the setting ----------

describe('sharing progress with connections', () => {
  beforeEach(setUpA);

  it('is on by default, and an admin can switch it off and on', async () => {
    const admin = await sessionCookie('admin');
    expect((await getSiteSettings(env.DB)).progressToConnections).toBe(true);

    await a.postForm('/connections/progress-sharing', {}, admin); // unchecked: nothing submitted
    expect((await getSiteSettings(env.DB)).progressToConnections).toBe(false);

    await a.postForm('/connections/progress-sharing', { progressToConnections: 'on' }, admin);
    expect((await getSiteSettings(env.DB)).progressToConnections).toBe(true);
  });

  it('is an admin decision', async () => {
    const res = await a.postForm('/connections/progress-sharing', {}, await sessionCookie('member'));
    expect(res.status).toBe(403);
    expect((await getSiteSettings(env.DB)).progressToConnections).toBe(true);
  });
});
