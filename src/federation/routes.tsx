// Public endpoints for connections between instances (docs/proposals/connections.md §5, §6, §14).
// Mounted before the session middleware: peers authenticate by signature, not by cookie. Every
// route here 404s unless this instance has a federation key, and all but the key check also need
// a household name to have been saved.
import { Hono, type Context } from 'hono';
import {
  activityInView,
  memberActivityInView,
  stillSharedMember,
  type MemberActivity,
  type SharedActivity,
  applyConnectionMessage,
  availability,
  countConnections,
  countPush,
  describeViews,
  findRedeemableInvite,
  getConnectionByBaseUrl,
  getConnectionView,
  getFederationSettings,
  itemMatchesView,
  listConnectionViews,
  outboxAfter,
  outboxHead,
  redeemInvite,
  shelfPage,
  stillShared,
} from '../db/federation';
import { getItem, getSiteSettings, namedReviews, tagsForItem, wantedAmong } from '../db/queries';
import { isGoalKind, type ActivityKind, type Connection, type NotificationKind } from '../db/schema';
import type { AppEnv } from '../env';
import { page } from '../views/layout';
import {
  ACCEPTS,
  DESCRIPTOR_PATH,
  FEED_PAGE_SIZE,
  FEED_READ_WINDOW_MS,
  FEED_READS_PER_WINDOW,
  FEED_RESPONSE_BUDGET_BYTES,
  INVITE_PATH,
  MAX_ACTIVE_CONNECTIONS,
  MAX_CHECK_BODY_BYTES,
  MAX_CHECK_IDS,
  MAX_CONNECT_BODY_BYTES,
  MAX_INBOX_BODY_BYTES,
  MEMBER_ACTIVITY_BASE,
  MAX_PUSHES_PER_DAY,
  OUTBOX_PAGE_SIZE,
  OUTBOX_RESPONSE_BUDGET_BYTES,
  PROTOCOL,
  PROTOCOL_VERSION,
  SHARED_VIEWS_CACHE_MS,
  VOLUME_WINDOW_DAYS,
} from './config';
import { fetchDescriptor, parseJson, readLimited, type Descriptor } from './http';
import { receiveDirected } from './directed';
import { isId, itemStamp, jsonBytes, toFeedGoal, toFeedItem, toItemDetail, toShelfItem, type FeedEntry } from './items';
import { importPublicKey, loadIdentity } from './keys';
import { isDirected, parseConnectRequest, parseInboxMessage } from './messages';
import { forgetPeer, peerByKeyid, rememberPeer } from './peers';
import { parseSignature, verifyRequest } from './signatures';
import { hashToken } from './tokens';

const federation = new Hono<AppEnv>();

// ---------- who we are ----------

federation.get(DESCRIPTOR_PATH, async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound();
  const settings = await getFederationSettings(c.env.DB);
  if (!settings) return c.notFound();
  const descriptor: Descriptor = {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    name: settings.householdName,
    url: settings.baseUrl,
    publicKey: identity.publicJwk,
    // §16 #58: what this inbox takes beyond version 1 — a household checks before sending one
    accepts: [...ACCEPTS],
  };
  return c.json(descriptor, 200, { 'cache-control': 'public, max-age=300' });
});

// An invitation link is `<origin>/connect#<token>`. The token stays in the fragment, which never
// reaches a server, so this page only explains what to do with the link.
federation.get(INVITE_PATH, async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound();
  const settings = await getFederationSettings(c.env.DB);
  if (!settings) return c.notFound();
  return page(
    c,
    'Invitation',
    <article class="panel form-card">
      <h1>An invitation to connect</h1>
      <p>
        This link is an invitation from <strong>{settings.householdName}</strong> to connect their Nalanda library with
        yours.
      </p>
      <p>
        It isn't meant to be opened here. Copy the whole link, open <strong>your own</strong> Nalanda, go to Connections,
        and paste it into “Accept an invitation”.
      </p>
      <p class="muted">Nothing about this library is visible from this page.</p>
    </article>,
  );
});

// ---------- redeeming an invitation ----------

