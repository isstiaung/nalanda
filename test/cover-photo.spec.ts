// A cover from the camera (ARCH.md §16 #73): a picture uploaded from an item's page or the item form, stored as it
// comes under a new key — the type read from its bytes, never from the upload — and the old object deleted once
// nothing points at it. No resizing on the server: the browser shrinks it (public/app.js).
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, getItem } from '../src/db/queries';
import { sniffImageType, storeUploadedCover, UPLOAD_MAX_BYTES } from '../src/lib/covers';
import app from '../src/index';
import { book, html, member, type Member } from './member-helpers';

const ORIGIN = 'http://nalanda.test';

/** Bytes that begin as the format says and run on to `size`: enough for the sniff, and past the minimum. */
const bytes = (head: number[], size = 2_000): Uint8Array => {
  const out = new Uint8Array(size);
  out.set(head);
  for (let i = head.length; i < size; i++) out[i] = (i * 7) & 0xff;
  return out;
};
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
const GIF = [...'GIF89a'].map((c) => c.charCodeAt(0));
const AVIF = [0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66];
const SVG = [...'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'].map((c) => c.charCodeAt(0));

/** A multipart POST as `who`, the file under `photo` with whatever type the browser claims, plus any other fields. */
async function upload(who: Member, path: string, file: { bytes: Uint8Array; type: string; name?: string } | null, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set('photo', new File([file.bytes], file.name ?? 'cover.jpg', { type: file.type }));
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, cookie: who.cookie }, body: form, redirect: 'manual' }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const stored = async (key: string) => {
  const obj = await env.COVERS.get(key);
  return obj ? { type: obj.httpMetadata?.contentType, size: obj.size } : null;
};

