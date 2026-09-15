// Public endpoints for connections between instances (docs/proposals/connections.md §5, §6, §14).
// Mounted before the session middleware: peers authenticate by signature, not by cookie. Every
// route here 404s unless this instance has a federation key, and all but the key check also need
// a household name to have been saved.
import { Hono, type Context } from 'hono';
import {
  activateConnection,
  activityInView,
  countConnections,
  countItemsInView,
  countPush,
  deleteConnection,
  findRedeemableInvite,
  getConnectionByBaseUrl,
  getConnectionView,
  getFederationSettings,
  listConnectionViews,
  markActivitySeen,
  redeemInvite,
  stillShared,
  viewVolume,
} from '../db/federation';
import type { Connection } from '../db/schema';
import type { AppEnv } from '../env';
import { page } from '../views/layout';
import {
  DESCRIPTOR_PATH,
  FEED_PAGE_SIZE,
  FEED_RESPONSE_BUDGET_BYTES,
  INVITE_PATH,
  MAX_ACTIVE_CONNECTIONS,
  MAX_CHECK_BODY_BYTES,
  MAX_CHECK_IDS,
  MAX_CONNECT_BODY_BYTES,
  MAX_INBOX_BODY_BYTES,
  MAX_PUSHES_PER_DAY,
  PROTOCOL,
  PROTOCOL_VERSION,
  VOLUME_WINDOW_DAYS,
} from './config';
import { fetchDescriptor, parseJson, readLimited, type Descriptor } from './http';
import { isId, jsonBytes, toFeedItem, type FeedEntry } from './items';
import { importPublicKey, loadIdentity } from './keys';
import { parseConnectRequest, parseInboxMessage } from './messages';
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
  return { connection: peer.connection, body };
}

const digits = (raw: string | undefined): number | null => (raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : null);

/** The views shared with connections, each with its size and how busy it has been — for subscribing. */
federation.get('/federation/views', async (c) => {
  if (!(await loadIdentity(c.env.FEDERATION_PRIVATE_KEY))) return c.notFound();
  const from = await fromActiveConnection(c, 0);
  if (from instanceof Response) return from;
  if (!(await getFederationSettings(c.env.DB))) return c.notFound();
  const views = await listConnectionViews(c.env.DB);
  const described = await Promise.all(
    views.map(async (view) => ({
      id: view.id,
      name: view.name,
      itemCount: await countItemsInView(c.env.DB, view),
      recent: { days: VOLUME_WINDOW_DAYS, ...(await viewVolume(c.env.DB, view, VOLUME_WINDOW_DAYS)) },
    })),
  );
  return c.json({ views: described });
});

/**
 * Activity in a view since the caller's cursor, newest first. At most FEED_PAGE_SIZE entries within
 * FEED_RESPONSE_BUDGET_BYTES; when more happened, the newest are sent and `truncated` says so. `latest`
 * is the next cursor either way — a feed keeps up with the present rather than replaying a backlog.
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

  const { latest, rows } = await activityInView(c.env.DB, view, since, FEED_PAGE_SIZE + 1);
  const entries: FeedEntry[] = [];
  let bytes = 0;
  let truncated = rows.length > FEED_PAGE_SIZE;
  for (const row of rows.slice(0, FEED_PAGE_SIZE)) {
    const entry: FeedEntry = { id: row.id, kind: row.kind, published: row.at, item: toFeedItem(row.item) };
    const size = jsonBytes(entry).bytes;
    if (bytes + size > FEED_RESPONSE_BUDGET_BYTES) {
      truncated = true;
      break;
    }
    entries.push(entry);
    bytes += size;
  }
  return c.json({ view: view.id, latest, truncated, entries });
});

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
  const valid = await stillShared(c.env.DB, view, asked);
  return c.json({ invalid: asked.filter((id) => !valid.has(id)), viewGone: false });
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
  }
  if (!(await countPush(c.env.DB, connection.id, MAX_PUSHES_PER_DAY))) {
    return c.json({ error: 'daily message limit reached' }, 429);
  }
  if (!(await markActivitySeen(c.env.DB, message.id))) return c.json({ status: 'already processed' });

  forgetPeer(connection.baseUrl);
  switch (message.type) {
    case 'ConnectAccept':
      await activateConnection(c.env.DB, connection.id, 'awaiting_them');
      return c.json({ status: 'active' });
    case 'ConnectDecline':
      await deleteConnection(c.env.DB, connection.id);
      return c.json({ status: 'declined' });
    case 'Disconnect':
      await deleteConnection(c.env.DB, connection.id);
      return c.json({ status: 'disconnected' });
  }
});

export default federation;
