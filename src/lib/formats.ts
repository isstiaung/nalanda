// Formats and editions (ARCH.md §16 #75): the forms an item is held in — hardcover and ebook, LP and CD — as a set
// of codes on the item, and "also held as", the other editions' identifiers that find the one item again. One item
// per work: editions are facts about it, never items of their own.
import type { MediaType } from '../db/schema';

export type Format = { code: string; label: string };

/** The formats each kind of item can be held in, in the order the pills and the form show them. */
export const FORMATS: Record<MediaType, Format[]> = {
  book: [
    { code: 'hardcover', label: 'Hardcover' },
    { code: 'paperback', label: 'Paperback' },
    { code: 'ebook', label: 'Ebook' },
    { code: 'audiobook', label: 'Audiobook' },
  ],
  vinyl: [
    { code: 'lp', label: 'LP' },
    { code: '7in', label: '7"' },
    { code: '10in', label: '10"' },
    { code: 'cd', label: 'CD' },
    { code: 'cassette', label: 'Cassette' },
  ],
  music: [
    { code: 'lp', label: 'LP' },
    { code: '7in', label: '7"' },
    { code: '10in', label: '10"' },
    { code: 'cd', label: 'CD' },
    { code: 'cassette', label: 'Cassette' },
    { code: 'digital', label: 'Digital' },
  ],
  boardgame: [
    { code: 'box', label: 'Boxed' },
    { code: 'expansion', label: 'Expansion' },
    { code: 'print-and-play', label: 'Print and play' },
    { code: 'digital', label: 'Digital' },
  ],
  movie: [
    { code: 'dvd', label: 'DVD' },
    { code: 'bluray', label: 'Blu-ray' },
    { code: 'digital', label: 'Digital' },
  ],
  videogame: [
    { code: 'physical', label: 'Physical' },
    { code: 'digital', label: 'Digital' },
  ],
  other: [],
};

/** Every code any kind may hold, for a filter that spans kinds. */
export const ALL_FORMATS: Format[] = Object.values(FORMATS)
  .flat()
  .filter((f, i, all) => all.findIndex((g) => g.code === f.code) === i);

const LABEL = new Map(ALL_FORMATS.map((f) => [f.code, f.label]));
export const formatLabel = (code: string): string => LABEL.get(code) ?? code;

/** The codes an item's `formats` column holds, in order. */
export function formatsOf(item: { formats?: string | null }): string[] {
  return (item.formats ?? '').split(',').filter(Boolean);
}

/**
 * The column's value from what a form or file says: only this kind's codes, each once, in the kind's order — so two
 * items held the same way compare equal, and a code typed into a spreadsheet for the wrong kind is dropped.
 */
export function normalizeFormats(mediaType: MediaType, codes: Iterable<string>): string {
  const wanted = new Set([...codes].map((c) => c.trim().toLowerCase()).filter(Boolean));
  return FORMATS[mediaType].filter((f) => wanted.has(f.code)).map((f) => f.code).join(',');
}

/** The `formats` CSV cell: the codes comma-joined, as stored. */
export const formatFormatsCell = (formats: string): string => formats;
/** A `formats` cell back into the column, for the row's kind: unknown codes dropped. */
export const parseFormatsCell = (mediaType: MediaType, cell: string | null | undefined): string =>
  normalizeFormats(mediaType, (cell ?? '').split(/[,;]/));

/**
 * What a provider says about the physical form, as a code or none: Open Library's `format` ("Paperback", "Mass Market
 * Paperback", "Hardcover", "Audio CD", "E-book"), Google Books has none. Only a clear word counts.
 */
export function formatFromPhysical(text: string | null | undefined): string | null {
  const t = (text ?? '').toLowerCase();
  if (!t) return null;
  if (/hardcover|hardback|library binding|board book/.test(t)) return 'hardcover';
  if (/paperback|softcover|trade paper|mass market/.test(t)) return 'paperback';
  if (/e-?book|kindle|epub|electronic/.test(t)) return 'ebook';
  if (/audio|mp3/.test(t)) return 'audiobook';
  return null;
}

/**
 * A record's formats from Discogs' pressing text ("2×Vinyl, LP, Album, Reissue", "CD, Album", "Cassette"): the
 * carriers it names, as codes, in the list's order.
 */
export function formatsFromPressing(text: string | null | undefined): string[] {
  const t = (text ?? '').toLowerCase();
  const out: string[] = [];
  if (/\blp\b|12"|12-inch|album/.test(t) && /vinyl|lp|12"/.test(t)) out.push('lp');
  if (/7"|7-inch/.test(t)) out.push('7in');
  if (/10"|10-inch/.test(t)) out.push('10in');
  if (/\bcd\b|cdr\b/.test(t)) out.push('cd');
  if (/cass/.test(t)) out.push('cassette');
  if (/\bfile\b|digital|flac|mp3/.test(t)) out.push('digital');
  return out;
}

// ---------- editions ----------

/** One "also held as" line, as the form, the file and the trash carry it. */
export type EditionDraft = { format: string | null; isbn: string | null; publisher: string | null; year: string | null };

export const MAX_EDITIONS_PER_ITEM = 20;
const MAX_TEXT = 200;

/** An edition's identifier: an ISBN-13, ISBN-10 or a barcode of 8 to 14 digits, hyphens and spaces dropped; else none. */
export function cleanEditionIsbn(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^\d{8,14}$/.test(digits) || /^\d{9}X$/.test(digits) ? digits : null;
}

/** A line as typed, tidied: a code only of this kind's, an identifier only as cleanEditionIsbn takes it; null when empty. */
export function cleanEdition(mediaType: MediaType, raw: Partial<Record<keyof EditionDraft, unknown>>): EditionDraft | null {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : null);
  const code = typeof raw.format === 'string' ? raw.format.trim().toLowerCase() : '';
  const format = FORMATS[mediaType].some((f) => f.code === code) ? code : null;
  const e: EditionDraft = { format, isbn: cleanEditionIsbn(raw.isbn), publisher: text(raw.publisher), year: text(raw.year)?.slice(0, 20) ?? null };
  return e.format || e.isbn || e.publisher || e.year ? e : null;
}

/** The `editions` CSV cell: a JSON array of lines, '' for none — as `purchase_links` is written. */
export function formatEditionsCell(editions: EditionDraft[]): string {
  return editions.length ? JSON.stringify(editions) : '';
}

/** An `editions` cell back, each line tidied as the form's are, at most MAX_EDITIONS_PER_ITEM; anything unreadable is none. */
export function parseEditionsCell(mediaType: MediaType, cell: string | null | undefined): EditionDraft[] {
  if (!cell?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: EditionDraft[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== 'object') continue;
    const line = cleanEdition(mediaType, e as Record<string, unknown>);
    if (line) out.push(line);
    if (out.length >= MAX_EDITIONS_PER_ITEM) break;
  }
  return out;
}
