// Route-level: phase 3 of connections between instances — comments on reviews in both directions,
// deletions, and the outbox behind every push (docs/proposals/connections.md §8, §9).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConnectionView,
  createSubscription,
  enqueueOutbox,
  pruneOrphanThreads,
  removeEntries,
  storeEntries,
} from '../src/db/federation';
import { createItem, createLibrary, deleteItem } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import { itemStamp } from '../src/federation/items';
import { commentCreate, commentDelete, inboxMessage } from '../src/federation/messages';
import {
  A,
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
let peer: Peer;
let connectionId: number;
let shelfId: number;
let itemId: number;
let stamp: string;
const THEIRS = '0123456789abcdef'; // the stamp of a book of theirs

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  await setUpA();
  peer = await makePeer('Riverbank library');
  connectionId = (await connectPeer(peer)).id;
  shelfId = (await createLibrary(env.DB, 'Main')).id;
  await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelfId, mediaType: null, status: null, owned: null });
  const item = await createItem(env.DB, { libraryId: shelfId, title: 'The Dispossessed', review: 'An ambiguous utopia.' });
  itemId = item.id;
  stamp = await itemStamp(item);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

const onOurReview = (from: Peer, content: string, item = itemId, itemStampOf = stamp) =>
  commentCreate(from.url, { owner: A.url, item, stamp: itemStampOf }, 'narain', content);

const onTheirReview = (from: Peer, item: number, content: string, itemStampOf = THEIRS) =>
  commentCreate(from.url, { owner: from.url, item, stamp: itemStampOf }, 'ana', content);

const inbox = (from: Peer, message: unknown) => a.signedPost('/federation/inbox', from, message);

const theirEntry = (item: number, itemStampOf: string, remoteId: number) => {
  const body = JSON.stringify({
    id: item,
    mediaType: 'book',
    title: 'Their book',
    creators: null,
    published: null,
    coverKey: null,
    rating: null,
    review: 'Their review',
    reviewTruncated: false,
    inCollection: true,
    completedOn: null,
    stamp: itemStampOf,
  });
  return {
    remoteId,
    itemRemoteId: item,
    itemStamp: itemStampOf,
    kind: 'reviewed' as const,
    publishedAt: sqlAgo(5),
    item: body,
    bytes: body.length,
  };
};

/** This household follows one of their reviews: a stored `reviewed` entry, already pulled. */
async function followTheirReview(item: number, itemStampOf = THEIRS) {
  const sub = (await createSubscription(env.DB, {
    connectionId,
    viewId: 1,
    viewName: 'Theirs',
    intervalMinutes: 1440,
    retentionDays: 90,
    maxEntries: 500,
  }))!;
  await env.DB.prepare("UPDATE feed_subscriptions SET last_pulled_at = datetime('now') WHERE id = ?").bind(sub.id).run();
  await storeEntries(env.DB, sub.id, [theirEntry(item, itemStampOf, 500 + item)]);
  return sub;
}

const feedComment = (item: number, body: string, itemStampOf = THEIRS) => ({
  connectionId: String(connectionId),
  itemId: String(item),
  stamp: itemStampOf,
  body,
});

