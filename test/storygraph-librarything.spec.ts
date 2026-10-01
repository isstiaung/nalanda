// StoryGraph and LibraryThing imports (ARCH.md §16 #87): two mappers beside Goodreads', recognised by their columns,
// matched and merged the same way — the importer's own reads, rating and review onto the book already here, the
// rest as Not owned entries, or owned copies where the file says so.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createItem, createLibrary } from '../src/db/queries';
import { looksLikeGoodreads, looksLikeLibraryThing, looksLikeNalandaExport, looksLikeStoryGraph, mapLibraryThingRow, mapStoryGraphRow } from '../src/lib/csv';
import { toPublicItem } from '../src/lib/share';
import { toConnectionItem } from '../src/federation/items';
import type { Item } from '../src/db/schema';
import app from '../src/index';
import { member, readsOf, rows } from './member-helpers';

const STORYGRAPH_HEADER =
  'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Character- or Plot-Driven?,Strong Character Development?,Loveable Characters?,Diverse Characters?,Flawed Characters?,Star Rating,Review,Content Warnings,Content Warning Description,Tags,Owned?';

/** A StoryGraph row as the export writes it, by column. */
function storygraph(values: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = {};
  for (const h of STORYGRAPH_HEADER.split(',')) row[h] = values[h] ?? '';
  return row;
}

const LIBRARYTHING_HEADER =
  'Book ID,Title,Sort Character,Primary Author,Primary Author Role,Secondary Author,Secondary Author Role,Publication,Date,Review,Rating,Comment,Private Comment,Summary,Media,Physical Description,Weight,Height,Thickness,Length,Dimensions,Page Count,LCCN,Acquired,Date Started,Date Read,Barcode,BCID,Tags,Collections,Languages,Original Languages,LC Classification,ISBN,ISBNs,Subjects,Dewey Decimal,Dewey Wording,Other Call Number,Copies,Source,Entry Date,From Where,OCLC,Work id,Lending Patron,Lending Status,Lending Start,Lending End';

function librarything(values: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = {};
  for (const h of LIBRARYTHING_HEADER.split(',')) row[h] = values[h] ?? '';
  return row;
}

describe('recognising the files', () => {
  it('tells the four exports apart by their columns', () => {
    const sg = STORYGRAPH_HEADER.split(',');
    const lt = LIBRARYTHING_HEADER.split(',');
    expect(looksLikeStoryGraph(sg)).toBe(true);
    expect(looksLikeLibraryThing(lt)).toBe(true);
    expect(looksLikeStoryGraph(lt)).toBe(false);
    expect(looksLikeLibraryThing(sg)).toBe(false);
    expect(looksLikeGoodreads(sg)).toBe(false);
    expect(looksLikeGoodreads(lt)).toBe(false);
    expect(looksLikeNalandaExport(sg)).toBe(false);
    // a libib file has none of their columns
    expect(looksLikeStoryGraph(['Title', 'Creators', 'EAN_ISBN13'])).toBe(false);
    expect(looksLikeLibraryThing(['Title', 'Creators', 'EAN_ISBN13'])).toBe(false);
  });
});

