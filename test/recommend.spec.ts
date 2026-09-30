// Route-level: recommending an item to a connected household, and what one recommended here becomes (ARCH.md §16 #58)
// — sending, receiving, the notification, the Recommended list, dismissing, wanting, names on and off, escaping,
// replays, limits, what leaves this instance, and D1 calls. Old peers are test/recommend-compat.spec.ts.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimRecommendation, createConnectionView, deleteConnection, enqueueOutbox } from '../src/db/federation';
import { createItem, createItemWithTags, createLibrary, setDisplayName, updateSiteSettings } from '../src/db/queries';
import type { Item } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { budgeted } from '../src/federation/budget';
import {
  MAX_OPEN_RECOMMENDATIONS_PER_CONNECTION,
  MAX_RECOMMEND_NOTE_CHARS,
  MAX_RECOMMENDATIONS_PER_DAY,
  MAX_SENT_PER_DAY,
} from '../src/federation/config';
import { itemStamp } from '../src/federation/items';
import { commentCreate, parseInboxMessage } from '../src/federation/messages';
import { A, connectPeer, instanceA, makeKeys, makePeer, sessionCookie, setUpA, signedBy, type Keys, type Peer } from './federation-helpers';
import { member, upgradedSwitches } from './member-helpers';
import { COVER_KEY, peerSide, retryDue, rows, theirRecommendation, to } from './recommend-helpers';

let keysA: Keys;
let a: ReturnType<typeof instanceA>;
const disabled = instanceA(env);
let peer: Peer;
let connectionId: number;
let shelfId: number;
let book: Item;
let hidden: Item;

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  await setUpA();
  peer = await makePeer('Riverbank library');
  connectionId = (await connectPeer(peer)).id;
  shelfId = (await createLibrary(env.DB, 'Main')).id;
  const privateShelf = (await createLibrary(env.DB, 'Private')).id;
  await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelfId, mediaType: null, status: null, owned: null });
  book = await createItem(env.DB, {
    libraryId: shelfId,
    title: 'The Dispossessed',
    creators: 'Ursula K. Le Guin',
    published: '1974',
    coverKey: '2c1f0c0e-1111-4222-8333-944455556666',
    isbn13: '9780061054884',
    notes: 'SECRET-NOTE',
    location: 'SECRET-LOCATION',
    review: 'An ambiguous utopia.',
    rating: 9,
  });
  hidden = await createItem(env.DB, { libraryId: privateShelf, title: 'Diary', copies: 1 });
  peerSide(peer); // pages here pull connections' outboxes after responding: never the real network
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const recommendForm = (fields: Record<string, string>, cookie: string, item: Item = book) =>
  a.postForm(`/items/${item.id}/recommend`, fields, cookie);
const outcome = (res: Response) => new URL(res.headers.get('location') ?? '', A.url).searchParams.get('recommend');
const inbox = (from: Peer, message: unknown) => a.signedPost('/federation/inbox', from, message);

// ---------- sending ----------

describe('Recommend to… on an item’s page', () => {
  it('shows for an item inside a connection view, names each household, and says how it will be signed', async () => {
    const other = await makePeer('Lakeside <library>');
    await connectPeer(other);
    await connectPeer(await makePeer('Still waiting'), 'awaiting_us');
    const html = await (await a.get(`/items/${book.id}`, await sessionCookie('member'))).text();
    expect(html).toContain('Recommend to…');
    expect(html).toContain('<label for="recommend-to">Household</label>');
    expect(html).toContain(`<option value="${connectionId}">Riverbank library</option>`);
    expect(html).toContain('Lakeside &lt;library&gt;');
    expect(html).not.toContain('Still waiting'); // only active connections
    expect(html).toContain('signed “A member”'); // no display name
  });

  it('says only shared items can be recommended — and has no form — for an item outside every view', async () => {
    const html = await (await a.get(`/items/${hidden.id}`, await sessionCookie('member'))).text();
    expect(html).toContain('Recommend to…');
    expect(html).toContain('Only items on a shelf you share with connections can be recommended');
    expect(html).not.toContain(`action="/items/${hidden.id}/recommend"`);
  });

  it('isn’t there without an active connection, or without a federation key', async () => {
    const cookie = await sessionCookie('member');
    expect(await (await disabled.get(`/items/${book.id}`, cookie)).text()).not.toContain('Recommend to');
    await deleteConnection(env.DB, connectionId);
    expect(await (await a.get(`/items/${book.id}`, cookie)).text()).not.toContain('Recommend to');
    expect((await disabled.postForm(`/items/${book.id}/recommend`, { connectionId: '1' }, cookie)).status).toBe(404);
  });
});

