import { describe, expect, it } from 'vitest';
import type { Item } from '../src/db/schema';
import { newShareToken, toPublicItem } from '../src/lib/share';

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
      details: { series: 'Earthsea' },
    });
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
