// The review list's "Add all" (ARCH.md §16 #94) posts the held barcodes to POST /api/scans/add twenty at a time and
// tallies the answers — the loop in public/scan-review.js, which has no DOM in it. This runs that script against the
// Worker with just enough browser around it, as test/import-batches.spec.ts runs import.js: the page has none of the
// list's elements, so only the loop attaches, and fetch goes to the app.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createItem, createLibrary } from '../src/db/queries';
import { scanQueueOwner } from '../src/lib/auth';
import app from '../src/index';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { member, rows, type Member } from './member-helpers';

type Entry = { code: string; at: string };
type Tally = { added: Array<{ code: string; id: number; title: string }>; already: Array<{ code: string; id: number; title: string }>; notFound: string[]; notices: string[]; sent: number; failed: { at: number; why: string } | null };
type Batch = {
  SIZE: number;
  split: (codes: Entry[]) => Entry[][];
  run: (opts: { codes: Entry[]; libraryId: string | number; scanOwner: string; onBatch?: (data: unknown, batch: Entry[]) => void | Promise<void>; fetch?: typeof fetch }) => Promise<Tally>;
};
let batch: Batch;

beforeAll(async () => {
  Object.assign(globalThis, { document: { getElementById: () => null, querySelector: () => null, addEventListener: () => {} }, window: {} });
  // @ts-expect-error -- a browser script with no types, run here for the loop it attaches to the page
  await import('../public/scan-review.js');
  batch = (globalThis as unknown as { window: { nalandaScanBatch: Batch } }).window.nalandaScanBatch;
});

beforeEach(() => activateFetchMock());
afterEach(() => assertNoPendingInterceptors());

const OL = 'https://openlibrary.org';
const GB = 'https://www.googleapis.com';
const isbn = (i: number) => `97803064${String(i).padStart(5, '0')}`;
const entries = (codes: string[]): Entry[] => codes.map((code, i) => ({ code, at: `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00Z` }));
/** Open Library knows the book; Google Books doesn't. */
function known(code: string, title: string) {
  intercept(OL, (p) => p.startsWith(`/search.json?q=isbn%3A${code}&`), json({ numFound: 1, docs: [{ key: '/works/OL1W', title, author_name: ['A. Writer'] }] }));
  intercept(GB, (p) => p.startsWith(`/books/v1/volumes?q=isbn%3A${code}&`), json({ totalItems: 0 }));
}

/**
 * A fetch that carries the app's own requests to the Worker as `who`, recording each batch's codes as posted. With
 * `failAt`, that batch (counting from 0) is answered with a 500 instead, as a batch the server refused would be; with
 * `signedOutAt`, with what a lapsed session's redirect looks like to a `redirect: 'manual'` fetch.
 */
