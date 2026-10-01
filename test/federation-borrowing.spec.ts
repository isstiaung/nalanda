// Route-level: phase 4 of connections between instances — shelves read live, borrow requests, lending
// with an ordinary loan, return notices, the Borrowed page (docs/proposals/connections.md §7, §10).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, enqueueOutbox, getConnection, getFederationSettings, postComment, requestToBorrow } from '../src/db/federation';
import { createItem, createLibrary, createLoan, deleteItem, setDisplayName, setItemTags, updateSiteSettings } from '../src/db/queries';
import { member, upgradedSwitches } from './member-helpers';
import type { Item } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { receiveBorrowing } from '../src/federation/borrowing';
import { MAX_SENT_PER_DAY } from '../src/federation/config';
import { BudgetSpent, budgeted } from '../src/federation/budget';
import { itemStamp } from '../src/federation/items';
import { loadIdentity } from '../src/federation/keys';
import {
  borrowAccept,
  borrowDecline,
  borrowRequest,
  borrowWithdraw,
  commentCreate,
  commentDelete,
  inboxMessage,
  parseInboxMessage,
} from '../src/federation/messages';
import { refreshOutboxes } from '../src/federation/outbox';
import { expectOnlyBudgetErrors } from './console';
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
  type Keys,
  type Peer,
} from './federation-helpers';

let keysA: Keys;
let a: ReturnType<typeof instanceA>;
const disabled = instanceA(env);
let peer: Peer;
let connectionId: number;
let shelfId: number;
let lendable: Item;
let twoCopies: Item;
let out: Item;
let logOnly: Item;
let hidden: Item;
const THEIRS = '0123456789abcdef'; // the stamp of a book of theirs