federation.post('/federation/connect', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound();

  // Everything before the invitation lookup is local work: no database access, no outbound fetch.
  const sig = parseSignature(c.req.raw.headers);
  if (!sig) return c.json({ error: 'unsigned request' }, 401);
  const raw = await readLimited(c.req.raw, MAX_CONNECT_BODY_BYTES);
  if (!raw) return c.json({ error: 'request too large' }, 413);
  const request = parseConnectRequest(parseJson(raw));
  if (!request || request.actor !== sig.keyid) return c.json({ error: 'malformed request' }, 400);
  // The key arrives in the body: this proves the sender holds it, not yet who they are.
  const theirKey = await importPublicKey(request.publicKey);
  if (!theirKey) return c.json({ error: 'malformed request' }, 400);
  const verdict = await verifyRequest(
    { method: 'POST', url: c.req.url, headers: c.req.raw.headers, body: raw },
    sig,
    theirKey,
  );
  if (!verdict.ok) return c.json({ error: 'signature rejected' }, 401);

  const settings = await getFederationSettings(c.env.DB);
  if (!settings) return c.notFound();
  // No per-IP throttle, unlike logins. A token is 256 random bits, so guessing gets nowhere, and a peer's
  // request comes from its Worker: Cloudflare gives every Worker on another zone the same CF-Connecting-IP,
  // so a per-IP limit would let one misbehaving peer lock every household out. A failed redemption costs
  // two indexed reads and writes nothing.
  const invite = await findRedeemableInvite(c.env.DB, await hashToken(request.token));
  if (!invite) return c.json({ error: 'invitation not found' }, 404);
  if (request.actor === settings.baseUrl) return c.json({ error: 'an instance cannot connect to itself' }, 422);
  if (await getConnectionByBaseUrl(c.env.DB, request.actor)) return c.json({ error: 'already connected' }, 409);
  if ((await countConnections(c.env.DB)) >= MAX_ACTIVE_CONNECTIONS) {
    return c.json({ error: 'connection limit reached' }, 409);
  }

  // The one outbound fetch, made only for a valid invitation: proves they control the address they
  // claim, by that address serving the same key that signed this request.
  const descriptor = await fetchDescriptor(request.actor);
  if (!descriptor || descriptor.publicKey.x !== request.publicKey.x) {
    return c.json({ error: 'could not confirm that this address serves this key' }, 422);
  }
  const outcome = await redeemInvite(
    c.env.DB,
    invite.id,
    { baseUrl: request.actor, householdName: descriptor.name, publicKey: JSON.stringify(descriptor.publicKey) },
    MAX_ACTIVE_CONNECTIONS,
    // the one that needs someone here to act: they're waiting on a confirmation from us
    { kind: 'connection_request', householdName: descriptor.name, href: '/connections' },
  );
  switch (outcome) {
    case 'pending':
      return c.json({ status: 'pending' }, 202);
    case 'invitation gone':
      return c.json({ error: 'invitation not found' }, 404);
    case 'limit reached':
      return c.json({ error: 'connection limit reached' }, 409);
    case 'already connected':
      return c.json({ error: 'already connected' }, 409);
  }
});

// ---------- what connections may read (phase 2) ----------

type FromConnection = { connection: Connection; body: Uint8Array };

// Each read costs D1 reads, so a connection gets a bounded number per window in each isolate. An honest one
// pulls a couple of subscriptions at most every quarter hour, far below it. Keyed only after a signature
// verifies, so strangers can't fill it.
const readCounts = new Map<string, { n: number; resets: number }>();

function withinReadRate(keyid: string): boolean {
  const now = Date.now();
  const entry = readCounts.get(keyid);
  if (!entry || entry.resets <= now) {
    if (readCounts.size >= 200) readCounts.clear();
    readCounts.set(keyid, { n: 1, resets: now + FEED_READ_WINDOW_MS });
    return true;
  }
  entry.n += 1;
  return entry.n <= FEED_READS_PER_WINDOW;
}

/**
 * A request signed by an active connection — or the response turning it away. Unsigned requests are
 * refused before the database is touched, and a connection still waiting for confirmation reads nothing.
 */
