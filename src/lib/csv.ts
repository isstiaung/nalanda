// CSV export formatting + libib import mapping.
// Parsing of uploaded CSV happens in the BROWSER (public/import.js) — the Worker only
// ever sees pre-parsed JSON rows (10 ms CPU budget, ARCH.md §12).
import type { Item, ItemStatus, MediaType, NewItem } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';

export const EXPORT_COLUMNS = [
  'library',
  'media_type',
  'title',
  'creators',
  'isbn13',
  'isbn10_upc',
  'publisher',
  'published',
  'description',
  'length',
  'status',
  'rating',
  'review',
  'notes',
  'tags',
  'copies',
  'began_on',
  'completed_on',
  'added_at',
  'details',
] as const;

export function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\r\n';
}

export function itemToCsvLine(item: Item, libraryName: string, tags: string[]): string {
  return csvLine([
    libraryName,
    item.mediaType,
    item.title,
    item.creators,
    item.isbn13,
    item.isbn10Upc,
    item.publisher,
    item.published,
    item.description,
    item.length,
    item.status,
    item.rating,
    item.review,
    item.notes,
    tags.join(', '),
    item.copies,
    item.beganOn,
    item.completedOn,
    item.addedAt,
    item.details === '{}' ? '' : item.details,
  ]);
}

// ---------- libib import mapping ----------

export type ImportOptions = {
  defaultType: MediaType;
  musicAsVinyl: boolean; // libib calls vinyl "music"; user opts in to remapping
};

export type MappedRow = {
  item: Omit<NewItem, 'libraryId' | 'addedBy'>;
  tags: string[];
};

/** Columns we map onto real item fields; everything else lands in `details` (lossless). */
const KNOWN_COLUMNS = new Set([
  'item_type',
  'type',
  'ean_isbn13',
  'isbn13',
  'upc_isbn10',
  'isbn10',
  'title',
  'creators',
  'first_name',
  'last_name',
  'description',
  'publisher',
  'publish_date',
  'published',
  'group',
  'tags',
  'notes',
  'length',
  'rating',
  'review',
  'status',
  'began',
  'completed',
  'added',
  'copies',
]);