describe('sending a recommendation', () => {
  it('pushes only toConnectionItem fields, signed and unsigned by any username, and records it as sent', async () => {
    const side = peerSide(peer);
    const asha = await member('asha-login');
    const res = await recommendForm({ connectionId: String(connectionId), note: 'Read it before the trip.' }, asha.cookie);
    expect(res.status).toBe(302);
    expect(outcome(res)).toBe('sent');

    // their descriptor first, then the push, signed by this instance
    expect(side.log.map((r) => new URL(r.url).pathname)).toEqual(['/.well-known/nalanda', '/federation/inbox']);
    expect(await signedBy(keysA.pair.publicKey, to(side.log, '/federation/inbox')[0]!)).toBe(true);
    const [pushed] = side.pushes;
    expect(Object.keys(pushed!).sort()).toEqual(['@context', 'actor', 'id', 'item', 'note', 'published', 'recommender', 'type']);
    expect(pushed).toMatchObject({ type: 'Recommend', actor: A.url, recommender: 'A member', note: 'Read it before the trip.' });
    expect(pushed!.item).toEqual({
      id: book.id,
      stamp: await itemStamp(book),
      view: 1,
      mediaType: 'book',
      title: 'The Dispossessed',
      creators: 'Ursula K. Le Guin',
      published: '1974',
      coverKey: '2c1f0c0e-1111-4222-8333-944455556666',
      ids: {},
    });
    const wire = JSON.stringify(pushed);
    for (const secret of ['asha-login', 'SECRET-NOTE', 'SECRET-LOCATION', '9780061054884', 'ambiguous utopia', '"rating"', '"copies"']) {
      expect(wire, secret).not.toContain(secret);
    }
    // what this version parses back is exactly what was sent
    expect(parseInboxMessage(pushed)).toEqual(pushed);

    expect(await rows('SELECT incoming, our_item_id, sender_id, recommender, note, status FROM recommendations')).toEqual([
      { incoming: 0, our_item_id: book.id, sender_id: asha.id, recommender: 'A member', note: 'Read it before the trip.', status: 'open' },
    ]);
    expect(await rows('SELECT delivered_at IS NOT NULL AS delivered FROM outbox')).toEqual([{ delivered: 1 }]);

    const page = await (await a.get(`/items/${book.id}?recommend=sent&to=${connectionId}`, asha.cookie)).text();
    expect(page).toContain('Recommended to Riverbank library.');
    expect(page).not.toContain(`<option value="${connectionId}"`); // already sent there
    expect(page).toContain('Recommended to every connected household.');
  });

  it('signs with the display name while names go to connections, “A member” once they don’t — never the username', async () => {
    const asha = await member('asha-login');
    await setDisplayName(env.DB, asha.id, 'Asha R.');
    const side = peerSide(peer);
    await recommendForm({ connectionId: String(connectionId) }, asha.cookie);
    expect(side.pushes[0]).toMatchObject({ recommender: 'Asha R.', note: null });

    const second = await createItem(env.DB, { libraryId: shelfId, title: 'The Word for World Is Forest' });
    await upgradedSwitches(); // names off, as an instance from before 1.5 has them
    expect(await (await a.get(`/items/${second.id}`, asha.cookie)).text()).toContain('signed “A member”');
    await recommendForm({ connectionId: String(connectionId) }, asha.cookie, second);
    expect(side.pushes[1]).toMatchObject({ recommender: 'A member' });
    expect(JSON.stringify(side.pushes)).not.toContain('asha-login');
  });

  it('carries a game’s BGG id and a record’s Discogs id, and nothing else from details', async () => {
    const game = await createItem(env.DB, {
      libraryId: shelfId,
      mediaType: 'boardgame',
      title: 'Azul',
      details: JSON.stringify({ bgg_id: 230802, players_min: 2, secret_key: 'x' }),
    });
    const record = await createItem(env.DB, { libraryId: shelfId, mediaType: 'vinyl', title: 'Kind of Blue', details: JSON.stringify({ discogs_id: '1234567', label: 'Columbia' }) });
    const side = peerSide(peer);
    const cookie = await sessionCookie('member');
    await recommendForm({ connectionId: String(connectionId) }, cookie, game);
    await recommendForm({ connectionId: String(connectionId) }, cookie, record);
    expect(side.pushes.map((p) => (p.item as { ids: unknown }).ids)).toEqual([{ bgg_id: 230802 }, { discogs_id: 1234567 }]);
  });

  it('won’t send an item outside every connection view: nothing asked of them, nothing queued', async () => {
    const side = peerSide(peer);
    const res = await recommendForm({ connectionId: String(connectionId) }, await sessionCookie('member'), hidden);
    expect(outcome(res)).toBe('unshared');
    expect(side.log).toHaveLength(0);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
    expect(await rows('SELECT * FROM recommendations')).toHaveLength(0);
  });

  it('sends one per item and household, however often it is submitted', async () => {
    const side = peerSide(peer);
    const cookie = await sessionCookie('member');
    const [first, second] = await Promise.all([
      recommendForm({ connectionId: String(connectionId) }, cookie),
      recommendForm({ connectionId: String(connectionId) }, cookie),
    ]);
    expect([outcome(first), outcome(second)].sort()).toEqual(['duplicate', 'sent']);
    expect(side.pushes).toHaveLength(1);
    expect(await rows('SELECT count(*) AS n FROM recommendations')).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 1 }]);
  });

  it('refuses a note past the limit, and ties the error to the note', async () => {
    const side = peerSide(peer);
    const cookie = await sessionCookie('member');
    const res = await recommendForm({ connectionId: String(connectionId), note: 'x'.repeat(MAX_RECOMMEND_NOTE_CHARS + 1) }, cookie);
    expect(outcome(res)).toBe('note');
    expect(side.log).toHaveLength(0);
    const back = new URL(res.headers.get('location')!, A.url);
    const html = await (await a.get(back.pathname + back.search, cookie)).text();
    expect(html).toMatch(/<textarea id="recommend-note"[^>]*aria-invalid="true"[^>]*aria-describedby="recommend-hint recommend-status"/);
    expect(html).toContain(`<p id="recommend-status" class="error" role="alert">A note can be at most ${MAX_RECOMMEND_NOTE_CHARS} characters.</p>`);
    // at the limit it goes
    expect(outcome(await recommendForm({ connectionId: String(connectionId), note: 'x'.repeat(MAX_RECOMMEND_NOTE_CHARS) }, cookie))).toBe('sent');
  });

  it('stops at this household’s daily limit of messages to one connection, before asking them anything', async () => {
    for (let i = 0; i < MAX_SENT_PER_DAY; i++) await enqueueOutbox(env.DB, connectionId, { id: `urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
    const side = peerSide(peer);
    expect(outcome(await recommendForm({ connectionId: String(connectionId) }, await sessionCookie('member')))).toBe('limit');
    expect(side.log).toHaveLength(0);
  });

  it('marks it refused, out of the outbox, when they turn it away — and never retries it', async () => {
    const side = peerSide(peer, { inbox: 409 });
    const cookie = await sessionCookie('member');
    expect(outcome(await recommendForm({ connectionId: String(connectionId) }, cookie))).toBe('refused');
    expect(await rows('SELECT status FROM recommendations')).toEqual([{ status: 'refused' }]);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
    for (let load = 0; load < 3; load++) {
      await retryDue();
      await a.get('/recommendations', cookie);
    }
    expect(side.pushes).toHaveLength(1);
    // refused isn't sent: the household can be chosen again
    expect(await (await a.get(`/items/${book.id}`, cookie)).text()).toContain(`<option value="${connectionId}">Riverbank library</option>`);
  });

  it('waits in the outbox when their inbox doesn’t answer, and lands on a later retry', async () => {
    peerSide(peer, { inbox: 'unreachable' });
    const cookie = await sessionCookie('member');
    expect(outcome(await recommendForm({ connectionId: String(connectionId) }, cookie))).toBe('queued');
    expect(await rows('SELECT delivered_at FROM outbox')).toEqual([{ delivered_at: null }]);
    const side = peerSide(peer);
    await retryDue();
    await a.get('/recommendations', cookie);
    expect(side.pushes.map((p) => p.type)).toEqual(['Recommend']);
    expect(await rows('SELECT delivered_at IS NOT NULL AS delivered FROM outbox')).toEqual([{ delivered: 1 }]);
    expect(await rows('SELECT status FROM recommendations')).toEqual([{ status: 'open' }]);
  });

  it('asks nothing of a household it can’t reach, and sends nothing', async () => {
    const side = peerSide(peer);
    vi.unstubAllGlobals();
    const log: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      log.push(String(input));
      throw new TypeError('unreachable');
    });
    expect(outcome(await recommendForm({ connectionId: String(connectionId) }, await sessionCookie('member')))).toBe('unreachable');
    expect(log).toEqual([`${peer.url}/.well-known/nalanda`]);
    expect(side.log).toHaveLength(0);
    expect(await rows('SELECT * FROM recommendations')).toHaveLength(0);
  });

  it('refuses a household that isn’t an active connection', async () => {
    const waiting = await makePeer('Waiting');
    const w = await connectPeer(waiting, 'awaiting_them');
    peerSide(waiting);
    expect(outcome(await recommendForm({ connectionId: String(w.id) }, await sessionCookie('member')))).toBe('household');
    expect(outcome(await recommendForm({ connectionId: '999' }, await sessionCookie('member')))).toBe('household');
  });
});

// ---------- receiving ----------

describe('a recommendation from a connection', () => {
  it('is taken once, notifies the household once, and lists everything they sent as escaped text', async () => {
    const message = theirRecommendation(
      peer,
      { title: '<script>alert("t")</script>Title', creators: '<b>Le Guin</b>' },
      '"><img src=x onerror=alert(1)>',
      '<img src=x onerror=alert(2)>\nSecond line',
    );
    const res = await inbox(peer, message);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'received' });

    const member = await sessionCookie('member');
    const notes = await (await a.get('/notifications', member)).text();
    expect(notes).toContain('<strong>Riverbank library</strong> recommended <em>&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;Title</em> to you');
    expect(notes).toContain('href="/recommendations"');

    const html = await (await a.get('/recommendations', member)).text();
    for (const raw of ['<script>alert', '<img src=x', '<b>Le Guin']) expect(html).not.toContain(raw);
    expect(html).toContain('&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;Title');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;\nSecond line');
    expect(html).toContain(`src="${peer.url}/covers/${COVER_KEY}"`);
    expect(html).toContain(`href="/households/${connectionId}/views/2/items/7"`);
    expect(html).not.toMatch(/on\w+="[^"]*(alert|&quot;)/); // no peer string inside an inline handler
  });

  it('is stored and notified once, however often it arrives — pushed twice, then pulled from their outbox', async () => {
    const message = theirRecommendation(peer);
    expect(await (await inbox(peer, message)).json()).toEqual({ status: 'received' });
    expect(await (await inbox(peer, message)).json()).toEqual({ status: 'already received' });

    peerSide(peer, { outbox: { latest: 1, more: false, messages: [{ seq: 1, message }] } });
    await a.get('/recommendations', await sessionCookie('member'));
    expect(await rows('SELECT outbox_cursor FROM connections WHERE id = ?1', connectionId)).toEqual([{ outbox_cursor: 1 }]);
    expect(await rows('SELECT count(*) AS n FROM recommendations')).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*) AS n FROM notifications WHERE kind = 'recommendation'")).toEqual([{ n: 1 }]);
  });

  it('arrives by their outbox too, when the push never came', async () => {
    const message = theirRecommendation(peer, { title: 'Pulled' });
    peerSide(peer, { outbox: { latest: 1, more: false, messages: [{ seq: 1, message }] } });
    await a.get('/recommendations', await sessionCookie('member'));
    expect(await rows('SELECT title, recommender FROM recommendations')).toEqual([{ title: 'Pulled', recommender: 'Priya' }]);
  });

  it('refuses a malformed one outright, and cleans a name the way every name from a peer is cleaned', async () => {
    const bad = [
      theirRecommendation(peer, { coverKey: 'https://evil.example/x.png' }),
      theirRecommendation(peer, { title: 'x'.repeat(1001) }),
      theirRecommendation(peer, { title: '   ' }),
      theirRecommendation(peer, { mediaType: 'scroll' as never }),
      theirRecommendation(peer, { ids: { isbn13: 9780061054884 } as never }),
      theirRecommendation(peer, { ids: { bgg_id: -1 } }),
      theirRecommendation(peer, {}, '', null),
      { ...theirRecommendation(peer), recommender: 'x'.repeat(81) }, // past PEER_NAME_MAX: refused, as any name from a peer
      theirRecommendation(peer, {}, 'Priya', 'x'.repeat(MAX_RECOMMEND_NOTE_CHARS + 1)),
      { ...theirRecommendation(peer), published: 'yesterday' },
      { ...theirRecommendation(peer), actor: 'https://someone-else.example' },
    ];
    for (const [i, message] of bad.entries()) expect((await inbox(peer, message)).status, `malformed #${i}`).toBe(400);
    expect(await rows('SELECT * FROM recommendations')).toHaveLength(0);
    expect(await rows('SELECT * FROM notifications')).toHaveLength(0);

    await inbox(peer, theirRecommendation(peer, {}, 'Pri‮ya​'));
    expect(await rows('SELECT recommender FROM recommendations')).toEqual([{ recommender: 'Pri ya' }]);
  });

  it(`takes ${MAX_RECOMMENDATIONS_PER_DAY} a day and ${MAX_OPEN_RECOMMENDATIONS_PER_CONNECTION} waiting from one household, each a final refusal past it`, async () => {
    for (let i = 0; i < MAX_RECOMMENDATIONS_PER_DAY; i++) expect((await inbox(peer, theirRecommendation(peer, { id: 100 + i }))).status).toBe(200);
    const today = await inbox(peer, theirRecommendation(peer));
    expect(today.status).toBe(409);
    expect(await today.json()).toEqual({ error: 'too many recommendations today' });

    // another household isn't held back by this one
    const other = await makePeer('Lakeside library');
    await connectPeer(other);
    expect((await inbox(other, theirRecommendation(other))).status).toBe(200);

    // yesterday's no longer count toward today; waiting ones still count toward the cap
    const backdate = () => env.DB.prepare("UPDATE recommendations SET created_at = datetime('now', '-1 day')").run();
    await backdate();
    for (let i = MAX_RECOMMENDATIONS_PER_DAY; i < MAX_OPEN_RECOMMENDATIONS_PER_CONNECTION; i++) {
      if (i % MAX_RECOMMENDATIONS_PER_DAY === 0) await backdate();
      expect((await inbox(peer, theirRecommendation(peer, { id: 100 + i }))).status).toBe(200);
    }
    await backdate();
    const waiting = await inbox(peer, theirRecommendation(peer));
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({ error: 'too many recommendations waiting' });
    expect(await rows('SELECT count(*) AS n FROM recommendations WHERE connection_id = ?1', connectionId)).toEqual([
      { n: MAX_OPEN_RECOMMENDATIONS_PER_CONNECTION },
    ]);
    expect(await rows("SELECT count(*) AS n FROM notifications WHERE kind = 'recommendation'")).toEqual([
      { n: MAX_OPEN_RECOMMENDATIONS_PER_CONNECTION + 1 },
    ]);

    // dismissing one makes room
    const [first] = await rows<{ id: number }>('SELECT id FROM recommendations WHERE connection_id = ?1 ORDER BY id LIMIT 1', connectionId);
    await a.postForm(`/recommendations/${first!.id}/dismiss`, {}, await sessionCookie('member'));
    expect((await inbox(peer, theirRecommendation(peer))).status).toBe(200);
  });

  it('is refused from a household that isn’t an active connection, before anything is written', async () => {
    const waiting = await makePeer('Waiting');
    await connectPeer(waiting, 'awaiting_us');
    expect((await inbox(waiting, theirRecommendation(waiting))).status).toBe(409);
    const stranger = await makePeer('Stranger');
    expect((await inbox(stranger, theirRecommendation(stranger))).status).toBe(401);
    expect(await rows('SELECT * FROM recommendations')).toHaveLength(0);
  });

  it('goes with the connection when it ends', async () => {
    await inbox(peer, theirRecommendation(peer));
    await deleteConnection(env.DB, connectionId);
    expect(await rows('SELECT * FROM recommendations')).toHaveLength(0);
  });
});

