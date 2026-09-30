// Recommendations and households on older versions (ARCH.md §16 #58), against 1.4.0's own code: its messages
// (test/fixtures/messages-v1.4.0.ts), its dispatch (directed-v1.4.0.ts), and its outbox parser and inbox parse step
// (outbox-v1.4.0.ts), each extracted with `git show v1.4.0:…`. 1.5.0's are the same files, byte for byte.
//
// What 1.4.0 does with a type it doesn't know: its inbox refuses it at parseInboxMessage — 400 "malformed message",
// before a write or a dispatch — and its outbox pull reads it as nothing and moves its cursor past it. So this version
// never queues a Recommend for a household whose descriptor doesn't list it in `accepts`, and treats a household that
// did and then refuses it (gone back to 1.4.0) as final: refused, out of the outbox, never retried.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, enqueueOutbox, getConnection, getFederationSettings } from '../src/db/federation';
import { createItem, createLibrary } from '../src/db/queries';
import type { Item } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { isDescriptor, peerAccepts } from '../src/federation/http';
import { itemStamp } from '../src/federation/items';
import { borrowWithdraw, commentCreate, parseInboxMessage, recommend } from '../src/federation/messages';
import * as v140directed from './fixtures/directed-v1.4.0';
import * as v140messages from './fixtures/messages-v1.4.0';
import * as v140 from './fixtures/outbox-v1.4.0';
import { A, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA, type Keys, type Peer } from './federation-helpers';
import { descriptorOf, peerSide, retryDue, rows, theirRecommendation, to } from './recommend-helpers';

