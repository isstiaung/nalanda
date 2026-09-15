// Route-level: phase 2 of connections between instances — connection views, the activity log, the
// feed this household serves, and following another household's (docs/proposals/connections.md §7, §8).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLifecycle,
  createConnectionView,
  createSubscription,
  deleteConnectionView,
  storeEntries,
  type NewRemoteActivity,
} from '../src/db/federation';
import { createItem, createLibrary, createLoan, deleteItem, updateItem } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { inboxMessage } from '../src/federation/messages';
import {
  answerOutbound,
  connectPeer,
  decode,
  instanceA,
  json,
  makeKeys,
  makePeer,
  sessionCookie,
  setUpA,
  signedBy,
  sqlAgo,
  type Keys,
  type Peer,
} from './federation-helpers';

let keysA: Keys;
let a: ReturnType<typeof instanceA>;
const disabled = instanceA(env);

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

const shareView = (overrides: Partial<Parameters<typeof createConnectionView>[1]> = {}) =>
  createConnectionView(env.DB, { name: 'Shared', libraryId: null, mediaType: null, status: null, owned: null, ...overrides });

type FeedBody = {
  latest: number;
  truncated: boolean;
  entries: Array<{ id: number; kind: string; item: { title: string } }>;
};

// ---------- the owner's side ----------

describe('recording activity', () => {
  it('records nothing until a view is shared, then one row per item and kind', async () => {
    const shelf = await createLibrary(env.DB, 'Main');
    await createItem(env.DB, { libraryId: shelf.id, title: 'Before', review: 'Great', rating: 8, status: 'completed' });
    expect(await rows('SELECT * FROM activity_log')).toHaveLength(0);

    // Sharing the first view starts the log with recent activity.
    await shareView();
    expect((await rows<{ kind: string }>('SELECT kind FROM activity_log')).map((r) => r.kind).sort()).toEqual([
      'finished',
      'rated',
      'reviewed',
    ]);

    const item = await createItem(env.DB, { libraryId: shelf.id, title: 'After', review: 'Fine' });
    const reviewed = async () =>
      (await rows<{ id: number }>("SELECT id FROM activity_log WHERE item_id = ? AND kind = 'reviewed'", item.id))[0]?.id;
    const first = await reviewed();
    expect(first).toBeDefined();

    await updateItem(env.DB, item.id, { review: 'Better on a second read' });
    const second = await reviewed();
    expect(second).toBeGreaterThan(first!); // replaced under a new id, never duplicated
    expect(await rows('SELECT * FROM activity_log WHERE item_id = ?', item.id)).toHaveLength(1);

    await updateItem(env.DB, item.id, { title: 'Retitled', review: 'Better on a second read' });
    expect(await reviewed()).toBe(second); // nothing connections see changed
    await updateItem(env.DB, item.id, { review: null });
    expect(await reviewed()).toBe(second); // removing a review isn't activity
  });
});

