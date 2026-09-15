// Route-level: phase 4 of connections between instances — shelves read live, borrow requests, lending
// with an ordinary loan, return notices, the Borrowed page (docs/proposals/connections.md §7, §10).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView } from '../src/db/federation';
import { createItem, createLibrary, createLoan, deleteItem, setItemTags } from '../src/db/queries';
import type { Item } from '../src/db/schema';
import type { Bindings } from '../src/env';
import { itemStamp } from '../src/federation/items';
import { borrowAccept, borrowDecline, borrowRequest, borrowWithdraw, inboxMessage, parseInboxMessage } from '../src/federation/messages';
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
    for (const secret of ['SECRET-BORROWER', '2099', 'Hidden', '"copies"']) expect(text).not.toContain(secret);
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
  it('leaves Loans as it was and has no borrowing pages', async () => {
    await ask(lendable);
    const member = await sessionCookie('member');
    expect(await (await disabled.get('/loans', member)).text()).not.toContain('Requests from connections');
    expect((await disabled.get('/borrowed', member)).status).toBe(404);
    expect((await disabled.get(`/households/${connectionId}`, member)).status).toBe(404);
    expect((await disabled.get('/federation/export.json', await sessionCookie('admin'))).status).toBe(404);
    expect(await (await disabled.get('/', member)).text()).not.toContain('href="/borrowed"');
  });
});