describe('a StoryGraph row', () => {
  it('maps a finished, owned book: every dated read, the rating in halves, the format, the tags, the rest in details', () => {
    const m = mapStoryGraphRow(
      storygraph({
        'Title': 'The Fifth Season (The Broken Earth, #1)',
        'Authors': 'N. K. Jemisin',
        'ISBN/UID': '9780356508191',
        'Format': 'audiobook',
        'Read Status': 'read',
        'Date Added': '2022-03-01',
        'Last Date Read': '2024/03/22',
        'Dates Read': '2022/03/06-2022/03/22, 2024/03/01-2024/03/22',
        'Read Count': '2',
        'Moods': 'dark, mysterious, tense',
        'Pace': 'medium',
        'Character- or Plot-Driven?': 'Plot',
        'Star Rating': '4.25',
        'Review': 'Stunning.',
        'Content Warnings': 'moderate: violence',
        'Tags': 'hugo-winners, sf',
        'Owned?': 'Yes',
      }),
    )!;
    expect(m.item.title).toBe('The Fifth Season');
    expect(m.series).toMatchObject({ name: 'The Broken Earth', number: 1 });
    expect(m.item.creators).toBe('N. K. Jemisin');
    expect(m.item.isbn13).toBe('9780356508191');
    expect(m.item.formats).toBe('audiobook');
    expect(m.item.copies).toBe(1);
    expect(m.item.rating).toBe(9); // 4.25 stars → 8.5 → 9 of 10
    expect(m.item.review).toBe('Stunning.');
    expect(m.item.status).toBe('completed');
    expect(m.item.completedOn).toBe('2024-03-22');
    expect(m.reads).toEqual([
      { status: 'completed', beganOn: '2022-03-06', endedOn: '2022-03-22' },
      { status: 'completed', beganOn: '2024-03-01', endedOn: '2024-03-22' },
    ]);
    expect(m.goodreads).toEqual({ shelf: 'completed', dateRead: '2024-03-22', dateStarted: '2024-03-01', readCount: 2 });
    expect(m.tags).toEqual(['hugo-winners', 'sf']);
    // the reader's impressions are private notes, never details (which share pages publish); the day added stays
    expect(m.item.notes).toBe('StoryGraph — moods: dark, mysterious, tense; pace: medium; driven by: Plot; content warnings: moderate: violence');
    const details = JSON.parse(m.item.details as string);
    expect(details).not.toHaveProperty('storygraph_date_added'); // the item's own date added now (§16 #90)
    expect(m.item.addedAt).toBe('2022-03-01 00:00:00');
    for (const gone of ['moods', 'pace', 'character_or_plot_driven', 'content_warnings', 'title', 'authors', 'read_status', 'star_rating', 'review', 'tags', 'owned', 'dates_read']) expect(details).not.toHaveProperty(gone);
  });

  it('reads the other statuses: currently reading with an open read, did not finish, to-read; an unowned ebook; a UID that isn’t an ISBN', () => {
    const reading = mapStoryGraphRow(storygraph({ 'Title': 'Open', 'Read Status': 'currently-reading', 'Dates Read': '2023/01/02-2023/01/20, 2026/09/01-', 'Owned?': 'No', 'Format': 'ebook', 'ISBN/UID': 'a1b2c3d4e5f6', 'Star Rating': '0.0' }))!;
    expect(reading.item.status).toBe('completed'); // finished once and being read again: Completed, re-reading (§16 #64)
    expect(reading.reads).toEqual([
      { status: 'completed', beganOn: '2023-01-02', endedOn: '2023-01-20' },
      { status: 'in_progress', beganOn: '2026-09-01', endedOn: null },
    ]);
    expect(reading.goodreads).toMatchObject({ shelf: 'in_progress', dateRead: '2023-01-20', dateStarted: '2026-09-01' });
    expect(reading.item.copies).toBe(0);
    expect(reading.item.formats).toBe('ebook');
    expect(reading.item.rating).toBeNull();
    expect(reading.item.isbn13).toBeNull();
    expect(JSON.parse(reading.item.details as string).storygraph_uid).toBe('a1b2c3d4e5f6');
    const dnf = mapStoryGraphRow(storygraph({ 'Title': 'Dropped', 'Read Status': 'did-not-finish', 'Dates Read': '2024/05/01-2024/05/10' }))!;
    expect(dnf.item.status).toBe('abandoned');
    expect(dnf.reads).toEqual([{ status: 'abandoned', beganOn: '2024-05-01', endedOn: '2024-05-10' }]);
    const toRead = mapStoryGraphRow(storygraph({ 'Title': 'Later', 'Read Status': 'to-read' }))!;
    expect(toRead.item.status).toBe('not_started');
    expect(toRead.reads).toEqual([]);
    // without dated reads, the row's status and last read make them, as Goodreads' do
    const undated = mapStoryGraphRow(storygraph({ 'Title': 'Once', 'Read Status': 'read', 'Last Date Read': '2021/12/31', 'Read Count': '1' }))!;
    expect(undated.reads).toEqual([{ status: 'completed', beganOn: null, endedOn: '2021-12-31' }]);
    expect(mapStoryGraphRow(storygraph({ 'Title': '' }))).toBeNull();
  });

  it('tops the dated reads up to Read Count with undated finishes, as a book with no dates and a merge are', () => {
    const m = mapStoryGraphRow(storygraph({ 'Title': 'Often', 'Read Status': 'read', 'Dates Read': '2022/01/04-2022/01/19, 2023/03/01-2023/03/02', 'Read Count': '5' }))!;
    expect(m.reads).toEqual([
      { status: 'completed', beganOn: '2022-01-04', endedOn: '2022-01-19' },
      { status: 'completed', beganOn: '2023-03-01', endedOn: '2023-03-02' },
      { status: 'completed', beganOn: null, endedOn: null },
      { status: 'completed', beganOn: null, endedOn: null },
      { status: 'completed', beganOn: null, endedOn: null },
    ]);
    expect(m.goodreads).toMatchObject({ readCount: 5 });
    // a count below the dated reads adds nothing; one that isn't a number is the dated reads' own
    expect(mapStoryGraphRow(storygraph({ 'Title': 'X', 'Read Status': 'read', 'Dates Read': '2022/01/04-2022/01/19, 2023/03/01-2023/03/02', 'Read Count': '1' }))!.reads).toHaveLength(2);
    expect(mapStoryGraphRow(storygraph({ 'Title': 'X', 'Read Status': 'read', 'Dates Read': '2022/01/04-2022/01/19', 'Read Count': 'lots' }))!.reads).toHaveLength(1);
  });
});