function toApp(who: Member, posted: string[][], opts: { failAt?: number; signedOutAt?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { codes: Entry[] };
    const n = posted.length;
    posted.push(body.codes.map((c) => c.code));
    if (n === opts.failAt) return new Response('{"error":"refused"}', { status: 500, headers: { 'content-type': 'application/json' } });
    if (n === opts.signedOutAt) return { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response;
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(new URL(String(input), 'http://nalanda.test'), { ...init, headers: { ...(init.headers as object), cookie: who.cookie, origin: 'http://nalanda.test' } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }) as typeof fetch;
}

describe('splitting the list', () => {
  it('makes batches of twenty, in order, a barcode listed twice going once', () => {
    expect(batch.SIZE).toBe(20);
    const codes = entries(Array.from({ length: 45 }, (_, i) => isbn(i)));
    const split = batch.split([...codes, codes[3]!, codes[44]!]);
    expect(split.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(split.flat()).toEqual(codes);
    expect(batch.split([])).toEqual([]);
  });
});

describe('"Add all", run against the app', () => {
  it('posts twenty a request until the list is done, tallies what each answered, and shows each answer as it lands', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Fiction');
    await createItem(env.DB, { libraryId: shelf.id, mediaType: 'book', title: 'Already Here', isbn13: isbn(7), details: '{}' });
    const codes = Array.from({ length: 25 }, (_, i) => isbn(i));
    codes.forEach((code, i) => (i === 24 ? intercept(OL, (p) => p.startsWith(`/search.json?q=isbn%3A${code}&`), json({ numFound: 0, docs: [] })) : known(code, `Book ${i}`)));
    intercept(GB, (p) => p.startsWith(`/books/v1/volumes?q=isbn%3A${codes[24]}&`), json({ totalItems: 0 }));
    const posted: string[][] = [];
    const seen: number[] = [];
    const tally = await batch.run({
      codes: entries(codes),
      libraryId: String(shelf.id),
      scanOwner: await scanQueueOwner(env.SESSION_SECRET, ravi),
      fetch: toApp(ravi, posted),
      onBatch: (data, sent) => {
        seen.push(sent.length);
        expect((data as { added: unknown[] }).added.length + (data as { already: unknown[] }).already.length + (data as { notFound: unknown[] }).notFound.length).toBe(sent.length);
      },
    });
    expect(posted.map((b) => b.length)).toEqual([20, 5]);
    expect(posted.flat()).toEqual(codes);
    expect(seen).toEqual([20, 5]);
    expect(tally.sent).toBe(25);
    expect(tally.failed).toBeNull();
    expect(tally.added.map((a) => a.title)).toEqual(codes.filter((_, i) => i !== 7 && i !== 24).map((_, n) => `Book ${n < 7 ? n : n + 1}`));
    expect(tally.already).toEqual([{ code: isbn(7), id: expect.any(Number), title: 'Already Here' }]);
    expect(tally.notFound).toEqual([isbn(24)]);
    expect(tally.notices).toEqual([`No book found for ISBN ${isbn(24)}. Try the search tab or add manually.`]);
    expect(await rows<{ n: number }>('SELECT count(*) AS n FROM items WHERE added_by = ?1', ravi.id)).toEqual([{ n: 23 }]);
  });

  it('stops at a batch the server refuses, with its reason — what landed stands, the rest was never sent', async () => {
    const ravi = await member('ravi');
    const shelf = await createLibrary(env.DB, 'Fiction');
    const codes = Array.from({ length: 45 }, (_, i) => isbn(i));
    codes.slice(0, 20).forEach((code, i) => known(code, `Book ${i}`));
    const posted: string[][] = [];
    const tally = await batch.run({ codes: entries(codes), libraryId: shelf.id, scanOwner: await scanQueueOwner(env.SESSION_SECRET, ravi), fetch: toApp(ravi, posted, { failAt: 1 }) });
    expect(posted.map((b) => b.length)).toEqual([20, 20]); // the third was never sent
    expect(tally.sent).toBe(20);
    expect(tally.added).toHaveLength(20);
    expect(tally.failed).toEqual({ at: 20, why: 'refused' });
    expect(await rows<{ n: number }>('SELECT count(*) AS n FROM items')).toEqual([{ n: 20 }]);
  });

  it('reads a lapsed session as signed out, and another account’s stamp as the server’s refusal', async () => {
    const ravi = await member('ravi');
    const priya = await member('priya');
    const shelf = await createLibrary(env.DB, 'Fiction');
    let tally = await batch.run({ codes: entries([isbn(1)]), libraryId: shelf.id, scanOwner: 'x', fetch: toApp(ravi, [], { signedOutAt: 0 }) });
    expect(tally).toMatchObject({ sent: 0, added: [], failed: { at: 0, why: 'Signed out — reload and sign in.' } });
    // the stamp is priya's, the session ravi's: the server refuses, nothing is looked up, and the loop says why
    tally = await batch.run({ codes: entries([isbn(1)]), libraryId: shelf.id, scanOwner: await scanQueueOwner(env.SESSION_SECRET, priya), fetch: toApp(ravi, []) });
    expect(tally.failed).toEqual({ at: 0, why: 'Those scans were held for whoever was signed in before. Nothing was added — reload Add items.' });
    expect(await rows('SELECT id FROM items')).toEqual([]);
  });
});