async function fromActiveConnection(c: Context<AppEnv>, maxBodyBytes: number): Promise<FromConnection | Response> {
  const sig = parseSignature(c.req.raw.headers);
  if (!sig) return c.json({ error: 'unsigned request' }, 401);
  const peer = await peerByKeyid(c.env.DB, sig.keyid);
  if (!peer || peer.connection.status !== 'active') return c.json({ error: 'unknown sender' }, 401);
  const body = c.req.method === 'POST' ? await readLimited(c.req.raw, maxBodyBytes) : new Uint8Array();
  if (!body) return c.json({ error: 'request too large' }, 413);
  const verdict = await verifyRequest({ method: c.req.method, url: c.req.url, headers: c.req.raw.headers, body }, sig, peer.key);
  if (!verdict.ok) return c.json({ error: 'signature rejected' }, 401);
  rememberPeer(peer);
  if (!withinReadRate(peer.connection.baseUrl)) return c.json({ error: 'too many requests' }, 429);
  return { connection: peer.connection, body };
}

const digits = (raw: string | undefined): number | null => (raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null);

// The shared views with their counts and volume: a handful of queries, reused briefly by one isolate.
let sharedViews: { json: string; expires: number } | null = null;

/** Called when a view is added or removed, so this isolate serves the change at once. */
export function clearSharedViewsCache(): void {
  sharedViews = null;
}

/** The views shared with connections, each with its size and how busy it has been — for subscribing. */
federation.get('/federation/views', async (c) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const from = await fromActiveConnection(c, 0);
  if (from instanceof Response) return from;
  if (!(await getFederationSettings(c.env.DB))) return c.notFound();
  if (!sharedViews || sharedViews.expires <= Date.now()) {
    const views = await listConnectionViews(c.env.DB);
    const sizes = await describeViews(c.env.DB, views, VOLUME_WINDOW_DAYS);
    const described = views.map((view, i) => ({
      id: view.id,
      name: view.name,
      itemCount: sizes[i]!.itemCount,
      recent: { days: VOLUME_WINDOW_DAYS, activities: sizes[i]!.activities, bytes: sizes[i]!.bytes },
    }));
    sharedViews = { json: JSON.stringify({ views: described }), expires: Date.now() + SHARED_VIEWS_CACHE_MS };
  }
  return c.body(sharedViews.json, 200, { 'content-type': 'application/json' });
});

/**
 * Activity in a view, at most FEED_PAGE_SIZE entries within FEED_RESPONSE_BUDGET_BYTES. After a cursor the
 * oldest come first and `latest` is the last one sent, with `more` when others wait; a new subscriber gets
 * the newest page and a cursor at its newest entry. `latest` only ever names activity in the view, so the
 * cursor can't reveal what happens outside it.
 */
federation.get('/federation/feed', async (c) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const from = await fromActiveConnection(c, 0);
  if (from instanceof Response) return from;
  if (!(await getFederationSettings(c.env.DB))) return c.notFound();
  const viewId = digits(c.req.query('view'));
  const since = digits(c.req.query('since') ?? '0');
  if (!viewId || since === null) return c.json({ error: 'malformed request' }, 400);
  const view = await getConnectionView(c.env.DB, viewId);
  if (!view) return c.json({ error: 'no such view' }, 404);

  // §16 #45: with names switched on, the per-person stream; off, the household's, exactly as before. Decided now, on
  // every pull, so switching off stops names reaching anyone from the next pull on.
  // Goals (§16 #49) ride in the per-person stream only, and only while the household shares them too.
  const { namesToConnections, goalsToConnections } = await getSiteSettings(c.env.DB);
  const { fromStart, rows } = namesToConnections
    ? await memberActivityInView(c.env.DB, view, since, FEED_PAGE_SIZE + 1, goalsToConnections)
    : await activityInView(c.env.DB, view, since, FEED_PAGE_SIZE + 1);
  const entries: FeedEntry[] = [];
  let bytes = 0;
  const stamps = new Map<number, string>();
  for (const row of rows) if (row.item && !stamps.has(row.item.id)) stamps.set(row.item.id, await itemStamp(row.item));
  // §16 #53: which of these the household wants and hasn't got — a boolean on each entry, never whose
  const wanted = await wantedAmong(c.env.DB, [...new Set(rows.flatMap((r) => (r.item && r.item.copies === 0 ? [r.item.id] : [])))]);
  for (const row of rows.slice(0, FEED_PAGE_SIZE)) {
    const entry = feedEntryOf(row, stamps, wanted);
    const size = jsonBytes(entry).bytes;
    if (entries.length > 0 && bytes + size > FEED_RESPONSE_BUDGET_BYTES) break;
    entries.push(entry);
    bytes += size;
  }
  // A first page runs newest by date, so its highest id can be anywhere in it; later pages run by id.
  const latest = fromStart ? Math.max(0, ...entries.map((e) => e.id)) : (entries[entries.length - 1]?.id ?? since);
  return c.json({ view: view.id, latest, more: !fromStart && rows.length > entries.length, entries });
});

