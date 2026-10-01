// Per-isolate cache of connected instances' keys (docs/proposals/connections.md §6), so a signed
// request from a peer doesn't cost a key import and a row read every time. Only peers whose signature
// has just verified are cached — caching every lookup would let anyone fill memory, or warm the cache
// with a row they never proved they own.
//
// A cached row may be up to a minute old, and it is trusted for the key alone. Whether the connection
// still stands is read fresh on every request: a reader checks `connections.status` (one indexed read,
// fromActiveConnection in ./routes.tsx), so a disconnect handled on any isolate takes effect at once on
// every other — not after this cache's minute; anything that changes state re-reads the whole connection
// and acts only if it still carries the key that signed (see /federation/inbox).
import { getConnectionByBaseUrl } from '../db/federation';
import type { Connection } from '../db/schema';
import { importPublicKey } from './keys';

const TTL_MS = 60_000;
const MAX_ENTRIES = 100;

export type Peer = { connection: Connection; key: CryptoKey };
const cache = new Map<string, Peer & { expires: number }>();

/**
 * The connection a key id names, with its imported key — from this isolate's cache, or the database. `fromCache`
 * says which: a cached row may be a minute old, so a caller that needs the connection's current state reads it.
 */
export async function peerByKeyid(d1: D1Database, keyid: string): Promise<(Peer & { fromCache: boolean }) | null> {
  const hit = cache.get(keyid);
  if (hit && hit.expires > Date.now()) return { connection: hit.connection, key: hit.key, fromCache: true };
  cache.delete(keyid);

  const connection = await getConnectionByBaseUrl(d1, keyid);
  if (!connection) return null;
  let jwk: unknown;
  try {
    jwk = JSON.parse(connection.publicKey);
  } catch {
    return null;
  }
  const key = await importPublicKey(jwk);
  return key ? { connection, key, fromCache: false } : null;
}

/** Caches a peer once a request signed by it has verified. */
export function rememberPeer(peer: Peer): void {
  const keyid = peer.connection.baseUrl;
  if (cache.has(keyid)) return;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(keyid, { connection: peer.connection, key: peer.key, expires: Date.now() + TTL_MS });
}

/** Drops a peer from this isolate's cache after its connection changed or was removed. */
export function forgetPeer(baseUrl: string): void {
  cache.delete(baseUrl);
}