describe('comments on this household’s reviews', () => {
  it('are taken for a shared review, shown under it escaped, and taken once', async () => {
    const message = onOurReview(peer, '<b>Loved</b> the ending');
    expect(await (await inbox(peer, message)).json()).toEqual({ status: 'received' });
    expect(await (await inbox(peer, message)).json()).toEqual({ status: 'already received' });
    expect(await rows('SELECT author_name, body, from_us FROM comments')).toEqual([
      { author_name: 'narain', body: '<b>Loved</b> the ending', from_us: 0 },
    ]);

    const html = await (await a.get(`/items/${itemId}`, await sessionCookie('member'))).text();
    expect(html).toContain('Comments from connections');
    expect(html).toContain('Riverbank library');
    expect(html).toContain('&lt;b&gt;Loved&lt;/b&gt; the ending');
    expect(html).not.toContain('<b>Loved');
  });

  it('are refused on reviews it doesn’t share, on no review, on a third household’s, and from a pending connection', async () => {
    const hidden = (await createLibrary(env.DB, 'Private')).id;
    const unshared = await createItem(env.DB, { libraryId: hidden, title: 'Private', review: 'Mine' });
    const unreviewed = await createItem(env.DB, { libraryId: shelfId, title: 'Unreviewed' });

    expect((await inbox(peer, onOurReview(peer, 'Hi', unshared.id, await itemStamp(unshared)))).status).toBe(404);
    expect((await inbox(peer, onOurReview(peer, 'Hi', unreviewed.id, await itemStamp(unreviewed)))).status).toBe(404);
    expect((await inbox(peer, onOurReview(peer, 'Hi', 999_999))).status).toBe(404);
    expect(
      (await inbox(peer, commentCreate(peer.url, { owner: 'https://third.example', item: itemId, stamp }, 'narain', 'Hi'))).status,
    ).toBe(400);
    expect((await inbox(peer, onOurReview(peer, 'x'.repeat(2001)))).status).toBe(400);

    const waiting = await makePeer('Waiting');
    await connectPeer(waiting, 'awaiting_us');
    expect((await inbox(waiting, onOurReview(waiting, 'Hi'))).status).toBe(409);
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
  });

  it('refuses a comment meant for a book whose id has since been reused', async () => {
    const mistake = await createItem(env.DB, { libraryId: shelfId, title: 'The wrong edition', review: 'Oops' });
    const mistakeStamp = await itemStamp(mistake);
    await deleteItem(env.DB, mistake.id);
    const replacement = await createItem(env.DB, {
      libraryId: shelfId,
      title: 'The right edition',
      review: 'Better',
      addedAt: '2026-01-02 03:04:05',
    });
    expect(replacement.id).toBe(mistake.id); // SQLite hands the newest deleted id out again

    expect((await inbox(peer, onOurReview(peer, 'About the wrong one', mistake.id, mistakeStamp))).status).toBe(404);
    expect((await inbox(peer, onOurReview(peer, 'About the right one', replacement.id, await itemStamp(replacement)))).status).toBe(200);
    expect(await rows('SELECT body FROM comments')).toEqual([{ body: 'About the right one' }]);
  });

  it('get replies from the item page, pushed signed to that household and kept in its outbox alone', async () => {
    await inbox(peer, onOurReview(peer, 'What did you make of the ending?'));
    const pushes: Record<string, unknown>[] = [];
    let signed = false;
    answerOutbound(async (req) => {
      if (req.url !== `${peer.url}/federation/inbox`) return json({}, 404);
      pushes.push(decode(req.body));
      signed = await signedBy(keysA.pair.publicKey, req);
      return json({ status: 'received' });
    });
    const member = await sessionCookie('member');
    const reply = { connectionId: String(connectionId), body: 'Still thinking about it.' };
    expect((await a.postForm(`/items/${itemId}/comments`, reply, member)).status).toBe(302);
    expect(signed).toBe(true);
    expect(pushes).toEqual([
      expect.objectContaining({ type: 'CommentCreate', actor: A.url, inReplyTo: { owner: A.url, item: itemId, stamp }, content: reply.body }),
    ]);
    expect((await rows<{ delivered_at: string | null }>('SELECT delivered_at FROM outbox'))[0]!.delivered_at).not.toBeNull();

    // A push that fails waits in the outbox, which serves it to that household and nobody else.
    answerOutbound(() => new Response('down', { status: 503 }));
    await a.postForm(`/items/${itemId}/comments`, { connectionId: String(connectionId), body: 'Hello?' }, member);
    const page = (await (await a.signedGet('/federation/outbox?since=0', peer)).json()) as {
      latest: number;
      more: boolean;
      messages: Array<{ seq: number; message: { content: string } }>;
    };
    expect(page.messages.map((m) => [m.seq, m.message.content])).toEqual([
      [1, 'Still thinking about it.'],
      [2, 'Hello?'],
    ]);
    expect(page).toMatchObject({ latest: 2, more: false });

    const other = await makePeer('Lakeside library');
    await connectPeer(other);
    expect(((await (await a.signedGet('/federation/outbox?since=0', other)).json()) as { messages: unknown[] }).messages).toEqual([]);
  });

  it('can only be replied to where that household started a thread', async () => {
    const pushes: unknown[] = [];
    answerOutbound((req) => {
      pushes.push(req.url);
      return json({});
    });
    await a.postForm(`/items/${itemId}/comments`, { connectionId: String(connectionId), body: 'Unprompted' }, await sessionCookie('member'));
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
    expect(pushes).toEqual([]);
  });
});