beforeEach(async () => {
  keysA = await makeKeys();
  a = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  answerOutbound(() => json({}, 404)); // pages here pull connections' outboxes after responding
  await setUpA();
  peer = await makePeer('Riverbank library');
  connectionId = (await connectPeer(peer)).id;
  shelfId = (await createLibrary(env.DB, 'Main')).id;
  const other = (await createLibrary(env.DB, 'Private')).id;
  await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelfId, mediaType: null, status: null, owned: null });
  lendable = await createItem(env.DB, { libraryId: shelfId, title: 'Lendable', copies: 1 });
  twoCopies = await createItem(env.DB, { libraryId: shelfId, title: 'Two copies', copies: 2 });
  out = await createItem(env.DB, { libraryId: shelfId, title: 'Out', copies: 1 });
  logOnly = await createItem(env.DB, { libraryId: shelfId, title: 'Read, not owned', copies: 0 });
  hidden = await createItem(env.DB, { libraryId: other, title: 'Hidden', copies: 1 });
  await createLoan(env.DB, { itemId: twoCopies.id, borrower: 'SECRET-BORROWER', dueOn: '2099-01-01' });
  await createLoan(env.DB, { itemId: out.id, borrower: 'SECRET-BORROWER' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;

const requestFor = async (item: Item, note: string | null = null, from: Peer = peer) =>
  borrowRequest(from.url, item.id, await itemStamp(item), 'narain', note);

const ask = async (item: Item, note: string | null = null, from: Peer = peer) =>
  a.signedPost('/federation/inbox', from, await requestFor(item, note, from));

function capturePushes(reply: unknown = { status: 'ok' }) {
  const pushes: Record<string, unknown>[] = [];
  answerOutbound((req) => {
    if (new URL(req.url).pathname !== '/federation/inbox') return json({}, 404);
    pushes.push(decode(req.body));
    return json(reply);
  });
  return pushes;
}

describe('lending: what a connection sees and asks for', () => {
  it('shows a shared shelf with whether each book is free, never who has it or when it’s due', async () => {
    const res = await a.signedGet(`/federation/shelf?view=1&page=1`, peer);
    expect(res.status).toBe(200);
    const text = await res.text();
    // the due date in full: a 16-hex stamp can hold "2099" by chance, never a hyphenated date
    for (const secret of ['SECRET-BORROWER', '2099-01-01', 'Hidden', '"copies"']) expect(text).not.toContain(secret);
    const body = JSON.parse(text) as { items: Array<{ title: string; available: boolean; inCollection: boolean; stamp: string }> };
    expect(Object.fromEntries(body.items.map((i) => [i.title, [i.available, i.inCollection]]))).toEqual({
      Lendable: [true, true],
      'Two copies': [true, true],
      Out: [false, true],
      'Read, not owned': [false, false],
    });
    expect(body.items.find((i) => i.title === 'Lendable')!.stamp).toBe(await itemStamp(lendable));

    await setItemTags(env.DB, lendable.id, ['sci-fi']);
    expect(await (await a.signedGet(`/federation/item?view=1&id=${lendable.id}`, peer)).json()).toMatchObject({
      title: 'Lendable',
      available: true,
      tags: ['sci-fi'],
    });
    expect((await a.signedGet(`/federation/item?view=1&id=${hidden.id}`, peer)).status).toBe(404);
    expect((await disabled.signedGet(`/federation/shelf?view=1`, peer)).status).toBe(404);
  });

  it('takes a request for a free book, refuses one that isn’t, and lists it on Loans', async () => {
    expect(await (await ask(lendable, '<b>For the trip</b>')).json()).toEqual({ status: 'received' });
    expect((await ask(lendable)).status).toBe(409); // already asked
    expect((await ask(out)).status).toBe(409);
    expect((await ask(logOnly)).status).toBe(409);
    expect((await ask(hidden)).status).toBe(404);
    const waiting = await makePeer('Waiting');
    await connectPeer(waiting, 'awaiting_us');
    expect((await ask(twoCopies, null, waiting)).status).toBe(409);

    const html = await (await a.get('/loans', await sessionCookie('member'))).text();
    expect(html).toContain('Requests from connections');
    expect(html).toContain('narain');
    expect(html).toContain('Riverbank library');
    expect(html).toContain('&lt;b&gt;For the trip&lt;/b&gt;');
  });

  it('cleans a requester’s name of direction overrides before Loans, the notification or a loan’s borrower sees it', async () => {
    const RLO = '\u202E';
    const request = borrowRequest(peer.url, lendable.id, await itemStamp(lendable), `nar${RLO}ain`, null);
    expect((await a.signedPost('/federation/inbox', peer, request)).status).toBe(200);
    expect(await rows('SELECT requester_name FROM borrow_requests')).toEqual([{ requester_name: 'nar ain' }]);
    expect(JSON.stringify(await rows('SELECT * FROM notifications'))).not.toContain(RLO);
    const member = await sessionCookie('member');
    const html = await (await a.get('/loans', member)).text();
    expect(html).toContain('nar ain');
    expect(html).not.toContain(RLO);
    const [row] = await rows<{ id: number }>('SELECT id FROM borrow_requests');
    capturePushes();
    await a.postForm(`/borrow-requests/${row!.id}/accept`, {}, member);
    expect(await rows('SELECT borrower FROM loans WHERE item_id = ?', lendable.id)).toEqual([{ borrower: 'nar ain (Riverbank library)' }]);
    // a name that is nothing but overrides is no name: the request is malformed
    const blank = borrowRequest(peer.url, twoCopies.id, await itemStamp(twoCopies), `${RLO}\u200B`, null);
    expect((await a.signedPost('/federation/inbox', peer, blank)).status).toBe(400);
    expect(await rows('SELECT * FROM borrow_requests')).toHaveLength(1);
  });

  it('refuses a request meant for a book whose id has since been reused', async () => {
    const mistake = await createItem(env.DB, { libraryId: shelfId, title: 'Wrong edition', copies: 1 });
    const mistakeStamp = await itemStamp(mistake);
    await deleteItem(env.DB, mistake.id);
    const replacement = await createItem(env.DB, { libraryId: shelfId, title: 'Right edition', copies: 1, addedAt: '2026-01-02 03:04:05' });
    expect(replacement.id).toBe(mistake.id);

    const stale = borrowRequest(peer.url, mistake.id, mistakeStamp, 'narain', null);
    expect((await a.signedPost('/federation/inbox', peer, stale)).status).toBe(404);
    expect((await ask(replacement)).status).toBe(200);
  });

  it('lends with an ordinary loan when a member accepts, tells them, and lends only once', async () => {
    const request = await requestFor(lendable);
    await a.signedPost('/federation/inbox', peer, request);
    const [row] = await rows<{ id: number }>('SELECT id FROM borrow_requests');
    const pushes = capturePushes();
    const member = await sessionCookie('member');
    await a.postForm(`/borrow-requests/${row!.id}/accept`, { dueOn: '2026-10-01' }, member);

    expect(await rows('SELECT borrower, due_on, returned_on FROM loans WHERE item_id = ?', lendable.id)).toEqual([
      { borrower: 'narain (Riverbank library)', due_on: '2026-10-01', returned_on: null },
    ]);
    expect(await rows('SELECT connection_id, request_activity_id FROM connection_loans')).toEqual([
      { connection_id: connectionId, request_activity_id: request.id },
    ]);
    expect(pushes).toEqual([expect.objectContaining({ type: 'BorrowAccept', request: request.id, dueOn: '2026-10-01' })]);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'accepted' }]);

    await a.postForm(`/borrow-requests/${row!.id}/accept`, {}, member);
    expect(await rows('SELECT * FROM loans WHERE item_id = ?', lendable.id)).toHaveLength(1);
  });

  it('keeps an acceptance their inbox never saw — Hono’s 404, a proxy’s 401 — and delivers it later; a refusal in their words still ends it', async () => {
    const retryDue = () => env.DB.prepare("UPDATE outbox SET attempted_at = datetime('now', '-1 hour')").run();
    const onlyRetries = () => env.DB.prepare("UPDATE connections SET outbox_pulled_at = datetime('now')").run(); // no outbox pull: the retry alone
    const answerInbox = (make: () => Response) => answerOutbound((req) => (new URL(req.url).pathname === '/federation/inbox' ? make() : json({}, 404)));
    const undelivered = () => rows<{ type: string }>("SELECT json_extract(message, '$.type') AS type FROM outbox WHERE delivered_at IS NULL");
    const member = await sessionCookie('member');

    // their key unset at the moment we lend: every connections route over there is Hono's not-found page
    await ask(lendable);
    const [first] = await rows<{ id: number }>('SELECT id FROM borrow_requests');
    answerInbox(() => new Response('404 Not Found', { status: 404 }));
    await a.postForm(`/borrow-requests/${first!.id}/accept`, { dueOn: '2026-10-01' }, member);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'accepted' }]);
    expect(await undelivered()).toEqual([{ type: 'BorrowAccept' }]); // kept, not dropped
    // a proxy's 401 on a retry settles nothing either
    await onlyRetries();
    await retryDue();
    answerInbox(() => new Response('unauthorized', { status: 401 }));
    await a.get('/loans', member);
    expect(await undelivered()).toEqual([{ type: 'BorrowAccept' }]);
    // back, their inbox takes it on the next retry
    await retryDue();
    const pushes: Record<string, unknown>[] = [];
    answerOutbound((req) => {
      if (new URL(req.url).pathname !== '/federation/inbox') return json({}, 404);
      pushes.push(decode(req.body));
      return json({ status: 'accepted' });
    });
    await a.get('/loans', member);
    expect(pushes).toEqual([expect.objectContaining({ type: 'BorrowAccept', dueOn: '2026-10-01' })]);
    expect(await undelivered()).toEqual([]);

    // a 404 in the inbox's own words — the request isn't known there — is a refusal, and ends the message on the retry
    await ask(twoCopies);
    const [second] = await rows<{ id: number }>("SELECT id FROM borrow_requests WHERE status = 'pending'");
    answerInbox(() => json({ error: 'no such request' }, 404));
    await a.postForm(`/borrow-requests/${second!.id}/accept`, {}, member);
    expect(await undelivered()).toEqual([{ type: 'BorrowAccept' }]); // a queued push leaves the verdict to the retry
    await retryDue();
    await a.get('/loans', member);
    expect(await undelivered()).toEqual([]);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(1); // the first, delivered; the second, dropped
  });

  it('lends the last copy once, however many members lend it at the same moment', async () => {
    const other = await makePeer('Lakeside library');
    await connectPeer(other);
    await ask(lendable);
    await ask(lendable, null, other);
    const [first, second] = (await rows<{ id: number }>('SELECT id FROM borrow_requests ORDER BY id')).map((r) => r.id);
    capturePushes();
    const [one, two] = [await sessionCookie('member'), await sessionCookie('member')];
    await Promise.all([
      a.postForm(`/borrow-requests/${first}/accept`, {}, one),
      a.postForm(`/borrow-requests/${second}/accept`, {}, two),
    ]);
    expect(await rows('SELECT * FROM loans WHERE item_id = ?', lendable.id)).toHaveLength(1);
    expect(await rows("SELECT * FROM borrow_requests WHERE status = 'accepted'")).toHaveLength(1);
    expect(await rows("SELECT * FROM borrow_requests WHERE status = 'pending'")).toHaveLength(1);
  });

  it('queues a Returned notice when the existing return button is used — for connection loans only', async () => {
    const request = await requestFor(lendable);
    await a.signedPost('/federation/inbox', peer, request);
    const [row] = await rows<{ id: number }>('SELECT id FROM borrow_requests');
    const member = await sessionCookie('member');
    await a.postForm(`/borrow-requests/${row!.id}/accept`, {}, member);
    const queuedBefore = (await rows('SELECT * FROM outbox')).length;

    const [loan] = await rows<{ id: number }>('SELECT id FROM loans WHERE item_id = ?', lendable.id);
    await a.postForm(`/loans/${loan!.id}/return`, {}, member);
    const queued = await rows<{ message: string; activity_id: string }>('SELECT message, activity_id FROM outbox ORDER BY id');
    expect(queued).toHaveLength(queuedBefore + 1);
    const notice = queued[queued.length - 1]!;
    expect(parseInboxMessage(JSON.parse(notice.message))).toMatchObject({
      type: 'Returned',
      id: notice.activity_id,
      actor: A.url,
      request: request.id,
    });

    const [ordinary] = await rows<{ id: number }>('SELECT id FROM loans WHERE item_id = ?', out.id);
    await a.postForm(`/loans/${ordinary!.id}/return`, {}, member);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(queuedBefore + 1);

    const pulled = (await (await a.signedGet('/federation/outbox?since=0', peer)).json()) as {
      messages: Array<{ message: { type: string } }>;
    };
    expect(pulled.messages.map((m) => m.message.type)).toContain('Returned');
  });

  it('tells them when a book lent to them, or asked for, is deleted from the catalog', async () => {
    const lent = await requestFor(lendable);
    const wanted = await requestFor(twoCopies);
    await a.signedPost('/federation/inbox', peer, lent);
    await a.signedPost('/federation/inbox', peer, wanted);
    const [lentRow] = await rows<{ id: number }>('SELECT id FROM borrow_requests WHERE activity_id = ?', lent.id);
    capturePushes();
    const member = await sessionCookie('member');
    await a.postForm(`/borrow-requests/${lentRow!.id}/accept`, {}, member);
    const before = (await rows('SELECT * FROM outbox')).length;

    await a.postForm(`/items/${lendable.id}/delete`, {}, member);
    await a.postForm(`/items/${twoCopies.id}/delete`, {}, member);
    const queued = (await rows<{ message: string }>('SELECT message FROM outbox ORDER BY id')).slice(before);
    expect(queued.map((q) => parseInboxMessage(JSON.parse(q.message)))).toEqual([
      expect.objectContaining({ type: 'Returned', request: lent.id }),
      expect.objectContaining({ type: 'BorrowDecline', request: wanted.id }),
    ]);
    expect(await rows('SELECT seq FROM outbox ORDER BY seq')).toEqual(
      Array.from({ length: before + 2 }, (_, i) => ({ seq: i + 1 })),
    );
  });

  it('declines a request, and lets them withdraw one', async () => {
    const first = await requestFor(lendable);
    const second = await requestFor(twoCopies);
    await a.signedPost('/federation/inbox', peer, first);
    await a.signedPost('/federation/inbox', peer, second);
    const pushes = capturePushes();
    const [row] = await rows<{ id: number }>('SELECT id FROM borrow_requests WHERE activity_id = ?', first.id);
    const member = await sessionCookie('member');
    await a.postForm(`/borrow-requests/${row!.id}/decline`, {}, member);
    expect(pushes).toEqual([expect.objectContaining({ type: 'BorrowDecline', request: first.id })]);

    expect((await a.signedPost('/federation/inbox', peer, borrowWithdraw(peer.url, second.id))).status).toBe(200);
    expect(await rows('SELECT status FROM borrow_requests ORDER BY id')).toEqual([{ status: 'declined' }, { status: 'withdrawn' }]);
    expect(await (await a.get('/loans', member)).text()).not.toContain('Requests from connections');
  });

  it('keeps the loan, but not the link or the requests, when the connection ends', async () => {
    const request = await requestFor(lendable);
    await a.signedPost('/federation/inbox', peer, request);
    const [row] = await rows<{ id: number }>('SELECT id FROM borrow_requests');
    capturePushes();
    await a.postForm(`/borrow-requests/${row!.id}/accept`, {}, await sessionCookie('member'));
    expect((await a.signedPost('/federation/inbox', peer, inboxMessage('Disconnect', peer.url))).status).toBe(200);
    expect(await rows('SELECT borrower FROM loans WHERE item_id = ?', lendable.id)).toEqual([{ borrower: 'narain (Riverbank library)' }]);
    expect(await rows('SELECT * FROM connection_loans')).toHaveLength(0);
    expect(await rows('SELECT * FROM borrow_requests')).toHaveLength(0);
  });
});