describe('a LibraryThing row', () => {
  it('maps a read, owned book: the author turned round, the ISBNs, publisher and year, pages, media, both comments, collections, language', () => {
    const m = mapLibraryThingRow(
      librarything({
        'Book ID': '67202782',
        'Title': 'The Left Hand of Darkness',
        'Primary Author': 'Le Guin, Ursula K.',
        'Secondary Author': 'Mitchell, David|Someone Else',
        'Publication': 'Ace Books (2000), Mass Market Paperback, 304 pages',
        'Date': '2000',
        'Review': 'A marvel.',
        'Rating': '4.5',
        'Comment': 'Signed copy',
        'Private Comment': 'Keep in the study',
        'Media': 'Paperback',
        'Page Count': '304 ',
        'Date Started': '2026-01-02',
        'Date Read': '2026-01-20',
        'Tags': 'sf, hainish',
        'Collections': 'Your library|Favorites',
        'Languages': 'English',
        'ISBN': '[0441478123]',
        'ISBNs': '[0441478123, 9780441478125]',
        'Subjects': 'Science fiction|Gender',
        'Copies': '2',
        'Entry Date': '2010-11-27',
        'Work id': '243179',
      }),
    )!;
    expect(m.item.creators).toBe('Ursula K. Le Guin, David Mitchell, Someone Else');
    expect(m.item.isbn13).toBe('9780441478125');
    expect(m.item.isbn10Upc).toBe('0441478123');
    expect(m.item.publisher).toBe('Ace Books');
    expect(m.item.published).toBe('2000');
    expect(m.item.length).toBe(304);
    expect(m.item.formats).toBe('paperback');
    expect(m.item.rating).toBe(9);
    expect(m.item.review).toBe('A marvel.');
    expect(m.item.notes).toBe('Signed copy\n\nKeep in the study');
    expect(m.item.copies).toBe(2);
    expect(m.item.language).toBe('en');
    expect(m.item.status).toBe('completed');
    expect(m.reads).toEqual([{ status: 'completed', beganOn: '2026-01-02', endedOn: '2026-01-20' }]);
    expect(m.tags).toEqual(['sf', 'hainish']);
    const details = JSON.parse(m.item.details as string);
    expect(details.librarything_book_id).toBe('67202782');
    expect(details).not.toHaveProperty('librarything_entry_date'); // the item's own date added now (§16 #90)
    expect(m.item.addedAt).toBe('2010-11-27 00:00:00');
    expect(details.subjects).toBe('Science fiction|Gender');
    expect(details.work_id).toBe('243179');
    for (const gone of ['title', 'primary_author', 'review', 'rating', 'comment', 'private_comment', 'collections', 'isbns', 'copies']) expect(details).not.toHaveProperty(gone);
  });

  it('reads the collections: currently reading, read but unowned, wishlist, to read; a series column; a bare catalogue entry is an owned copy', () => {
    const reading = mapLibraryThingRow(librarything({ 'Title': 'Open', 'Primary Author': 'Pratchett, Terry', 'Date Started': '2026-09-01', 'Collections': 'Your library, Currently reading' }))!;
    expect(reading.item.status).toBe('in_progress');
    expect(reading.reads).toEqual([{ status: 'in_progress', beganOn: '2026-09-01', endedOn: null }]);
    expect(reading.item.copies).toBe(1);
    const unowned = mapLibraryThingRow(librarything({ 'Title': 'Borrowed once', 'Primary Author': 'X', 'Collections': 'Read but unowned' }))!;
    expect(unowned.item.status).toBe('completed');
    expect(unowned.item.copies).toBe(0);
    expect(unowned.reads).toEqual([{ status: 'completed', beganOn: null, endedOn: null }]);
    const wish = mapLibraryThingRow(librarything({ 'Title': 'Wanted', 'Primary Author': 'X', 'Collections': 'Wishlist', 'Copies': '1' }))!;
    expect(wish.item.status).toBe('not_started');
    expect(wish.item.copies).toBe(0);
    const toRead = mapLibraryThingRow(librarything({ 'Title': 'Soon', 'Primary Author': 'X', 'Collections': 'Your library|To read' }))!;
    expect(toRead.item.status).toBe('not_started');
    expect(toRead.item.copies).toBe(1);
    const bare = mapLibraryThingRow(librarything({ 'Title': 'Just catalogued', 'Primary Author': 'X' }))!;
    expect(bare.item.copies).toBe(1);
    expect(bare.item.status).toBe('not_started');
    const inSeries = mapLibraryThingRow({ ...librarything({ 'Title': 'The Colour of Magic', 'Primary Author': 'Pratchett, Terry' }), 'Series': 'Discworld', 'Volume': '1' })!;
    expect(inSeries.series).toEqual({ name: 'Discworld', number: 1, total: null });
    expect(inSeries.item.title).toBe('The Colour of Magic');
    expect(mapLibraryThingRow(librarything({ 'Title': '' }))).toBeNull();
  });
});

