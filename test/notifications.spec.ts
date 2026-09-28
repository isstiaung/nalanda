// Notifications (ARCH.md §16 #36): each connection, borrowing and comment event notifies once — a replayed
// message must not notify again — connection events only admins, and each person reads them separately.
// Feed activity is counted rather than notified, and that count survives the Feed page's own pull.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConnectionView,
  createInvite,
  createSubscription,
  getConnectionByBaseUrl,
  getFederationSettings,
  insertBorrowRequest,
  notify,
  storeEntries,
  unreadCounts,
  type NewRemoteActivity,
} from '../src/db/federation';
import { createItem, createLibrary, createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted, isBudgetSpent } from '../src/federation/budget';
import { receiveDirected } from '../src/federation/directed';
import { itemStamp } from '../src/federation/items';
import {
  borrowAccept,
  borrowDecline,
  borrowRequest,
  borrowWithdraw,
  commentCreate,
  connectRequest,
  inboxMessage,
  type DirectedMessage,
} from '../src/federation/messages';
import { clearSharedViewsCache } from '../src/federation/routes';
import { hashToken, newInviteToken } from '../src/federation/tokens';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import {
  A,
  answerOutbound,
  connectPeer,
  instanceA,
  json,
  makeKeys,
  makePeer,
  setUpA,
  sqlAgo,
  type Keys,
  type Peer,
} from './federation-helpers';

let keysA: Keys;
let a: ReturnType<typeof instanceA>;
let peer: Peer;

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  clearSharedViewsCache();
  await setUpA();
  peer = await makePeer('Riverbank library');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function person(role: 'admin' | 'member') {
  const user = await createUser(env.DB, { username: `${role}-${crypto.randomUUID().slice(0, 6)}`, passwordHash: 'pbkdf2$1$x$y', role, mustChangePassword: false });
  const cookie = `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000))}`;
  return { id: user.id, cookie };
}

const kinds = async () =>
  (await env.DB.prepare('SELECT kind FROM notifications ORDER BY id').all<{ kind: string }>()).results.map((r) => r.kind);

const inbox = (message: unknown, from: Peer = peer) => a.signedPost('/federation/inbox', from, message);

const count = async (query: string, ...params: unknown[]) => (await env.DB.prepare(query).bind(...params).first<{ n: number }>())!.n;

