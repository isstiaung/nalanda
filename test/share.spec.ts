import { describe, expect, it } from 'vitest';
import type { Item, Share } from '../src/db/schema';
import { itemMatchesShare, newShareToken, toPublicItem } from '../src/lib/share';

const item: Item = {
  id: 7,
  libraryId: 1,
  mediaType: 'book',
  title: 'A Wizard of Earthsea',
  creators: 'Ursula K. Le Guin',
  isbn13: '9780547773742',
  isbn10Upc: null,
  publisher: 'Parnassus',
  published: '1968',
  description: 'Ged goes to wizard school before it was cool.',
  length: 183,
  coverKey: 'abc-123',
  status: 'completed',
  rating: 10,
  review: 'A favorite.',
  notes: 'SECRET: bought as a gift for dad, do not spoil',
  copies: 2,
  beganOn: '2026-01-01',
  completedOn: '2026-01-10',
  details: '{"series":"Earthsea"}',
  addedBy: 3,
  addedAt: '2026-01-01 10:00:00',
  updatedAt: '2026-01-10 10:00:00',
};

describe('share whitelist', () => {
  it('exposes exactly the public fields', () => {
    const pub = toPublicItem(item);
    expect(pub).toEqual({
      id: 7,
      mediaType: 'book',
      title: 'A Wizard of Earthsea',
      creators: 'Ursula K. Le Guin',
      publisher: 'Parnassus',
      published: '1968',
      description: 'Ged goes to wizard school before it was cool.',
      length: 183,
      coverKey: 'abc-123',
      rating: 10,
      review: 'A favorite.',
      inCollection: true,
      details: { series: 'Earthsea' },
    });
  });

  it('exposes ownership only as a boolean, never the copies count', () => {
    expect(toPublicItem({ ...item, copies: 0 }).inCollection).toBe(false);
    expect(toPublicItem({ ...item, copies: 3 }).inCollection).toBe(true);
    expect(toPublicItem(item)).not.toHaveProperty('copies');
  });

  it('never leaks private fields, even as keys', () => {
    const pub = toPublicItem(item) as unknown as Record<string, unknown>;
    for (const forbidden of ['notes', 'copies', 'addedBy', 'addedAt', 'isbn13', 'status', 'libraryId']) {
      expect(pub).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(pub)).not.toContain('SECRET');
  });

  it('tolerates broken details JSON', () => {
    expect(toPublicItem({ ...item, details: 'not json{' }).details).toEqual({});
  });
});

describe('share tokens', () => {
  it('are 32 hex chars and unique', () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('share view scope', () => {
  const view: Share = {
    id: 1,
    token: 't',
    name: 'Reviews',
    libraryId: 1,
    mediaType: 'book',
    status: null,
    owned: false,
    sort: 'title',
    createdAt: '2026-07-18 12:00:00',
  };

  it('admits only items matching every captured filter', () => {
    const notOwnedBook = { ...item, copies: 0 };
    expect(itemMatchesShare(view, notOwnedBook)).toBe(true);
    expect(itemMatchesShare(view, item)).toBe(false); // owned (copies 2) — outside an owned:false view
    expect(itemMatchesShare(view, { ...notOwnedBook, libraryId: 2 })).toBe(false);
    expect(itemMatchesShare(view, { ...notOwnedBook, mediaType: 'vinyl' })).toBe(false);
    expect(itemMatchesShare({ ...view, status: 'completed' }, notOwnedBook)).toBe(true); // fixture is completed
    expect(itemMatchesShare({ ...view, status: 'in_progress' }, notOwnedBook)).toBe(false);
  });

  it('null filters admit everything on that axis', () => {
    const wholeShelf: Share = { ...view, mediaType: null, status: null, owned: null };
    expect(itemMatchesShare(wholeShelf, item)).toBe(true);
    expect(itemMatchesShare({ ...wholeShelf, libraryId: null }, { ...item, libraryId: 99 })).toBe(true);
  });
});
