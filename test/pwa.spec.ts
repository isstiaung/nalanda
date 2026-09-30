// The installable app (ARCH.md §16 #48): the manifest and icons a phone installs from, and the tags that point to
// them. Static files are served by Cloudflare before the Worker runs, so these read them through the ASSETS binding
// the test config adds (vitest.config.ts) — the same asset server, headers and all.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { member } from './member-helpers';

const ORIGIN = 'http://nalanda.test';

/** A static file as a browser gets it. */
const asset = (path: string) => env.ASSETS.fetch(`${ORIGIN}${path}`, { redirect: 'manual' });

/** Width, height, colour type, and the top-left pixel (RGBA) of a PNG — enough to tell a full-bleed icon from a tile. */
async function png(res: Response): Promise<{ width: number; height: number; colorType: number; corner: number[] }> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(bytes.buffer);
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = view.getUint8(24);
  const colorType = view.getUint8(25);
  expect(depth).toBe(8);
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    if (type === 'IDAT') idat.push(bytes.slice(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const inflated = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  // The first pixel of the first row reads the same under every PNG filter (it has no left or upper neighbour).
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(channels, `colour type ${colorType}`).toBeGreaterThan(0);
  const first = [...inflated.slice(1, 1 + channels)];
  return { width, height, colorType, corner: channels === 3 ? [...first, 255] : first };
}

describe('the web app manifest', () => {
  it('is served from public/ as a manifest, and names an installable, full-screen app', async () => {
    const res = await asset('/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    const manifest = (await res.json()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: '/',
      name: 'Nalanda',
      short_name: 'Nalanda',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
  });

  it('takes its colours from the design system: palm-leaf paper, as the light theme-color says', async () => {
    const manifest = (await (await asset('/manifest.webmanifest')).json()) as { theme_color: string; background_color: string };
    const css = await (await asset('/app.css')).text();
    const paper = /--paper:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
    expect(paper).toBe('#f6f2e7');
    expect(manifest.theme_color).toBe(paper);
    expect(manifest.background_color).toBe(paper);
  });

  it('lists 192 and 512 px icons, a maskable one, and every one is a PNG of the size it claims', async () => {
    const { icons } = (await (await asset('/manifest.webmanifest')).json()) as {
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    expect(icons.filter((i) => i.purpose === 'any').map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    expect(icons.filter((i) => i.purpose === 'maskable').map((i) => i.sizes)).toEqual(['512x512']);
    for (const icon of icons) {
      const res = await asset(icon.src);
      expect(res.status, icon.src).toBe(200);
      expect(res.headers.get('content-type'), icon.src).toBe('image/png');
      const { width, height, corner } = await png(res);
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
      if (icon.purpose === 'maskable') {
        // full bleed: the launcher cuts its own shape, so the corner is paper (#f6f2e7, give or take rounding)
        const paper = [0xf6, 0xf2, 0xe7];
        paper.forEach((v, i) => expect(Math.abs((corner[i] ?? -99) - v), icon.src).toBeLessThanOrEqual(2));
        expect(corner[3], icon.src).toBe(255);
      } else {
        // the rounded tile: its corners are see-through, not white squares on a dark home screen
        expect(corner[3], icon.src).toBe(0);
      }
    }
  });

  it('comes with an opaque 180 px apple-touch-icon for iOS', async () => {
    const res = await asset('/icons/apple-touch-icon.png');
    expect(res.status).toBe(200);
    const { width, height, corner } = await png(res);
    expect([width, height]).toEqual([180, 180]);
    expect(corner[3]).toBe(255); // iOS fills transparency with black
  });

  it('is linked from every app page, with the theme colours for light and dark and the iOS home-screen tags', async () => {
    const admin = await member('ravi', 'admin');
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${ORIGIN}/add`, { headers: { cookie: admin.cookie } }), env, ctx);
    await waitOnExecutionContext(ctx);
    const html = await res.text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"/>');
    expect(html).toContain('<meta name="theme-color" content="#f6f2e7" media="(prefers-color-scheme: light)"/>');
    expect(html).toContain('<meta name="theme-color" content="#171310" media="(prefers-color-scheme: dark)"/>');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"/>');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Nalanda"/>');
  });
});