let keysA: Keys;
let a: ReturnType<typeof instanceA>;
let peer: Peer;
let connectionId: number;
let book: Item;

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  await setUpA();
  peer = await makePeer('Oldtown library');
  connectionId = (await connectPeer(peer)).id;
  const shelf = (await createLibrary(env.DB, 'Main')).id;
  await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelf, mediaType: null, status: null, owned: null });
  book = await createItem(env.DB, { libraryId: shelf, title: 'The Dispossessed', review: 'An ambiguous utopia.' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const recommendForm = async () =>
  a.postForm(`/items/${book.id}/recommend`, { connectionId: String(connectionId), note: 'For you' }, await sessionCookie('member'));
const outcome = (res: Response) => new URL(res.headers.get('location') ?? '', A.url).searchParams.get('recommend');

/** A household on 1.4.0 as this instance meets it: its descriptor has no `accepts`, and its inbox is 1.4.0's parse step. */
function onV140(opts: { advertises?: boolean } = {}) {
  return peerSide(peer, {
    accepts: opts.advertises ? ['Recommend'] : undefined,
    inbox: (body) => {
      const refused = v140.inboxStep(body, peer.url);
      return refused ? json(refused.body, refused.status) : json({ status: 'ok' });
    },
  });
}

describe('what 1.4.0 does with a Recommend', () => {
  it('refuses it at the inbox as a malformed message — 400, before anything is written or dispatched', async () => {
    const message = theirRecommendation(peer);
    // this version reads it whole; 1.4.0 knows no such type
    expect(parseInboxMessage(message)).toEqual(message);
    expect(v140messages.parseInboxMessage(message)).toBeNull();
    expect(v140.inboxStep(bytes(message), peer.url)).toEqual({ status: 400, body: { error: 'malformed message' } });
    // control: the same step takes a message 1.4.0 does know
    const comment = commentCreate(peer.url, { owner: A.url, item: 1, stamp: '0123456789abcdef' }, 'narain', 'Hello');
    expect(v140.inboxStep(bytes(comment), peer.url)).toBeNull();
  });

  it('has no branch for it past the parser: its dispatch answers nothing — which is why 1.4.0’s parser is the only guard', async () => {
    const settings = (await getFederationSettings(env.DB))!;
    const connection = (await getConnection(env.DB, connectionId))!;
    const message = theirRecommendation(peer) as unknown as v140messages.DirectedMessage;
    // routed to borrowing, whose switch has no case for it: no outcome at all, where the inbox route reads
    // `outcome.body` — a 500 there, which a sender retries. It never gets here: parseInboxMessage refused it first.
    expect(await v140directed.receiveDirected(env.DB, settings, connection, message)).toBeUndefined();
    // control: a type 1.4.0 knows gets its answer from the same dispatch
    const known = borrowWithdraw(peer.url, 'urn:uuid:00000000-0000-4000-8000-000000000001');
    expect(await v140directed.receiveDirected(env.DB, settings, connection, known)).toEqual({ status: 404, body: { error: 'no such request' } });
  });

  it('skips it when pulling this household’s outbox, keeps the rest of the page, and moves past it', async () => {
    const recommendation = recommend(A.url, { id: book.id, stamp: await itemStamp(book), view: 1, mediaType: 'book', title: 'x', creators: null, published: null, coverKey: null, ids: {} }, 'A member', null);
    const comment = commentCreate(A.url, { owner: A.url, item: book.id, stamp: await itemStamp(book) }, 'A member', 'Reply');
    await enqueueOutbox(env.DB, connectionId, recommendation);
    await enqueueOutbox(env.DB, connectionId, comment);
    const served = await (await a.signedGet('/federation/outbox?since=0', peer)).json();
    const page = v140.parseOutboxPage(served)!;
    expect(page.messages.map((m) => [m.seq, m.message?.type ?? null])).toEqual([
      [1, null],
      [2, 'CommentCreate'],
    ]);
    // 1.4.0's pullOutbox moves its cursor to every entry's seq after the cursor, applied or not, so it never asks again
    expect(page.more).toBe(false);
  });
});

describe('sending to a household on an older version', () => {
  it('queues nothing for one whose descriptor doesn’t list Recommend, and says why', async () => {
    const side = onV140();
    const res = await recommendForm();
    expect(outcome(res)).toBe('old');
    expect(side.log.map((r) => new URL(r.url).pathname)).toEqual(['/.well-known/nalanda']);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
    expect(await rows('SELECT * FROM recommendations')).toHaveLength(0);
    const html = await (await a.get(`/items/${book.id}?recommend=old&to=${connectionId}`, await sessionCookie('member'))).text();
    expect(html).toContain('Oldtown library runs an older version of Nalanda that can’t take recommendations yet. Nothing was sent.');
    expect(html).toMatch(/<select id="recommend-to"[^>]*aria-invalid="true"[^>]*aria-describedby="recommend-status"/);

    // control: the same household once it lists Recommend is sent to — the list is what decided
    const upgraded = peerSide(peer);
    expect(outcome(await recommendForm())).toBe('sent');
    expect(to(upgraded.log, '/federation/inbox')).toHaveLength(1);
  });

  it('takes a 400 from one that listed it and went back to 1.4.0 as final: refused, out of the outbox, never retried', async () => {
    const side = onV140({ advertises: true });
    expect(outcome(await recommendForm())).toBe('refused');
    expect(to(side.log, '/federation/inbox')).toHaveLength(1);
    expect(await rows('SELECT status FROM recommendations')).toEqual([{ status: 'refused' }]);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
    const cookie = await sessionCookie('member');
    for (let load = 0; load < 4; load++) {
      await retryDue();
      await a.get('/recommendations', cookie);
    }
    expect(to(side.log, '/federation/inbox')).toHaveLength(1);
  });

  it('retries a push that never landed once, and stops at 1.4.0’s refusal — no loop', async () => {
    peerSide(peer, { inbox: 'unreachable' });
    expect(outcome(await recommendForm())).toBe('queued');
    const side = onV140({ advertises: true });
    const cookie = await sessionCookie('member');
    for (let load = 0; load < 4; load++) {
      await retryDue();
      await a.get('/recommendations', cookie);
    }
    expect(to(side.log, '/federation/inbox')).toHaveLength(1);
    expect(await rows('SELECT status FROM recommendations')).toEqual([{ status: 'refused' }]);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
  });
});

describe('the descriptor', () => {
  it('still reads as a descriptor where it’s new, and an older one still reads here, taking nothing new', async () => {
    const res = await a.get('/.well-known/nalanda');
    const ours = await res.json();
    // isDescriptor is byte for byte what every release since 1.0.0 runs (src/federation/http.ts is unchanged there)
    expect(isDescriptor(ours)).toBe(true);
    expect(peerAccepts(ours as never, 'Recommend')).toBe(true);
    const older = descriptorOf(peer);
    expect(isDescriptor(older)).toBe(true);
    expect(peerAccepts(older as never, 'Recommend')).toBe(false);
    // a malformed list is "no", never a crash
    for (const accepts of ['Recommend', [7], null, {}, Array(51).fill('Recommend')]) {
      expect(peerAccepts(descriptorOf(peer, accepts) as never, 'Recommend')).toBe(false);
    }
  });
});
