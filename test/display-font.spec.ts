// A household's own display font (ARCH.md §16 #96): uploaded by an admin under Members for a shipped locale, stored
// in R2 under a random key as it came — the format read from its bytes — served public at /fonts/<key>, and set ahead
// of Eczar by a <style> in the head of every page in that locale: the app, the login page, share pages. Read in the
// D1 call each page already made for its language, so it costs none.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { cleanFontName, displayFaceOf, serveFont, sniffFontType, storeFont } from '../src/lib/fonts';
import app from '../src/index';

/** Bytes that open as the format says and run on to `size`: the sniffer reads magic bytes, not a whole font. */
const bytes = (head: number[] | string, size = 4_000): Uint8Array => {
  const start = typeof head === 'string' ? [...head].map((c) => c.charCodeAt(0)) : head;
  const out = new Uint8Array(size);
  out.set(start);
  for (let i = start.length; i < size; i++) out[i] = (i * 13) & 0xff;
  return out;
};
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('sniffFontType', () => {
  it('reads each format from its magic bytes, and refuses an image, a page and garbage', () => {
    expect(sniffFontType(bytes('wOF2'))).toBe('woff2');
    expect(sniffFontType(bytes('wOFF'))).toBe('woff');
    expect(sniffFontType(bytes([0x00, 0x01, 0x00, 0x00]))).toBe('ttf');
    expect(sniffFontType(bytes('true'))).toBe('ttf');
    expect(sniffFontType(bytes('OTTO'))).toBe('otf');
    expect(sniffFontType(bytes(PNG))).toBeNull();
    expect(sniffFontType(bytes('<!doctype html><script>'))).toBeNull();
    expect(sniffFontType(bytes([0x13, 0x37, 0xbe, 0xef]))).toBeNull();
    expect(sniffFontType(bytes('wOF'))).toBeNull(); // three of the four, then padding
    expect(sniffFontType(new Uint8Array(0))).toBeNull();
    expect(sniffFontType(bytes('ttcf'))).toBeNull(); // a collection is not one face
  });

  it('cleans a name to its last segment, plain text, at most 80 characters', () => {
    expect(cleanFontName('Mukta-Bold.woff2', 'woff2')).toBe('Mukta-Bold.woff2');
    expect(cleanFontName('C:\\fonts\\Hind.ttf', 'ttf')).toBe('Hind.ttf');
    expect(cleanFontName('../../etc/x.otf', 'otf')).toBe('x.otf');
    expect(cleanFontName('a\u202eb\u0000c  d.woff', 'woff')).toBe('abc d.woff');
    expect(cleanFontName('', 'woff2')).toBe('font.woff2');
    expect(cleanFontName(undefined, 'ttf')).toBe('font.ttf');
    expect(Array.from(cleanFontName('த'.repeat(200), 'ttf')).length).toBe(80);
  });

  it('lets only a UUID key and a known format through to a page', () => {
    const key = crypto.randomUUID();
    expect(displayFaceOf({ key, format: 'woff2' })).toEqual({ key, format: 'woff2' });
    expect(displayFaceOf({ key: `${key.slice(0, 35)}'`, format: 'woff2' })).toBeNull();
    expect(displayFaceOf({ key: "x'); } body { color: red", format: 'woff2' })).toBeNull();
    expect(displayFaceOf({ key, format: 'svg' })).toBeNull();
    expect(displayFaceOf(null)).toBeNull();
  });
});

describe('the stored font', () => {
  it('is served at /fonts/<key> as its own type, cached for good, never sniffed — and nothing else is', async () => {
    const key = (await storeFont(env.COVERS, bytes('wOF2').buffer as ArrayBuffer, 'woff2'))!;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const res = await fetchPath(`/fonts/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/woff2');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBeNull(); // same origin: no CORS
    expect((await res.arrayBuffer()).byteLength).toBe(4_000);
    // each of the other formats keeps its own type
    for (const [head, format, type] of [['wOFF', 'woff', 'font/woff'], ['true', 'ttf', 'font/ttf'], ['OTTO', 'otf', 'font/otf']] as const) {
      const k = (await storeFont(env.COVERS, bytes(head).buffer as ArrayBuffer, format))!;
      expect((await serveFont(env.COVERS, k)).headers.get('content-type'), format).toBe(type);
    }
    // a cover in the same bucket is never a font, and a font is never a cover
    await env.COVERS.put('0b1e6f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', bytes(PNG), { httpMetadata: { contentType: 'image/png' } });
    expect((await fetchPath('/fonts/0b1e6f0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b')).status).toBe(404);
    expect((await fetchPath(`/covers/${key}`)).status).toBe(404);
    // a key not shaped like ours is never looked up; a gone one is a 404
    expect((await fetchPath('/fonts/..%2Fsecret')).status).toBe(404);
    expect((await fetchPath(`/fonts/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

/** A plain GET, signed out: fonts are public, like covers. */
async function fetchPath(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://nalanda.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
