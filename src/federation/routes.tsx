// Public endpoints for connections between instances (docs/proposals/connections.md §5, §6, §14).
// Mounted before the session middleware: peers authenticate by signature, not by cookie. Every
// route here 404s unless this instance has a federation key, and all but the key check also need
// a household name to have been saved.
import { Hono } from 'hono';
import {
  activateConnection,
  countConnections,
  countPush,
  deleteConnection,
  findRedeemableInvite,
  getConnectionByBaseUrl,
  getFederationSettings,
  markActivitySeen,
  redeemInvite,
} from '../db/federation';
import type { AppEnv } from '../env';
import { page } from '../views/layout';
import {
  DESCRIPTOR_PATH,
  INVITE_PATH,
  MAX_ACTIVE_CONNECTIONS,
  MAX_CONNECT_BODY_BYTES,
  MAX_INBOX_BODY_BYTES,
  MAX_PUSHES_PER_DAY,
  PROTOCOL,
  PROTOCOL_VERSION,
} from './config';
import { fetchDescriptor, parseJson, readLimited, type Descriptor } from './http';
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
