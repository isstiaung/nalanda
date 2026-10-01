// The only code that touches the R2 binding (ARCH.md §13 exit strategy).
// Covers are stored as-fetched — no resizing, ever (10 ms CPU budget).
import { fetchWithTimeout, USER_AGENT } from '../env';

/**
 * Raster images only. A cover is served back from this origin, publicly, so a type that can carry script — SVG above
 * all — must never be stored: a connected household's /covers/ is copied here when a recommendation is wanted (§16 #58),
 * and its bytes are theirs to choose.
 */
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Discogs' images are Restricted Data under its API terms — "limited, personal, non-sublicensable", never passed to a
 * third party — and a stored cover is served on share pages and to connections (ARCH.md §16 #67). So no cover is ever
 * fetched into storage from a Discogs host, whichever path asks: a record's cover comes from the Cover Art Archive.
 */
export function isDiscogsUrl(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && (host === 'discogs.com' || host.endsWith('.discogs.com'));
}

/** The Cover Art Archive and the Internet Archive, where its images live: the only hosts its redirects may lead to. */
const isArchiveHost = (host: string | null) =>
  !!host && (host === 'coverartarchive.org' || host === 'archive.org' || host.endsWith('.archive.org'));
const ARCHIVE_HOPS = 5;

/**
 * A Cover Art Archive URL, its redirects followed by hand: coverartarchive.org answers with a 307 to archive.org, which
 * answers with a 302 to one of its storage hosts. Each hop must stay on those hosts, and is asked over https whatever
 * the redirect says. Anywhere else, or more hops than that, is no cover.
 */
async function fetchFromArchive(url: string): Promise<Response | null> {
  let next = url;
  for (let hop = 0; hop <= ARCHIVE_HOPS; hop++) {
    const at = new URL(next);
    if (!isArchiveHost(at.hostname.toLowerCase()) || (at.protocol !== 'https:' && at.protocol !== 'http:')) return null;
    at.protocol = 'https:';
    const res = await fetchWithTimeout(at.href, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get('location');
    if (!location) return null;
    next = new URL(location, at).href;
  }
  return null;
}

/**
 * A cover's bytes and type, fetched by the rules every stored cover keeps — or null. Only http(s); never a Discogs
 * host; a Cover Art Archive URL's redirects followed only to the archive's hosts; raster types only; 500 bytes to 5 MB.
 * `followRedirects: false` for a URL another instance named: its cover is at its own /covers/<uuid>, and following a
 * redirect would let it point this Worker's fetch anywhere. No R2 here, so the laptop scripts fetch by the same rules.
 */
export async function fetchCover(
  url: string | null | undefined,
  opts: { followRedirects?: boolean } = {},
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  if (!url || !/^https?:\/\//.test(url) || isDiscogsUrl(url)) return null;
  try {
    const res =
      isArchiveHost(hostOf(url)) && opts.followRedirects !== false
        ? await fetchFromArchive(url)
        : await fetchWithTimeout(url, {
            headers: { 'User-Agent': USER_AGENT },
            ...(opts.followRedirects === false ? { redirect: 'manual' as const } : {}),
          });
    if (!res?.ok || isDiscogsUrl(res.url)) return null; // a redirect that ended at Discogs is still Discogs' image
    // A metadata provider that sends no type has always been taken as a JPEG, and still is: the guess can only ever be
    // a raster type, and every cover is served sandboxed (serveCover). Another instance must say what it sends — left
    // out, the stored type would be ours to guess for bytes it chose, so its cover is refused.
    const declared = res.headers.get('content-type');
    if (!declared && opts.followRedirects === false) return null;
    const contentType = (declared ?? 'image/jpeg').split(';')[0]!.trim().toLowerCase();
    if (!COVER_TYPES.has(contentType)) return null;
    // Buffer instead of streaming: R2 put() needs a known length, covers are ~30-100 KB.
    const body = await res.arrayBuffer();
    // < 500 bytes is a tracking pixel or provider placeholder, not cover art
    if (body.byteLength < 500 || body.byteLength > 5 * 1024 * 1024) return null;
    return { body, contentType };
  } catch {
    return null;
  }
}

export async function storeCover(
  covers: R2Bucket,
  url: string | null | undefined,
  opts: { followRedirects?: boolean } = {},
): Promise<string | null> {
  const fetched = await fetchCover(url, opts);
  if (!fetched) return null;
  try {
    const key = crypto.randomUUID();
    await covers.put(key, fetched.body, { httpMetadata: { contentType: fetched.contentType } });
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
