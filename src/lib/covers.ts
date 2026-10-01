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
 * A host name as DNS reads it, for every host check here: lower case, and without the trailing dot of a fully
 * qualified name — `i.discogs.com.` is `i.discogs.com`, and a check that compared the spelling let it through.
 */
const normalHost = (hostname: string): string => hostname.toLowerCase().replace(/\.+$/, '');

const hostOf = (url: string): string | null => {
  try {
    return normalHost(new URL(url).hostname);
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

/**
 * Whether a URL names its host by IP number — `http://10.0.0.5/…`, `http://[::1]/…`, or a form the URL parser reads
 * as one — rather than by name. A cover URL someone types is refused with that host: no image anyone would paste
 * lives at a bare address, and a Worker's fetch is not for reaching into networks by number. Not a rule of
 * fetchCover() itself — a connection in development is `http://127.0.0.1`, and its covers come by this path.
 */
export function isIpLiteralUrl(url: string | null | undefined): boolean {
  const host = url ? hostOf(url) : null;
  return !!host && (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host));
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
    if (!isArchiveHost(normalHost(at.hostname)) || (at.protocol !== 'https:' && at.protocol !== 'http:')) return null;
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

/**
 * What an upload may be, and how large. The browser resizes a photo to a few hundred KB (public/app.js); the limit is
 * for a browser that couldn't. Parsing a multipart body and buffering it is CPU work in proportion to its size (§12:
 * 10 ms a request): measured in workerd, 8 MB took about 7 ms before any D1 or R2 call, 4 MB about 4 ms. So 4 MB.
 */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MIN_BYTES = 500;

/**
 * The raster type the bytes say they are, or null: JPEG, PNG, GIF, WebP or AVIF by their magic numbers. What a browser
 * declares for an upload is never trusted — an SVG renamed .jpg would be served from this origin as "image/jpeg", and
 * the type is what it says it is, not the extension. Anything else is no cover.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (start: number, text: string) => [...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
  return null;
}

/**
 * A cover someone uploaded — a photo taken on the phone, or a file picked (ARCH.md §16 #73) — stored as it came, under
 * a new key: no resizing here (10 ms CPU; the browser shrank it), the type from the bytes, never from the upload, and
 * the same raster-only rule as a fetched cover. Null for anything that isn't a raster image of a plausible size.
 */
export async function storeUploadedCover(covers: R2Bucket, file: Blob | null | undefined): Promise<string | null> {
  if (!(await isUploadableCover(file))) return null;
  try {
    const body = await file!.arrayBuffer();
    const contentType = sniffImageType(new Uint8Array(body, 0, Math.min(16, body.byteLength)));
    if (!contentType || !COVER_TYPES.has(contentType)) return null;
    const key = crypto.randomUUID();
    await covers.put(key, body, { httpMetadata: { contentType } });
    return key;
  } catch {
    return null;
  }
}

/** Whether an upload would be kept: a plausible size, and bytes that open as a raster image — read from its first 16. */
export async function isUploadableCover(file: Blob | null | undefined): Promise<boolean> {
  if (!file || file.size < UPLOAD_MIN_BYTES || file.size > UPLOAD_MAX_BYTES) return false;
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const type = sniffImageType(head);
    return !!type && COVER_TYPES.has(type);
  } catch {
    return false;
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