describe('deleting comments', () => {
  it('lets this household remove any comment on its own review, and tells the other household', async () => {
    const theirs = onOurReview(peer, 'Rude remark');
    await inbox(peer, theirs);
    const [row] = await rows<{ id: number }>('SELECT id FROM comments');
    const pushes: Record<string, unknown>[] = [];
    answerOutbound((req) => {
      pushes.push(decode(req.body));
      return json({ status: 'deleted' });
    });
    const member = await sessionCookie('member');
    await a.postForm(`/comments/${row!.id}/delete`, { back: `/items/${itemId}#comments` }, member);
    expect(await rows('SELECT body, deleted_at IS NOT NULL AS deleted FROM comments')).toEqual([{ body: null, deleted: 1 }]);
    expect(pushes).toEqual([expect.objectContaining({ type: 'CommentDelete', comment: theirs.id })]);
    expect(await (await a.get(`/items/${itemId}`, member)).text()).not.toContain('Rude remark');
  });

  it('lets the other household withdraw only its own comments', async () => {
    const theirs = onOurReview(peer, 'Changed my mind');
    await inbox(peer, theirs);
    answerOutbound(() => json({ status: 'received' }));
    await a.postForm(`/items/${itemId}/comments`, { connectionId: String(connectionId), body: 'Our reply' }, await sessionCookie('member'));
    const [ours] = await rows<{ activity_id: string }>('SELECT activity_id FROM comments WHERE from_us = 1');

    expect((await inbox(peer, commentDelete(peer.url, ours!.activity_id))).status).toBe(403);
    expect((await inbox(peer, commentDelete(peer.url, theirs.id))).status).toBe(200);
    expect(await rows('SELECT from_us, body FROM comments ORDER BY id')).toEqual([
      { from_us: 0, body: null },
      { from_us: 1, body: 'Our reply' },
    ]);
  });

  it('keeps a comment deleted when its deletion arrives first', async () => {
    const late = onOurReview(peer, 'Arrives late');
    expect((await inbox(peer, commentDelete(peer.url, late.id))).status).toBe(200);
    expect(await (await inbox(peer, late)).json()).toEqual({ status: 'already received' });
    expect(await rows('SELECT body FROM comments')).toEqual([{ body: null }]);
  });
});

