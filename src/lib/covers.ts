// The only code that touches the R2 binding (ARCH.md §13 exit strategy).
// Covers are stored as-fetched — no resizing, ever (10 ms CPU budget).
import { USER_AGENT } from '../env';

export async function storeCover(covers: R2Bucket, url: string | null | undefined): Promise<string | null> {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    // Buffer instead of streaming: R2 put() needs a known length, covers are ~30-100 KB.
    const body = await res.arrayBuffer();
    // < 500 bytes is a tracking pixel or provider placeholder, not cover art
    if (body.byteLength < 500 || body.byteLength > 5 * 1024 * 1024) return null;
    const key = crypto.randomUUID();
    await covers.put(key, body, { httpMetadata: { contentType } });
    return key;
  } catch {
    return null;
  }
}

export async function deleteCover(covers: R2Bucket, key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await covers.delete(key);
  } catch {
    // best-effort cleanup; an orphaned 30 KB object is not worth failing a request over
  }
}

export async function serveCover(covers: R2Bucket, key: string): Promise<Response> {
  const object = await covers.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Keys are immutable UUIDs — replacing a cover mints a new key.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}
