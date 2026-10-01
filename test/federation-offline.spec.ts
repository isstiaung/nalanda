// FEDERATION_OFFLINE (ARCH.md §16 #92): a plain runtime variable for a copy of a production database restored
// elsewhere, whose connections table still names the real households. Set, this instance contacts none of them —
// no background pull or push, no message a page would send, no live read of a shelf — while what peers sign to it is
// answered as before. The fetch stub records every outbound request; the proof is that it records none.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionView, createSubscription, getConnection, getConnectionByBaseUrl } from '../src/db/federation';
import { createItem, createLibrary } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { itemStamp } from '../src/federation/items';
import { borrowRequest } from '../src/federation/messages';
import { federationOffline, OFFLINE_NOTICE } from '../src/federation/offline';
import { newInviteToken } from '../src/federation/tokens';
import { answerOutbound, connectPeer, instanceA, json, makeKeys, makePeer, sessionCookie, setUpA, type Keys, type Outbound, type Peer } from './federation-helpers';

let keysA: Keys;
let online: ReturnType<typeof instanceA>;
let offline: ReturnType<typeof instanceA>;
let peer: Peer;
let connectionId: number;
let outbound: Outbound[];
let lendable: { id: number; stamp: string };

const rows = async <T = Record<string, unknown>>(query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all<T>()).results;
const paths = () => outbound.map((r) => new URL(r.url).pathname);

beforeEach(async () => {
  keysA = await makeKeys();
  online = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret } as Bindings);
  offline = instanceA({ ...env, FEDERATION_PRIVATE_KEY: keysA.secret, FEDERATION_OFFLINE: '1' } as Bindings);
  outbound = answerOutbound(() => json({ status: 'ok' }));
  await setUpA();
  peer = await makePeer('Riverbank library');
  connectionId = (await connectPeer(peer)).id; // outbox never pulled: due on the first page load
  const shelf = await createLibrary(env.DB, 'Main');
  await createConnectionView(env.DB, { name: 'Main shelf', libraryId: shelf.id, mediaType: null, status: null, owned: null });
  const item = await createItem(env.DB, { libraryId: shelf.id, title: 'Lendable', copies: 1 });
  lendable = { id: item.id, stamp: await itemStamp(item) };
  // a followed view, overdue for a pull
  await createSubscription(env.DB, { connectionId, viewId: 7, viewName: 'Theirs', intervalMinutes: 15, retentionDays: 90, maxEntries: 500 });
});

afterEach(() => vi.unstubAllGlobals());

describe('the switch', () => {
  it('is on for anything but blank, 0, false, no or off', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'restored copy', ' 1 ']) expect(federationOffline({ FEDERATION_OFFLINE: value }), value).toBe(true);
    for (const value of [undefined, '', '  ', '0', 'false', 'FALSE', 'no', 'off']) expect(federationOffline({ FEDERATION_OFFLINE: value }), String(value)).toBe(false);
  });
});

describe('with FEDERATION_OFFLINE set', () => {
  it('pulls no outbox and no feed after a page load — where the same load otherwise does', async () => {
    const member = await sessionCookie('member');
    expect((await offline.get('/borrowed', member)).status).toBe(200);
    expect((await offline.get('/feed', member)).status).toBe(200);
    expect((await offline.get('/loans', member)).status).toBe(200);
    expect(outbound).toEqual([]);
    // negative control: without the variable the first load pulls their outbox, and Feed their view
    expect((await online.get('/borrowed', member)).status).toBe(200);
    expect((await online.get('/feed', member)).status).toBe(200);
    expect(paths()).toContain('/federation/outbox');
    expect(paths()).toContain('/federation/feed');
  });

  it('pushes nothing a page queues, and asks nothing before queuing — the outbox keeps it', async () => {
    const member = await sessionCookie('member');
    // they ask (what peers sign to this instance is still answered), and a member lends: the acceptance is queued, not pushed
    expect((await offline.signedPost('/federation/inbox', peer, borrowRequest(peer.url, lendable.id, lendable.stamp, 'narain', null))).status).toBe(200);
    const [request] = await rows<{ id: number }>('SELECT id FROM borrow_requests');
    expect((await offline.postForm(`/borrow-requests/${request!.id}/accept`, {}, member)).status).toBe(302);
    expect(await rows('SELECT status FROM borrow_requests')).toEqual([{ status: 'accepted' }]);
    expect(await rows("SELECT json_extract(message, '$.type') AS type, delivered_at FROM outbox")).toEqual([{ type: 'BorrowAccept', delivered_at: null }]);
    // asking to borrow from them: refused on the Borrowed page before they are asked anything, and nothing is queued
    const res = await offline.postForm(`/households/${connectionId}/requests`, { viewId: '7', itemId: '70', note: '' }, member);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(OFFLINE_NOTICE);
    expect(await rows('SELECT * FROM borrow_requests WHERE incoming = 0')).toHaveLength(0);
    expect(await rows('SELECT * FROM outbox')).toHaveLength(1);
    expect(outbound).toEqual([]);
  });

  it('reads no shelf live, and says so', async () => {
    const member = await sessionCookie('member');
    for (const path of [`/households/${connectionId}`, `/households/${connectionId}/views/7`, `/households/${connectionId}/views/7/items/70`]) {
      const res = await offline.get(path, member);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain(OFFLINE_NOTICE);
    }
    expect(outbound).toEqual([]);
  });

  it('notifies nobody of a disconnect, confirms and redeems nothing, and says so on Connections', async () => {
    const admin = await sessionCookie('admin');
    expect(await (await offline.get('/connections', admin)).text()).toContain(OFFLINE_NOTICE);
    expect(await (await online.get('/connections', admin)).text()).not.toContain(OFFLINE_NOTICE);
    // a request waiting on us: Confirm sends nothing and changes nothing
    const waiting = await makePeer('Clifftop library');
    const row = await connectPeer(waiting, 'awaiting_us');
    expect(await (await offline.postForm(`/connections/${row.id}/confirm`, {}, admin)).text()).toContain(OFFLINE_NOTICE);
    expect((await getConnection(env.DB, row.id))?.status).toBe('awaiting_us');
    // an invitation link: nothing fetched, nothing recorded
    const link = `https://peer-new.example/connect#${newInviteToken()}`;
    expect(await (await offline.postForm('/connections/redeem', { link }, admin)).text()).toContain(OFFLINE_NOTICE);
    expect(await getConnectionByBaseUrl(env.DB, 'https://peer-new.example')).toBeNull();
    // the disconnect itself still happens here; the notice to them does not go
    expect((await offline.postForm(`/connections/${connectionId}/disconnect`, {}, admin)).status).toBe(302);
    expect(await getConnection(env.DB, connectionId)).toBeNull();
    expect(outbound).toEqual([]);
  });

  it('still answers what peers sign to it', async () => {
    const res = await offline.signedGet('/federation/views', peer);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { views: unknown[] }).views).toHaveLength(1);
    expect(outbound).toEqual([]);
  });
});