/** Instance A with room for only `left` D1 calls, so a request fails at a chosen point. */
const withBudget = (left: number) =>
  instanceA({ ...env, DB: budgeted(env.DB, { left }), FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);

// ---------- connections ----------

describe('connection events', () => {
  it('tells admins — and only admins — when a household redeems an invitation and waits on them', async () => {
    const admin = await person('admin');
    const member = await person('member');
    const token = newInviteToken();
    await createInvite(env.DB, { tokenHash: await hashToken(token), createdBy: admin.id, ttlDays: 7 });
    answerOutbound((req) =>
      req.url === `${peer.url}/.well-known/nalanda`
        ? json({ protocol: 'nalanda-connections', version: 1, name: peer.name, url: peer.url, publicKey: peer.publicJwk })
        : new Response('not found', { status: 404 }),
    );

    const res = await a.signedPost('/federation/connect', peer, connectRequest(peer.url, peer.name, peer.publicJwk, token));

    expect(res.status).toBe(202);
    expect(await kinds()).toEqual(['connection_request']);
    expect((await unreadCounts(env.DB, admin.id)).notifications).toBe(1);
    expect((await unreadCounts(env.DB, member.id)).notifications).toBe(0); // they can't confirm it anyway
    const html = await (await a.get('/notifications', admin.cookie)).text();
    expect(html).toContain('Riverbank library</strong> wants to connect');
  });

  it('tells us once when they accept ours, however often the acceptance arrives', async () => {
    await connectPeer(peer, 'awaiting_them');
    const accept = inboxMessage('ConnectAccept', peer.url);

    await inbox(accept);
    await inbox(accept); // their outbox may deliver it again

    expect((await getConnectionByBaseUrl(env.DB, peer.url))?.status).toBe('active');
    expect(await kinds()).toEqual(['connection_accepted']);
  });

  it('names a Disconnect by where it found us: a withdrawn request, a decline, or a disconnection', async () => {
    await connectPeer(peer, 'awaiting_us'); // they asked us, then took it back
    await inbox(inboxMessage('Disconnect', peer.url));
    const asked = await makePeer('Lakeside library');
    await connectPeer(asked, 'awaiting_them'); // we asked them; they backed out without confirming
    await inbox(inboxMessage('Disconnect', asked.url), asked);
    const other = await makePeer('Hillside annex');
    await connectPeer(other, 'active');
    await inbox(inboxMessage('Disconnect', other.url), other);

    expect(await kinds()).toEqual(['connection_withdrawn', 'connection_declined', 'disconnected']);
  });

  it('applies a connection message whole or not at all wherever it fails, so their retry still lands', async () => {
    // The replay marker once went in first and alone: a failure after it turned every retry away as
    // "already processed", leaving a connection waiting on an acceptance that had arrived, or never removed.
    const cases = [
      { type: 'ConnectAccept', from: 'awaiting_them', done: async () => (await getConnectionByBaseUrl(env.DB, peer.url))?.status === 'active' },
      { type: 'ConnectDecline', from: 'awaiting_them', done: async () => !(await getConnectionByBaseUrl(env.DB, peer.url)) },
      { type: 'Disconnect', from: 'active', done: async () => !(await getConnectionByBaseUrl(env.DB, peer.url)) },
    ] as const;
    for (const { type, from, done } of cases) {
      for (let left = 0; ; left++) {
        expect(left, `${type} never finished`).toBeLessThan(20);
        await env.DB.batch(['connections', 'federation_seen', 'notifications'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
        await connectPeer(peer, from);
        const message = inboxMessage(type, peer.url);

        const res = await withBudget(left).signedPost('/federation/inbox', peer, message);

        const seen = await count('SELECT count(*) AS n FROM federation_seen WHERE activity_id = ?1', message.id);
        const state = { seen, applied: (await done()) ? 1 : 0, notified: await count('SELECT count(*) AS n FROM notifications') };
        expect(state, `${type}, with room for ${left} queries`).toEqual({ seen, applied: seen, notified: seen });
        if (res.status === 200) {
          expect(state, type).toEqual({ seen: 1, applied: 1, notified: 1 });
          break;
        }
        expect(res.status).toBe(500);
        const retry = await inbox(message);
        expect(await retry.json(), `${type} retried after failing with room for ${left}`).not.toEqual({ status: 'already processed' });
        expect(await done()).toBe(true);
        expect(await count('SELECT count(*) AS n FROM notifications')).toBe(1);
      }
    }
  });

  it('records a redeemed invitation and its notice together, so a retry after a failure gets through', async () => {
    // Notified after the redemption, a failure between the two left a request no admin was told about, and
    // their retry was refused because the invitation was already used.
    const admin = await person('admin');
    answerOutbound((req) =>
      req.url === `${peer.url}/.well-known/nalanda`
        ? json({ protocol: 'nalanda-connections', version: 1, name: peer.name, url: peer.url, publicKey: peer.publicJwk })
        : new Response('not found', { status: 404 }),
    );
    for (let left = 0; ; left++) {
      expect(left, 'never finished').toBeLessThan(20);
      await env.DB.batch(['connections', 'connection_invites', 'notifications'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
      const token = newInviteToken();
      await createInvite(env.DB, { tokenHash: await hashToken(token), createdBy: admin.id, ttlDays: 7 });
      const request = connectRequest(peer.url, peer.name, peer.publicJwk, token);

      const res = await withBudget(left).signedPost('/federation/connect', peer, request);

      const pending = await count("SELECT count(*) AS n FROM connections WHERE status = 'awaiting_us'");
      const used = await count('SELECT count(*) AS n FROM connection_invites WHERE used_at IS NOT NULL');
      const notified = await count('SELECT count(*) AS n FROM notifications');
      expect({ used, notified }, `with room for ${left} queries`).toEqual({ used: pending, notified: pending });
      if (res.status === 202) {
        expect(pending).toBe(1);
        break;
      }
      expect(res.status).toBe(500);
      expect((await a.signedPost('/federation/connect', peer, request)).status, `retried after failing with room for ${left}`).toBe(202);
      expect(await kinds()).toEqual(['connection_request']);
    }
  });
});

// ---------- borrowing and comments ----------

describe('borrowing and comment events', () => {
  let bookId: number;
  let stamp: string;
  beforeEach(async () => {
    answerOutbound(() => json({}, 404));
    await connectPeer(peer);
    const shelf = await createLibrary(env.DB, 'Main');
    await createConnectionView(env.DB, { name: 'Main', libraryId: shelf.id, mediaType: null, status: null, owned: null });
    const book = await createItem(env.DB, { libraryId: shelf.id, title: 'The Dispossessed', copies: 1, review: 'An ambiguous utopia.' });
    bookId = book.id;
    stamp = await itemStamp(book);
  });

  it('notifies a borrow request once, naming the book, for everyone in the household', async () => {
    const member = await person('member');
    const request = borrowRequest(peer.url, bookId, stamp, 'narain', null);

    expect((await inbox(request)).status).toBe(200);
    await inbox(request);

    expect(await kinds()).toEqual(['borrow_request']);
    expect((await unreadCounts(env.DB, member.id)).notifications).toBe(1);
    expect(await (await a.get('/notifications', member.cookie)).text()).toContain('asked to borrow <em>The Dispossessed</em>');
  });

  it('notifies a comment on one of our reviews once, linking to the book', async () => {
    const comment = commentCreate(peer.url, { owner: A.url, item: bookId, stamp }, 'narain', 'Loved this one.');

    await inbox(comment);
    await inbox(comment);

    const rows = (await env.DB.prepare('SELECT kind, subject, href FROM notifications').all()).results;
    expect(rows).toEqual([{ kind: 'comment', subject: 'The Dispossessed', href: `/items/${bookId}` }]);
  });

  it('records each notification with its change or not at all, wherever a pull runs out of queries', async () => {
    // An outbox pull applies messages on a budget. Once the change and its notification were two calls, and a
    // budget spent between them kept the change alone; the next pull saw the change made, skipped the message,
    // and the notification never came.
    const settings = (await getFederationSettings(env.DB))!;
    const connection = (await getConnectionByBaseUrl(env.DB, peer.url))!;
    for (const activityId of ['urn:uuid:ours-declined', 'urn:uuid:ours-accepted']) {
      await insertBorrowRequest(env.DB, {
        activityId, connectionId: connection.id, incoming: false, theirItemId: 5, itemTitle: 'Kindred', requesterName: 'me', note: null,
      });
    }
    const request = borrowRequest(peer.url, bookId, stamp, 'narain', null);
    const returned = {
      '@context': 'https://www.w3.org/ns/activitystreams', type: 'Returned', id: `urn:uuid:${crypto.randomUUID()}`,
      actor: peer.url, request: 'urn:uuid:ours-accepted', returnedOn: '2026-09-20',
    } as DirectedMessage;
    const cases: Array<{ message: DirectedMessage; kind: string; applied: string }> = [
      { message: commentCreate(peer.url, { owner: A.url, item: bookId, stamp }, 'narain', 'Loved this one.'), kind: 'comment', applied: 'SELECT count(*) AS n FROM comments' },
      { message: request, kind: 'borrow_request', applied: 'SELECT count(*) AS n FROM borrow_requests WHERE incoming = 1' },
      { message: borrowWithdraw(peer.url, request.id), kind: 'borrow_withdrawn', applied: "SELECT count(*) AS n FROM borrow_requests WHERE status = 'withdrawn'" },
      { message: borrowDecline(peer.url, 'urn:uuid:ours-declined'), kind: 'borrow_declined', applied: "SELECT count(*) AS n FROM borrow_requests WHERE status = 'declined'" },
      { message: borrowAccept(peer.url, 'urn:uuid:ours-accepted', '2026-09-15', null), kind: 'borrow_accepted', applied: "SELECT count(*) AS n FROM borrow_requests WHERE status = 'accepted'" },
      { message: returned, kind: 'returned', applied: 'SELECT count(*) AS n FROM borrowed_items WHERE returned_on IS NOT NULL' },
    ];
    for (const { message, kind, applied } of cases) {
      for (let left = 0; ; left++) {
        expect(left, `${kind} never finished`).toBeLessThan(20);
        const outcome = await receiveDirected(budgeted(env.DB, { left }), settings, connection, message).catch((err) => {
          if (!isBudgetSpent(err)) throw err;
          return null;
        });
        // wherever it stopped, the change and its notification are both there or both missing
        const now = { applied: await count(applied), notified: await count('SELECT count(*) AS n FROM notifications WHERE kind = ?1', kind) };
        expect(now.notified, `${kind}, with room for ${left} queries`).toBe(now.applied);
        if (outcome) {
          expect(outcome.status, kind).toBe(200);
          expect(now, kind).toEqual({ applied: 1, notified: 1 });
          break;
        }
      }
    }
  });
});

// ---------- reading them ----------

describe('reading notifications', () => {
  it("keeps each person's read state separately, and marks only what was shown", async () => {
    const one = await person('member');
    const two = await person('member');
    await notify(env.DB, { kind: 'comment', householdName: peer.name, subject: 'Piranesi', href: '/items/1' });

    const page = await (await a.get('/notifications', one.cookie)).text();
    expect(page).toContain('class="unread"');
    expect((await unreadCounts(env.DB, one.id)).notifications).toBe(0);
    expect((await unreadCounts(env.DB, two.id)).notifications).toBe(1); // someone else's visit reads nothing for them

    await notify(env.DB, { kind: 'comment', householdName: peer.name, subject: 'Kindred', href: '/items/2' });
    expect((await unreadCounts(env.DB, one.id)).notifications).toBe(1); // arrived after the visit
    expect(await (await a.get('/notifications', one.cookie)).text()).not.toMatch(/class="unread"[^>]*>\s*<a[^>]*>\s*<strong>Riverbank library<\/strong> commented on <em>Piranesi/);
  });

  it('shows the count on every page, and escapes names from other instances', async () => {
    const me = await person('admin');
    await notify(env.DB, { kind: 'connection_request', householdName: '<img src=x onerror=alert(1)>', href: '/connections' });

    const overview = await (await a.get('/', me.cookie)).text();
    expect(overview).toContain('aria-label="1 unread"');
    // a phone folds the sidebar away, so the mobile bar carries its own link
    expect(overview).toContain('aria-label="1 unread notifications"');
    const list = await (await a.get('/notifications', me.cookie)).text();
    expect(list).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(list).not.toContain('<img src=x');
  });

  it('does not exist on an instance without connections, and costs its pages nothing', async () => {
    const plain = instanceA(env); // no federation key
    const me = await person('admin');
    expect((await plain.get('/notifications', me.cookie)).status).toBe(404);
    expect(await (await plain.get('/', me.cookie)).text()).not.toContain('/notifications');
  });
});

// ---------- the feed's count ----------

describe('new feed activity', () => {
  let subscriptionId: number;
  beforeEach(async () => {
    const connectionId = (await connectPeer(peer)).id;
    const sub = await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'Reading', intervalMinutes: 60, retentionDays: 90, maxEntries: 500 });
    subscriptionId = sub!.id;
  });

  const entry = (remoteId: number): NewRemoteActivity => {
    const item = JSON.stringify({
      id: remoteId, mediaType: 'book', title: `Book ${remoteId}`, creators: null, published: null, coverKey: null, rating: 8,
      review: null, reviewTruncated: false, inCollection: true, completedOn: null, stamp: '0123456789abcdef', progress: null,
    });
    return { remoteId, itemRemoteId: remoteId, itemStamp: '0123456789abcdef', kind: 'rated', publishedAt: sqlAgo(5), item, bytes: item.length };
  };

  it('counts what arrived since the last visit to Feed', async () => {
    const me = await person('member');
    await storeEntries(env.DB, subscriptionId, [entry(1), entry(2)]);
    expect((await unreadCounts(env.DB, me.id)).feed).toBe(2);

    answerOutbound(() => json({ view: 7, latest: 0, more: false, entries: [] }));
    await a.get('/feed', me.cookie);

    expect((await unreadCounts(env.DB, me.id)).feed).toBe(0);
  });

  it('still counts a new entry after the newest one was withdrawn (ids are never reused)', async () => {
    const me = await person('member');
    await storeEntries(env.DB, subscriptionId, [entry(1), entry(2)]);
    answerOutbound(() => json({ view: 7, latest: 0, more: false, entries: [] }));
    await a.get('/feed', me.cookie); // seen up to the newest stored entry
    // the owner withdraws that newest entry; a new one arrives
    await env.DB.prepare('DELETE FROM remote_activities WHERE id = (SELECT max(id) FROM remote_activities)').run();
    await storeEntries(env.DB, subscriptionId, [entry(3)]);

    expect((await unreadCounts(env.DB, me.id)).feed).toBe(1); // was 0: the new row reused the withdrawn id
  });

  it("leaves unread what the Feed page's own pull brings in after rendering", async () => {
    const me = await person('member');
    await storeEntries(env.DB, subscriptionId, [entry(1)]);
    // the pull the visit starts returns a new entry, stored after the page was rendered
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/feed'
        ? json({
            view: 7, latest: 3, more: false,
            entries: [{ id: 3, kind: 'rated', published: sqlAgo(1), item: JSON.parse(entry(3).item) }],
          })
        : json({ invalid: [], viewGone: false }),
    );

    await a.get('/feed', me.cookie); // waits for the background pull too

    expect((await unreadCounts(env.DB, me.id)).feed).toBe(1);
  });
});
