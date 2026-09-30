// The only code that touches the R2 binding (ARCH.md §13 exit strategy).
// Covers are stored as-fetched — no resizing, ever (10 ms CPU budget).
import { fetchWithTimeout, USER_AGENT } from '../env';

/**
 * Raster images only. A cover is served back from this origin, publicly, so a type that can carry script — SVG above
 * all — must never be stored: a connected household's /covers/ is copied here when a recommendation is wanted (§16 #58),
 * and its bytes are theirs to choose.
 */
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/**
 * `followRedirects: false` for a URL another instance named: its cover is at its own /covers/<uuid>, and following a
 * redirect would let it point this Worker's fetch anywhere.
 */
export async function storeCover(
  covers: R2Bucket,
  url: string | null | undefined,
  opts: { followRedirects?: boolean } = {},
): Promise<string | null> {
  if (!url || !/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': USER_AGENT },
      ...(opts.followRedirects === false ? { redirect: 'manual' as const } : {}),
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim().toLowerCase();
    if (!COVER_TYPES.has(contentType)) return null;
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
  // An image and nothing else, even one stored before only raster types were kept: no script, no document
  headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return new Response(object.body, { headers });
}