describe('comments on a connected household’s reviews', () => {
  it('are sent from the Feed only for a review this household follows, and their replies join the thread', async () => {
    await followTheirReview(77);
    const pushes: Record<string, unknown>[] = [];
    answerOutbound((req) => {
      if (new URL(req.url).pathname !== '/federation/inbox') return json({}, 404);
      pushes.push(decode(req.body));
      return json({ status: 'received' });
    });
    const member = await sessionCookie('member');
    await a.postForm('/feed/comments', feedComment(77, 'Lovely review'), member);
    await a.postForm('/feed/comments', feedComment(78, 'Not followed'), member);
    expect(pushes).toEqual([
      expect.objectContaining({ type: 'CommentCreate', inReplyTo: { owner: peer.url, item: 77, stamp: THEIRS }, content: 'Lovely review' }),
    ]);
    expect(await rows('SELECT their_item_id, their_item_stamp, body FROM comments')).toEqual([
      { their_item_id: 77, their_item_stamp: THEIRS, body: 'Lovely review' },
    ]);

    expect(await (await inbox(peer, onTheirReview(peer, 77, 'Thank you!'))).json()).toEqual({ status: 'received' });
    expect(await (await inbox(peer, onTheirReview(peer, 78, 'Unfollowed'))).json()).toEqual({ status: 'not kept' });

    const html = await (await a.get('/feed', member)).text();
    expect(html).toContain('Lovely review');
    expect(html).toContain('Thank you!');
    expect(html).toContain('Seen only by Riverbank library and this library.');
  });

  it('keep their comment only in a thread this household started', async () => {
    await followTheirReview(77);
    expect(await (await inbox(peer, onTheirReview(peer, 77, 'Unprompted'))).json()).toEqual({ status: 'not kept' });
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
  });

  it('go with the feed entries they belong to', async () => {
    const sub = await followTheirReview(77);
    answerOutbound(() => json({ status: 'received' }));
    await a.postForm('/feed/comments', feedComment(77, 'Lovely review'), await sessionCookie('member'));
    expect(await rows('SELECT * FROM comments')).toHaveLength(1);
    await a.postForm(`/connections/${connectionId}/subscriptions/${sub.id}/purge`, {}, await sessionCookie('admin'));
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
  });

  it('stay with their own book when its id is reused', async () => {
    const sub = await followTheirReview(77);
    answerOutbound(() => json({ status: 'received' }));
    const member = await sessionCookie('member');
    await a.postForm('/feed/comments', feedComment(77, 'On the first book'), member);

    // They delete that book and add another, which takes its id.
    const second = 'fedcba9876543210';
    await storeEntries(env.DB, sub.id, [theirEntry(77, second, 900)]);
    await removeEntries(env.DB, sub.id, [577]);
    await pruneOrphanThreads(env.DB);
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);

    await a.postForm('/feed/comments', feedComment(77, 'On the second book', second), member);
    expect(await rows('SELECT their_item_stamp, body FROM comments')).toEqual([{ their_item_stamp: second, body: 'On the second book' }]);
  });

  it('survive a pull that stops partway while their review is being replaced', async () => {
    const sub = await followTheirReview(77); // entry 577
    answerOutbound(() => json({ status: 'received' }));
    const member = await sessionCookie('member');
    await a.postForm('/feed/comments', feedComment(77, 'Keep me'), member);
    await env.DB.prepare('UPDATE feed_subscriptions SET last_pulled_at = NULL WHERE id = ?').bind(sub.id).run();

    // They edited the review: 577 is gone, and its replacement waits on a later page.
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/feed') return json({ view: 1, latest: 600, more: true, entries: [] });
      if (pathname === '/federation/feed/check') return json({ invalid: [577], viewGone: false });
      return json({}, 404);
    });
    await a.get('/feed', member);
    expect(await rows('SELECT * FROM remote_activities')).toHaveLength(0);
    expect(await rows('SELECT body FROM comments')).toEqual([{ body: 'Keep me' }]);
  });
});

