// New from your authors (ARCH.md §16 #78): the authors a member has finished, and on a click their works from Open
// Library — one request, cached in the isolate for a day — with what the catalog holds marked.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addPastRead, createLibrary, finishedAuthors } from '../src/db/queries';
import { clearDiscoverCache } from '../src/routes/discover';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { as, book, html, member } from './member-helpers';

const OL = 'https://openlibrary.org';
// every outbound fetch is stubbed: an unmatched request throws rather than reaching Open Library, and one queued
// and unused fails the test — which is what proves the second look answers from the cache
beforeEach(() => activateFetchMock());
afterEach(() => assertNoPendingInterceptors());

async function household() {
  clearDiscoverCache();
  const asha = await member('asha', 'admin');
  const ravi = await member('ravi');
  const shelf = await createLibrary(env.DB, 'Fiction');
  return { asha, ravi, shelf };
}
const finished = (itemId: number, who: number) => addPastRead(env.DB, itemId, { status: 'completed', beganOn: null, endedOn: '2026-01-10' }, who);

describe('the authors you have finished', () => {
  it('are the creators of your own finished books, most first, split into people — nobody else’s', async () => {
    const { asha, ravi, shelf } = await household();
    const a = await book(asha, { libraryId: shelf.id, title: 'A Wizard of Earthsea', creators: 'Le Guin, Ursula K.' });
    const b = await book(asha, { libraryId: shelf.id, title: 'The Dispossessed', creators: 'Ursula K. Le Guin' });
    const c = await book(asha, { libraryId: shelf.id, title: 'Good Omens', creators: 'Terry Pratchett, Neil Gaiman' });
    const d = await book(asha, { libraryId: shelf.id, title: 'Unfinished', creators: 'Someone Else' });
    await finished(a.id, ravi.id);
    await finished(b.id, ravi.id);
    await finished(c.id, ravi.id);
    await finished(d.id, asha.id); // asha's, not ravi's
    expect(await finishedAuthors(env.DB, ravi.id)).toEqual([
      { name: 'Ursula K. Le Guin', books: 2 },
      { name: 'Neil Gaiman', books: 1 },
      { name: 'Terry Pratchett', books: 1 },
    ]);
    const text = await html(ravi, '/discover');
    expect(text).toContain('3 AUTHORS YOU HAVE FINISHED');
    expect(text.indexOf('Ursula K. Le Guin')).toBeLessThan(text.indexOf('Neil Gaiman'));
    expect(text).not.toContain('Someone Else');
    expect(text).toContain('href="/creators/Ursula%20K.%20Le%20Guin"');
    expect(await html(asha, '/')).toContain('href="/discover"');
    const fresh = await member('mira');
    expect(await html(fresh, '/discover')).toContain('Finish a book, and its author appears here.');
  });
});

describe('looking an author up', () => {
  const docs = (titles: Array<[string, number, string?]>) => json({ docs: titles.map(([title, year, isbn]) => ({ key: `/works/${title}`, title, author_name: ['Ursula K. Le Guin'], first_publish_year: year, ...(isbn ? { isbn: [isbn] } : {}) })) });

  it('asks Open Library once, marks what is here by ISBN or title, offers the rest, and answers from the cache after', async () => {
    const { asha, ravi, shelf } = await household();
    const have = await book(asha, { libraryId: shelf.id, title: 'The Dispossessed', creators: 'Ursula K. Le Guin', isbn13: '9780061054884' });
    await book(asha, { libraryId: shelf.id, title: 'A Wizard of Earthsea', creators: 'Le Guin, Ursula K.' });
    await finished(have.id, ravi.id);
    intercept(OL, (p) => p.startsWith('/search.json?author=Ursula%20K.%20Le%20Guin&sort=new&'), docs([
      ['The Dispossessed', 1974, '9780061054884'],
      ['A Wizard of Earthsea', 1968],
      ['The Lathe of Heaven', 1971, '9781416556961'],
      ['Always Coming Home', 1985],
    ]));
    const res = await as(ravi, '/discover', { body: { author: 'Ursula K. Le Guin' } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Ursula K. Le Guin: 2 not on your shelves · 2 already here');
    expect(text).toContain('Looked up');
    expect(text).toContain('The Lathe of Heaven');
    expect(text).toContain('Always Coming Home');
    // the two already here are marked, by ISBN and by title alone
    expect((text.match(/In your catalog/g) ?? []).length).toBe(2);
    // the rest come as Add-page cards, with a shelf, Add, Log and Want
    expect(text).toContain('action="/items"');
    expect(text).toContain('Log — not owned');
    // a second look asks nothing: the one interceptor is used up, and an unmatched request would throw
    const again = await as(ravi, '/discover', { body: { author: 'ursula k. le guin' } });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('The Lathe of Heaven');
  });

  it('says so when Open Library lists nothing, and ignores an empty name', async () => {
    const { ravi } = await household();
    intercept(OL, (p) => p.startsWith('/search.json?author=Nobody%20Known&'), json({ docs: [] }));
    expect(await (await as(ravi, '/discover', { body: { author: 'Nobody Known' } })).text()).toContain('Open Library lists nothing for that name right now.');
    expect((await as(ravi, '/discover', { body: { author: '   ' } })).headers.get('location')).toBe('/discover');
  });
});