/**
 * One row of either stream as it goes out. A goal entry (§16 #49) carries `goal` and no item — memberStillShows lets
 * one through only with its goal and its member's display name, so both are there; every other entry is an item's.
 */
function feedEntryOf(row: SharedActivity | MemberActivity, stamps: Map<number, string>, wanted: Set<number>): FeedEntry {
  if ('goal' in row && isGoalKind(row.kind) && row.goal) {
    return { id: row.id, kind: row.kind, published: row.at, goal: toFeedGoal(row.by ?? '', row.goal.year, row.goal.target, row.goal.count) };
  }
  const item = row.item!;
  const kind = row.kind as ActivityKind;
  const person = 'by' in row ? row : undefined;
  return {
    id: row.id,
    kind,
    published: row.at,
    item: toFeedItem(item, kind, stamps.get(item.id)!, row.progressPage, row.readsBefore, person, wanted.has(item.id)),
  };
}

/**
 * The removal check (docs/proposals/connections.md §8): which of the caller's stored entries this
 * household no longer shares. Nothing records what was sent to whom — validity is worked out now.
 */
federation.post('/federation/feed/check', async (c) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const from = await fromActiveConnection(c, MAX_CHECK_BODY_BYTES);
  if (from instanceof Response) return from;
  if (!(await getFederationSettings(c.env.DB))) return c.notFound();
  const request = parseJson(from.body) as { view?: unknown; ids?: unknown } | null;
  const viewId = request?.view;
  const ids = request?.ids;
  if (!isId(viewId) || !Array.isArray(ids) || ids.length > MAX_CHECK_IDS || !ids.every(isId)) {
    return c.json({ error: 'malformed request' }, 400);
  }
  const asked = [...new Set(ids)];
  const view = await getConnectionView(c.env.DB, viewId);
  if (!view) return c.json({ invalid: asked, viewGone: true });
  // One stream is valid at a time (§16 #45): the household's with names off, checked as ever; the per-person one (ids
  // past MEMBER_ACTIVITY_BASE) with names on. Switching either way withdraws what was sent from the other at the next
  // check — named entries once names go off, and the household's once they're on, so no one sees an event twice.
  // Goal entries (§16 #49) are per-person entries: withdrawn with the rest once names go off, and on their own once goals do.
  const { namesToConnections, goalsToConnections } = await getSiteSettings(c.env.DB);
  const [valid, validMember] = await Promise.all([
    namesToConnections ? Promise.resolve(new Set<number>()) : stillShared(c.env.DB, view, asked.filter((id) => id < MEMBER_ACTIVITY_BASE)),
    namesToConnections
      ? stillSharedMember(c.env.DB, view, asked.filter((id) => id >= MEMBER_ACTIVITY_BASE), goalsToConnections)
      : Promise.resolve(new Set<number>()),
  ]);
  return c.json({ invalid: asked.filter((id) => !valid.has(id) && !validMember.has(id)), viewGone: false });
});

/**
 * Messages this household addressed to the caller, after its cursor, oldest first (docs/proposals/
 * connections.md §8). The fallback for pushes that didn't arrive: only that connection's messages, ever.
 */