describe('the feed this household serves', () => {
  let peer: Peer;

  beforeEach(async () => {
    await setUpA();
    peer = await makePeer('Riverbank library');
    await connectPeer(peer);
  });

  it('serves activity in a view to an active connection, with whitelisted fields only', async () => {
    const shelf = await createLibrary(env.DB, 'Main');
    const hidden = await createLibrary(env.DB, 'Private');
    const view = await shareView({ libraryId: shelf.id });
    const inside = await createItem(env.DB, {
      libraryId: shelf.id,
      title: 'Inside',
      review: 'Loved it',
      rating: 9,
      status: 'completed',
      notes: 'PRIVATE-NOTE',
      copies: 3,
    });
    await createLoan(env.DB, { itemId: inside.id, borrower: 'SECRET-BORROWER' });
    await createItem(env.DB, { libraryId: hidden.id, title: 'Outside', review: 'Not for them' });

    const res = await a.signedGet(`/federation/feed?view=${view.id}&since=0`, peer);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of ['PRIVATE-NOTE', 'SECRET-BORROWER', 'Outside', '"copies"', '"notes"']) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text) as FeedBody;
    expect(body.entries.map((e) => [e.kind, e.item.title]).sort()).toEqual([
      ['finished', 'Inside'],
      ['rated', 'Inside'],
      ['reviewed', 'Inside'],
    ]);
    expect(body.truncated).toBe(false);

    const again = (await (await a.signedGet(`/federation/feed?view=${view.id}&since=${body.latest}`, peer)).json()) as FeedBody;
    expect(again.entries).toEqual([]);
  });

  it('turns away unsigned requests, strangers and unconfirmed connections, and says when a view is gone', async () => {
    const view = await shareView();
    const path = `/federation/feed?view=${view.id}`;
    expect((await a.get(path)).status).toBe(401);
    expect((await a.signedGet(path, await makePeer('Stranger'))).status).toBe(401);
    const waiting = await makePeer('Waiting');
    await connectPeer(waiting, 'awaiting_us');
    expect((await a.signedGet(path, waiting)).status).toBe(401);

    const gone = await a.signedGet('/federation/feed?view=999', peer);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'no such view' });
    expect((await disabled.signedGet(path, peer)).status).toBe(404);
  });

  it('sends the newest 100 entries when more happened, and says the rest were cut', async () => {
    const shelf = await createLibrary(env.DB, 'Main');
    const view = await shareView();
    await env.DB.batch(
      Array.from({ length: 105 }, (_, i) =>
        env.DB.prepare("INSERT INTO items (library_id, title, review) VALUES (?, ?, 'ok')").bind(shelf.id, `Book ${i}`),
      ),
    );
    const body = (await (await a.signedGet(`/federation/feed?view=${view.id}&since=0`, peer)).json()) as FeedBody;
    expect(body.entries).toHaveLength(100);
    expect(body.truncated).toBe(true);
    expect(body.entries[0]!.item.title).toBe('Book 104');
  });

  it('tells a connection which of its stored entries are no longer shared', async () => {
    const shelf = await createLibrary(env.DB, 'Main');
    const elsewhere = await createLibrary(env.DB, 'Elsewhere');
    const view = await shareView({ libraryId: shelf.id });
    const unreviewed = await createItem(env.DB, { libraryId: shelf.id, title: 'Unreviewed later', review: 'Hmm' });
    const deleted = await createItem(env.DB, { libraryId: shelf.id, title: 'Deleted later', rating: 6 });
    const moved = await createItem(env.DB, { libraryId: shelf.id, title: 'Moved later', status: 'completed' });
    await createItem(env.DB, { libraryId: shelf.id, title: 'Kept', review: 'Yes' });

    const feed = (await (await a.signedGet(`/federation/feed?view=${view.id}&since=0`, peer)).json()) as FeedBody;
    const ids = ['Unreviewed later', 'Deleted later', 'Moved later', 'Kept'].map(
      (title) => feed.entries.find((e) => e.item.title === title)!.id,
    );

    await updateItem(env.DB, unreviewed.id, { review: null });
    await deleteItem(env.DB, deleted.id);
    await updateItem(env.DB, moved.id, { libraryId: elsewhere.id });
    const check = await a.signedPost('/federation/feed/check', peer, { view: view.id, ids });
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ invalid: ids.slice(0, 3), viewGone: false });

    await deleteConnectionView(env.DB, view.id);
    expect(await (await a.signedPost('/federation/feed/check', peer, { view: view.id, ids })).json()).toEqual({
      invalid: ids,
      viewGone: true,
    });
    expect((await a.signedPost('/federation/feed/check', peer, { view: view.id, ids: ['1'] })).status).toBe(400);
  });

  it('lists shared views with their size and recent activity', async () => {
    const shelf = await createLibrary(env.DB, 'Main');
    const view = await shareView({ name: 'Everything' });
    await createItem(env.DB, { libraryId: shelf.id, title: 'One', review: 'x'.repeat(100) });
    await createItem(env.DB, { libraryId: shelf.id, title: 'Two' });
    const body = (await (await a.signedGet('/federation/views', peer)).json()) as {
      views: Array<{ recent: { bytes: number } }>;
    };
    expect(body.views).toEqual([
      { id: view.id, name: 'Everything', itemCount: 2, recent: { days: 90, activities: 1, bytes: expect.any(Number) } },
    ]);
    expect(body.views[0]!.recent.bytes).toBeGreaterThan(100);
  });

  it('shares a view from the Connections page, admins only', async () => {
    const shelf = await createLibrary(env.DB, 'Main');
    const admin = await sessionCookie('admin');
    const fields = { name: 'Finished books', libraryId: String(shelf.id), mediaType: 'book', status: 'completed', owned: '' };
    expect((await a.postForm('/connections/views', fields, await sessionCookie('member'))).status).toBe(403);
    expect((await a.postForm('/connections/views', fields, admin)).status).toBe(302);
    const html = await (await a.get('/connections', admin)).text();
    expect(html).toContain('Finished books');
    expect(html).toContain('Book · Completed');
  });
});

