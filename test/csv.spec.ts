import { describe, expect, it } from 'vitest';
import { csvEscape, csvLine, looksLikeGoodreads, mapGoodreadsRow, mapLibibRow } from '../src/lib/csv';

describe('csv escaping', () => {
  it('quotes only when needed and doubles quotes', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(null)).toBe('');
    expect(csvLine(['a', 'b,c'])).toBe('a,"b,c"\r\n');
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
    const details = JSON.parse(m.item.details as string);
    expect(details.goodreads_book_id).toBe('18541');
    expect(details.average_rating).toBe('4.32');
    expect(details.binding).toBe('Paperback');
    expect(details).not.toHaveProperty('bookshelves_with_positions'); // duplicate, dropped
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
});
