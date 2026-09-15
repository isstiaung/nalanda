// Route-level: phase 3 of connections between instances — comments on reviews in both directions,
// deletions, and the outbox behind every push (docs/proposals/connections.md §8, §9).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, createSubscription, storeEntries } from '../src/db/federation';
import { createItem, createLibrary } from '../src/db/queries';
import type { Bindings } from '../src/env';
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

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  await setUpA();
  peer = await makePeer('Riverbank library');
  connectionId = (await connectPeer(peer)).id;
  shelfId = (await createLibrary(env.DB, 'Main')).id;
  await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelfId, mediaType: null, status: null, owned: null });
  itemId = (await createItem(env.DB, { libraryId: shelfId, title: 'The Dispossessed', review: 'An ambiguous utopia.' })).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

const onOurReview = (from: Peer, content: string, item = itemId) =>
  commentCreate(from.url, { owner: A.url, item }, 'narain', content);

const inbox = (from: Peer, message: unknown) => a.signedPost('/federation/inbox', from, message);

/** This household follows one of their reviews: a stored `reviewed` entry, already pulled. */
async function followTheirReview(item: number) {
  const sub = (await createSubscription(env.DB, {
    connectionId,
    viewId: 1,
    viewName: 'Theirs',
    intervalMinutes: 1440,
    retentionDays: 90,
    maxEntries: 500,
  }))!;
  await env.DB.prepare("UPDATE feed_subscriptions SET last_pulled_at = datetime('now') WHERE id = ?").bind(sub.id).run();
  const entry = JSON.stringify({
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
  });
  await storeEntries(env.DB, sub.id, [
    { remoteId: 500 + item, itemRemoteId: item, kind: 'reviewed', publishedAt: sqlAgo(5), item: entry, bytes: entry.length },
  ]);
  return sub;
}

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
    const unshared = (await createItem(env.DB, { libraryId: hidden, title: 'Private', review: 'Mine' })).id;
    const unreviewed = (await createItem(env.DB, { libraryId: shelfId, title: 'Unreviewed' })).id;

    expect((await inbox(peer, onOurReview(peer, 'Hi', unshared))).status).toBe(404);
    expect((await inbox(peer, onOurReview(peer, 'Hi', unreviewed))).status).toBe(404);
    expect((await inbox(peer, onOurReview(peer, 'Hi', 999_999))).status).toBe(404);
    expect(
      (await inbox(peer, commentCreate(peer.url, { owner: 'https://third.example', item: itemId }, 'narain', 'Hi'))).status,
    ).toBe(400);
    expect((await inbox(peer, onOurReview(peer, 'x'.repeat(2001)))).status).toBe(400);

    const waiting = await makePeer('Waiting');
    await connectPeer(waiting, 'awaiting_us');
    expect((await inbox(waiting, onOurReview(waiting, 'Hi'))).status).toBe(409);
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
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
      expect.objectContaining({ type: 'CommentCreate', actor: A.url, inReplyTo: { owner: A.url, item: itemId }, content: reply.body }),
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
    expect(page.messages.map((m) => m.message.content)).toEqual(['Still thinking about it.', 'Hello?']);
    expect(page).toMatchObject({ latest: page.messages[1]!.seq, more: false });

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
    await a.postForm('/feed/comments', { connectionId: String(connectionId), itemId: '77', body: 'Lovely review' }, member);
    await a.postForm('/feed/comments', { connectionId: String(connectionId), itemId: '78', body: 'Not followed' }, member);
    expect(pushes).toEqual([
      expect.objectContaining({ type: 'CommentCreate', inReplyTo: { owner: peer.url, item: 77 }, content: 'Lovely review' }),
    ]);
    expect(await rows('SELECT their_item_id, body FROM comments')).toEqual([{ their_item_id: 77, body: 'Lovely review' }]);

    expect(await (await inbox(peer, commentCreate(peer.url, { owner: peer.url, item: 77 }, 'ana', 'Thank you!'))).json()).toEqual({
      status: 'received',
    });
    expect(await (await inbox(peer, commentCreate(peer.url, { owner: peer.url, item: 78 }, 'ana', 'Unfollowed'))).json()).toEqual({
      status: 'not kept',
    });

    const html = await (await a.get('/feed', member)).text();
    expect(html).toContain('Lovely review');
    expect(html).toContain('Thank you!');
    expect(html).toContain('Seen only by Riverbank library and this library.');
  });

  it('go with the feed entries they belong to', async () => {
    const sub = await followTheirReview(77);
    answerOutbound(() => json({ status: 'received' }));
    await a.postForm('/feed/comments', { connectionId: String(connectionId), itemId: '77', body: 'Lovely review' }, await sessionCookie('member'));
    expect(await rows('SELECT * FROM comments')).toHaveLength(1);
    await a.postForm(`/connections/${connectionId}/subscriptions/${sub.id}/purge`, {}, await sessionCookie('admin'));
    expect(await rows('SELECT * FROM comments')).toHaveLength(0);
  });
});

describe('the outbox', () => {
  it('is pulled when Feed opens, applied in order, and only what that household wrote is taken', async () => {
    const created = onOurReview(peer, 'Sent while you were down');
    const impostor = commentCreate('https://someone-else.example', { owner: A.url, item: itemId }, 'mallory', 'Not from them');
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
    expect((await disabled.postForm('/feed/comments', { connectionId: String(connectionId), itemId: '1', body: 'x' }, member)).status).toBe(404);
  });
});
