// A series' missing volumes from Open Library (ARCH.md §16 #79): one request on a click, sorted against the
// household's own numbering, which always wins.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLibrary, updateItemWithTags, updateSeries } from '../src/db/queries';
import { clearSeriesFindCache } from '../src/routes/series';
import { activateFetchMock, assertNoPendingInterceptors, intercept, json } from './fetch-mock';
import { as, book, html, member, rows } from './member-helpers';

const OL = 'https://openlibrary.org';
beforeEach(() => activateFetchMock());
afterEach(() => assertNoPendingInterceptors());

const doc = (title: string, position: string | null, isbn?: string, series = 'The Expanse') => ({
  key: `/works/${title}`,
  title,
  author_name: ['James S. A. Corey'],
  first_publish_year: 2011,
  ...(isbn ? { isbn: [isbn] } : {}),
  ...(position === null ? { series_name: [series] } : { series_name: [series], series_position: [position] }),
});

async function expanse() {
  clearSeriesFindCache();
  const asha = await member('asha', 'admin');
  const shelf = await createLibrary(env.DB, 'Fiction');
  const one = await book(asha, { libraryId: shelf.id, title: 'Leviathan Wakes', creators: 'James S. A. Corey', isbn13: '9780316129084' });
  await updateItemWithTags(env.DB, one.id, {}, [], undefined, asha.id, undefined, { name: 'The Expanse', number: 1, total: 9 });
  const three = await book(asha, { libraryId: shelf.id, title: 'Abaddon’s Gate', creators: 'James S. A. Corey' });
  await updateItemWithTags(env.DB, three.id, {}, [], undefined, asha.id, undefined, { name: 'The Expanse', number: 3 });
  const [series] = await rows<{ id: number }>("SELECT id FROM series WHERE name = 'The Expanse'");
  return { asha, shelf, seriesId: series!.id };
}

describe('finding a series’ gaps', () => {
  it('offers the numbers missing with this series’ name, counts what is here, lists the unnumbered apart, and never changes the household’s numbering', async () => {
    const { asha, seriesId } = await expanse();
    const page = await html(asha, `/series/${seriesId}`);
    expect(page).toContain('Find the missing volumes on Open Library');
    expect(page).toContain(`method="get" action="/series/${seriesId}/find"`);
    intercept(OL, (p) => p.startsWith('/search.json?q=The%20Expanse&'), json({ docs: [
      doc('Leviathan Wakes', '1', '9780316129084'), // here by ISBN and by number
      doc('Caliban’s War', '2'), // a gap
      doc('Abaddon’s Gate', '3'), // here by number (and title)
      doc('Cibola Burn', '4', '9780316217620'), // a gap
      doc('Tiamat’s Wrath', '8'), // a gap
      doc('Persepolis Rising', '10'), // past the total of 9: not a gap
      doc('The Churn', null), // no number known
      doc('Unrelated', '2', undefined, 'Another Series'), // another series entirely: dropped
    ] }));
    const text = await (await as(asha, `/series/${seriesId}/find`)).text();
    expect(text).toContain('From Open Library: 3 volumes fill a gap · 2 with no number it knows · 2 already here');
    expect(text).toContain('Looked up on Open Library');
    for (const t of ['Caliban’s War', 'Cibola Burn', 'Tiamat’s Wrath', 'The Churn', 'Persepolis Rising']) expect(text).toContain(t);
    expect(text).not.toContain('Unrelated');
    // each offer carries this series' name and Open Library's number, as hidden fields on an Add-page card
    expect(text).toContain('name="seriesName" value="The Expanse"');
    expect(text).toContain('name="seriesNumber" value="2"');
    expect(text).toContain('name="seriesNumber" value="4"');
    expect(text).not.toContain('name="seriesNumber" value="1"'); // nothing here is offered again
    expect(text.indexOf('Caliban’s War')).toBeLessThan(text.indexOf('The Churn')); // gaps first, then the unnumbered
    // the household's series is untouched
    expect(await rows("SELECT name, total FROM series WHERE id = ?1", seriesId)).toEqual([{ name: 'The Expanse', total: 9 }]);
    expect(await rows('SELECT series_number AS n FROM items WHERE series_id = ?1 ORDER BY n', seriesId)).toEqual([{ n: 1 }, { n: 3 }]);
    // a second look answers from the cache: the one interceptor is used up, and another request would throw
    expect(await (await as(asha, `/series/${seriesId}/find`)).text()).toContain('Caliban’s War');
  });

  it('says so when Open Library has nothing or doesn’t answer, never caching the failure, and 404s a series that isn’t there', async () => {
    const { asha, seriesId } = await expanse();
    await updateSeries(env.DB, seriesId, 'Expanse', 9);
    intercept(OL, (p) => p.startsWith('/search.json?q=Expanse&'), { status: 503, body: 'busy' });
    expect(await (await as(asha, `/series/${seriesId}/find`)).text()).toContain('Open Library didn’t answer — try again in a moment.');
    intercept(OL, (p) => p.startsWith('/search.json?q=Expanse&'), json({ docs: [doc('Leviathan Wakes', '1', '9780316129084')] }));
    expect(await (await as(asha, `/series/${seriesId}/find`)).text()).toContain('lists nothing for this series that isn’t here already');
    expect((await as(asha, '/series/999999/find')).status).toBe(404);
  });
});
