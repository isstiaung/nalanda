// QR codes for share links (ARCH.md §16 #85): the Shared links page carries, per link, an image the browser draws
// from the address beside it and a download button, and the two scripts that do it — vendored, served from here.
// Nothing new is published: the code is the address.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createLibrary, createShare, listShares } from '../src/db/queries';
import { newShareToken } from '../src/lib/share';
import { as, html, member } from './member-helpers';

const ORIGIN = 'http://nalanda.test';
const asset = (path: string) => env.ASSETS.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });

describe('the Shared links page', () => {
  it('shows each link as an image to be drawn from its address, with a download named after it, and the scripts', async () => {
    const lib = await createLibrary(env.DB, 'Books');
    const admin = await member('admin', 'admin');
    const token = newShareToken();
    await createShare(env.DB, { token, name: 'Everything on the shelf — Books!', libraryId: lib.id });
    const page = await html(admin, '/shares');
    expect(page).toContain(`<img data-qr="${ORIGIN}/share/${token}" alt="QR code for Everything on the shelf — Books!" width="512" height="512" src="data:image/svg+xml`);
    expect(page).toContain('data-qr-download="nalanda-everything-on-the-shelf-books.png"');
    expect(page).toContain('<button type="button" data-qr-download=');
    expect(page).toContain('class="btn" hidden="">Download PNG'); // until the drawing is done
    expect(page).toContain('<script src="/vendor/qrcode.js" defer=""></script>');
    expect(page).toContain('<script src="/qr.js" defer=""></script>');
    // a member has no Shared links page, so no codes either
    const ravi = await member('ravi');
    expect((await as(ravi, '/shares')).status).toBe(403);
  });

  it('follows a rotated link: the image is the new address', async () => {
    const lib = await createLibrary(env.DB, 'Books');
    const admin = await member('admin', 'admin');
    const token = newShareToken();
    const share = await createShare(env.DB, { token, name: 'Rotated', libraryId: lib.id });
    await as(admin, `/shares/${share.id}`, { body: { action: 'rotate', libraryId: String(lib.id) } });
    const [after] = await listShares(env.DB, lib.id);
    expect(after!.token).not.toBe(token);
    const page = await html(admin, '/shares');
    expect(page).toContain(`data-qr="${ORIGIN}/share/${after!.token}"`);
    expect(page).not.toContain(token);
  });
});

describe('the files that draw it', () => {
  it('are served from this origin: the vendored library with its MIT header, and the drawing script', async () => {
    const lib = await asset('/vendor/qrcode.js');
    expect(lib.status).toBe(200);
    const text = await lib.text();
    expect(text).toContain('QR Code Generator for JavaScript');
    expect(text).toContain('Licensed under the MIT license');
    expect(text).toContain('var qrcode = function()');
    const script = await asset('/qr.js');
    expect(script.status).toBe(200);
    const js = await script.text();
    expect(js).toContain("qrcode(0, 'H')"); // error correction H: the mark covers a sixth of the code
    expect(js).toContain('img[data-qr]');
    expect(js).toContain("fetch('/logo.svg')");
    expect(js).not.toMatch(/https?:\/\//); // nothing fetched from anywhere else
  });
});