describe('borrowing: this household asks', () => {
  const shelfJson = {
    view: { id: 7, name: 'Their shelf' },
    total: 2,
    page: 1,
    pages: 1,
    items: [
      { id: 70, mediaType: 'book', title: 'Free one', creators: 'Someone', published: '2001', coverKey: null, rating: null, inCollection: true, available: true, stamp: THEIRS },
      { id: 71, mediaType: 'book', title: '<i>Out one</i>', creators: null, published: null, coverKey: null, rating: 6, inCollection: true, available: false, stamp: 'fedcba9876543210' },
    ],
  };
  const detailJson = (available: boolean) => ({
    id: 70,
    mediaType: 'book',
    title: 'Free one',
    creators: 'Someone',
    publisher: null,
    published: '2001',
    description: 'A book.',
    length: null,
    coverKey: null,
    rating: null,
    review: null,
    inCollection: true,
    details: {},
    completedOn: null,
    updatedAt: '2026-09-01 10:00:00',
    available,
    tags: [],
    stamp: THEIRS,
  });
  const askForFreeOne = (member: string) =>
    a.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '70', note: '' }, member);

  it('browses a household’s shelf live, keeping it in memory for a few minutes', async () => {
    const outbound = answerOutbound((req) => (new URL(req.url).pathname === '/federation/shelf' ? json(shelfJson) : json({}, 404)));
    const member = await sessionCookie('member');
    const html = await (await a.get(`/households/${connectionId}/views/7`, member)).text();
    expect(html).toContain('Free one');
    expect(html).toContain('&lt;i&gt;Out one&lt;/i&gt;');
    expect(html).toContain('Available');
    expect(html).toContain('>Out<');
    await a.get(`/households/${connectionId}/views/7`, member);
    const shelfReads = outbound.filter((r) => new URL(r.url).pathname === '/federation/shelf');
    expect(shelfReads).toHaveLength(1);
    expect(await signedBy(keysA.pair.publicKey, shelfReads[0]!)).toBe(true);
  });

  it('doesn’t keep an answer it couldn’t read', async () => {
    let readable = false;
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/shelf' ? json(readable ? shelfJson : { nonsense: true }) : json({}, 404),
    );
    const member = await sessionCookie('member');
    expect(await (await a.get(`/households/${connectionId}/views/7`, member)).text()).toContain('Couldn’t reach');
    readable = true;
    expect(await (await a.get(`/households/${connectionId}/views/7`, member)).text()).toContain('Free one');
  });

  it("shows a connection's detail values as text, never as links into their chosen URL", async () => {
    answerOutbound((req) =>
      new URL(req.url).pathname === '/federation/item'
        ? json({ ...detailJson(true), details: { reviewed_in: 'https://evil.example/phish', format: 'Paperback' } })
        : json({}, 404),
    );
    const html = await (await a.get(`/households/${connectionId}/views/7/items/70`, await sessionCookie('member'))).text();

    expect(html).toContain('https://evil.example/phish'); // still shown, as text
    expect(html).not.toContain('href="https://evil.example');
    expect(html).toContain('Paperback');
  });

  it('sends "A member" as the requester — the display name only with names on for connections — never a login', async () => {
    await upgradedSwitches(); // names off to start with
    const pushes: Record<string, unknown>[] = [];
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      if (pathname === '/federation/inbox') {
        pushes.push(decode(req.body));
        return json({ status: 'received' });
      }
      return json({}, 404);
    });
    const priya = await member('u-priya-login');
    await setDisplayName(env.DB, priya.id, 'Priya');
    await a.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '70', note: '' }, priya.cookie);
    expect(pushes[0]).toMatchObject({ type: 'BorrowRequest', requester: 'A member' }); // names off (§16 #45)
    await env.DB.prepare('DELETE FROM borrow_requests').run(); // a request for the same book again
    await updateSiteSettings(env.DB, { namesToConnections: true });
    await a.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '70', note: '' }, priya.cookie);
    expect(pushes[1]).toMatchObject({ type: 'BorrowRequest', requester: 'Priya' });
    expect(JSON.stringify(pushes)).not.toContain('u-priya-login');
    expect((await env.DB.prepare('SELECT requester_name AS r FROM borrow_requests').all()).results).toEqual([{ r: 'u-priya-login' }]); // ours, inside
  });

  it('asks to borrow, and follows the answer through to the return', async () => {
    const pushes: Record<string, unknown>[] = [];
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      if (pathname === '/federation/inbox') {
        pushes.push(decode(req.body));
        return json({ status: 'received' });
      }
      return json({}, 404);
    });
    const member = await sessionCookie('member');
    await a.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '70', note: 'Next week?' }, member);
    expect(pushes).toEqual([expect.objectContaining({ type: 'BorrowRequest', item: 70, stamp: THEIRS, note: 'Next week?' })]);
    expect(await rows('SELECT incoming, their_item_id, their_item_stamp, item_title, status FROM borrow_requests')).toEqual([
      { incoming: 0, their_item_id: 70, their_item_stamp: THEIRS, item_title: 'Free one', status: 'pending' },
    ]);
    expect(await (await a.get('/borrowed', member)).text()).toContain('Waiting');

    const requestId = pushes[0]!.id as string;
    const accept = borrowAccept(peer.url, requestId, '2026-09-15', '2026-10-01');
    expect((await a.signedPost('/federation/inbox', peer, accept)).status).toBe(200);
    expect(await rows('SELECT their_item_id, title, due_on, returned_on FROM borrowed_items')).toEqual([
      { their_item_id: 70, title: 'Free one', due_on: '2026-10-01', returned_on: null },
    ]);
    expect(await (await a.get('/borrowed', member)).text()).toContain('2026-10-01');

    // A book still out can't be removed from the list.
    const [borrowed] = await rows<{ id: number }>('SELECT id FROM borrowed_items');
    await a.postForm(`/borrowed/${borrowed!.id}/remove`, {}, member);
    expect(await rows('SELECT * FROM borrowed_items')).toHaveLength(1);

    const returned = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Returned',
      id: `urn:uuid:${crypto.randomUUID()}`,
      actor: peer.url,
      request: requestId,
      returnedOn: '2026-09-20',
    };
    expect((await a.signedPost('/federation/inbox', peer, returned)).status).toBe(200);
    expect(await rows('SELECT returned_on FROM borrowed_items')).toEqual([{ returned_on: '2026-09-20' }]);
    await a.postForm(`/borrowed/${borrowed!.id}/remove`, {}, member);
    expect(await rows('SELECT * FROM borrowed_items')).toHaveLength(0);

    // The same acceptance again — a retried push — brings nothing back.
    expect(await (await a.signedPost('/federation/inbox', peer, accept)).json()).toEqual({ status: 'already answered' });
    expect(await rows('SELECT * FROM borrowed_items')).toHaveLength(0);

    // An answer about a request this household never sent to them changes nothing.
    const other = await makePeer('Lakeside library');
    await connectPeer(other);
    expect((await a.signedPost('/federation/inbox', other, borrowDecline(other.url, requestId))).status).toBe(404);
  });

  it('records an acceptance whole or not at all when a pull runs out of queries', async () => {
    const pushes: Record<string, unknown>[] = [];
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      if (pathname === '/federation/inbox') pushes.push(decode(req.body));
      return json({ status: 'received' });
    });
    await askForFreeOne(await sessionCookie('member'));
    const accept = borrowAccept(peer.url, pushes[0]!.id as string, '2026-09-15', null);
    const connection = (await getConnection(env.DB, connectionId))!;

    // Room to find the request, not to write the answer — the write is one batch, one call, so a budget of
    // one covers the lookup and nothing more. Nothing changes, so a later pull applies it in full.
    await expect(receiveBorrowing(budgeted(env.DB, { left: 1 }), connection, accept)).rejects.toThrow(BudgetSpent);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'pending' }]);
    expect(await rows('SELECT * FROM borrowed_items')).toHaveLength(0);

    expect(await receiveBorrowing(env.DB, connection, accept)).toEqual({ status: 200, body: { status: 'accepted' } });
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'accepted' }]);
    expect(await rows('SELECT title, due_on, returned_on FROM borrowed_items')).toEqual([
      { title: 'Free one', due_on: null, returned_on: null },
    ]);
  });

  it('marks a request declined at once when they refuse it', async () => {
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      if (pathname === '/federation/inbox') return json({ error: 'not available' }, 409);
      return json({}, 404);
    });
    const html = await (await askForFreeOne(await sessionCookie('member'))).text();
    expect(html).toContain('the book isn’t available any more');
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'declined' }]);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
  });

  it('stops at this household’s daily limit of messages to one connection, before asking them anything', async () => {
    const calls = answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      return json({ status: 'received' });
    });
    const member = await sessionCookie('member');
    // the day's hundredth message is the last one that goes
    for (let i = 0; i < MAX_SENT_PER_DAY - 1; i++) {
      await enqueueOutbox(env.DB, connectionId, { id: `urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
    }
    expect((await askForFreeOne(member)).status).toBe(302);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'pending' }]);
    expect(calls.map((r) => new URL(r.url).pathname)).toEqual(['/federation/item', '/federation/inbox']);
    // the hundred-and-first is refused on the Borrowed page: not sent, not queued, and they are never asked
    calls.length = 0;
    const res = await a.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '71', note: '' }, member);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('as many messages as one day allows');
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'pending' }]);
    expect(await rows('SELECT count(*) AS n FROM outbox')).toEqual([{ n: MAX_SENT_PER_DAY }]);
    // the Borrowed page still pulls their outbox after its response, as every load does; nothing else goes their way
    expect(calls.map((r) => new URL(r.url).pathname).filter((path) => path !== '/federation/outbox')).toEqual([]);
  });

  it('leaves a request waiting when the answer isn’t their inbox’s — a not-found page — rather than declining it', async () => {
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      if (pathname === '/federation/inbox') return new Response('404 Not Found', { status: 404 }); // their key unset: Hono's page
      return json({}, 404);
    });
    const member = await sessionCookie('member');
    const res = await askForFreeOne(member);
    expect(res.status).toBe(302); // not the "couldn't take that request" page
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'pending' }]);
    expect(await rows('SELECT delivered_at FROM outbox')).toEqual([{ delivered_at: null }]);
    // the same answer in the inbox's own words declines it at once, as before
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      if (pathname === '/federation/inbox') return json({ error: 'no such item' }, 404);
      return json({}, 404);
    });
    await env.DB.prepare('DELETE FROM borrow_requests').run();
    await env.DB.prepare('DELETE FROM outbox').run();
    const html = await (await askForFreeOne(member)).text();
    expect(html).toContain('the book isn’t available any more');
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'declined' }]);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);
  });

  it('won’t ask for a book that isn’t free, and can withdraw a request', async () => {
    answerOutbound((req) => (new URL(req.url).pathname === '/federation/item' ? json(detailJson(false)) : json({ status: 'ok' })));
    const member = await sessionCookie('member');
    await askForFreeOne(member);
    expect(await rows('SELECT * FROM borrow_requests')).toHaveLength(0);

    const pushes: Record<string, unknown>[] = [];
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detailJson(true));
      if (pathname === '/federation/inbox') pushes.push(decode(req.body));
      return json({ status: 'ok' });
    });
    await askForFreeOne(member);
    const [row] = await rows<{ id: number; activity_id: string }>('SELECT id, activity_id FROM borrow_requests');
    await a.postForm(`/borrow-requests/${row!.id}/withdraw`, {}, member);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'withdrawn' }]);
    expect(pushes[pushes.length - 1]).toMatchObject({ type: 'BorrowWithdraw', request: row!.activity_id });
  });

  it('gives up on a request they refuse on a retry, and never re-sends one that was withdrawn', async () => {
    const unreachable = () =>
      answerOutbound((req) => {
        const { pathname } = new URL(req.url);
        if (pathname === '/federation/item') return json(detailJson(true));
        if (pathname === '/federation/inbox') throw new TypeError('unreachable');
        return json({}, 404);
      });
    const retryDue = () => env.DB.prepare("UPDATE outbox SET attempted_at = datetime('now', '-1 hour')").run();
    const member = await sessionCookie('member');

    // Asked while they were unreachable: the request waits in the outbox. On a retry they refuse it.
    unreachable();
    await askForFreeOne(member);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'pending' }]);
    await retryDue();
    answerOutbound((req) => (new URL(req.url).pathname === '/federation/inbox' ? json({ error: 'not available' }, 409) : json({}, 404)));
    await a.get('/borrowed', member);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'declined' }]);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(0);

    // Asked again while unreachable, then withdrawn — that push failed too. The request is never sent after all.
    unreachable();
    await askForFreeOne(member);
    const [row] = await rows<{ id: number }>("SELECT id FROM borrow_requests WHERE status = 'pending'");
    await a.postForm(`/borrow-requests/${row!.id}/withdraw`, {}, member);
    const pushes = capturePushes();
    for (let load = 0; load < 2; load++) {
      await retryDue();
      await a.get('/borrowed', member);
    }
    expect(pushes.map((p) => p.type)).not.toContain('BorrowRequest');
  });

  it('exports connections data for admins only, listing active connections and no keys', async () => {
    const waiting = await makePeer('Still waiting');
    await connectPeer(waiting, 'awaiting_us');
    expect((await a.get('/federation/export.json', await sessionCookie('member'))).status).toBe(403);
    const res = await a.get('/federation/export.json', await sessionCookie('admin'));
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ library: { name: A.name }, connections: [expect.objectContaining({ householdName: 'Riverbank library' })] });
    expect(JSON.stringify(body)).not.toContain('Still waiting');
    expect(JSON.stringify(body)).not.toContain('"d"');
  });
});

describe('without a federation key', () => {
  it('leaves Loans as it was, and Borrowed is the people-only page — the connections sections and pages are gone', async () => {
    await ask(lendable);
    const member = await sessionCookie('member');
    expect(await (await disabled.get('/loans', member)).text()).not.toContain('Requests from connections');
    // Borrowed is every household's since ARCH.md §16 #82: what is borrowed from people, and nothing of connections
    const borrowed = await disabled.get('/borrowed', member);
    expect(borrowed.status).toBe(200);
    const page = await borrowed.text();
    expect(page).toContain('From people');
    expect(page).not.toContain('FROM CONNECTIONS');
    expect(page).not.toContain('From connections');
    expect(page).not.toContain('Browse connected households');
    expect(page).not.toContain('/federation/export.json');
    expect((await disabled.get(`/households/${connectionId}`, member)).status).toBe(404);
    expect((await disabled.get('/federation/export.json', await sessionCookie('admin'))).status).toBe(404);
    expect(await (await disabled.get('/', member)).text()).toContain('href="/borrowed"');
  });
});

describe('a change here and the message that tells them: both or neither', () => {
  // Every action that changes something a connection must hear about queues its message in the same batch as
  // the change. Queued afterwards, a failure between the two left a change they were never told about — a
  // comment stored here, never sent, and doubled when the person pressed Send again. Each case fails the action
  // at every point in turn, checks the change and the message agree, then retries it with room to spare.
  const withBudget = (left: number) =>
    instanceA({ ...env, DB: budgeted(env.DB, { left }), FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  const queuedOf = async (type: string) =>
    (await rows<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE message LIKE ?1', `%"type":"${type}"%`))[0]!.n;
  const clear = (...tables: string[]) => env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));

  async function atEveryFailurePoint(
    label: string,
    type: string,
    reset: () => Promise<void>,
    act: (app: ReturnType<typeof instanceA>) => Promise<Response>,
    changed: () => Promise<boolean>,
  ) {
    expectOnlyBudgetErrors();
    for (let left = 0; ; left++) {
      expect(left, `${label} never finished`).toBeLessThan(60);
      await reset();
      const res = await act(withBudget(left));
      const state = { changed: await changed(), queued: await queuedOf(type) };
      expect(state.queued, `${label}, with room for ${left} queries: ${JSON.stringify(state)}`).toBe(state.changed ? 1 : 0);
      if (res.status < 500) {
        expect(state, label).toEqual({ changed: true, queued: 1 });
        return;
      }
      await act(a); // the person tries again
      expect({ changed: await changed(), queued: await queuedOf(type) }, `${label}, retried after ${left}`).toEqual({ changed: true, queued: 1 });
    }
  }

  let member: string;
  beforeEach(async () => {
    member = await sessionCookie('member');
    answerOutbound((req) => (new URL(req.url).pathname === '/federation/inbox' ? json({ status: 'received' }) : json({}, 404)));
  });

  const incomingRequest = async () => {
    await clear('connection_loans', 'outbox', 'borrow_requests');
    await env.DB.prepare('DELETE FROM loans WHERE item_id = ?1').bind(lendable.id).run();
    expect((await ask(lendable)).status).toBe(200);
    await clear('outbox');
  };
  const requestId = async () => (await rows<{ id: number }>('SELECT id FROM borrow_requests'))[0]!.id;
  const status = async () => (await rows<{ status: string }>('SELECT status FROM borrow_requests'))[0]?.status;

  it('lends a book with its acceptance queued, or neither', async () => {
    await atEveryFailurePoint(
      'lend',
      'BorrowAccept',
      incomingRequest,
      async (app) => app.postForm(`/borrow-requests/${await requestId()}/accept`, { dueOn: '' }, member),
      async () => {
        const accepted = (await status()) === 'accepted';
        const loans = await rows('SELECT id FROM loans WHERE item_id = ?1', lendable.id);
        const links = await rows('SELECT loan_id FROM connection_loans');
        expect({ loans: loans.length, links: links.length }).toEqual(accepted ? { loans: 1, links: 1 } : { loans: 0, links: 0 });
        if (accepted) expect(links[0]!.loan_id).toBe(loans[0]!.id);
        return accepted;
      },
    );
  });

  it('declines a request with the decline queued, or neither', async () => {
    await atEveryFailurePoint(
      'decline',
      'BorrowDecline',
      incomingRequest,
      async (app) => app.postForm(`/borrow-requests/${await requestId()}/decline`, {}, member),
      async () => (await status()) === 'declined',
    );
  });

  it('withdraws a request of ours with the withdrawal queued, or neither', async () => {
    await atEveryFailurePoint(
      'withdraw',
      'BorrowWithdraw',
      async () => {
        await clear('outbox', 'borrow_requests');
        const message = borrowRequest(A.url, 70, THEIRS, 'me', null);
        await requestToBorrow(
          env.DB,
          { activityId: message.id, connectionId, incoming: false, theirItemId: 70, theirItemStamp: THEIRS, theirViewId: 7, itemTitle: 'Free one', requesterName: 'me', note: null },
          message,
        );
        await clear('outbox');
      },
      async (app) => app.postForm(`/borrow-requests/${await requestId()}/withdraw`, {}, member),
      async () => (await status()) === 'withdrawn',
    );
  });

  it('asks to borrow with the request queued, or neither', async () => {
    const detail = { id: 70, mediaType: 'book', title: 'Free one', creators: null, publisher: null, published: null, description: null, length: null, coverKey: null, rating: null, review: null, inCollection: true, details: {}, completedOn: null, updatedAt: '2026-09-01 10:00:00', available: true, tags: [], stamp: THEIRS };
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detail);
      return pathname === '/federation/inbox' ? json({ status: 'received' }) : json({}, 404);
    });
    await atEveryFailurePoint(
      'request',
      'BorrowRequest',
      () => clear('outbox', 'borrow_requests').then(() => undefined),
      (app) => app.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '70', note: '' }, member),
      async () => (await rows('SELECT id FROM borrow_requests')).length === 1,
    );
  });

  it('makes one request for a book however often it is submitted', async () => {
    // The check for a request already waiting was a read of its own, so two quick submits could both pass it,
    // and the second came back refused as "not available any more".
    const values = (message: { id: string }) => ({
      activityId: message.id, connectionId, incoming: false, theirItemId: 70, theirItemStamp: THEIRS, theirViewId: 7, itemTitle: 'Free one', requesterName: 'me', note: null,
    });
    const first = borrowRequest(A.url, 70, THEIRS, 'me', null);
    const again = borrowRequest(A.url, 70, THEIRS, 'me', null);
    expect(await requestToBorrow(env.DB, values(first), first)).toEqual(expect.any(Number));
    expect(await requestToBorrow(env.DB, values(again), again)).toBeNull();
    expect(await rows('SELECT activity_id FROM borrow_requests')).toEqual([{ activity_id: first.id }]);
    expect(await queuedOf('BorrowRequest')).toBe(1);

    // and through the page: two submits at once
    await env.DB.batch([env.DB.prepare('DELETE FROM outbox'), env.DB.prepare('DELETE FROM borrow_requests')]);
    const detail = { id: 70, mediaType: 'book', title: 'Free one', creators: null, publisher: null, published: null, description: null, length: null, coverKey: null, rating: null, review: null, inCollection: true, details: {}, completedOn: null, updatedAt: '2026-09-01 10:00:00', available: true, tags: [], stamp: THEIRS };
    answerOutbound((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/federation/item') return json(detail);
      return pathname === '/federation/inbox' ? json({ status: 'received' }) : json({}, 404);
    });
    const submit = () => a.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '70', note: '' }, member);
    await Promise.all([submit(), submit()]);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'pending' }]);
    expect(await queuedOf('BorrowRequest')).toBe(1);
  });

  it('posts and deletes a comment with its message queued, or neither', async () => {
    const book = await createItem(env.DB, { libraryId: shelfId, title: 'Reviewed', review: 'A review.' });
    // a thread they started, so a reply is allowed
    const theirs = commentCreate(peer.url, { owner: A.url, item: book.id, stamp: await itemStamp(book) }, 'them', 'Hi');
    await env.DB.prepare(
      `INSERT INTO comments (activity_id, connection_id, our_item_id, from_us, author_name, body, created_at)
       VALUES (?1, ?2, ?3, 0, 'them', 'Hi', '2026-09-01 00:00:00')`,
    ).bind(theirs.id, connectionId, book.id).run();
    const ours = () => rows<{ id: number; deleted_at: string | null }>('SELECT id, deleted_at FROM comments WHERE from_us = 1');

    await atEveryFailurePoint(
      'comment',
      'CommentCreate',
      () => env.DB.batch([env.DB.prepare('DELETE FROM comments WHERE from_us = 1'), env.DB.prepare('DELETE FROM outbox')]).then(() => undefined),
      (app) => app.postForm(`/items/${book.id}/comments`, { connectionId: String(connectionId), body: 'My reply' }, member),
      async () => {
        const mine = await ours();
        expect(mine.length, 'stored once, however often Send was pressed').toBeLessThanOrEqual(1);
        return mine.length === 1;
      },
    );

    await atEveryFailurePoint(
      'comment deletion',
      'CommentDelete',
      async () => {
        await env.DB.batch([env.DB.prepare('DELETE FROM comments WHERE from_us = 1'), env.DB.prepare('DELETE FROM outbox')]);
        const message = commentCreate(A.url, { owner: A.url, item: book.id, stamp: await itemStamp(book) }, 'me', 'Mine');
        await postComment(
          env.DB,
          { activityId: message.id, connectionId, ourItemId: book.id, fromUs: true, authorName: 'me', body: 'Mine', createdAt: message.published },
          message,
        );
        await clear('outbox');
      },
      async (app) => app.postForm(`/comments/${(await ours())[0]!.id}/delete`, { back: '/feed' }, member),
      async () => (await ours())[0]!.deleted_at !== null,
    );
  });

  it('declines a refused request of ours as it lets go of it, wherever the retry runs out', async () => {
    // Dropped from the outbox first, a failure before the decline left the request pending for good: the
    // outbox row is what brings it back on a later page load.
    const identity = (await loadIdentity(keysA.secret))!;
    const settings = (await getFederationSettings(env.DB))!;
    answerOutbound((req) => json({ error: 'not available' }, new URL(req.url).pathname === '/federation/inbox' ? 409 : 404));
    for (let left = 0; ; left++) {
      expect(left, 'never finished').toBeLessThan(30);
      await clear('outbox', 'borrow_requests');
      await env.DB.prepare("UPDATE connections SET outbox_pulled_at = datetime('now')").run(); // only the retry runs
      const message = borrowRequest(settings.baseUrl, 70, THEIRS, 'me', null);
      await requestToBorrow(
        env.DB,
        { activityId: message.id, connectionId, incoming: false, theirItemId: 70, theirItemStamp: THEIRS, theirViewId: 7, itemTitle: 'Free one', requesterName: 'me', note: null },
        message,
      );
      await env.DB.prepare('UPDATE outbox SET attempted_at = NULL').run(); // due for a retry now

      await refreshOutboxes(env.DB, identity, settings, { left });

      const state = { status: await status(), queued: await queuedOf('BorrowRequest') };
      expect(state, `with room for ${left} queries`).not.toEqual({ status: 'pending', queued: 0 });
      if (state.status === 'declined') {
        expect(state.queued).toBe(0);
        return;
      }
    }
  });
});
