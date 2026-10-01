// Search operators (ARCH.md §16 #80): author:, title:, tag:, status:, year:, lang: and type: on the search box —
// parsed once, the indexed ones as FTS5 column filters, the rest as WHERE clauses inside the one id query. An
// unknown prefix, or a value an operator can't read, is searched as text.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addPastRead, createItem, createLibrary, searchItems, setItemTags, updateSiteSettings, startRead } from '../src/db/queries';
import type { NewItem } from '../src/db/schema';
import { ftsMatch, hasFilters, languageCode, MAX_PER_OPERATOR, parseSearch } from '../src/lib/search';
import { as, html, member } from './member-helpers';

describe('parseSearch', () => {
  it('splits plain words, and reads each operator', () => {
    const p = parseSearch('left hand author:"le guin" title:dispossessed tag:SF status:read year:1974 lang:English type:book');
    expect(p).toEqual({
      text: ['left', 'hand'],
      author: ['le guin'],
      title: ['dispossessed'],
      tags: ['sf'],
      statuses: ['completed'],
      years: [{ from: 1974, to: 1974 }],
      languages: ['en'],
      types: ['book'],
    });
  });

  it('reads the status, type and language words people use, and a year range either way round', () => {
    expect(parseSearch('status:unread status:reading status:dnf').statuses).toEqual(['not_started', 'in_progress', 'abandoned']);
    expect(parseSearch('status:re-reading').statuses).toEqual(['in_progress']);
    expect(parseSearch('type:game type:records type:film').types).toEqual(['boardgame', 'vinyl', 'movie']);
    expect(parseSearch('lang:hi lang:Tamil language:fr').languages).toEqual(['hi', 'ta', 'fr']);
    expect(parseSearch('year:2010-2019 year:2019-2010 year:1990').years).toEqual([
      { from: 2010, to: 2019 },
      { from: 1990, to: 1990 },
    ]);
    expect(parseSearch('creator:tolkien by:"n. k. jemisin"').author).toEqual(['tolkien', 'n. k. jemisin']);
    expect(languageCode('Hindi')).toBe('hi');
    expect(languageCode('klingon')).toBeNull();
  });

  it('keeps an unknown prefix, and a value an operator cannot read, as the text it is', () => {
    const p = parseSearch('re:zero status:maybe year:soon lang:klingon type:scroll 12:30');
    expect(p.text).toEqual(['re:zero', 'status:maybe', 'year:soon', 'lang:klingon', 'type:scroll', '12:30']);
    expect(hasFilters(p)).toBe(false);
    // a quoted plain phrase is its words, as before operators
    expect(parseSearch('"left hand"').text).toEqual(['left', 'hand']);
    // an operator with nothing after it is nothing
    expect(parseSearch('tag: author:""')).toEqual(parseSearch(''));
  });

  it('reads the same value once, and keeps at most ten values per operator — a pasted query is a search, not an error', () => {
    expect(parseSearch('status:read status:completed status:finished').statuses).toEqual(['completed']);
    expect(parseSearch('year:2019 year:2019-2019').years).toEqual([{ from: 2019, to: 2019 }]);
    const many = parseSearch(Array.from({ length: 40 }, (_, i) => `tag:t${i} year:${1900 + i} lang:${['hi', 'ta', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'ar'][i % 12]}`).join(' '));
    expect(many.tags).toHaveLength(MAX_PER_OPERATOR);
    expect(many.years).toHaveLength(MAX_PER_OPERATOR);
    expect(many.languages).toHaveLength(MAX_PER_OPERATOR);
    expect(many.tags[0]).toBe('t0');
  });

  it('builds the FTS5 expression: prefixes everywhere, column filters for title: and author:, syntax characters dropped', () => {
    expect(ftsMatch(parseSearch('left hand'))).toBe('"left"* "hand"*');
    expect(ftsMatch(parseSearch('author:"le guin" title:"the dispossessed"'))).toBe('title:"the dispossessed"* creators:"le guin"*');
    expect(ftsMatch(parseSearch('o*k "quo^te" author:a:b'))).toBe('"o k"* "quo te"* creators:"a b"*');
    expect(ftsMatch(parseSearch('tag:fantasy status:unread'))).toBe('');
    expect(hasFilters(parseSearch('tag:fantasy'))).toBe(true);
  });
});