federation.get('/federation/outbox', async (c) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const from = await fromActiveConnection(c, 0);
  if (from instanceof Response) return from;
  if (!(await getFederationSettings(c.env.DB))) return c.notFound();
  const since = digits(c.req.query('since') ?? '0');
  if (since === null) return c.json({ error: 'malformed request' }, 400);

  // A cursor past the end came from before a restore on this side: start again. Receiving is idempotent.
  const after = since > (await outboxHead(c.env.DB, from.connection.id)) ? 0 : since;
  const rows = await outboxAfter(c.env.DB, from.connection.id, after, OUTBOX_PAGE_SIZE + 1);
  const messages: Array<{ seq: number; message: unknown }> = [];
  let bytes = 0;
  for (const row of rows.slice(0, OUTBOX_PAGE_SIZE)) {
    const size = new TextEncoder().encode(row.message).byteLength;
    if (messages.length > 0 && bytes + size > OUTBOX_RESPONSE_BUDGET_BYTES) break;
    messages.push({ seq: row.seq, message: JSON.parse(row.message) });
    bytes += size;
  }
  const last = messages[messages.length - 1];
  return c.json({ latest: last?.seq ?? after, more: rows.length > messages.length, messages });
});

// ---------- shelves, read live by connections (phase 4) ----------

/** One page of a connection view, in the view's own order, with whether a copy of each book is free — never who has it. */
federation.get('/federation/shelf', async (c) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const from = await fromActiveConnection(c, 0);
  if (from instanceof Response) return from;
  if (!(await getFederationSettings(c.env.DB))) return c.notFound();
  const viewId = digits(c.req.query('view'));
  const pageNum = digits(c.req.query('page') ?? '1');
  if (!viewId || !pageNum) return c.json({ error: 'malformed request' }, 400);
  const view = await getConnectionView(c.env.DB, viewId);
  if (!view) return c.json({ error: 'no such view' }, 404);
  const shelf = await shelfPage(c.env.DB, view, pageNum);
  const [free, wanted] = await Promise.all([
    availability(c.env.DB, shelf.items),
    wantedAmong(c.env.DB, shelf.items.filter((i) => i.copies === 0).map((i) => i.id)),
  ]);
  const stamps = await Promise.all(shelf.items.map((item) => itemStamp(item)));
  return c.json({
    view: { id: view.id, name: view.name },
    total: shelf.total,
    page: shelf.page,
    pages: shelf.pages,
    items: shelf.items.map((item, i) => toShelfItem(item, free.get(item.id) ?? false, stamps[i]!, wanted.has(item.id))),
  });
});

/** One item of a connection view in full, for its page — only while it is inside that view. */
federation.get('/federation/item', async (c) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const from = await fromActiveConnection(c, 0);
  if (from instanceof Response) return from;
  if (!(await getFederationSettings(c.env.DB))) return c.notFound();
  const viewId = digits(c.req.query('view'));
  const itemId = digits(c.req.query('id'));
  if (!viewId || !itemId) return c.json({ error: 'malformed request' }, 400);
  const [view, item] = await Promise.all([getConnectionView(c.env.DB, viewId), getItem(c.env.DB, itemId)]);
  if (!view || !item || !itemMatchesView(view, item)) return c.json({ error: 'no such item' }, 404);
  const [free, tags, settings, wanted] = await Promise.all([
    availability(c.env.DB, [item]),
    tagsForItem(c.env.DB, item.id),
    getSiteSettings(c.env.DB),
    item.copies === 0 ? wantedAmong(c.env.DB, [item.id]) : Promise.resolve(new Set<number>()),
  ]);
  // §16 #45: everyone's rating and review by display name, only while names are switched on for connections
  const reviews = settings.namesToConnections ? await namedReviews(c.env.DB, item.id) : undefined;
  return c.json(toItemDetail(item, free.get(item.id) ?? false, tags, await itemStamp(item), reviews, wanted.has(item.id)));
});

// ---------- messages from connected instances ----------