// ---------- answering one ----------

describe('the Recommended list', () => {
  const received = async (item = {}, from: Peer = peer) => {
    await inbox(from, theirRecommendation(from, item));
    return (await rows<{ id: number }>('SELECT id FROM recommendations WHERE incoming = 1 ORDER BY id DESC LIMIT 1'))[0]!.id;
  };
  const wantsOf = (userId: number) => rows<{ item_id: number }>('SELECT item_id FROM wants WHERE user_id = ?1', userId);

  it('is seen by the whole household, and anyone may dismiss one — for everyone, without telling them', async () => {
    const id = await received();
    const [asha, ravi] = [await member('asha'), await member('ravi')];
    expect(await (await a.get('/recommendations', ravi.cookie)).text()).toContain('The Left Hand of Darkness');
    const side = peerSide(peer);
    const res = await a.postForm(`/recommendations/${id}/dismiss`, {}, asha.cookie);
    expect(res.headers.get('location')).toBe('/recommendations?done=dismissed');
    expect(await (await a.get('/recommendations', ravi.cookie)).text()).not.toContain('The Left Hand of Darkness');
    expect(to(side.log, '/federation/inbox')).toHaveLength(0);
    expect((await a.postForm(`/recommendations/${id}/dismiss`, {}, ravi.cookie)).headers.get('location')).toBe('/recommendations?done=gone');
    expect(await rows('SELECT status, handled_by FROM recommendations')).toEqual([{ status: 'dismissed', handled_by: asha.id }]);
  });

  it('adds one to the member’s want list as a Not owned item made from what they sent, its cover copied from theirs', async () => {
    const id = await received({ published: '1969' });
    const asha = await member('asha');
    const side = peerSide(peer);
    const res = await a.postForm(`/recommendations/${id}/want`, { libraryId: String(shelfId) }, asha.cookie);
    const [made] = await rows<Record<string, unknown>>(
      'SELECT id, library_id, media_type, title, creators, published, copies, cover_key, details, added_by FROM items WHERE title = ?1',
      'The Left Hand of Darkness',
    );
    expect(made).toMatchObject({
      library_id: shelfId,
      media_type: 'book',
      creators: 'Ursula K. Le Guin',
      published: '1969',
      copies: 0,
      details: '{}',
      added_by: asha.id,
    });
    expect(res.headers.get('location')).toBe(`/recommendations?done=wanted&item=${made!.id}`);
    expect(to(side.log, `/covers/${COVER_KEY}`)).toHaveLength(1);
    expect(made!.cover_key).not.toBe(COVER_KEY); // a key of our own, in our bucket
    expect(await env.COVERS.get(made!.cover_key as string)).not.toBeNull();
    expect(await wantsOf(asha.id)).toEqual([{ item_id: made!.id }]);
    expect(await rows('SELECT status, handled_by, wanted_item_id FROM recommendations')).toEqual([
      { status: 'wanted', handled_by: asha.id, wanted_item_id: made!.id },
    ]);
    expect(to(side.log, '/federation/inbox')).toHaveLength(0); // they aren't told
    const page = await (await a.get(`/recommendations?done=wanted&item=${made!.id}`, asha.cookie)).text();
    expect(page).toContain(`Added to your want list. <a href="/items/${made!.id}">Open it</a>`);
    expect(page).not.toContain('recommendation-'); // it left the list
  });

  it('puts the want on a copy already here — a game by its BGG id, a record by its Discogs id — and makes no second', async () => {
    const game = await createItem(env.DB, { libraryId: shelfId, mediaType: 'boardgame', title: 'Azul (ours)', details: JSON.stringify({ bgg_id: '230802' }) });
    const record = await createItem(env.DB, { libraryId: shelfId, mediaType: 'vinyl', title: 'Kind of Blue (ours)', details: JSON.stringify({ discogs_id: 1234567 }), copies: 1 });
    const asha = await member('asha');
    peerSide(peer);
    const before = (await rows<{ n: number }>('SELECT count(*) AS n FROM items'))[0]!.n;
    const g = await received({ id: 11, mediaType: 'boardgame', title: 'Azul', ids: { bgg_id: 230802 } });
    const r = await received({ id: 12, mediaType: 'vinyl', title: 'Kind of Blue', ids: { discogs_id: 1234567 } });
    expect((await a.postForm(`/recommendations/${g}/want`, { libraryId: String(shelfId) }, asha.cookie)).headers.get('location')).toBe(
      `/recommendations?done=wanted&item=${game.id}`,
    );
    await a.postForm(`/recommendations/${r}/want`, { libraryId: String(shelfId) }, asha.cookie);
    expect((await rows<{ n: number }>('SELECT count(*) AS n FROM items'))[0]!.n).toBe(before);
    expect((await wantsOf(asha.id)).map((w) => w.item_id).sort()).toEqual([game.id, record.id].sort());
  });

  it('puts a book recommended again by the same household on the item the first one made', async () => {
    peerSide(peer);
    const [asha, ravi] = [await member('asha'), await member('ravi')];
    const first = await received();
    const again = await received();
    await a.postForm(`/recommendations/${first}/want`, { libraryId: String(shelfId) }, asha.cookie);
    await a.postForm(`/recommendations/${again}/want`, { libraryId: String(shelfId) }, ravi.cookie);
    const made = await rows<{ id: number }>('SELECT id FROM items WHERE title = ?1', 'The Left Hand of Darkness');
    expect(made).toHaveLength(1);
    expect(await wantsOf(ravi.id)).toEqual([{ item_id: made[0]!.id }]);
  });

  it('adds nothing on a second click, or another member’s at the same moment', async () => {
    peerSide(peer);
    const id = await received();
    const [asha, ravi] = [await member('asha'), await member('ravi')];
    await Promise.all([
      a.postForm(`/recommendations/${id}/want`, { libraryId: String(shelfId) }, asha.cookie),
      a.postForm(`/recommendations/${id}/want`, { libraryId: String(shelfId) }, ravi.cookie),
    ]);
    const res = await a.postForm(`/recommendations/${id}/want`, { libraryId: String(shelfId) }, asha.cookie);
    expect(res.headers.get('location')).toBe('/recommendations?done=gone');
    expect(await rows('SELECT count(*) AS n FROM items WHERE title = ?1', 'The Left Hand of Darkness')).toEqual([{ n: 1 }]);
    expect(await rows('SELECT count(*) AS n FROM wants')).toEqual([{ n: 1 }]);
  });

  it('writes nothing at all when the claim can’t be made: the item, its want and the link go with it or not at all', async () => {
    const id = await received();
    const asha = await member('asha');
    await env.DB.prepare("UPDATE recommendations SET status = 'dismissed' WHERE id = ?1").bind(id).run();
    const before = await rows('SELECT count(*) AS n FROM items');
    await expect(
      createItemWithTags(env.DB, { libraryId: shelfId, title: 'Raced', copies: 0 }, [], null, {
        wantedBy: asha.id,
        before: claimRecommendation(env.DB, id, asha.id, null),
      }),
    ).rejects.toThrow(/NOT NULL/);
    expect(await rows('SELECT count(*) AS n FROM items')).toEqual(before);
    expect(await rows('SELECT count(*) AS n FROM wants')).toEqual([{ n: 0 }]);
    expect(await rows('SELECT status FROM recommendations')).toEqual([{ status: 'dismissed' }]);
    // and with the claim still open, the same batch goes through whole
    await env.DB.prepare("UPDATE recommendations SET status = 'open' WHERE id = ?1").bind(id).run();
    const made = await createItemWithTags(env.DB, { libraryId: shelfId, title: 'Raced', copies: 0 }, [], null, {
      wantedBy: asha.id,
      before: claimRecommendation(env.DB, id, asha.id, null),
    });
    expect(await rows('SELECT item_id FROM wants')).toEqual([{ item_id: made }]);
  });

  it('asks for a shelf when there’s more than one, and won’t add without one', async () => {
    const id = await received();
    const cookie = await sessionCookie('member');
    const html = await (await a.get('/recommendations', cookie)).text();
    expect(html).toContain(`<label for="want-shelf-${id}" class="visually-hidden">Shelf for The Left Hand of Darkness</label>`);
    expect((await a.postForm(`/recommendations/${id}/want`, { libraryId: '999' }, cookie)).headers.get('location')).toBe(
      '/recommendations?done=shelf',
    );
    expect(await rows('SELECT status FROM recommendations')).toEqual([{ status: 'open' }]);
  });

  it('lists what this household sent, with who sent it — inside the app only', async () => {
    peerSide(peer);
    const asha = await member('asha-login');
    await recommendForm({ connectionId: String(connectionId) }, asha.cookie);
    const html = await (await a.get('/recommendations', asha.cookie)).text();
    expect(html).toContain('Recommended from here');
    expect(html).toMatch(/The Dispossessed<\/a><\/td><td>Riverbank library<\/td><td class="hide-sm">asha-login<\/td>/);
  });

  it('is not there without a federation key', async () => {
    const cookie = await sessionCookie('member');
    expect((await disabled.get('/recommendations', cookie)).status).toBe(404);
    expect((await disabled.postForm('/recommendations/1/dismiss', {}, cookie)).status).toBe(404);
    expect((await disabled.postForm('/recommendations/1/want', {}, cookie)).status).toBe(404);
    expect(await (await disabled.get('/', cookie)).text()).not.toContain('href="/recommendations"');
    expect(await (await a.get('/', cookie)).text()).toContain('href="/recommendations"');
  });
});