describe('the outbox', () => {
  it('is pulled when Feed opens, applied in order, and only what that household wrote is taken', async () => {
    const created = onOurReview(peer, 'Sent while you were down');
    const impostor = commentCreate('https://someone-else.example', { owner: A.url, item: itemId, stamp }, 'mallory', 'Not from them');
    const withdrawn = commentDelete(peer.url, created.id);
    const outbound = answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/outbox'
        ? json({
            latest: 3,
            more: false,
            messages: [
              { seq: 1, message: created },
              { seq: 2, message: impostor },
              { seq: 3, message: withdrawn },
            ],
          })
        : json({}, 404),
    );
    const member = await sessionCookie('member');

    await a.get('/feed', member);
    expect(outbound.map((r) => `${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual(['/federation/outbox?since=0']);
    expect(await signedBy(keysA.pair.publicKey, outbound[0]!)).toBe(true);
    expect(await rows('SELECT author_name, body FROM comments')).toEqual([{ author_name: 'narain', body: null }]);
    expect(await rows('SELECT outbox_cursor FROM connections WHERE id = ?', connectionId)).toEqual([{ outbox_cursor: 3 }]);

    await a.get('/feed', member);
    expect(outbound).toHaveLength(1); // not due again for a few minutes
  });

  it('drains a backlog across page loads, each within the free plan’s 50 D1 queries', async () => {
    const backlog = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, message: onOurReview(peer, `Comment ${i + 1}`) }));
    answerOutbound((req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/federation/outbox') return json({}, 404);
      const rest = backlog.filter((m) => m.seq > Number(url.searchParams.get('since')));
      const page = rest.slice(0, 50);
      return json({ latest: page[page.length - 1]?.seq ?? 0, more: rest.length > 50, messages: page });
    });
    const counter = { left: 100_000 };
    const counted = instanceA({ ...env, DB: budgeted(env.DB, counter), FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
    const member = await sessionCookie('member');
    for (let load = 0; load < 12; load++) {
      const before = counter.left;
      await counted.get('/feed', member);
      expect(before - counter.left).toBeLessThanOrEqual(50);
    }
    expect(await rows('SELECT count(*) AS n FROM comments')).toEqual([{ n: 30 }]);
    expect(await rows('SELECT outbox_cursor FROM connections WHERE id = ?', connectionId)).toEqual([{ outbox_cursor: 30 }]);
  });

  it('reaches every connection, however often others claim more is waiting', async () => {
    await env.DB.prepare("UPDATE connections SET outbox_pulled_at = datetime('now', '-6 minutes') WHERE id = ?").bind(connectionId).run();
    await connectPeer(await makePeer('Noisy one'));
    await connectPeer(await makePeer('Noisy two'));
    const message = onOurReview(peer, 'From the honest one');
    answerOutbound((req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/federation/outbox') return json({}, 404);
      return url.origin === peer.url
        ? json({ latest: 1, more: false, messages: [{ seq: 1, message }] })
        : json({ latest: 0, more: true, messages: [] });
    });
    await a.get('/feed', await sessionCookie('member'));
    expect(await rows('SELECT body FROM comments')).toEqual([{ body: 'From the honest one' }]);
  });

  it('numbers each connection’s messages on their own, and starts again from a cursor past the end', async () => {
    const other = await makePeer('Lakeside library');
    const otherId = (await connectPeer(other)).id;
    const deletion = () => commentDelete(A.url, `urn:uuid:${crypto.randomUUID()}`);
    for (let i = 0; i < 3; i++) await enqueueOutbox(env.DB, otherId, deletion());
    await enqueueOutbox(env.DB, connectionId, deletion());

    const seqs = async (since: number) =>
      ((await (await a.signedGet(`/federation/outbox?since=${since}`, peer)).json()) as { messages: Array<{ seq: number }> }).messages.map(
        (m) => m.seq,
      );
    expect(await seqs(0)).toEqual([1]); // nothing about the three queued for someone else
    expect(await seqs(99)).toEqual([1]); // a cursor from before a restore on this side starts over
  });

  it('lists recent comments on this household’s reviews at the top of Feed', async () => {
    await inbox(peer, onOurReview(peer, 'Great pick'));
    answerOutbound(() => json({}, 404));
    const html = await (await a.get('/feed', await sessionCookie('member'))).text();
    expect(html).toContain('Comments on your reviews');
    expect(html).toContain(`href="/items/${itemId}#comments"`);
  });
});

describe('limits and endings', () => {
  it('refuses comments past the daily message limit', async () => {
    await env.DB.prepare("INSERT INTO connection_push_counts (connection_id, day, pushes) VALUES (?, date('now'), 200)")
      .bind(connectionId)
      .run();
    expect((await inbox(peer, onOurReview(peer, 'One too many'))).status).toBe(429);
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
  });

  it('deletes comments and queued messages when the connection ends', async () => {
    await inbox(peer, onOurReview(peer, 'Hello'));
    answerOutbound(() => new Response('down', { status: 503 }));
    await a.postForm(`/items/${itemId}/comments`, { connectionId: String(connectionId), body: 'Reply' }, await sessionCookie('member'));
    expect(await rows('SELECT * FROM outbox')).toHaveLength(1);
    expect((await inbox(peer, inboxMessage('Disconnect', peer.url))).status).toBe(200);
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
  });

  it('shows and takes no comments on an instance without a federation key', async () => {
    await inbox(peer, onOurReview(peer, 'Hello'));
    const member = await sessionCookie('member');
    expect(await (await disabled.get(`/items/${itemId}`, member)).text()).not.toContain('Comments from connections');
    expect((await disabled.postForm(`/items/${itemId}/comments`, { connectionId: String(connectionId), body: 'x' }, member)).status).toBe(404);
    expect((await disabled.postForm('/feed/comments', feedComment(1, 'x'), member)).status).toBe(404);
  });
});
