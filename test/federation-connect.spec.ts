// Route-level: phase 1 of connections between instances — descriptor, invitations, the connect
// handshake, confirmation and inbox messages (docs/proposals/connections.md §5, §6).
//
// The instance under test is A, at https://a.example. The test plays the other household, B:
// it answers A's outbound requests through a fetch stub, and signs its own requests with its
// own key. Each peer gets a unique address, because A caches peer keys per isolate and that
// cache outlives the per-test database reset.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConnection,
  createInvite,
  getConnection,
  getConnectionByBaseUrl,
  getFederationSettings,
  listInvites,
  saveFederationSettings,
} from '../src/db/federation';
import { createUser } from '../src/db/queries';
import type { Bindings } from '../src/env';
import { importPublicKey, type PublicJwk } from '../src/federation/keys';
import { connectRequest, inboxMessage } from '../src/federation/messages';
import { parseSignature, signRequest, verifyRequest } from '../src/federation/signatures';
import { hashToken, newInviteToken } from '../src/federation/tokens';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

const A = { url: 'https://a.example', name: 'Hillside library' };
const ED25519 = { name: 'Ed25519' } as const;
const enc = new TextEncoder();
const uid = () => crypto.randomUUID().slice(0, 8);

type Keys = { pair: CryptoKeyPair; publicJwk: PublicJwk; secret: string };
type Peer = { url: string; name: string; pair: CryptoKeyPair; publicJwk: PublicJwk };

async function makeKeys(): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    pair,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x! },
    secret: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }),
  };
}

async function makePeer(name: string): Promise<Peer> {
  const { pair, publicJwk } = await makeKeys();
  return { url: `https://peer-${uid()}.example`, name, pair, publicJwk };
}

const descriptorOf = (peer: Peer, overrides: Record<string, unknown> = {}) => ({
  protocol: 'nalanda-connections',
  version: 1,
  name: peer.name,
  url: peer.url,
  publicKey: peer.publicJwk,
  ...overrides,
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

// ---------- A's outbound requests, answered by the test ----------

type Outbound = { url: string; method: string; headers: Headers; body: Uint8Array };
let outbound: Outbound[] = [];

function answerOutbound(handler: (req: Outbound) => Response | Promise<Response>) {
  outbound = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const req: Outbound = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    };
    outbound.push(req);
    return handler(req);
  });
}

async function signedBy(key: CryptoKey | null, req: Outbound): Promise<boolean> {
  const sig = parseSignature(req.headers);
  if (!key || !sig) return false;
  return (await verifyRequest({ method: req.method, url: req.url, headers: req.headers, body: req.body }, sig, key)).ok;
}

afterEach(() => {
  outbound = [];
  vi.unstubAllGlobals();
});

// ---------- requests to A ----------

let keysA: Keys;
let enabled: Bindings;

beforeEach(async () => {
  keysA = await makeKeys();
  enabled = { ...env, FEDERATION_PRIVATE_KEY: keysA.secret };
});

async function send(request: Request, bindings: Bindings = enabled): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function newUser(role: 'admin' | 'member') {
  return createUser(env.DB, {
    username: `u-${uid()}`,
    passwordHash: 'pbkdf2$100000$x$y',
    role,
    mustChangePassword: false,
  });
}

