// The R2 code for a household's own display fonts (ARCH.md §16 #96) — beside covers.ts, the only code that touches
// the R2 binding. Fonts share the covers bucket: each under a random UUID of its own, stored as uploaded (no
// subsetting, no conversion — 10 ms CPU), the format read from the bytes, never from the file's name or the type the
// browser claimed. Public at /fonts/<key> like a cover: a font file carries nothing about the household.
import { FONT_FORMATS, type FontFormat } from '../db/schema';

export { FONT_FORMATS, type FontFormat } from '../db/schema';

/**
 * What an upload may weigh: 1 KB to 2 MB. A display face's woff2 is 20–200 KB; a full CJK or Indic family can pass a
 * megabyte as .ttf. Parsing a multipart body is CPU in proportion to its size (covers.ts measured 4 MB at about 4 ms),
 * so 2 MB keeps the upload well inside the 10 ms budget. Under 1 KB is no font at all.
 */
export const FONT_MAX_BYTES = 2 * 1024 * 1024;
export const FONT_MIN_BYTES = 1024;

/** The longest file name kept: it is shown on Members, nowhere else. */
export const MAX_FONT_NAME = 80;

/** The MIME type each format is served as (RFC 8081). */
export const FONT_TYPES: Record<FontFormat, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

/** The `format()` hint an @font-face src takes for each: CSS names TrueType and OpenType by their long names. */
export const CSS_FORMATS: Record<FontFormat, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

export const isFontFormat = (value: unknown): value is FontFormat => typeof value === 'string' && (FONT_FORMATS as readonly string[]).includes(value);

/** A font's key as storeFont() makes it: a UUID, and nothing else ever goes into a /fonts/ URL or a page's <style>. */
export const FONT_KEY = /^[0-9a-f-]{36}$/;

/**
 * The format the bytes say they are, or null, by the four bytes every font file opens with: `wOF2`, `wOFF`, the
 * TrueType version 0x00010000 (or Apple's `true`), `OTTO` for CFF-flavoured OpenType. A magic number, not a parse: a
 * file that starts right and is broken after is the household's to fix — the browser simply won't use it, and the
 * titles fall back to Eczar. Anything else — an image, a page, a script — is no font.
 */
export function sniffFontType(bytes: Uint8Array): FontFormat | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (text: string) => [...text].every((ch, i) => at(i) === ch.charCodeAt(0));
  if (ascii('wOF2')) return 'woff2';
  if (ascii('wOFF')) return 'woff';
  if ((at(0) === 0x00 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00) || ascii('true')) return 'ttf';
  if (ascii('OTTO')) return 'otf';
  return null;
}

/**
 * The file's name as it is kept and shown on Members: its last path segment (a crafted upload can send any name),
 * without control or bidi-override characters, whitespace collapsed, at most MAX_FONT_NAME characters — and
 * `font.<format>` when nothing is left. Text only: it is rendered escaped, and never reaches a page outside Members.
 */
export function cleanFontName(raw: unknown, format: FontFormat): string {
  const base = typeof raw === 'string' ? (raw.split(/[\\/]/).pop() ?? '') : '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? Array.from(clean).slice(0, MAX_FONT_NAME).join('') : `font.${format}`;
}

/** A display font as a page uses it: the key and the format, both checked — nothing else from the row. */
export type DisplayFace = { key: string; format: FontFormat };

/** A row's key and format if both are what storeFont() and sniffFontType() make, else null: a page then sets no face. */
export function displayFaceOf(row: { key: unknown; format: unknown } | null | undefined): DisplayFace | null {
  if (!row || typeof row.key !== 'string' || !FONT_KEY.test(row.key) || !isFontFormat(row.format)) return null;
  return { key: row.key, format: row.format };
}

/** Stores a font's bytes under a new key, served back as its format's type; the key, or null if R2 refused it. */
export async function storeFont(bucket: R2Bucket, bytes: ArrayBuffer, format: FontFormat): Promise<string | null> {
  try {
    const key = crypto.randomUUID();
    await bucket.put(key, bytes, { httpMetadata: { contentType: FONT_TYPES[format] } });
    return key;
  } catch {
    return null;
  }
}

export async function deleteFont(bucket: R2Bucket, key: string | null | undefined): Promise<void> {
  if (!key || !FONT_KEY.test(key)) return;
  try {
    await bucket.delete(key);
  } catch {
    // best-effort cleanup: an orphaned font is public bytes nobody points at, not worth failing a request over
  }
}

const isFontType = (type: string | undefined): boolean => !!type && Object.values(FONT_TYPES).includes(type);

/**
 * A stored font, as a browser loads it for @font-face: its own type, cached for good (a new upload mints a new key),
 * never sniffed as anything else. Only a key shaped like ours is looked up, and only an object stored as a font is
 * served — the bucket holds covers too, and /fonts/ never serves one. Same origin as the pages, so no CORS header.
 */
export async function serveFont(bucket: R2Bucket, key: string): Promise<Response> {
  if (!FONT_KEY.test(key)) return new Response('Not found', { status: 404 });
  const object = await bucket.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const type = object.httpMetadata?.contentType;
  if (!isFontType(type)) {
    await object.body.cancel();
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers();
  headers.set('content-type', type!);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  // a font and nothing else: opened directly, it is no document that could run anything
  headers.set('content-security-policy', "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
}