describe('sniffImageType', () => {
  it('reads the type from the bytes, and refuses what is not a raster image', () => {
    expect(sniffImageType(bytes(JPEG))).toBe('image/jpeg');
    expect(sniffImageType(bytes(PNG))).toBe('image/png');
    expect(sniffImageType(bytes(WEBP))).toBe('image/webp');
    expect(sniffImageType(bytes(GIF))).toBe('image/gif');
    expect(sniffImageType(bytes(AVIF))).toBe('image/avif');
    expect(sniffImageType(bytes(SVG))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(bytes([0xff, 0xd8]))).toBeNull(); // two of a JPEG's three
    expect(sniffImageType(bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull(); // RIFF, but WAVE
  });
});

describe('storeUploadedCover', () => {
  it('stores a raster image under a new key with the sniffed type, whatever the upload claimed', async () => {
    const key = await storeUploadedCover(env.COVERS, new File([bytes(PNG)], 'x.jpg', { type: 'image/jpeg' }));
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stored(key!)).toEqual({ type: 'image/png', size: 2_000 });
  });

  it('refuses an SVG however it is named, an empty file, a tiny one and one past the limit', async () => {
    expect(await storeUploadedCover(env.COVERS, new File([bytes(SVG)], 'cover.jpg', { type: 'image/jpeg' }))).toBeNull();
    expect(await storeUploadedCover(env.COVERS, new File([], 'cover.jpg', { type: 'image/jpeg' }))).toBeNull();
    expect(await storeUploadedCover(env.COVERS, new File([bytes(JPEG, 100)], 'cover.jpg', { type: 'image/jpeg' }))).toBeNull();
    expect(await storeUploadedCover(env.COVERS, new File([bytes(JPEG, UPLOAD_MAX_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' }))).toBeNull();
    expect(await storeUploadedCover(env.COVERS, null)).toBeNull();
  });
});

describe('POST /items/:id/cover', () => {
  it('any member stores a photo, points the item at it, and deletes the cover it replaces', async () => {
    const asha = await member('asha', 'admin');
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await env.COVERS.put('old-cover', 'x');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', coverKey: 'old-cover' });

    const res = await upload(ravi, `/items/${b.id}/cover`, { bytes: bytes(JPEG), type: 'image/jpeg' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/items/${b.id}`);
    const after = (await getItem(env.DB, b.id))!;
    expect(after.coverKey).not.toBe('old-cover');
    expect(after.coverKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stored(after.coverKey!)).toEqual({ type: 'image/jpeg', size: 2_000 });
    expect(await env.COVERS.get('old-cover')).toBeNull();
    expect(after.updatedAt).not.toBe(after.addedAt === after.updatedAt ? 'never' : after.addedAt); // saved since: #67's script leaves it
    const pageText = await html(ravi, `/items/${b.id}`);
    expect(pageText).toContain(`src="/covers/${after.coverKey}"`);
    expect(pageText).toContain('Replace the cover with a photo');
  });

  it('refuses what is not a picture, keeps the cover it had, and says so on the page', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await env.COVERS.put('old-cover', 'x');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', coverKey: 'old-cover' });
    for (const file of [{ bytes: bytes(SVG), type: 'image/svg+xml' }, { bytes: bytes(SVG), type: 'image/jpeg' }, { bytes: bytes(JPEG, 10), type: 'image/jpeg' }, null]) {
      const res = await upload(asha, `/items/${b.id}/cover`, file);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/items/${b.id}?cover=refused`);
    }
    expect((await getItem(env.DB, b.id))!.coverKey).toBe('old-cover');
    expect(await env.COVERS.get('old-cover')).not.toBeNull();
    const text = await html(asha, `/items/${b.id}?cover=refused`);
    expect(text).toContain('role="alert"');
    expect(text).toContain('isn’t a picture Nalanda can keep');
  });

  it('removes the cover on request, and 404s an item that is not there', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await env.COVERS.put('old-cover', 'x');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', coverKey: 'old-cover' });
    const res = await upload(asha, `/items/${b.id}/cover`, null, { action: 'remove' });
    expect(res.status).toBe(302);
    expect((await getItem(env.DB, b.id))!.coverKey).toBeNull();
    expect(await env.COVERS.get('old-cover')).toBeNull();
    expect(await html(asha, `/items/${b.id}`)).toContain('Add a cover from a photo');
    expect((await upload(asha, '/items/999999/cover', { bytes: bytes(JPEG), type: 'image/jpeg' })).status).toBe(404);
  });

  it('works for a record and a board game as for a book', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Things');
    const { createItem } = await import('../src/db/queries');
    for (const mediaType of ['vinyl', 'boardgame'] as const) {
      const item = await createItem(env.DB, { libraryId: shelf.id, mediaType, title: `A ${mediaType}`, details: '{}' });
      const res = await upload(asha, `/items/${item.id}/cover`, { bytes: bytes(WEBP), type: 'image/webp' });
      expect(res.status).toBe(302);
      const after = (await getItem(env.DB, item.id))!;
      expect(await stored(after.coverKey!)).toEqual({ type: 'image/webp', size: 2_000 });
    }
  });
});

describe('the item form', () => {
  it('takes a photo on the edit form, which wins over a cover URL beside it', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    const res = await upload(asha, `/items/${b.id}`, { bytes: bytes(PNG), type: 'image/png', name: 'c.png' }, {
      title: 'Piranesi',
      libraryId: String(shelf.id),
      mediaType: 'book',
      coverUrl: 'https://covers.example/other.jpg', // never fetched: the fetch mock would throw on an unmatched request
    });
    expect(res.status).toBe(302);
    const after = (await getItem(env.DB, b.id))!;
    expect(await stored(after.coverKey!)).toEqual({ type: 'image/png', size: 2_000 });
  });

  it('takes a photo on the add form', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const res = await upload(asha, '/items', { bytes: bytes(JPEG), type: 'image/jpeg' }, { title: 'New with photo', libraryId: String(shelf.id), mediaType: 'book' });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get('location')!.match(/\/items\/(\d+)/)![1]);
    const item = (await getItem(env.DB, id))!;
    expect(await stored(item.coverKey!)).toEqual({ type: 'image/jpeg', size: 2_000 });
  });

  it('says so on the form, tied to the field, when the photo can’t be kept — and saves nothing', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', coverKey: null });
    const res = await upload(asha, `/items/${b.id}`, { bytes: bytes(SVG), type: 'image/svg+xml', name: 'c.svg' }, {
      title: 'Renamed anyway?',
      libraryId: String(shelf.id),
      mediaType: 'book',
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('isn’t a picture Nalanda can keep');
    expect(text).toMatch(/<input type="file" name="photo"[^>]*aria-invalid="true"/);
    const after = (await getItem(env.DB, b.id))!;
    expect(after.title).toBe('Piranesi');
    expect(after.coverKey).toBeNull();
    // the add form likewise
    const add = await upload(asha, '/items', { bytes: bytes(JPEG, 10), type: 'image/jpeg' }, { title: 'Tiny', libraryId: String(shelf.id), mediaType: 'book' });
    expect(add.status).toBe(400);
    expect(await add.text()).toContain('isn’t a picture Nalanda can keep');
  });

  it('still saves a form with no photo chosen', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi', coverKey: null });
    const form = new FormData();
    form.set('title', 'Piranesi (renamed)');
    form.set('libraryId', String(shelf.id));
    form.set('mediaType', 'book');
    form.set('photo', new File([], '', { type: 'application/octet-stream' })); // what a browser sends for an empty file field
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${ORIGIN}/items/${b.id}`, { method: 'POST', headers: { origin: ORIGIN, cookie: asha.cookie }, body: form, redirect: 'manual' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(302);
    const after = (await getItem(env.DB, b.id))!;
    expect(after.title).toBe('Piranesi (renamed)');
    expect(after.coverKey).toBeNull();
  });

  it('is sent as multipart, with a labelled file field', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const b = await book(asha, { libraryId: shelf.id, title: 'Piranesi' });
    const text = await html(asha, `/items/${b.id}/edit`);
    expect(text).toContain('enctype="multipart/form-data"');
    expect(text).toContain('type="file" name="photo" id="cover-photo" accept="image/*" data-resize="cover"');
    expect(text).not.toContain('capture='); // with capture a phone offers only the camera, never a photo already taken
  });
});

describe('app.js', () => {
  it('shrinks a chosen picture in the browser before the form sends it', async () => {
    const js = await (await env.ASSETS.fetch(`${ORIGIN}/app.js`)).text();
    expect(js).toContain("input.dataset.resize !== 'cover'");
    expect(js).toContain('const MAX = 1200;');
    expect(js).toContain("canvas.toBlob(resolve, 'image/jpeg', QUALITY)");
    expect(js).toContain('input.files = dt.files;');
  });
});