describe('covers', () => {
  it('may load on connected households’ pages, only on an instance with a federation key', async () => {
    const key = crypto.randomUUID();
    await env.COVERS.put(key, new Uint8Array(1200), { httpMetadata: { contentType: 'image/jpeg' } });
    const withKey = await a.get(`/covers/${key}`);
    await withKey.arrayBuffer();
    expect(withKey.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const withoutKey = await disabled.get(`/covers/${key}`);
    await withoutKey.arrayBuffer();
    expect(withoutKey.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
});

// ---------- the receiving side ----------

describe('following another household', () => {
  let peer: Peer;
  let connectionId: number;
  let admin: string;

  beforeEach(async () => {
    await setUpA();
    peer = await makePeer('Riverbank library');
    connectionId = (await connectPeer(peer)).id;
    admin = await sessionCookie('admin');
  });

  const follow = (overrides: Partial<Parameters<typeof createSubscription>[1]> = {}) =>
    createSubscription(env.DB, {
      connectionId,
      viewId: 7,
      viewName: 'Finished',
      intervalMinutes: 60,
      retentionDays: 90,
      maxEntries: 500,
      ...overrides,
    }).then((sub) => sub!);

  const entry = (id: number, title: string, item: Record<string, unknown> = {}) => ({
    id,
    kind: 'reviewed',
    published: sqlAgo(10),
    item: {
      id,
      mediaType: 'book',
      title,
      creators: 'Someone',
      published: '2020',
      coverKey: null,
      rating: null,
      review: 'Good',
      reviewTruncated: false,
      inCollection: true,
      completedOn: null,
      ...item,
    },
  });

  const stored = (remoteId: number, minutesAgo: number): NewRemoteActivity => ({
    remoteId,
    kind: 'rated',
    publishedAt: sqlAgo(minutesAgo),
    item: '{}',
    bytes: 2,
  });

  it('shows the views they share, and follows one with the limits chosen', async () => {
    const theirs = { views: [{ id: 7, name: 'Finished this year', itemCount: 42, recent: { days: 90, activities: 30, bytes: 30_000 } }] };
    const outbound = answerOutbound((req) => (new URL(req.url).pathname === '/federation/views' ? json(theirs) : json({}, 404)));
    const html = await (await a.get(`/connections/${connectionId}/feed`, admin)).text();
    expect(html).toContain('Finished this year');
    expect(html).toContain('Follow');
    expect(await signedBy(keysA.pair.publicKey, outbound[0]!)).toBe(true);
    expect((await a.get(`/connections/${connectionId}/feed`, await sessionCookie('member'))).status).toBe(403);

    const path = `/connections/${connectionId}/subscriptions`;
    const refused = await a.postForm(path, { viewId: '7', intervalMinutes: '5', retentionDays: '90', maxEntries: '500' }, admin);
    expect(await refused.text()).toContain('Pull every 15 minutes');
    expect(await rows('SELECT * FROM feed_subscriptions')).toHaveLength(0);

    const followed = await a.postForm(path, { viewId: '7', intervalMinutes: '1440', retentionDays: '30', maxEntries: '200' }, admin);
    expect(followed.status).toBe(302);
    expect(
      await rows('SELECT view_id, view_name, interval_minutes, retention_days, max_entries FROM feed_subscriptions'),
    ).toEqual([{ view_id: 7, view_name: 'Finished this year', interval_minutes: 1440, retention_days: 30, max_entries: 200 }]);
  });

  it('pulls when Feed opens, keeps only what validates, and honours the removal check', async () => {
    const sub = await follow();
    const cover = crypto.randomUUID();
    let checked: Record<string, unknown> | null = null;
    const outbound = answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/feed') {
        return json({
          view: 7,
          latest: 12,
          truncated: false,
          entries: [
            entry(10, 'Withdrawn later'),
            entry(11, 'Hostile', { review: '<img src=x onerror=alert(1)>', coverKey: cover }),
            entry(12, 'Bad cover', { coverKey: 'https://evil.example/x.png' }),
          ],
        });
      }
      if (pathname === '/federation/feed/check') {
        checked = decode(req.body);
        return json({ invalid: [10, 999], viewGone: false });
      }
      return json({}, 404);
    });
    const member = await sessionCookie('member');

    await a.get('/feed', member); // the pull runs after the response
    expect(outbound.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([
      '/federation/feed?view=7&since=0',
      '/federation/feed/check',
    ]);
    expect(await signedBy(keysA.pair.publicKey, outbound[0]!)).toBe(true);
    expect(checked).toEqual({ view: 7, ids: expect.arrayContaining([10, 11]) });
    expect(await rows('SELECT remote_id FROM remote_activities')).toEqual([{ remote_id: 11 }]);
    expect(await rows('SELECT cursor FROM feed_subscriptions WHERE id = ?', sub.id)).toEqual([{ cursor: 12 }]);

    const html = await (await a.get('/feed', member)).text();
    expect(outbound).toHaveLength(2); // not due again within its interval
    expect(html).toContain('Hostile');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(`${peer.url}/covers/${cover}`);
    expect(html).not.toContain('evil.example');
    expect(html).toContain('1 entry was removed');
  });

  it('keeps only what the subscription and the connection ceiling allow', async () => {
    const small = await follow({ viewId: 1, retentionDays: 30, maxEntries: 10 });
    await storeEntries(env.DB, small.id, [
      ...Array.from({ length: 30 }, (_, i) => stored(i + 1, (30 - i) * 60)),
      stored(100, 60 * 24 * 45), // older than the 30 days kept
    ]);
    await applyLifecycle(env.DB, small);
    expect((await rows<{ remote_id: number }>('SELECT remote_id FROM remote_activities ORDER BY remote_id')).map((r) => r.remote_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 21 + i),
    );

    const big = await follow({ viewId: 2, retentionDays: 365, maxEntries: 1000 });
    const bigger = await follow({ viewId: 3, retentionDays: 365, maxEntries: 1000 });
    await storeEntries(env.DB, big.id, Array.from({ length: 700 }, (_, i) => stored(1000 + i, i)));
    await storeEntries(env.DB, bigger.id, Array.from({ length: 700 }, (_, i) => stored(5000 + i, i)));
    await applyLifecycle(env.DB, big);
    expect(await rows('SELECT count(*) AS n FROM remote_activities')).toEqual([{ n: 1000 }]);
  });

  it('drops everything from a view they stop sharing', async () => {
    const sub = await follow();
    await storeEntries(env.DB, sub.id, [stored(1, 5)]);
    answerOutbound(() => json({ error: 'no such view' }, 404));
    await a.get('/feed', await sessionCookie('member'));
    expect(await rows('SELECT * FROM remote_activities')).toHaveLength(0);
    expect((await rows<{ gone_at: string | null }>('SELECT gone_at FROM feed_subscriptions'))[0]!.gone_at).not.toBeNull();
    expect(await (await a.get(`/connections/${connectionId}/feed`, admin)).text()).toContain('No longer shared');
  });

  it('deletes everything stored from a connection when either side disconnects', async () => {
    await storeEntries(env.DB, (await follow()).id, [stored(1, 5)]);
    answerOutbound(() => json({ status: 'disconnected' }));
    await a.postForm(`/connections/${connectionId}/disconnect`, {}, admin);
    expect(await rows('SELECT * FROM feed_subscriptions')).toHaveLength(0);
    expect(await rows('SELECT * FROM remote_activities')).toHaveLength(0);

    const other = await makePeer('Lakeside library');
    connectionId = (await connectPeer(other)).id;
    await storeEntries(env.DB, (await follow()).id, [stored(1, 5)]);
    expect((await a.signedPost('/federation/inbox', other, inboxMessage('Disconnect', other.url))).status).toBe(200);
    expect(await rows('SELECT * FROM remote_activities')).toHaveLength(0);
  });
});

describe('without a federation key', () => {
  it('has no Feed page or link', async () => {
    const member = await sessionCookie('member');
    expect((await disabled.get('/feed', member)).status).toBe(404);
    expect(await (await disabled.get('/', member)).text()).not.toContain('href="/feed"');
    expect(await (await a.get('/', member)).text()).toContain('href="/feed"');
    expect((await disabled.postForm('/connections/views', { name: 'x' }, await sessionCookie('admin'))).status).toBe(404);
  });
});