describe('what never reaches details', () => {
  it('drops a LibraryThing row’s money, condition, provenance and call number from details — the call number is the location — and nothing of them is published', () => {
    const full: Record<string, string> = {};
    for (const h of [...LIBRARYTHING_HEADER.split(','), 'List Price', 'Value', 'Condition', 'Purchase Price', 'Date Acquired', 'Reading Dates', 'Series', 'Volume', 'ASIN']) full[h] = `v-${h}`;
    Object.assign(full, { Title: 'Everything filled', 'Primary Author': 'X', ISBNs: '[9780441478125]', Rating: '4', Copies: '1', 'Page Count': '10', Date: '2001', 'Other Call Number': 'Study, 2nd shelf', 'List Price': '$30', Value: '$12', Condition: 'Fair', Acquired: '2020-01-01', 'From Where': 'A bookshop', Source: 'amazon.com' });
    const m = mapLibraryThingRow(full)!;
    expect(m.item.location).toBe('Study, 2nd shelf');
    const details = JSON.parse(m.item.details as string) as Record<string, string>;
    for (const key of ['list_price', 'value', 'condition', 'purchase_price', 'acquired', 'date_acquired', 'from_where', 'source', 'other_call_number', 'lending_patron', 'lending_status', 'barcode', 'comment', 'private_comment', 'review', 'rating', 'copies']) expect(details, key).not.toHaveProperty(key);
    // and through both whitelists, with the item as it would be stored
    const item = { id: 1, libraryId: 1, mediaType: 'book', title: m.item.title, creators: 'X', coverKey: null, copies: 1, status: 'not_started', rating: null, review: null, details: m.item.details, formats: '', language: null, originalTitle: null, publisher: null, published: null, description: null, length: null, isbn13: null, isbn10Upc: null, notes: m.item.notes, location: m.item.location, rereading: false, progressPage: null, readCount: 0, beganOn: null, completedOn: null, addedAt: '2026-10-01 00:00:00', updatedAt: '2026-10-01 00:00:00', addedBy: null, seriesId: null, seriesNumber: null, purchasePrice: null, purchaseCurrency: null, mediaCondition: null, sleeveCondition: null } as unknown as Item;
    const published = JSON.stringify(toPublicItem(item)) + JSON.stringify(toConnectionItem(item));
    for (const secret of ['Study, 2nd shelf', '$30', '$12', 'Fair', 'A bookshop', 'amazon.com', 'v-Lending Patron', 'v-Barcode', 'list_price', 'condition']) expect(published, secret).not.toContain(secret);
  });
});

