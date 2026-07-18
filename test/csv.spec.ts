import { describe, expect, it } from 'vitest';
import { csvEscape, csvLine, mapLibibRow } from '../src/lib/csv';

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