federation.post('/federation/inbox', async (c) => {
  const identity = await loadIdentity(c.env.FEDERATION_PRIVATE_KEY);
  if (!identity) return c.notFound();
  const sig = parseSignature(c.req.raw.headers);
  if (!sig) return c.json({ error: 'unsigned request' }, 401); // turned away without touching the database
  const peer = await peerByKeyid(c.env.DB, sig.keyid);
  if (!peer) return c.json({ error: 'unknown sender' }, 401);
  const raw = await readLimited(c.req.raw, MAX_INBOX_BODY_BYTES);
  if (!raw) return c.json({ error: 'request too large' }, 413);
  const verdict = await verifyRequest(
    { method: 'POST', url: c.req.url, headers: c.req.raw.headers, body: raw },
    sig,
    peer.key,
  );
  if (!verdict.ok) return c.json({ error: 'signature rejected' }, 401);
  rememberPeer(peer);
  const message = parseInboxMessage(parseJson(raw));
  if (!message || message.actor !== peer.connection.baseUrl) return c.json({ error: 'malformed message' }, 400);

  // Changing state never trusts the cache: re-read the connection, and act only if it still carries the
  // key that signed. A household removed a minute ago can't reach whatever connection came after it.
  const connection = await getConnectionByBaseUrl(c.env.DB, peer.connection.baseUrl);
  if (!connection || connection.publicKey !== peer.connection.publicKey) {
    forgetPeer(peer.connection.baseUrl);
    return c.json({ error: 'unknown sender' }, 401);
  }

  // What each state accepts. Anything else is refused before a single write, so a household that was
  // never confirmed — someone holding a leaked invitation, say — can't spend this instance's D1 allowance.
  switch (message.type) {
    case 'ConnectAccept':
      if (connection.status === 'active') return c.json({ status: 'active' }); // a repeat: nothing to do
      if (connection.status !== 'awaiting_them') return c.json({ error: 'no request of ours to accept' }, 409);
      break;
    case 'ConnectDecline':
      // From active too: they may have confirmed and then declined after our reply to them was lost.
      if (connection.status === 'awaiting_us') return c.json({ error: 'no request of ours to decline' }, 409);
      break;
    case 'Disconnect':
      break; // in any state: for a household still waiting on us, this withdraws their request
    default: // comments and borrowing pass only between connected households
      if (connection.status !== 'active') return c.json({ error: 'not connected' }, 409);
      break;
  }
  if (!(await countPush(c.env.DB, connection.id, MAX_PUSHES_PER_DAY))) {
    return c.json({ error: 'daily message limit reached' }, 429);
  }
  if (isDirected(message)) {
    // Idempotent by activity id, so no replay record: the same message may arrive again from their outbox anyway.
    const settings = await getFederationSettings(c.env.DB);
    if (!settings) return c.notFound();
    const outcome = await receiveDirected(c.env.DB, settings, connection, message);
    return c.json(outcome.body, outcome.status);
  }
  forgetPeer(connection.baseUrl);
  // The effect, its notification and the replay marker land together, so a repeat of this message changes
  // nothing and notifies nothing, and a failure part way leaves the message new for their retry.
  const who = connection.householdName;
  const apply = (change: 'activate' | 'delete', kind: NotificationKind) =>
    applyConnectionMessage(c.env.DB, message.id, connection.id, change, { kind, householdName: who, href: '/connections' });
  switch (message.type) {
    case 'ConnectAccept':
      if (!(await apply('activate', 'connection_accepted'))) return c.json({ status: 'already processed' });
      return c.json({ status: 'active' });
    case 'ConnectDecline':
      if (!(await apply('delete', 'connection_declined'))) return c.json({ status: 'already processed' });
      return c.json({ status: 'declined' });
    case 'Disconnect': {
      // What a Disconnect means depends on where it found us: a household still waiting on us takes back its
      // request; one we asked, that never confirmed, has in effect declined; only an active one disconnects.
      const kind =
        connection.status === 'awaiting_us'
          ? 'connection_withdrawn'
          : connection.status === 'awaiting_them'
            ? 'connection_declined'
            : 'disconnected';
      if (!(await apply('delete', kind))) return c.json({ status: 'already processed' });
      return c.json({ status: 'disconnected' });
    }
  }
});

export default federation;
