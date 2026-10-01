// A household's own display font (ARCH.md §16 #96): uploaded by an admin under Members for a shipped locale, stored
// in R2 under a random key as it came — the format read from its bytes — served public at /fonts/<key>, and set ahead
// of Eczar by a <style> in the head of every page in that locale: the app, the login page, share pages. Read in the
// D1 call each page already made for its language, so it costs none.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { cleanFontName, displayFaceOf, FONT_MAX_BYTES, serveFont, sniffFontType, storeFont } from '../src/lib/fonts';
import app from '../src/index';
import { as, html, member, rows, type Member } from './member-helpers';

const ORIGIN = 'http://nalanda.test';

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

/**
 * A minimal WOFF2 file as far as the sniffer reads one: the signature, a flavour (TrueType), a length, then padding
 * to `size`. Not a font a browser would draw — nothing here draws.
 */
const woff2 = (size = 6_000): Uint8Array => {
  const out = bytes('wOF2', size);
  out.set([0x00, 0x01, 0x00, 0x00], 4); // flavor
  new DataView(out.buffer).setUint32(8, size); // length
  return out;
};

/** The Members form's multipart POST as `who`: the file under `file`, named and typed as a browser would send it. */
async function upload(who: Member, file: { bytes: Uint8Array; name?: string; type?: string } | null, locale: string = 'hi'): Promise<Response> {
  const form = new FormData();
  form.set('locale', locale);
  if (file) form.set('file', new File([file.bytes], file.name ?? 'Mukta-SemiBold.woff2', { type: file.type ?? 'font/woff2' }));
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}/settings/display-fonts`, { method: 'POST', headers: { origin: ORIGIN, cookie: who.cookie }, body: form, redirect: 'manual' }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const fontRows = () => rows<{ locale: string; key: string; format: string; name: string; bytes: number }>('SELECT locale, key, format, name, bytes FROM display_fonts ORDER BY locale');
const objects = async () => (await env.COVERS.list()).objects.map((o) => o.key);

describe('POST /settings/display-fonts', () => {
  it('refuses a member, a language that isn’t shipped, bytes that aren’t a font and a file past the cap — storing nothing', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    expect((await upload(ravi, { bytes: woff2() })).status).toBe(403);
    let res = await upload(asha, { bytes: woff2() }, 'fr');
    expect(res.status).toBe(400);
    let text = await res.text();
    expect(text).toContain('<p class="error" role="alert" id="display-font-error">Choose a language from the list.</p>');
    expect(text).toContain('aria-describedby="display-font-error"'); // the select names the refusal
    // 1.5 KB of garbage, named and typed as a font
    res = await upload(asha, { bytes: bytes([0x13, 0x37, 0xbe, 0xef], 1_536), name: 'Mukta.woff2' });
    expect(res.status).toBe(400);
    text = await res.text();
    expect(text).toContain('That file is not a font: upload a .woff2, .woff, .ttf or .otf file.');
    expect(text).toMatch(/<input id="display-font-file"[^>]*aria-invalid="true"[^>]*aria-describedby="display-font-error display-font-help"/);
    // a font's first bytes on something under a kilobyte is no font either
    expect((await upload(asha, { bytes: woff2(600) })).status).toBe(400);
    // 3 MB
    res = await upload(asha, { bytes: woff2(3 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('That file is larger than 2 MB.');
    // no file at all
    expect((await upload(asha, null)).status).toBe(400);
    expect(await fontRows()).toEqual([]);
    expect(await objects()).toEqual([]);
  });

  it('stores a font under a new UUID key as its sniffed format, lists it on Members, and serves it', async () => {
    const asha = await member('asha', 'admin');
    expect(FONT_MAX_BYTES).toBe(2 * 1024 * 1024);
    // the browser's claimed type and the name's extension are not what decides the format
    const res = await upload(asha, { bytes: woff2(), name: 'C:\\fakepath\\Mukta\u202e-SemiBold.ttf', type: 'application/octet-stream' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings/users?font=saved#display-font');
    const [row] = await fontRows();
    expect(row).toMatchObject({ locale: 'hi', format: 'woff2', name: 'Mukta-SemiBold.ttf', bytes: 6_000 });
    expect(row!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await objects()).toEqual([row!.key]);
    const served = await as(null, `/fonts/${row!.key}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('font/woff2');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(woff2());

    const members = await html(asha, '/settings/users?font=saved');
    expect(members).toContain('<p class="notice">Display font saved.</p>');
    expect(members).toContain('हिन्दी: Mukta-SemiBold.ttf, 6 KB, uploaded ');
    expect(members).toContain('English: the shipped faces');
    expect(members).toContain('தமிழ்: the shipped faces');
    expect(members).toContain('action="/settings/display-fonts/hi/delete"');
    expect(members).not.toContain('action="/settings/display-fonts/ta/delete"');
    // the upload form: multipart, both fields labelled, the licence and the publicity said
    expect(members).toContain('<form method="post" action="/settings/display-fonts" enctype="multipart/form-data"');
    expect(members).toContain('<label for="display-font-locale">Font for</label>');
    expect(members).toContain('<label for="display-font-file">Font file</label>');
    expect(members).toContain('accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"');
    expect(members).toContain('The household is responsible for the font’s licence');
    expect(members).toContain('The file becomes public like a cover');
  });

  it('replaces a locale’s font — the old object deleted once the row names the new — and Remove clears it', async () => {
    const asha = await member('asha', 'admin');
    await upload(asha, { bytes: woff2() });
    const [first] = await fontRows();
    await upload(asha, { bytes: bytes('OTTO', 8_192), name: 'Hind.otf', type: 'font/otf' });
    const [second] = await fontRows();
    expect(second).toMatchObject({ locale: 'hi', format: 'otf', name: 'Hind.otf', bytes: 8_192 });
    expect(second!.key).not.toBe(first!.key);
    expect(await objects()).toEqual([second!.key]);
    expect((await as(null, `/fonts/${first!.key}`)).status).toBe(404);
    expect((await as(null, `/fonts/${second!.key}`)).headers.get('content-type')).toBe('font/otf');

    // another locale's font is its own row and object
    await upload(asha, { bytes: bytes([0x00, 0x01, 0x00, 0x00], 5_000), name: 'Catamaran.ttf' }, 'ta');
    expect((await fontRows()).map((r) => [r.locale, r.format])).toEqual([['hi', 'otf'], ['ta', 'ttf']]);

    // a member can't remove one
    const ravi = await member('ravi');
    expect((await as(ravi, '/settings/display-fonts/hi/delete', { body: {} })).status).toBe(403);
    const res = await as(asha, '/settings/display-fonts/hi/delete', { body: {} });
    expect(res.headers.get('location')).toBe('/settings/users?font=removed#display-font');
    expect((await fontRows()).map((r) => r.locale)).toEqual(['ta']);
    expect(await objects()).not.toContain(second!.key);
    expect((await as(null, `/fonts/${second!.key}`)).status).toBe(404);
    expect(await html(asha, '/settings/users?font=removed')).toContain('<p class="notice">Display font removed.</p>');
    // removing one that isn't there, or for no shipped locale, changes nothing
    expect((await as(asha, '/settings/display-fonts/hi/delete', { body: {} })).status).toBe(302);
    expect((await as(asha, '/settings/display-fonts/fr/delete', { body: {} })).status).toBe(302);
    expect((await fontRows()).map((r) => r.locale)).toEqual(['ta']);
  });
});