function mapMediaType(raw: string | undefined, opts: ImportOptions): MediaType {
  const v = (raw ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (!v) return opts.defaultType;
  if (v === 'book' || v === 'books' || v === 'ebook') return 'book';
  if (v === 'boardgame' || v === 'boardgames') return 'boardgame';
  if (v === 'videogame' || v === 'videogames') return 'videogame';
  if (v === 'movie' || v === 'movies' || v === 'film' || v === 'dvd' || v === 'bluray') return 'movie';
  if (v === 'music' || v === 'album' || v === 'cd') return opts.musicAsVinyl ? 'vinyl' : 'music';
  if (v === 'vinyl' || v === 'record' || v === 'lp') return 'vinyl';
  return (MEDIA_TYPES as readonly string[]).includes(v) ? (v as MediaType) : opts.defaultType;
}

function mapStatus(raw: string | undefined): ItemStatus | undefined {
  const v = (raw ?? '').toLowerCase().trim();
  if (!v) return undefined;
  if (v === 'not begun' || v === 'not started') return 'not_started';
  if (v === 'in progress') return 'in_progress';
  return (ITEM_STATUSES as readonly string[]).includes(v.replace(' ', '_'))
    ? (v.replace(' ', '_') as ItemStatus)
    : undefined;
}

/** libib rates 0–5 (halves allowed); we store half-stars 0–10. */
function mapRating(raw: string | undefined): number | undefined {
  const n = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(10, Math.max(1, Math.round(n * 2)));
}

function digits(raw: string | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/** Maps one parsed libib CSV row (header → value) onto our item shape. Null if unusable. */
export function mapLibibRow(row: Record<string, string>, opts: ImportOptions): MappedRow | null {
  // normalize header keys once: lowercase, spaces → underscores
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.trim().toLowerCase().replace(/\s+/g, '_');
    if (key) r[key] = (v ?? '').trim();
  }

  const title = r['title'];
  if (!title) return null;

  const creators = r['creators'] || [r['first_name'], r['last_name']].filter(Boolean).join(' ') || undefined;
  const isbn13 = digits(r['ean_isbn13'] ?? r['isbn13']);
  const isbn10Upc = (r['upc_isbn10'] ?? r['isbn10'] ?? '').trim();
  const lengthNum = Number.parseInt(digits(r['length']), 10);
  const copiesNum = Number.parseInt(digits(r['copies']), 10);

  const details: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!KNOWN_COLUMNS.has(k) && v) details[k] = v;
  }

  const tags = (r['tags'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (r['group']) tags.push(r['group']); // libib "group" becomes a tag

  return {
    item: {
      mediaType: mapMediaType(r['item_type'] ?? r['type'], opts),
      title,
      creators: creators ?? null,
      isbn13: isbn13.length === 13 ? isbn13 : null,
      isbn10Upc: isbn10Upc || null,
      publisher: r['publisher'] || null,
      published: r['publish_date'] || r['published'] || null,
      description: r['description'] || null,
      length: Number.isFinite(lengthNum) && lengthNum > 0 ? lengthNum : null,
      status: mapStatus(r['status']) ?? 'not_started',
      rating: mapRating(r['rating']) ?? null,
      review: r['review'] || null,
      notes: r['notes'] || null,
      copies: Number.isFinite(copiesNum) && copiesNum >= 0 ? copiesNum : 1, // 0 = cataloged, not owned
      beganOn: r['began'] || null,
      completedOn: r['completed'] || null,
      details: Object.keys(details).length ? JSON.stringify(details) : '{}',
    },
    tags,
  };
}

// ---------- Goodreads import mapping ----------

/**
 * Columns we map onto item fields, plus pure duplicates we drop (author_l-f,
 * bookshelves_with_positions). Everything else lands in `details` (lossless).
 */
const KNOWN_GOODREADS = new Set([
  'book_id',
  'title',
  'author',
  'author_l-f',
  'additional_authors',
  'isbn',
  'isbn13',
  'my_rating',
  'publisher',
  'number_of_pages',
  'year_published',
  'date_read',
  'bookshelves',
  'bookshelves_with_positions',
  'exclusive_shelf',
  'my_review',
  'private_notes',
  'owned_copies',
]);

/** Goodreads' three built-in exclusive shelves — they map to status, not tags. */
const EXCLUSIVE_SHELVES = new Set(['read', 'currently-reading', 'to-read']);

/** Goodreads wraps ISBNs in an Excel guard: ="9780…" (or ="" when absent). */
function unguard(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  return v.startsWith('=') ? v.slice(1).replace(/^"|"$/g, '') : v;
}

/** Goodreads dates are 2024/01/15; we store 2024-01-15. */
function isoDate(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().replaceAll('/', '-');
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function goodreadsStatus(exclusive: string, shelves: string[]): ItemStatus {
  const dnf = (v: string) => v === 'abandoned' || v === 'dnf' || v === 'did-not-finish';
  if (dnf(exclusive)) return 'abandoned';
  if (exclusive === 'read') return 'completed';
  if (exclusive === 'currently-reading') return 'in_progress';
  if (shelves.some(dnf)) return 'abandoned';
  return 'not_started'; // to-read and anything unrecognized
}

/** A Goodreads export is recognized by its mandatory Exclusive Shelf column. */
export function looksLikeGoodreads(headers: string[]): boolean {
  return headers.some((h) => h.trim().toLowerCase().replace(/\s+/g, '_') === 'exclusive_shelf');
}

/** Maps one parsed Goodreads-export CSV row onto our item shape. Null if unusable. */
export function mapGoodreadsRow(row: Record<string, string>): MappedRow | null {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.trim().toLowerCase().replace(/\s+/g, '_');
    if (key) r[key] = (v ?? '').trim();
  }

  const title = r['title'];
  if (!title) return null;

  const isbn13 = unguard(r['isbn13']).replace(/\D/g, '');
  const isbn10 = unguard(r['isbn']).replace(/[^0-9Xx]/g, '');
  const ratingNum = Number.parseInt(r['my_rating'] ?? '', 10); // 0–5 whole stars, 0 = unrated
  const pages = Number.parseInt(r['number_of_pages'] ?? '', 10);
  const ownedNum = Number.parseInt(r['owned_copies'] ?? '', 10);

  const shelves = (r['bookshelves'] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const exclusive = r['exclusive_shelf'] ?? '';
  // Custom shelves — including a custom *exclusive* shelf like "to-re-read" — become
  // tags. Only the three built-ins are dropped: status captures them fully.
  const tagShelves = new Set(shelves);
  if (exclusive) tagShelves.add(exclusive);

  const details: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!KNOWN_GOODREADS.has(k) && v) details[k] = v;
  }
  if (r['book_id']) details['goodreads_book_id'] = r['book_id'];

  return {
    item: {
      mediaType: 'book',
      title,
      creators: [r['author'], r['additional_authors']].filter(Boolean).join(', ') || null,
      isbn13: isbn13.length === 13 ? isbn13 : null,
      isbn10Upc: isbn10 || null,
      publisher: r['publisher'] || null,
      published: r['year_published'] || r['original_publication_year'] || null,
      description: null,
      length: Number.isFinite(pages) && pages > 0 ? pages : null,
      status: goodreadsStatus(exclusive, shelves),
      rating: Number.isFinite(ratingNum) && ratingNum >= 1 && ratingNum <= 5 ? ratingNum * 2 : null,
      review: r['my_review'] ? r['my_review'].replace(/<br\s*\/?>/gi, '\n') : null,
      notes: r['private_notes'] || null,
      copies: Number.isFinite(ownedNum) && ownedNum > 0 ? ownedNum : 0, // default: reading log, not owned
      beganOn: null, // Goodreads doesn't export a start date
      completedOn: isoDate(r['date_read']),
      details: Object.keys(details).length ? JSON.stringify(details) : '{}',
    },
    tags: [...tagShelves].filter((sh) => !EXCLUSIVE_SHELVES.has(sh)),
  };
}
