import { describe, expect, it } from 'vitest';
import { classifyBarcode, cleanDescription, creatorsMatch, mergeBookCandidates, searchableTitle, titlesMatch } from '../src/metadata';
import type { Candidate } from '../src/metadata';

describe('barcode routing', () => {
  it('routes ISBN EANs to books', () => {
    expect(classifyBarcode('9780060512750')).toEqual({ kind: 'isbn13', code: '9780060512750' });
    expect(classifyBarcode('979-8-88-777666-5')).toEqual({ kind: 'isbn13', code: '9798887776665' });
    expect(classifyBarcode('0060512750')).toEqual({ kind: 'isbn13', code: '0060512750' }); // ISBN-10
  });

  it('routes other EAN/UPC codes to Discogs', () => {
    expect(classifyBarcode('074646493922')).toEqual({ kind: 'upc', code: '074646493922' }); // 12-digit UPC-A
    expect(classifyBarcode('5099750442229')).toEqual({ kind: 'upc', code: '5099750442229' }); // non-978 EAN-13
  });

  it('rejects junk', () => {
    expect(classifyBarcode('hello')).toBeNull();
    expect(classifyBarcode('123')).toBeNull();
    expect(classifyBarcode('')).toBeNull();
  });
});

describe('book candidate merging', () => {
  const ol: Candidate = {
    mediaType: 'book',
    title: 'OL Title',
    creators: 'OL Author',
    publisher: 'OL Press',
    details: {},
    provider: 'openlibrary',
  };
  const gb: Candidate = {
    mediaType: 'book',
    title: 'GB Title',
    description: 'A description only Google has.',
    coverUrl: 'https://books.google/cover.jpg',
    length: 320,
    details: {},
    provider: 'googlebooks',
  };

  it('prefers Open Library bibliographically, fills gaps from Google Books', () => {
    const merged = mergeBookCandidates(ol, gb)!;
    expect(merged.title).toBe('OL Title');
    expect(merged.creators).toBe('OL Author');
    expect(merged.description).toBe('A description only Google has.');
    expect(merged.coverUrl).toBe('https://books.google/cover.jpg');
    expect(merged.length).toBe(320);
    expect(merged.provider).toBe('openlibrary+googlebooks');
  });

  it('handles one-sided and empty results', () => {
    expect(mergeBookCandidates(ol, null)?.provider).toBe('openlibrary');
    expect(mergeBookCandidates(null, gb)?.provider).toBe('googlebooks');
    expect(mergeBookCandidates(null, null)).toBeNull();
  });
});

describe('title matching (cover backfill pass 2 guard)', () => {
  it('accepts the same book across case, punctuation, and subtitles', () => {
    expect(titlesMatch('The Dispossessed', 'the dispossessed')).toBe(true);
    expect(titlesMatch('The Dispossessed: An Ambiguous Utopia', 'The Dispossessed')).toBe(true);
    expect(titlesMatch('Café Europa', 'Cafe Europa')).toBe(true);
  });

  it('rejects different books and too-short titles', () => {
    expect(titlesMatch('Dune', 'Neuromancer')).toBe(false);
    expect(titlesMatch('It', 'It')).toBe(false); // <3 chars normalized — deliberately cautious
  });

  it('requires the author surname to appear in the candidate creators', () => {
    expect(creatorsMatch('Italo Calvino', 'Italo Calvino')).toBe(true);
    expect(creatorsMatch('F. Scott Fitzgerald', 'Francis Scott Fitzgerald')).toBe(true);
    expect(creatorsMatch('Ursula K. Le Guin, David Mitchell', 'Ursula K. Le Guin')).toBe(true);
    expect(creatorsMatch('Italo Calvino', 'Алёна Четвертакова')).toBe(false); // the live bug this guards
    expect(creatorsMatch('Italo Calvino', undefined)).toBe(false);
    expect(creatorsMatch(null, 'Anyone At All')).toBe(true); // no author on file — title match stands alone
  });
});

describe('author guard and generational suffixes', () => {
  it('matches a record that omits Jr., Sr. or a numeral', () => {
    expect(creatorsMatch('Kurt Vonnegut Jr.', 'Kurt Vonnegut')).toBe(true);
    expect(creatorsMatch('Dean Koontz III', 'Dean Koontz')).toBe(true);
    expect(creatorsMatch('Martin Luther King Jr.', 'Martin Luther King')).toBe(true);
  });

  it('still rejects a different author', () => {
    expect(creatorsMatch('Kurt Vonnegut Jr.', 'Ursula K. Le Guin')).toBe(false);
    expect(creatorsMatch('Kurt Vonnegut Jr.', 'Kurt Andersen')).toBe(false);
  });
});

describe('provider query cleaning (cover backfill pass 2)', () => {
  it('drops series, issue and bracket noise, and spells out an ampersand', () => {
    expect(searchableTitle('Neuromancer (Sprawl, #1)')).toBe('Neuromancer');
    expect(searchableTitle('The Silence of the Lambs  (Hannibal Lecter)')).toBe('The Silence of the Lambs');
    expect(searchableTitle('Jonathan Strange & Mr Norrell')).toBe('Jonathan Strange and Mr Norrell');
    expect(searchableTitle('Neonomicon #1')).toBe('Neonomicon');
    expect(searchableTitle('Lectures from Colombo to Almora (Hard bound)')).toBe('Lectures from Colombo to Almora');
  });

  it('searches the main title, not the subtitle', () => {
    expect(searchableTitle('Disciplined Entrepreneurship: 24 Steps to a Successful Startup')).toBe(
      'Disciplined Entrepreneurship',
    );
  });

  it('keeps the original when cleaning would leave too little to search for', () => {
    expect(searchableTitle('We (Canons)')).toBe('We (Canons)');
    expect(searchableTitle('It')).toBe('It');
  });
});

describe('description cleaning', () => {
  it('strips reference-style links and blockquote markers', () => {
    const raw =
      "[Comment by Kim Stanley Robinson, on The Guardian's website][1]:\n" +
      'The Left Hand of Darkness by Ursula K Le Guin (1969)\n\n' +
      '> One of my favourite novels is The Left Hand of Darkness, and it still serves very well.\n\n' +
      '  [1]: https://example.com/guardian';
    const out = cleanDescription(raw);
    expect(out).not.toContain('][1]');
    expect(out).not.toContain('>');
    expect(out).toContain("Comment by Kim Stanley Robinson, on The Guardian's website:");
    expect(out).toContain('One of my favourite novels');
    expect(out).not.toContain('https://example.com');
  });

  it('strips Open Library markdown and its source footnote', () => {
    const raw = '**Small Is Beautiful** is a collection of essays by [E. F. Schumacher](https://example.com).\n\n([source][1])\n\n  [1]: https://openlibrary.org/x';
    expect(cleanDescription(raw)).toBe('Small Is Beautiful is a collection of essays by E. F. Schumacher.');
  });

  it('strips the HTML Google Books returns', () => {
    expect(cleanDescription('<p>A novel about <i>everything</i> &amp; nothing at all, at length.</p>')).toBe(
      'A novel about everything & nothing at all, at length.',
    );
  });

  it('rejects a stub too short to be worth storing', () => {
    expect(cleanDescription('First published 1944.')).toBeNull();
    expect(cleanDescription('   ')).toBeNull();
    expect(cleanDescription(null)).toBeNull();
  });
});
