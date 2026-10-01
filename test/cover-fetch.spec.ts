// fetchCover()'s size rule (src/lib/covers.ts): a cover over 5 MB is refused before it is read — by the length the
// host declares, or else the moment the body passes the cap — never buffered whole and then measured. The Worker and
// the laptop scripts (backfill, record covers) fetch through the same function, so both keep the cap.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCover } from '../src/lib/covers';

const MB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** A JPEG-typed answer of `bytes` bytes, streamed 64 KB at a time; `pulled` counts what the reader took from it. */
function serves(bytes: number, headers: Record<string, string> = {}) {
  const pulled = { bytes: 0, cancelled: false };
  vi.stubGlobal('fetch', async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        const n = Math.min(CHUNK, bytes - sent);
        controller.enqueue(new Uint8Array(n).fill(7));
        sent += n;
        pulled.bytes = sent;
      },
      cancel() {
        pulled.cancelled = true;
      },
    });
    return new Response(stream, { headers: { 'content-type': 'image/jpeg', ...headers } });
  });
  return pulled;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchCover and a cover’s size', () => {
  it('reads a cover of a plausible size whole, as the bytes came', async () => {
    const pulled = serves(1 * MB);
    const got = await fetchCover('https://covers.example/big.jpg');
    expect(got?.contentType).toBe('image/jpeg');
    expect(got?.body.byteLength).toBe(1 * MB);
    expect(new Uint8Array(got!.body).every((b) => b === 7)).toBe(true);
    expect(pulled.bytes).toBe(1 * MB);
  });

  it('refuses a body that passes 5 MB as it streams, pulling no more than the cap and a chunk or two', async () => {
    const pulled = serves(12 * MB);
    expect(await fetchCover('https://covers.example/huge.jpg')).toBeNull();
    expect(pulled.bytes).toBeGreaterThan(5 * MB); // it did read up to the cap before refusing
    expect(pulled.bytes).toBeLessThanOrEqual(5 * MB + 4 * CHUNK); // and no further: the rest of the 12 MB stayed on the host
    expect(pulled.cancelled).toBe(true);
  });

  it('refuses a declared length over 5 MB without reading the body', async () => {
    const pulled = serves(12 * MB, { 'content-length': String(12 * MB) });
    expect(await fetchCover('https://covers.example/huge.jpg')).toBeNull();
    expect(pulled.bytes).toBeLessThanOrEqual(CHUNK); // the one chunk a stream primes itself with; nothing was read from it
  });

  it('believes the body over a declared length that understates it', async () => {
    const pulled = serves(6 * MB, { 'content-length': '1000' });
    expect(await fetchCover('https://covers.example/liar.jpg')).toBeNull();
    expect(pulled.bytes).toBeLessThanOrEqual(5 * MB + 4 * CHUNK);
  });

  it('still refuses a tracking pixel: under 500 bytes is no cover', async () => {
    serves(300);
    expect(await fetchCover('https://covers.example/pixel.jpg')).toBeNull();
  });
});
