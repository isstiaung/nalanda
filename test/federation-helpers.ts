// Shared by the connections specs from phase 2 on. The instance under test is A, at
// https://a.example. Tests play the other household: they answer A's outbound requests through a
// fetch stub, and sign their own requests with their own key. Each peer gets a unique address,
// because A caches peer keys per isolate and that cache outlives the per-test database reset.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import { createConnection, saveFederationSettings } from '../src/db/federation';
import { createUser } from '../src/db/queries';
import type { ConnectionStatus } from '../src/db/schema';
import type { Bindings } from '../src/env';
import type { PublicJwk } from '../src/federation/keys';
import { parseSignature, signRequest, verifyRequest } from '../src/federation/signatures';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth';
import app from '../src/index';

export const A = { url: 'https://a.example', name: 'Hillside library' };
const ED25519 = { name: 'Ed25519' } as const;
const enc = new TextEncoder();
export const uid = () => crypto.randomUUID().slice(0, 8);

export type Keys = { pair: CryptoKeyPair; publicJwk: PublicJwk; secret: string };
export type Peer = { url: string; name: string; pair: CryptoKeyPair; publicJwk: PublicJwk };

export async function makeKeys(): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    pair,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x! },
    secret: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }),
  };
}

export async function makePeer(name: string): Promise<Peer> {
  const { pair, publicJwk } = await makeKeys();
  return { url: `https://peer-${uid()}.example`, name, pair, publicJwk };
}

export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

/** SQLite's datetime('now') format, `minutes` ago. */
export const sqlAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);

// ---------- A's outbound requests, answered by the test ----------

export type Outbound = { url: string; method: string; headers: Headers; body: Uint8Array };

/** Stubs fetch for A's outbound requests. The returned list fills as A makes them. */
export function answerOutbound(handler: (req: Outbound) => Response | Promise<Response>): Outbound[] {
  const log: Outbound[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const req: Outbound = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
    };
    log.push(req);
    return handler(req);
  });
  return log;
}

export async function signedBy(key: CryptoKey, req: Outbound): Promise<boolean> {
  const sig = parseSignature(req.headers);
  if (!sig) return false;
  return (await verifyRequest({ method: req.method, url: req.url, headers: req.headers, body: req.body }, sig, key)).ok;
}

// ---------- requests to A ----------

async function send(request: Request, bindings: Bindings): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx); // work A defers until after its response has finished too
  return res;
}

export async function sessionCookie(role: 'admin' | 'member'): Promise<string> {
  const user = await createUser(env.DB, {
    username: `u-${uid()}`,
    passwordHash: 'pbkdf2$100000$x$y',
    role,
    mustChangePassword: false,
  });
  return `${SESSION_COOKIE}=${await createSessionToken(env.SESSION_SECRET, user.id, Math.floor(Date.now() / 1000))}`;
}

/** Requests to A, running with these bindings — pass `env` itself for an instance without a federation key. */
export function instanceA(bindings: Bindings) {
  return {
    get: (path: string, cookie?: string) =>
      send(new Request(`${A.url}${path}`, { headers: cookie ? { cookie } : {} }), bindings),

    postForm: (path: string, fields: Record<string, string>, cookie: string) =>
      send(
        new Request(`${A.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', cookie },
          body: new URLSearchParams(fields).toString(),
        }),
        bindings,
      ),

    signedGet: async (path: string, from: Peer) => {
      const url = `${A.url}${path}`;
      const headers = await signRequest({ method: 'GET', url, keyid: from.url, privateKey: from.pair.privateKey });
      return send(new Request(url, { headers }), bindings);
    },

    signedPost: async (path: string, from: Peer, payload: unknown) => {
      const url = `${A.url}${path}`;
      const body = enc.encode(JSON.stringify(payload));
      const headers = await signRequest({ method: 'POST', url, body, keyid: from.url, privateKey: from.pair.privateKey });
      return send(new Request(url, { method: 'POST', body, headers: { ...headers, 'content-type': 'application/json' } }), bindings);
    },
  };
}

export const setUpA = () => saveFederationSettings(env.DB, { householdName: A.name, baseUrl: A.url });

export const connectPeer = (peer: Peer, status: ConnectionStatus = 'active') =>
  createConnection(env.DB, {
    baseUrl: peer.url,
    householdName: peer.name,
    publicKey: JSON.stringify(peer.publicJwk),
    status,
  });
