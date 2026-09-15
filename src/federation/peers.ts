// Per-isolate cache of connected instances' keys (docs/proposals/connections.md §6), so a signed
// request from a peer doesn't cost a database read every time. Only known peers are cached —
// caching misses would let anyone fill memory with made-up key ids.
//
// State changes never trust the cached row: they use conditional updates, so a stale entry can
// at worst let a message through for a connection another isolate removed within the last minute.
import { getConnectionByBaseUrl } from '../db/federation';
import type { Connection } from '../db/schema';
import { importPublicKey } from './keys';

const TTL_MS = 60_000;
const MAX_ENTRIES = 100;

type Peer = { connection: Connection; key: CryptoKey };
const cache = new Map<string, Peer & { expires: number }>();

export async function peerByKeyid(d1: D1Database, keyid: string): Promise<Peer | null> {
  const hit = cache.get(keyid);
  if (hit && hit.expires > Date.now()) return hit;
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
  if (!key) return null;

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const entry = { connection, key, expires: Date.now() + TTL_MS };
  cache.set(keyid, entry);
  return entry;
}

/** Drops a peer from this isolate's cache after its connection changed or was removed. */
export function forgetPeer(baseUrl: string): void {
  cache.delete(baseUrl);
}
