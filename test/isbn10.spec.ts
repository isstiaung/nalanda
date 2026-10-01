// An ISBN-10 at the Add page — the number older printings carry. It is a book, one ending in X included (stripped to
// nine digits it used to be asked of Discogs as a UPC), and its candidate carries the ISBN-13 it stands for — Google
// Books' when it names one, else derived — beside the ISBN-10 as scanned, so "In your catalog" knows the book again
// when its EAN-13 is scanned later, and the other way round.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibrary, getItem } from '../src/db/queries';
import type { Bindings } from '../src/env';
import app from '../src/index';
import type { Candidate } from '../src/metadata';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { as, html, member, type Member } from './member-helpers';

const OL = 'https://openlibrary.org';
const GB = 'https://www.googleapis.com';

/** Open Library's lean search answer for an ISBN: the one edition, or nothing. */
const olAnswers = (isbn: string, title: string | null) =>
  intercept(OL, (p) => p.startsWith(`/search.json?q=isbn%3A${isbn}&`), json({ numFound: title ? 1 : 0, docs: title ? [{ key: '/works/OL1W', title, author_name: ['William Strunk Jr.'], cover_i: 12 }] : [] }));

/** Google Books' answer for an ISBN: a volume with these identifiers, or nothing. */
const gbAnswers = (isbn: string, identifiers: Array<{ type: string; identifier: string }> | null) =>
  intercept(GB, (p) => p.startsWith(`/books/v1/volumes?q=isbn%3A${isbn}&`), json(identifiers ? { items: [{ volumeInfo: { title: 'The Elements of Style', industryIdentifiers: identifiers } }] } : {}));

/** The lookup as JSON, with a Discogs token set so a barcode read as a UPC would have somewhere to go. */
async function lookup(who: Member, barcode: string): Promise<{ candidates: Candidate[]; notices: string[] }> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://nalanda.test/api/lookup?barcode=${encodeURIComponent(barcode)}`, { headers: { cookie: who.cookie } }),
    { ...env, DISCOGS_TOKEN: 'discogs-token' } as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => activateFetchMock());
afterEach(() => assertNoPendingInterceptors());

describe('an ISBN-10 scanned or typed', () => {
  it('is a book whose candidate carries the ISBN-13 Google Books names, and the ISBN-10 as scanned', async () => {
    const asha = await member('asha');
    olAnswers('0060512750', 'The Elements of Style');
    gbAnswers('0060512750', [
      { type: 'ISBN_10', identifier: '0060512750' },
      { type: 'ISBN_13', identifier: '9780060512750' },
    ]);
    const { candidates, notices } = await lookup(asha, '0060512750');
    expect(notices).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ mediaType: 'book', title: 'The Elements of Style', isbn13: '9780060512750', isbn10Upc: '0060512750', provider: 'openlibrary+googlebooks' });
  });

  it('derives the ISBN-13 when Google Books names none: 978, the nine digits, the EAN check digit', async () => {
    const asha = await member('asha');
    olAnswers('0060512750', 'The Elements of Style');
    gbAnswers('0060512750', null);
    const { candidates } = await lookup(asha, '0060512750');
    expect(candidates[0]).toMatchObject({ isbn13: '9780060512750', isbn10Upc: '0060512750', provider: 'openlibrary' });
    // and from Google Books alone, whose volume names only the ten
    olAnswers('0441478123', null);
    gbAnswers('0441478123', [{ type: 'ISBN_10', identifier: '0441478123' }]);
    const left = await lookup(asha, '0441478123');
    expect(left.candidates[0]).toMatchObject({ isbn13: '9780441478125', isbn10Upc: '0441478123', provider: 'googlebooks' });
  });

  it('ending in X is still a book: asked of the book providers as typed, hyphens aside, and never of Discogs', async () => {
    const asha = await member('asha');
    olAnswers('080442957X', 'The Elements of Style');
    gbAnswers('080442957X', null);
    const { candidates, notices } = await lookup(asha, '0-8044-2957-x');
    expect(notices).toEqual([]);
    expect(candidates[0]).toMatchObject({ mediaType: 'book', isbn13: '9780804429573', isbn10Upc: '080442957X' });
    // the Discogs path would have been open (a token is set) and nothing asked it: every interceptor queued was a book provider's
  });

  it('adds the book under its ISBN-13, so a later EAN-13 scan finds it In your catalog — and an ISBN-10 scan finds one held by EAN', async () => {
    const asha = await member('asha', 'admin');
    const shelf = await createLibrary(env.DB, 'Books');
    olAnswers('0060512750', 'The Elements of Style');
    gbAnswers('0060512750', null);
    const [candidate] = (await lookup(asha, '0060512750')).candidates;
    const res = await as(asha, '/items', {
      body: { libraryId: String(shelf.id), mediaType: 'book', title: candidate!.title, isbn13: candidate!.isbn13!, isbn10Upc: candidate!.isbn10Upc! },
    });
    expect(res.status).toBe(302);
    const id = Number(res.headers.get('location')!.split('/').pop());
    expect(await getItem(env.DB, id)).toMatchObject({ isbn13: '9780060512750', isbn10Upc: '0060512750' });

    olAnswers('9780060512750', 'The Elements of Style');
    gbAnswers('9780060512750', null);
    expect(await html(asha, '/add/results?barcode=9780060512750')).toContain(`<a href="/items/${id}" class="pill in-catalog">In your catalog</a>`);

    // the other way round: held by its EAN-13 (an earlier scan, an import), found by its ISBN-10
    olAnswers('0060512750', 'The Elements of Style');
    gbAnswers('0060512750', null);
    expect(await html(asha, '/add/results?barcode=0060512750')).toContain(`<a href="/items/${id}" class="pill in-catalog">In your catalog</a>`);
  });
});