async function sessionCookie(role: 'admin' | 'member'): Promise<string> {
  const user = await newUser(role);
  return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000))}`;
}

const get = (path: string, cookie?: string, bindings?: Bindings) =>
  send(new Request(`${A.url}${path}`, { headers: cookie ? { cookie } : {} }), bindings);

const postForm = (path: string, fields: Record<string, string>, cookie: string, origin = A.url) =>
  send(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', cookie },
      body: new URLSearchParams(fields).toString(),
    }),
  );

async function signedPost(
  path: string,
  from: Peer,
  payload: unknown,
  opts: { created?: number; signWith?: CryptoKey } = {},
): Promise<Response> {
  const url = `${A.url}${path}`;
  const body = enc.encode(JSON.stringify(payload));
  const headers = await signRequest({
    method: 'POST',
    url,
    body,
    keyid: from.url,
    privateKey: opts.signWith ?? from.pair.privateKey,
    created: opts.created,
  });
  return send(
    new Request(url, {
      method: 'POST',
      body,
      headers: { ...headers, 'content-type': 'application/json' },
    }),
  );
}

const setUpA = () => saveFederationSettings(env.DB, { householdName: A.name, baseUrl: A.url });

// ---------- tests ----------

describe('without a federation key, nothing new exists', () => {
  it('404s every connections route and shows no Connections link', async () => {
    const admin = await sessionCookie('admin');
    expect((await get('/.well-known/nalanda', undefined, env)).status).toBe(404);
    expect((await get('/connect', undefined, env)).status).toBe(404);
    expect((await get('/connections', admin, env)).status).toBe(404);

    const peer = await makePeer('Riverbank library');
    for (const path of ['/federation/connect', '/federation/inbox']) {
      const url = `${A.url}${path}`;
      const body = enc.encode('{}');
      const headers = await signRequest({ method: 'POST', url, body, keyid: peer.url, privateKey: peer.pair.privateKey });
      expect((await send(new Request(url, { method: 'POST', body, headers }), env)).status).toBe(404);
    }
    expect(await (await get('/', admin, env)).text()).not.toContain('href="/connections"');
  });
});

describe('identity and setup', () => {
  it('serves no descriptor until the library has a name — then only the public half of the key', async () => {
    expect((await get('/.well-known/nalanda')).status).toBe(404);
    await setUpA();
    const res = await get('/.well-known/nalanda');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      protocol: 'nalanda-connections',
      version: 1,
      name: A.name,
      url: A.url,
      publicKey: keysA.publicJwk,
    });
    expect(JSON.stringify(body)).not.toContain('"d"');
  });

  it('explains an invitation link opened in a browser, without exposing anything', async () => {
    await setUpA();
    const html = await (await get('/connect')).text();
    expect(html).toContain('An invitation to connect');
    expect(html).toContain(A.name);
  });

  it('shows the Connections link and page to admins only', async () => {
    const admin = await sessionCookie('admin');
    const member = await sessionCookie('member');
    expect(await (await get('/', admin)).text()).toContain('href="/connections"');
    expect(await (await get('/', member)).text()).not.toContain('href="/connections"');
    expect((await get('/connections', admin)).status).toBe(200);
    expect((await get('/connections', member)).status).toBe(403);
  });

  it('saves the name with this origin as the address, and refuses plain http away from localhost', async () => {
    const admin = await sessionCookie('admin');
    const plain = await postForm('/connections/settings', { householdName: A.name }, admin, 'http://a.example');
    expect(await plain.text()).toContain('served over https');
    expect(await getFederationSettings(env.DB)).toBeNull();

    expect((await postForm('/connections/settings', { householdName: A.name }, admin)).status).toBe(302);
    expect(await getFederationSettings(env.DB)).toMatchObject({ householdName: A.name, baseUrl: A.url });
  });

  it('shows an invitation link exactly once, and stores only its hash', async () => {
    await setUpA();
    const admin = await sessionCookie('admin');
    const html = await (await postForm('/connections/invites', {}, admin)).text();
    const token = /https:\/\/a\.example\/connect#([A-Za-z0-9_-]{43})/.exec(html)?.[1];
    expect(token).toBeDefined();

    const invites = await listInvites(env.DB);
    expect(invites).toHaveLength(1);
    expect(invites[0]!.tokenHash).toBe(await hashToken(token!));
    expect(JSON.stringify(invites)).not.toContain(token!);
    expect(await (await get('/connections', admin)).text()).not.toContain(token!);
  });
});

describe('an invitation redeemed at /federation/connect', () => {
  let peer: Peer;
  let token: string;
  let inviteId: number;

  beforeEach(async () => {
    await setUpA();
    peer = await makePeer('Riverbank library');
    token = newInviteToken();
    const creator = await newUser('admin');
    inviteId = (await createInvite(env.DB, { tokenHash: await hashToken(token), createdBy: creator.id, ttlDays: 7 })).id;
  });

  const serveDescriptor = (descriptor: unknown) =>
    answerOutbound((req) =>
      req.url === `${peer.url}/.well-known/nalanda` ? json(descriptor) : new Response('not found', { status: 404 }),
    );
  const inviteUsed = async () => (await listInvites(env.DB))[0]?.usedAt ?? null;

  it('records a pending connection, named by their own descriptor, and uses the invitation up', async () => {
    serveDescriptor(descriptorOf(peer));
    const res = await signedPost(
      '/federation/connect',
      peer,
      connectRequest(peer.url, 'whatever they typed', peer.publicJwk, token),
    );
    expect(res.status).toBe(202);
    expect(await getConnectionByBaseUrl(env.DB, peer.url)).toMatchObject({
      status: 'awaiting_us',
      householdName: 'Riverbank library',
      inviteId,
    });
    expect(await inviteUsed()).not.toBeNull();
  });

  it('turns away a second use of the same invitation', async () => {
    serveDescriptor(descriptorOf(peer));
    await signedPost('/federation/connect', peer, connectRequest(peer.url, peer.name, peer.publicJwk, token));

    const other = await makePeer('Clifftop library');
    answerOutbound(() => json(descriptorOf(other)));
    const res = await signedPost('/federation/connect', other, connectRequest(other.url, other.name, other.publicJwk, token));
    expect(res.status).toBe(404);
    expect(await getConnectionByBaseUrl(env.DB, other.url)).toBeNull();
  });

  it('rejects an unsigned request before touching the invitation or fetching anything', async () => {
    serveDescriptor(descriptorOf(peer));
    const res = await send(
      new Request(`${A.url}/federation/connect`, {
        method: 'POST',
        body: JSON.stringify(connectRequest(peer.url, peer.name, peer.publicJwk, token)),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(401);
    expect(outbound).toHaveLength(0);
    expect(await inviteUsed()).toBeNull();
  });

  it('rejects a request signed by a different key than the one it presents', async () => {
    serveDescriptor(descriptorOf(peer));
    const impostor = await makeKeys();
    const res = await signedPost('/federation/connect', peer, connectRequest(peer.url, peer.name, peer.publicJwk, token), {
      signWith: impostor.pair.privateKey,
    });
    expect(res.status).toBe(401);
    expect(outbound).toHaveLength(0);
    expect(await inviteUsed()).toBeNull();
  });

  it('fetches nothing for an invitation that does not exist', async () => {
    serveDescriptor(descriptorOf(peer));
    const res = await signedPost(
      '/federation/connect',
      peer,
      connectRequest(peer.url, peer.name, peer.publicJwk, newInviteToken()),
    );
    expect(res.status).toBe(404);
    expect(outbound).toHaveLength(0);
  });

  it('keeps the invitation when their address does not serve the key that signed', async () => {
    const elsewhere = await makeKeys();
    serveDescriptor(descriptorOf(peer, { publicKey: elsewhere.publicJwk }));
    const res = await signedPost('/federation/connect', peer, connectRequest(peer.url, peer.name, peer.publicJwk, token));
    expect(res.status).toBe(422);
    expect(await getConnectionByBaseUrl(env.DB, peer.url)).toBeNull();
    expect(await inviteUsed()).toBeNull();
  });

  it('rejects a request whose actor is not the signing key id', async () => {
    serveDescriptor(descriptorOf(peer));
    const res = await signedPost(
      '/federation/connect',
      peer,
      connectRequest('https://someone-else.example', peer.name, peer.publicJwk, token),
    );
    expect(res.status).toBe(400);
  });

  // Peers' Workers share one CF-Connecting-IP, so a limit on failures would lock out every household.
  it('never locks out a real invitation, however many guesses come first', async () => {
    serveDescriptor(descriptorOf(peer));
    for (let i = 0; i < 20; i++) {
      const guess = await signedPost(
        '/federation/connect',
        peer,
        connectRequest(peer.url, peer.name, peer.publicJwk, newInviteToken()),
      );
      expect(guess.status).toBe(404);
    }
    const res = await signedPost('/federation/connect', peer, connectRequest(peer.url, peer.name, peer.publicJwk, token));
    expect(res.status).toBe(202);
  });
});

describe('confirming, and messages at /federation/inbox', () => {
  let peer: Peer;

  beforeEach(async () => {
    await setUpA();
    peer = await makePeer('Riverbank library');
  });

  const seedPeer = (status: 'awaiting_us' | 'awaiting_them' | 'active') =>
    createConnection(env.DB, {
      baseUrl: peer.url,
      householdName: peer.name,
      publicKey: JSON.stringify(peer.publicJwk),
      status,
    });

  it('confirms a request by sending them a signed acceptance, then marks it active', async () => {
    const row = await seedPeer('awaiting_us');
    const keyOfA = await importPublicKey(keysA.publicJwk);
    let verified = false;
    answerOutbound(async (req) => {
      verified = await signedBy(keyOfA, req);
      return json({ status: 'active' });
    });

    const res = await postForm(`/connections/${row.id}/confirm`, {}, await sessionCookie('admin'));
    expect(res.status).toBe(302);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.url).toBe(`${peer.url}/federation/inbox`);
    expect(verified).toBe(true);
    expect(decode(outbound[0]!.body)).toMatchObject({ type: 'ConnectAccept', actor: A.url });
    expect((await getConnection(env.DB, row.id))?.status).toBe('active');
  });

  it('leaves the request pending when they cannot be reached', async () => {
    const row = await seedPeer('awaiting_us');
    answerOutbound(() => {
      throw new TypeError('network unreachable');
    });
    const html = await (await postForm(`/connections/${row.id}/confirm`, {}, await sessionCookie('admin'))).text();
    expect(html).toContain('to confirm. Nothing changed');
    expect((await getConnection(env.DB, row.id))?.status).toBe('awaiting_us');
  });

  it('activates our request when their signed acceptance arrives', async () => {
    const row = await seedPeer('awaiting_them');
    const res = await signedPost('/federation/inbox', peer, inboxMessage('ConnectAccept', peer.url));
    expect(res.status).toBe(200);
    expect((await getConnection(env.DB, row.id))?.status).toBe('active');
  });

  it('turns away unsigned messages, unknown senders, stale signatures and mismatched actors', async () => {
    const row = await seedPeer('awaiting_them');
    const accept = inboxMessage('ConnectAccept', peer.url);

    const unsigned = await send(
      new Request(`${A.url}/federation/inbox`, { method: 'POST', body: JSON.stringify(accept) }),
    );
    expect(unsigned.status).toBe(401);

    const stranger = await makePeer('Clifftop library');
    expect((await signedPost('/federation/inbox', stranger, inboxMessage('ConnectAccept', stranger.url))).status).toBe(401);

    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    expect((await signedPost('/federation/inbox', peer, accept, { created: tenMinutesAgo })).status).toBe(401);

    expect(
      (await signedPost('/federation/inbox', peer, inboxMessage('ConnectAccept', 'https://someone-else.example'))).status,
    ).toBe(400);

    expect((await getConnection(env.DB, row.id))?.status).toBe('awaiting_them');
  });

  it('processes a message once — a replay changes nothing', async () => {
    await seedPeer('active');
    const disconnect = inboxMessage('Disconnect', peer.url);
    expect(await (await signedPost('/federation/inbox', peer, disconnect)).json()).toEqual({ status: 'disconnected' });
    expect(await getConnectionByBaseUrl(env.DB, peer.url)).toBeNull();

    await seedPeer('active'); // reconnected since
    expect(await (await signedPost('/federation/inbox', peer, disconnect)).json()).toEqual({
      status: 'already processed',
    });
    expect(await getConnectionByBaseUrl(env.DB, peer.url)).not.toBeNull();
  });
});

describe('accepting an invitation from the Connections page', () => {
  let peer: Peer;

  beforeEach(async () => {
    await setUpA();
    peer = await makePeer('Riverbank library');
  });

  it('sends a signed request carrying the token, and records that we are waiting for them', async () => {
    const token = newInviteToken();
    const keyOfA = await importPublicKey(keysA.publicJwk);
    let signedByA = false;
    let carried: Record<string, unknown> = {};
    answerOutbound(async (req) => {
      if (req.method === 'GET' && req.url === `${peer.url}/.well-known/nalanda`) return json(descriptorOf(peer));
      if (req.method === 'POST' && req.url === `${peer.url}/federation/connect`) {
        signedByA = await signedBy(keyOfA, req);
        carried = decode(req.body);
        return json({ status: 'pending' }, 202);
      }
      return new Response('unexpected request', { status: 500 });
    });

    const html = await (
      await postForm('/connections/redeem', { link: `${peer.url}/connect#${token}` }, await sessionCookie('admin'))
    ).text();
    expect(html).toContain('Request sent');
    expect(signedByA).toBe(true);
    expect(carried).toMatchObject({ type: 'ConnectRequest', actor: A.url, token, publicKey: keysA.publicJwk });
    expect(await getConnectionByBaseUrl(env.DB, peer.url)).toMatchObject({
      status: 'awaiting_them',
      householdName: peer.name,
    });
  });

  it('saves nothing when they refuse the invitation', async () => {
    answerOutbound((req) => (req.method === 'GET' ? json(descriptorOf(peer)) : json({ error: 'invitation not found' }, 404)));
    const html = await (
      await postForm('/connections/redeem', { link: `${peer.url}/connect#${newInviteToken()}` }, await sessionCookie('admin'))
    ).text();
    expect(html).toContain('already been used');
    expect(await getConnectionByBaseUrl(env.DB, peer.url)).toBeNull();
  });

  it('rejects something that is not an invitation link without contacting anyone', async () => {
    answerOutbound(() => json({}));
    const html = await (
      await postForm('/connections/redeem', { link: `${peer.url}/share/abc` }, await sessionCookie('admin'))
    ).text();
    expect(html).toContain('a Nalanda invitation link');
    expect(outbound).toHaveLength(0);
  });
});

describe('names that come from another server', () => {
  it('are escaped, and never placed inside an inline script handler', async () => {
    await setUpA();
    const hostile = `<img src=x onerror=alert(1)>'); alert('pwned`;
    await createConnection(env.DB, {
      baseUrl: `https://hostile-${uid()}.example`,
      householdName: hostile,
      publicKey: JSON.stringify((await makeKeys()).publicJwk),
      status: 'active',
    });
    const html = await (await get('/connections', await sessionCookie('admin'))).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    for (const handler of html.match(/onsubmit="[^"]*"/g) ?? []) expect(handler).not.toContain('pwned');
  });
});