describe('through the Import page', () => {
  async function call(cookie: string, body: unknown) {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('http://nalanda.test/api/import', { method: 'POST', headers: { cookie, origin: 'http://nalanda.test', 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      env,
      ctx,
    );
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
  }

  it('recognises both, merges onto the book already here by ISBN and adds the rest as the importer’s own reading', async () => {
    const lib = await createLibrary(env.DB, 'Books');
    const ravi = await member('ravi');
    const here = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'The Fifth Season', creators: 'N. K. Jemisin', isbn13: '9780356508191', details: '{}', copies: 1 });
    const sgRows = [
      storygraph({ 'Title': 'The Fifth Season', 'Authors': 'N. K. Jemisin', 'ISBN/UID': '9780356508191', 'Read Status': 'read', 'Dates Read': '2024/03/01-2024/03/22', 'Read Count': '1', 'Star Rating': '5.0', 'Review': 'Stunning.', 'Owned?': 'Yes' }),
      storygraph({ 'Title': 'A Closed and Common Orbit', 'Authors': 'Becky Chambers', 'ISBN/UID': '9781473621435', 'Read Status': 'to-read', 'Owned?': 'No' }),
    ];
    const preview = await call(ravi.cookie, { libraryId: lib.id, rows: sgRows, dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ format: 'storygraph', mapped: 2, merged: 1, fresh: 1 });
    const done = await call(ravi.cookie, { libraryId: lib.id, rows: sgRows });
    expect(done.json).toMatchObject({ inserted: 1, merged: 1 });
    expect(await readsOf(here.id)).toMatchObject([{ status: 'completed', beganOn: '2024-03-01', endedOn: '2024-03-22', readerId: ravi.id }]);
    const review = await rows<{ rating: number; review: string; user_id: number }>('SELECT rating, review, user_id FROM reviews WHERE item_id = ?1', here.id);
    expect(review).toEqual([{ rating: 10, review: 'Stunning.', user_id: ravi.id }]);
    const fresh = await rows<{ title: string; copies: number; status: string }>("SELECT title, copies, status FROM items WHERE title = 'A Closed and Common Orbit'");
    expect(fresh).toEqual([{ title: 'A Closed and Common Orbit', copies: 0, status: 'not_started' }]);
    // the household's notes on a matched book are kept, with the file's impressions added after them
    const noted = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'The Long Way to a Small, Angry Planet', creators: 'Becky Chambers', isbn13: '9781473619814', details: '{}', notes: 'Signed at the launch.' });
    const moody = [storygraph({ 'Title': 'The Long Way to a Small, Angry Planet', 'Authors': 'Becky Chambers', 'ISBN/UID': '9781473619814', 'Read Status': 'read', 'Moods': 'hopeful', 'Pace': 'medium', 'Owned?': 'Yes' })];
    await call(ravi.cookie, { libraryId: lib.id, rows: moody });
    const notesAfter = (await rows<{ notes: string }>('SELECT notes FROM items WHERE id = ?1', noted.id))[0]!.notes;
    expect(notesAfter).toBe('Signed at the launch.\n\nStoryGraph — moods: hopeful; pace: medium');
    await call(ravi.cookie, { libraryId: lib.id, rows: moody });
    expect((await rows<{ notes: string }>('SELECT notes FROM items WHERE id = ?1', noted.id))[0]!.notes).toBe(notesAfter); // byte for byte
    // the same file again changes nothing
    const again = await call(ravi.cookie, { libraryId: lib.id, rows: sgRows });
    expect(again.json).toMatchObject({ inserted: 0, merged: 2 });
    expect(await readsOf(here.id)).toHaveLength(1);
    // and a LibraryThing file, likewise
    const ltRows = [librarything({ 'Title': 'The Fifth Season', 'Primary Author': 'Jemisin, N. K.', 'ISBNs': '[9780356508191]', 'Date Read': '2024-03-22', 'Rating': '5', 'Collections': 'Your library' })];
    const lt = await call(ravi.cookie, { libraryId: lib.id, rows: ltRows, dryRun: true });
    expect(lt.json).toMatchObject({ format: 'librarything', mapped: 1, merged: 1, fresh: 0 });
  });

  it('a merge keeps every dated range and the read count, as an insert does — and a second import adds nothing', async () => {
    const lib = await createLibrary(env.DB, 'Books');
    const ravi = await member('ravi');
    const here = await createItem(env.DB, { libraryId: lib.id, mediaType: 'book', title: 'Piranesi', creators: 'Susanna Clarke', isbn13: '9781635575637', details: '{}', copies: 1 });
    const dates = (r: { beganOn: string | null; endedOn: string | null }) => [r.beganOn, r.endedOn];
    const twice = [storygraph({ 'Title': 'Piranesi', 'Authors': 'Susanna Clarke', 'ISBN/UID': '9781635575637', 'Read Status': 'read', 'Dates Read': '2019/01/01-2019/02/01, 2022/01/04-2022/01/19', 'Read Count': '2', 'Owned?': 'Yes' })];
    expect((await call(ravi.cookie, { libraryId: lib.id, rows: twice })).json).toMatchObject({ merged: 1, inserted: 0, reads: 2 });
    // every range, not the last with an undated stand-in for the first
    expect((await readsOf(here.id)).map(dates)).toEqual([
      ['2019-01-01', '2019-02-01'],
      ['2022-01-04', '2022-01-19'],
    ]);
    expect((await call(ravi.cookie, { libraryId: lib.id, rows: twice })).json).toMatchObject({ merged: 1, reads: 0 });
    expect(await readsOf(here.id)).toHaveLength(2);
    // Read Count past the dated ranges tops a new book up, and a re-import of it adds nothing more
    const often = [storygraph({ 'Title': 'Often', 'Authors': 'Someone', 'Read Status': 'read', 'Dates Read': '2022/01/04-2022/01/19, 2023/03/01-2023/03/02', 'Read Count': '5', 'Owned?': 'No' })];
    expect((await call(ravi.cookie, { libraryId: lib.id, rows: often })).json).toMatchObject({ inserted: 1, reads: 5 });
    const fresh = (await rows<{ id: number }>("SELECT id FROM items WHERE title = 'Often'"))[0]!.id;
    expect(await readsOf(fresh)).toHaveLength(5);
    expect((await call(ravi.cookie, { libraryId: lib.id, rows: often })).json).toMatchObject({ merged: 1, reads: 0 });
    expect(await readsOf(fresh)).toHaveLength(5);
  });
});