// ---------- what leaves, and what's kept ----------

describe('portability', () => {
  it('lists recommendations both ways in the connections export, and keeps theirs out of /export.csv', async () => {
    peerSide(peer);
    const admin = await sessionCookie('admin');
    await recommendForm({ connectionId: String(connectionId), note: 'Ours' }, admin);
    await inbox(peer, theirRecommendation(peer, { title: 'THEIR-TITLE' }, 'Priya', 'THEIR-NOTE'));
    const body = (await (await a.get('/federation/export.json', admin)).json()) as { recommendations: Array<Record<string, unknown>> };
    expect(body.recommendations.map((r) => [r.incoming, r.title, r.note])).toEqual([
      [false, 'The Dispossessed', 'Ours'],
      [true, 'THEIR-TITLE', 'THEIR-NOTE'],
    ]);
    const csv = await (await a.get('/export.csv', admin)).text();
    expect(csv).toContain('The Dispossessed');
    expect(csv).not.toContain('THEIR-TITLE');
    expect(csv).not.toContain('THEIR-NOTE');
  });
});

// ---------- D1 calls ----------

describe('D1 calls', () => {
  const counted = (budget: { left: number }) =>
    instanceA({ ...env, DB: budgeted(env.DB, budget), FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  const calls = async (run: (app: ReturnType<typeof instanceA>) => Promise<Response>) => {
    const budget = { left: 1000 };
    const res = await run(counted(budget));
    expect(res.status).toBeLessThan(400);
    return 1000 - budget.left;
  };

  it('keep the item page, sending, receiving and the list inside the budget of 50', async () => {
    const cookie = await sessionCookie('member');
    peerSide(peer);
    // nothing due in the background, so each count is the page's own
    await env.DB.prepare("UPDATE connections SET outbox_pulled_at = datetime('now')").run();
    const withSection = await calls((app) => app.get(`/items/${book.id}`, cookie));
    await env.DB.prepare("UPDATE connections SET status = 'awaiting_them'").run(); // no household to send to
    const withoutHouseholds = await calls((app) => app.get(`/items/${book.id}`, cookie));
    await env.DB.prepare("UPDATE connections SET status = 'active'").run();
    const send = await calls((app) => app.postForm(`/items/${book.id}/recommend`, { connectionId: String(connectionId) }, cookie));
    const receive = await calls((app) => app.signedPost('/federation/inbox', peer, theirRecommendation(peer)));
    for (let i = 0; i < 30; i++) await inbox(peer, theirRecommendation(peer, { id: 200 + i }));
    await env.DB.prepare("UPDATE recommendations SET created_at = datetime('now', '-1 day')").run();
    const list = await calls((app) => app.get('/recommendations', cookie));
    console.info(`recommendation D1 calls: ${JSON.stringify({ withSection, withoutHouseholds, send, receive, list })}`);
    // the section is one call for the households, and one more for the name it would be signed with
    expect(withSection - withoutHouseholds).toBeLessThanOrEqual(1);
    for (const n of [withSection, send, receive, list]) expect(n).toBeLessThanOrEqual(50);
    expect(receive).toBeLessThanOrEqual(8);
  });

  it('keep an outbox pull full of recommendations inside the background budget', async () => {
    const backlog = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, message: theirRecommendation(peer, { id: 300 + i }) }));
    peerSide(peer, { outbox: { latest: 30, more: false, messages: backlog } });
    const cookie = await sessionCookie('member');
    const logged = vi.spyOn(console, 'error');
    for (let load = 0; load < 8; load++) {
      await env.DB.prepare("UPDATE connections SET outbox_pulled_at = NULL").run();
      expect(await calls((app) => app.get('/recommendations', cookie))).toBeLessThanOrEqual(50);
    }
    expect(logged.mock.calls).toEqual([]);
    // a day's worth taken, the rest refused for today — and the pull still moves past them
    expect(await rows('SELECT count(*) AS n FROM recommendations')).toEqual([{ n: MAX_RECOMMENDATIONS_PER_DAY }]);
    expect(await rows('SELECT outbox_cursor FROM connections WHERE id = ?1', connectionId)).toEqual([{ outbox_cursor: 30 }]);
  });
});

// a comment from the same household still goes where it always did, beside recommendations
describe('beside the other directed messages', () => {
  it('leaves comments to comments', async () => {
    const message = commentCreate(peer.url, { owner: A.url, item: book.id, stamp: await itemStamp(book) }, 'narain', 'Nice');
    expect(await (await inbox(peer, message)).json()).toEqual({ status: 'received' });
    expect(await rows('SELECT * FROM recommendations')).toHaveLength(0);
  });
});