async function seed() {
  const lib = await createLibrary(env.DB, 'Books');
  const item = (values: Partial<NewItem>) => createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: 'x', ...values });
  const leftHand = await item({ title: 'The Left Hand of Darkness', creators: 'Ursula K. Le Guin', published: '1969' });
  const dispossessed = await item({ title: 'The Dispossessed', creators: 'Ursula K. Le Guin', published: '1974-05-01', language: 'en' });
  const earthsea = await item({ title: 'A Wizard of Earthsea', creators: 'Ursula K. Le Guin', published: 'November 1968' });
  const hindi = await item({ title: 'Godaan', creators: 'Premchand', published: '1936', language: 'hi' });
  const game = await item({ title: 'Earthsea: the board game', mediaType: 'boardgame', creators: 'Someone Else', published: '2019' });
  await setItemTags(env.DB, leftHand.id, ['sf', 'hainish']);
  await setItemTags(env.DB, dispossessed.id, ['sf', 'hainish', 'anarchism']);
  await setItemTags(env.DB, earthsea.id, ['fantasy']);
  return { lib, leftHand, dispossessed, earthsea, hindi, game };
}

const ids = (items: Array<{ id: number }>) => items.map((i) => i.id).sort((a, b) => a - b);

describe('searchItems with operators', () => {
  it('narrows a text search by tag, type and author, and author: looks only at creators', async () => {
    const { leftHand, dispossessed, earthsea, game } = await seed();
    expect(ids(await searchItems(env.DB, 'the tag:hainish'))).toEqual(ids([leftHand, dispossessed]));
    expect(ids(await searchItems(env.DB, 'the tag:hainish tag:anarchism'))).toEqual([dispossessed.id]);
    expect(ids(await searchItems(env.DB, 'earthsea type:game'))).toEqual([game.id]);
    expect(ids(await searchItems(env.DB, 'earthsea type:book'))).toEqual([earthsea.id]);
    // "earthsea" is in the game's title, not its creators: author: does not find it
    expect(ids(await searchItems(env.DB, 'author:earthsea'))).toEqual([]);
    expect(ids(await searchItems(env.DB, 'author:"le guin" title:wizard'))).toEqual([earthsea.id]);
    // an unknown prefix is text, and finds nothing by that text here
    expect(await searchItems(env.DB, 'wizard re:zero')).toEqual([]);
  });

  it('reads the year an item was published, at the start or the end of what the field says, singly or as a range', async () => {
    const { leftHand, dispossessed, earthsea, hindi, game } = await seed();
    expect(ids(await searchItems(env.DB, 'year:1969'))).toEqual([leftHand.id]);
    expect(ids(await searchItems(env.DB, 'year:1974'))).toEqual([dispossessed.id]);
    expect(ids(await searchItems(env.DB, 'year:1968'))).toEqual([earthsea.id]);
    expect(ids(await searchItems(env.DB, 'year:1960-1969'))).toEqual(ids([leftHand, earthsea]));
    expect(ids(await searchItems(env.DB, 'year:1930-1939 year:2019'))).toEqual(ids([hindi, game]));
    expect(await searchItems(env.DB, 'year:2000')).toEqual([]);
  });

  it('matches lang: by code or name, reading an item with no language of its own as the household default', async () => {
    const { leftHand, dispossessed, earthsea, hindi, game } = await seed();
    expect(ids(await searchItems(env.DB, 'lang:hi'))).toEqual([hindi.id]);
    expect(ids(await searchItems(env.DB, 'lang:Hindi'))).toEqual([hindi.id]);
    // nothing set: the household's default is English
    expect(ids(await searchItems(env.DB, 'lang:en'))).toEqual(ids([leftHand, dispossessed, earthsea, game]));
    // a Tamil household: the items without a language of their own are Tamil; the one marked English stays English
    await updateSiteSettings(env.DB, { language: 'ta' });
    expect(ids(await searchItems(env.DB, 'lang:tamil'))).toEqual(ids([leftHand, earthsea, game]));
    expect(ids(await searchItems(env.DB, 'lang:en'))).toEqual([dispossessed.id]);
  });

  it('filters by status as the shelf does — In progress holds a re-read — and a query of operators alone lists by title', async () => {
    const { leftHand, dispossessed, earthsea } = await seed();
    const ravi = await member('ravi');
    await addPastRead(env.DB, leftHand.id, { status: 'completed', beganOn: null, endedOn: '2025-01-10' }, ravi.id);
    await addPastRead(env.DB, dispossessed.id, { status: 'completed', beganOn: null, endedOn: '2025-02-10' }, ravi.id);
    await startRead(env.DB, dispossessed.id, '2026-09-01', ravi.id); // a re-read: Completed and In progress both
    await startRead(env.DB, earthsea.id, '2026-09-02', ravi.id);
    expect(ids(await searchItems(env.DB, 'status:read'))).toEqual(ids([leftHand, dispossessed]));
    expect(ids(await searchItems(env.DB, 'status:reading'))).toEqual(ids([dispossessed, earthsea]));
    expect((await searchItems(env.DB, 'status:unread')).map((i) => i.title)).toEqual(['Earthsea: the board game', 'Godaan']);
    // with text, rank orders; "Read by" still narrows inside the query
    expect(ids(await searchItems(env.DB, 'the status:reading'))).toEqual([dispossessed.id]);
    expect(ids(await searchItems(env.DB, 'status:read', 50, { readerId: ravi.id, mode: 'finished' }))).toEqual(ids([leftHand, dispossessed]));
    expect(ids(await searchItems(env.DB, 'tag:sf', 50, { readerId: ravi.id, mode: 'reading' }))).toEqual([dispossessed.id]);
  });

  it('answers a pasted query of two hundred operators with a page, inside D1\'s hundred bound parameters', async () => {
    const { earthsea } = await seed();
    const admin = await member('admin', 'admin');
    const q = Array.from({ length: 200 }, (_, i) => (i % 2 ? `year:${1900 + i}-${1901 + i}` : `type:book tag:fantasy lang:${['hi', 'ta', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'zh'][i % 11]}`)).join(' ');
    // the real values come first, so the cap keeps them; everything after the tenth of each operator is ignored
    expect(ids(await searchItems(env.DB, `year:1968 lang:en status:unread status:read status:reading status:abandoned ${q}`))).toEqual([earthsea.id]);
    const res = await as(admin, `/search?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
  });

  it('limits a query of operators alone as it limits a text search', async () => {
    const { lib } = await seed();
    for (let i = 0; i < 5; i++) await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', details: '{}', title: `Padding ${i}` });
    expect((await searchItems(env.DB, 'type:book', 3)).length).toBe(3);
  });
});

describe('the Search page', () => {
  it('explains the operators beside the box, and shows what they find', async () => {
    const { earthsea } = await seed();
    const admin = await member('admin', 'admin');
    const page = await html(admin, '/search?q=tag%3Afantasy+status%3Aunread');
    expect(page).toContain('aria-describedby="search-help"');
    expect(page).toContain('<code>author:</code>');
    expect(page).toContain(`/items/${earthsea.id}`);
    expect(page).toContain('1 RESULT FOR');
    const none = await html(admin, '/search?q=tag%3Anothing');
    expect(none).toContain('Nothing found for');
  });
});
