// CSV export formatting + libib import mapping.
// Parsing of uploaded CSV happens in the BROWSER (public/import.js) — the Worker only
// ever sees pre-parsed JSON rows (10 ms CPU budget, ARCH.md §12).
import type { Item, ItemStatus, MediaType, NewItem } from '../db/schema';
import { ITEM_STATUSES, MEDIA_TYPES } from '../db/schema';
import { isRecord, parseGrade } from './condition';
import { cellPrice, isStoredPrice, minorToDecimal } from './money';
import {
  formatReadsCell,
  inDisplayOrder,
  parseReadsCell,
  readsFromColumns,
  reconcileGoodreads,
  summarizeReads,
  topUpReads,
  type CellRead,
  type GoodreadsReading,
  type PersonRead,
  type ReadDraft,
  type ReadRow,
} from './reads';
import { formatLinksCell, formatWantsCell, parseLinksCell, parseWantsCell, type CellWant, type LinkDraft } from './links';
import { formatEditionsCell, formatFormatsCell, parseEditionsCell, parseFormatsCell, type EditionDraft, normalizeFormats } from './formats';
import { DEFAULT_LANGUAGE, languageFromProvider } from './language';
import { formatQuotesCell, parseQuotesCell, type CellQuote, type PersonQuote } from './quotes';
import { formatLoansCell, parseLoansCell, type LoanDraft } from './loans';
import { formatPlaysCell, parsePlaysCell, type CellPlay, type PersonPlay } from './plays';
import { formatReviewsCell, parseReviewsCell, summarizeReviews, type CellReview, type PersonReview } from './reviews';
import { cleanSeriesName, formatSeriesNumber, parseSeriesNumber, parseSeriesTotal, parseTitleSeries, type SeriesDraft } from './series';
import { languageCode } from './search';

export const EXPORT_COLUMNS = [
  'library',
  'media_type',
  'title',
  'creators',
  'isbn13',
  'isbn10_upc',
  'publisher',
  'published',
  'series', // §16 #52: the series' name, the item's number in it, and how many volumes the series has
  'series_number',
  'series_total',
  'description',
  'length',
  'progress_page',
  'status',
  'rating',
  'review',
  'reviews',
  'notes',
  'location',
  'tags',
  'copies',
  'loans',
  'purchase_price', // what was paid (§16 #61): a plain decimal in major units — 302.50 — and the currency it was in
  'purchase_currency',
  'media_condition', // a record's grades (§16 #55): Discogs' codes, M to P — the sleeve's also Generic or No Cover
  'sleeve_condition',
  'began_on',
  'completed_on',
  'read_count',
  'reads',
  'plays',
  'added_at',
  'progress_history',
  'wanted_by',
  'purchase_links',
  'formats', // the forms it is held in (§16 #75): codes, comma-joined
  'editions', // "also held as": the other editions' format, ISBN, publisher, year, as JSON
  'language', // ISO 639-1 (§16 #76); blank reads as the household's default on import
  'original_title',
  'quotes', // quotes and highlights (§16 #77): JSON, each with its writer's username
  'borrowed', // borrowed from someone not on Nalanda (§16 #82): as the loans cell, the lender in the borrower's place
  'added_by', // who added it, by username as the reads cell names people; empty for a member removed since
  'details',
] as const;

/**
 * A text cell that a spreadsheet would read as a formula — one starting with `=`, `+`, `-`, `@`, a tab or a carriage
 * return — goes out with a `'` in front, the spreadsheets' own text marker (ARCH.md §16 #91): a title a connection sent
 * is the one place untrusted text reaches the export without passing a form. So that the round trip stays exact, a
 * cell that starts with `'` is guarded the same way, and mapNalandaRow strips exactly one leading `'` from every cell.
 * Numbers are never guarded: nothing a number says is a formula.
 */
const FORMULA_LEAD = /^[=+\-@\t\r']/;

export function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : typeof value === 'string' && FORMULA_LEAD.test(value) ? `'${value}` : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\r\n';
}

/**
 * The reading log in one cell: `page@timestamp`, oldest first, semicolon-separated, each followed by `#n` naming
 * its read by position in the `reads` cell (§16 #41) — none for a page from before reads, on a book with none.
 * Nothing here needs CSV quoting, and the whole history leaves with the export rather than only the latest page.
 */
export function progressHistoryCell(
  entries: { page: number; at: string; readId?: number | null }[],
  readPosition: Map<number, number> = new Map(),
): string {
  return entries
    .map((e) => {
      const n = e.readId !== null && e.readId !== undefined ? readPosition.get(e.readId) : undefined;
      return `${e.page}@${e.at}${n ? `#${n}` : ''}`;
    })
    .join(';');
}

/**
 * One item as a line of the export. `rating` and `review` are the household's summary (§16 #43); `reviews` holds
 * everyone's, and `reads` names each read's reader, so a re-import gives every member back their own. `loans` is
 * every loan, open and returned (§16 #57), and `plays` is the household's play log, oldest first, each date with
 * who logged it (§16 #54). `wanted_by` names whose want list it is on and since when, and `purchase_links` holds its
 * links (§16 #53). `addedBy` is the username of whoever added it — shown on the item's page, so it round-trips —
 * or null for a member removed since.
 */
export function itemToCsvLine(
  item: Item,
  libraryName: string,
  tags: string[],
  progress: { page: number; at: string; readId?: number | null }[] = [],
  reads: Array<ReadRow & { reader?: string | null }> = [],
  reviews: CellReview[] = [],
  loans: LoanDraft[] = [],
  plays: CellPlay[] = [],
  series: { name: string; total: number | null } | null = null,
  wants: Array<{ by: string; at: string }> = [],
  links: LinkDraft[] = [],
  editions: EditionDraft[] = [],
  quotes: CellQuote[] = [],
  borrows: LoanDraft[] = [],
  addedBy: string | null = null,
): string {
  const ordered = inDisplayOrder(reads);
  const position = new Map(ordered.map((r, i) => [r.id, i + 1]));
  return csvLine([
    libraryName,
    item.mediaType,
    item.title,
    item.creators,
    item.isbn13,
    item.isbn10Upc,
    item.publisher,
    item.published,
    series?.name,
    series && item.seriesNumber !== null ? formatSeriesNumber(item.seriesNumber) : '',
    series?.total,
    item.description,
    item.length,
    item.progressPage,
    item.status,
    item.rating,
    item.review,
    formatReviewsCell(reviews),
    item.notes,
    item.location,
    tags.join(', '),
    item.copies,
    formatLoansCell(loans),
    ...priceCells(item),
    item.mediaCondition,
    item.sleeveCondition,
    item.beganOn,
    item.completedOn,
    item.readCount,
    formatReadsCell(ordered),
    formatPlaysCell(plays),
    item.addedAt,
    progressHistoryCell(progress, position),
    formatWantsCell(wants),
    formatLinksCell(links),
    formatFormatsCell(item.formats ?? ''),
    formatEditionsCell(editions),
    item.language,
    item.originalTitle,
    formatQuotesCell(quotes),
    formatLoansCell(borrows),
    addedBy,
    item.details === '{}' ? '' : item.details,
  ]);
}

/** A price's two cells (§16 #61): "302.50" and "INR", or both empty — never an amount without its currency. */
function priceCells(item: Pick<Item, 'purchasePrice' | 'purchaseCurrency'>): [string, string] {
  if (!isStoredPrice(item.purchasePrice, item.purchaseCurrency)) return ['', ''];
  return [minorToDecimal(item.purchasePrice!, item.purchaseCurrency), item.purchaseCurrency];
}

/** A row's price (§16 #61), for the item: both columns, or neither. */
const rowPrice = (amount: string | undefined, currency: string | undefined, household: string | null | undefined) =>
  cellPrice(amount, currency, household) ?? { purchasePrice: null, purchaseCurrency: null };

/**
 * A row's grades (§16 #55), by code or by Discogs' wording, for a record only. A grade off the scale is dropped — never
 * kept in details, which share pages render: a condition is private.
 */
export function rowGrades(mediaType: MediaType, media: string | undefined, sleeve: string | undefined): Pick<NewItem, 'mediaCondition' | 'sleeveCondition'> {
  if (!isRecord(mediaType)) return { mediaCondition: null, sleeveCondition: null };
  return { mediaCondition: parseGrade(media ?? '', 'media') ?? null, sleeveCondition: parseGrade(sleeve ?? '', 'sleeve') ?? null };
}

// ---------- libib import mapping ----------

export type ImportOptions = {
  defaultType: MediaType;
  musicAsVinyl: boolean; // libib calls vinyl "music"; user opts in to remapping
  // the household's currency (§16 #61): what a price without a currency of its own — libib's `price` — was paid in
  currency?: string | null;
};

export type MappedRow = {
  item: Omit<NewItem, 'libraryId' | 'addedBy'>;
  tags: string[];
  // the row's reads, when the file says more than one status and pair of dates can (§16 #41); otherwise the
  // importer makes them from the item's status and dates. A Nalanda export names each read's reader (§16 #43).
  reads?: CellRead[];
  // a Nalanda export's `reviews`, each member's by name; otherwise the row's rating and review are the importer's
  reviews?: CellReview[];
  // a Nalanda export's `plays` (§16 #54), each with who logged it by name; any other file brings none
  plays?: CellPlay[];
  // a Nalanda export's `wanted_by` and `purchase_links` (§16 #53)
  wants?: CellWant[];
  links?: LinkDraft[];
  // "also held as" (§16 #75), a Nalanda export's `editions` column
  editions?: EditionDraft[];
  // quotes and highlights (§16 #77), by username as the reviews cell names people
  quotes?: CellQuote[];
  // borrowed from someone not on Nalanda (§16 #82), a Nalanda export's `borrowed` cell
  borrows?: LoanDraft[];
  // a Goodreads row's reading, which a merge reconciles with the reads already here
  goodreads?: GoodreadsReading;
  // a Nalanda export's `loans`, restored onto the item the row makes (§16 #57); libib and Goodreads have none
  loans?: LoanDraft[];
  // its series (§16 #52): a Nalanda export's columns, libib's "group", or the suffix a Goodreads title carries
  series?: SeriesDraft | null;
  // who added it, by username, as a Nalanda export names them; absent when the file names nobody (a former member,
  // an older export, any other format) — then the importer's, as every row's added_by was before
  addedBy?: string;
};

/**
 * Columns no mapper lets fall through into `details`, which share pages and connections render (§9), under every
 * name a file might carry them: Nalanda's own export missing a column and so read as libib's, or one of these added
 * to a Goodreads, StoryGraph or LibraryThing file before import. Where it lives and the notes on it (§16 #51), everyone's
 * reading and its dates (§16 #41, #43), loans and borrows (§16 #57, #82), when a game was played (§16 #54), who wants
 * what and where to buy it (§16 #53), the editions' identifiers (§16 #75), quotes (§16 #77), the copy's grades and
 * what it cost (§16 #55, #61), the copies count, and who added it. Each mapper maps what it can of these onto their own
 * columns (`location` and `notes` everywhere); the rest is dropped, never kept.
 */
export const PRIVATE_COLUMNS: ReadonlySet<string> = new Set([
  'location',
  'notes',
  'private_notes',
  'comment',
  'private_comment',
  'other_call_number',
  'began',
  'completed',
  'began_on',
  'completed_on',
  'date_read',
  'date_started',
  'last_date_read',
  'dates_read',
  'reading_dates',
  'read_count',
  'reads',
  'reviews',
  'progress_page',
  'progress_history',
  'loans',
  'borrowed',
  'lending_patron',
  'lending_status',
  'lending_start',
  'lending_end',
  'plays',
  'wanted_by',
  'purchase_links',
  'editions',
  'quotes',
  'media_condition',
  'sleeve_condition',
  'condition',
  'condition_description',
  'purchase_price',
  'purchase_currency',
  'list_price',
  'value',
  'original_purchase_date',
  'original_purchase_location',
  'acquired',
  'date_acquired',
  'from_where',
  'source',
  'copies',
  'owned_copies',
  'owned',
  'added_by',
  'recommended_for',
  'recommended_by',
  'barcode',
  'bcid',
]);

/**
 * A row's leftover columns, for `details`: what the mapper doesn't know by name, never a private column
 * (PRIVATE_COLUMNS), never an empty cell, and none `skip` names.
 */
function leftover(r: Record<string, string>, known: ReadonlySet<string>, skip: (key: string) => boolean = () => false): Record<string, string> {
  const details: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) if (v && !known.has(k) && !PRIVATE_COLUMNS.has(k) && !skip(k)) details[k] = v;
  return details;
}

/**
 * Columns we map onto real item fields; everything else lands in `details` (lossless) — except a private column by any
 * name, which PRIVATE_COLUMNS keeps out whatever the mapper.
 */
const KNOWN_COLUMNS = new Set([
  // Nalanda's own export: reading progress is private and must never fall through into `details`,
  // which share pages and connections render. Re-importing a Nalanda export doesn't restore it.
  'progress_page',
  'progress_history',
  // and each read, with its dates and reader, is as private as the dates columns (§16 #41, #43) — and so is
  // everyone's review with their name
  'read_count',
  'reads',
  'reviews',
  // and so is every loan, with its borrower (§9)
  'loans',
  // a record's condition is its own (§16 #55), never public: it maps to its columns, and never falls into details
  'media_condition',
  'sleeve_condition',
  // and the dates a game or record was played (§16 #54): share pages may say how many, never when
  'plays',
  // who wants what is theirs to publish, as a gift list, and a link belongs to "Where to buy" (§16 #53) — neither may
  // fall into details, which every share page renders
  'wanted_by',
  'purchase_links',
  // formats and editions (§16 #75) map to their own places: the editions' ISBNs are as private as the main one
  'formats',
  'editions',
  // its language and original title (§16 #76) map to their columns
  'language',
  'original_title',
  // and quotes (§16 #77), each with its writer, private until shared
  'quotes',
  // and what is borrowed from people (§16 #82), private like the loans
  'borrowed',
  // and what was paid (§16 #61): money is never published. libib's own `price` is mapped below, and stays in details
  // — which published pages strip of money — only when it can't be read as a price in the household's currency
  'purchase_price',
  'purchase_currency',
  'item_type',
  'type',
  'ean_isbn13',
  'isbn13',
  'upc_isbn10',
  'isbn10',
  // a Nalanda export that lost a column reads as libib: its type and UPC still map, and what names its shelf, its
  // time added or a series' size says nothing about the item
  'media_type',
  'isbn10_upc',
  'library',
  'added_at',
  'series_total',
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
  // where it lives (§16 #51) is private, like notes: a file's location column must never fall through into `details`,
  // which share pages and connections render
  'location',
  'length',
  'rating',
  'review',
  'status',
  'began',
  'completed',
  'added',
  'copies',
  // a file with series columns of its own (§16 #52) — libib's own word for a series is "group"
  'series',
  'series_number',
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

/** A location as the edit form keeps it: one line, spaces collapsed; blank is none. */
function oneLine(raw: string | undefined): string | null {
  return (raw ?? '').replace(/\s+/g, ' ').trim() || null;
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
  const isbn10Upc = (r['upc_isbn10'] ?? r['isbn10'] ?? r['isbn10_upc'] ?? '').trim();
  const lengthNum = Number.parseInt(digits(r['length']), 10);
  const copiesNum = Number.parseInt(digits(r['copies']), 10);

  // a file's own price columns (a Nalanda export missing a column reads as libib), else libib's `price`, which has no
  // currency: the household's. One that can't be read stays in details, which nothing published shows money from.
  const own = cellPrice(r['purchase_price'], r['purchase_currency'], opts.currency);
  const libibPrice = own ? null : cellPrice(r['price'], undefined, opts.currency);
  const price = own ?? libibPrice;
  // libib's `added`, the day it was catalogued there, dates the item here (§16 #90) when it reads as a date; a known
  // column, so it never lands in details
  const added = addedAtOf(r['added']);
  // libib's price stays in details only when it couldn't be read as one; published pages strip it there (§16 #61)
  const details = leftover(r, KNOWN_COLUMNS, (k) => k === 'price' && !!libibPrice);

  const tags = (r['tags'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  // libib "group" becomes a tag, as it always has — split on commas like every other tag cell, so a group of
  // "sci-fi, classics" isn't one tag the export writes and the next import splits
  tags.push(...(r['group'] ?? '').split(',').map((t) => t.trim()).filter(Boolean));
  // …and, since libib documents it as "what series an item belongs to", the item's series (§16 #52). libib keeps no
  // number; a file with a series column of its own is taken at its word first.
  const seriesName = cleanSeriesName(r['series'] || r['group']);
  const series = seriesName ? { name: seriesName, number: parseSeriesNumber(r['series_number']) ?? null } : null;

  const mediaType = mapMediaType(r['item_type'] ?? r['type'] ?? r['media_type'], opts);
  return {
    series,
    item: {
      mediaType,
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
      location: oneLine(r['location']),
      copies: Number.isFinite(copiesNum) && copiesNum >= 0 ? copiesNum : 1, // 0 = cataloged, not owned
      // libib's dates, or a Nalanda export's that lost a column and is read as libib (its reads cell is not read)
      beganOn: r['began'] || r['began_on'] || null,
      completedOn: r['completed'] || r['completed_on'] || null,
      ...added,
      details: Object.keys(details).length ? JSON.stringify(details) : '{}',
      ...rowGrades(mediaType, r['media_condition'], r['sleeve_condition']),
      ...(price ?? { purchasePrice: null, purchaseCurrency: null }),
    },
    tags,
  };
}

// ---------- Nalanda's own export ----------

/** Our /export.csv, recognized by column names neither libib nor Goodreads uses. */
export function looksLikeNalandaExport(headers: string[]): boolean {
  const have = new Set(headers.map((h) => h.trim().toLowerCase()));
  return ['media_type', 'isbn10_upc', 'began_on', 'completed_on', 'added_at', 'details'].every((c) => have.has(c));
}

const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * A row of our own export, mapped back exactly — the round trip every column promises (CLAUDE.md). Unlike a
 * libib row: the rating is already on our half-star 1–10 scale (libib's 0–5 mapping would double it), details
 * is our JSON merged back rather than nested as a string, and the type, identifiers and dates keep their own
 * columns. The shelf is the one chosen on the import form — `library` only names where a row came from — and
 * columns this format doesn't define are dropped, not kept in details (reading progress among them).
 */
export function mapNalandaRow(row: Record<string, string>, household: string | null = null, language: string = DEFAULT_LANGUAGE): MappedRow | null {
  const r: Record<string, string> = {};
  // exactly one leading `'` off every cell: the export's formula guard (§16 #91), also on a cell that began with one
  for (const [k, v] of Object.entries(row)) r[k.trim().toLowerCase()] = (v ?? '').replace(/^'/, '').trim();

  const title = r['title'];
  if (!title) return null;
  // Whole numbers only, and within reason: /^\d+$/ alone let "99999999999999999999" through as 1e20.
  const int = (raw: string | undefined, max: number) => {
    if (!/^\d+$/.test(raw ?? '')) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n <= max ? n : null;
  };
  const date = (raw: string | undefined) => (/^\d{4}-\d{2}-\d{2}$/.test(raw ?? '') ? raw! : null);
  const status = (ITEM_STATUSES as readonly string[]).includes(r['status'] ?? '') ? (r['status'] as ItemStatus) : 'not_started';
  const rating = int(r['rating'], 10);
  const length = int(r['length'], 100_000);
  const copies = int(r['copies'], 9_999);
  let detailsObj: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(r['details'] || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detailsObj = parsed as Record<string, unknown>;
  } catch {
    // not our JSON — keep none rather than guess
  }
  // An export from before reads carries Goodreads' Read Count in details, as the import once kept it: it becomes
  // reads and leaves details, as migration 0023 did to the catalog — details are public on share pages.
  let count = int(r['read_count'], Number.MAX_SAFE_INTEGER); // capped at MAX_READS_PER_ITEM by topUpReads
  if (!('reads' in r)) {
    const legacy = int(String(detailsObj['read_count'] ?? '').trim(), Number.MAX_SAFE_INTEGER);
    if (legacy !== null) {
      count = Math.max(count ?? 0, legacy);
      delete detailsObj['read_count'];
    }
  }
  const details = JSON.stringify(detailsObj);
  // The reads column is the whole history (§16 #41); status and the two dates are only its summary, so they speak
  // only for an export from before reads, or a row whose reads cell was emptied. A read count higher than the
  // finished reads — someone edited the spreadsheet — tops them up with undated ones.
  const reads = topUpReads(
    (r['reads'] ?? '').trim() ? parseReadsCell(r['reads']) : readsFromColumns(status, date(r['began_on']), date(r['completed_on'])),
    count,
  );
  const state = summarizeReads(reads);
  // Everyone's reviews, when the file has them (§16 #43): the item's own rating and review are then only their summary.
  // Otherwise — an export from before reviews, or a row whose reviews cell was emptied — those two columns are one
  // review, the importer's.
  const reviews = parseReviewsCell(r['reviews']);
  const summary = reviews ? summarizeReviews(reviews) : { rating: rating && rating >= 1 && rating <= 10 ? rating : null, review: r['review'] || null };
  // The play log (§16 #54). An export from before plays has no such column, and its games and records arrive unplayed.
  const plays = parsePlaysCell(r['plays']);
  // Its series (§16 #52). A number or total that isn't one — someone edited the spreadsheet — is dropped, not guessed.
  const seriesName = cleanSeriesName(r['series']);
  const series = seriesName
    ? { name: seriesName, number: parseSeriesNumber(r['series_number']) ?? null, total: parseSeriesTotal(r['series_total']) ?? null }
    : null;
  const mediaType = (MEDIA_TYPES as readonly string[]).includes(r['media_type'] ?? '') ? (r['media_type'] as MediaType) : 'book';
  return {
    series,
    item: {
      mediaType,
      title,
      creators: r['creators'] || null,
      isbn13: /^\d{13}$/.test(r['isbn13'] ?? '') ? r['isbn13']! : null,
      isbn10Upc: r['isbn10_upc'] || null,
      publisher: r['publisher'] || null,
      published: r['published'] || null,
      description: r['description'] || null,
      length: length && length > 0 ? length : null,
      status: state.status,
      rating: summary.rating,
      review: summary.review,
      notes: r['notes'] || null,
      location: oneLine(r['location']),
      copies: copies ?? 1,
      beganOn: state.beganOn,
      completedOn: state.completedOn,
      ...(SQL_DATETIME.test(r['added_at'] ?? '') ? { addedAt: r['added_at'] } : {}),
      details,
      formats: parseFormatsCell(mediaType, r['formats']),
      // its language (§16 #76): the file's code when it is one, else the household's; and the original title as written
      language: languageFromProvider(r['language']) ?? language,
      originalTitle: oneLine(r['original_title']),
      ...rowGrades(mediaType, r['media_condition'], r['sleeve_condition']),
      // what was paid, in the currency the file says (§16 #61); one it doesn't say is the household's
      ...rowPrice(r['purchase_price'], r['purchase_currency'], household),
    },
    reads,
    ...(reviews ? { reviews } : {}),
    // every loan, open and returned, as the file has it (§16 #57); an export from before loans has none
    loans: parseLoansCell(r['loans']),
    ...(plays.length ? { plays } : {}),
    wants: parseWantsCell(r['wanted_by']),
    links: parseLinksCell(r['purchase_links']),
    editions: parseEditionsCell(mediaType, r['editions']),
    quotes: parseQuotesCell(r['quotes']),
    // an owned row keeps only the borrows given back: a copy of yours is never also someone's (§16 #82), whatever a hand-edited cell says
    borrows: parseLoansCell(r['borrowed']).filter((b) => (copies ?? 1) === 0 || b.returnedOn !== null),
    ...(r['added_by'] ? { addedBy: r['added_by'] } : {}),
    tags: (r['tags'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

// ---------- whose reads and reviews an import brings (§16 #43) ----------

/**
 * How the people in a file were matched, for the preview: per name — `undefined` for reads and reviews that name
 * nobody, `null` for a member removed since — what it brings and whose it becomes here (`to`, null: nobody's).
 */
export type PeopleTally = Map<string | null | undefined, { reads: number; reviews: number; wants: number; to: number | null; known: boolean }>;

/**
 * A mapped row's reads and reviews with their people as ids here. A username that is a member here is theirs; any
 * other name is the importer's, and so is anything that names nobody — an export from before readers, a libib or
 * Goodreads row; an entry the file marks as a former member's stays unattributed. Only an admin's import keeps
 * names (`keepNames`): members change only their own reading, so a member's import is theirs, whatever the file says
 * — it can't make reads or reviews in anyone else's name, or ones only an admin could then change. Two reviews that
 * land on one person keep the one written last, as a person has one review. `tally` counts it all for the preview.
 * Who added the item (`addedBy`) follows the same rule, and is the importer when the file names nobody.
 */
export function attributePeople(
  m: MappedRow,
  members: Map<string, number>,
  importer: number,
  tally?: PeopleTally,
  keepNames = true,
): { reads?: PersonRead[]; reviews?: PersonReview[]; plays?: PersonPlay[]; wants?: Array<{ userId: number; at: string | null }>; quotes?: PersonQuote[]; addedBy: number } {
  const resolve = (name: string | null | undefined): number | null =>
    !keepNames || name === undefined ? importer : name === null ? null : (members.get(name) ?? importer);
  const count = (name: string | null | undefined, what: 'reads' | 'reviews' | 'wants', n = 1) => {
    if (!tally || n < 1) return;
    const entry = tally.get(name) ?? { reads: 0, reviews: 0, wants: 0, to: resolve(name), known: keepNames && typeof name === 'string' && members.has(name) };
    entry[what] += n;
    tally.set(name, entry);
  };

  const reads = m.reads?.map(({ reader, ...read }) => {
    count(reader, 'reads');
    return { ...read, readerId: resolve(reader) };
  });
  // a row without reads of its own makes them from its status and dates, all the importer's
  if (!m.reads) count(undefined, 'reads', readsFromColumns(m.item.status ?? 'not_started', m.item.beganOn, m.item.completedOn).length);

  let reviews: PersonReview[] | undefined;
  if (m.reviews) {
    const resolved = m.reviews.map(({ by, ...review }) => {
      count(by, 'reviews');
      return { ...review, userId: resolve(by) };
    });
    const chosen = new Map<number, number>(); // person → the index of the review kept for them
    resolved.forEach((r, i) => {
      if (r.userId === null) return;
      const j = chosen.get(r.userId);
      if (j === undefined || (r.reviewedAt ?? '') >= (resolved[j]!.reviewedAt ?? '')) chosen.set(r.userId, i);
    });
    // still oldest first, as exported: ids then break ties between equal times the same way here
    reviews = resolved.filter((r, i) => r.userId === null || chosen.get(r.userId) === i);
  } else if (m.item.rating != null || m.item.review) {
    count(undefined, 'reviews');
  }
  // Who logged each play (§16 #54) resolves as a read's reader does. Plays aren't in the preview's tally: who pressed
  // Played is kept for auditing and removal, not as anyone's history.
  const plays = m.plays?.map(({ by, ...play }) => ({ ...play, loggedBy: resolve(by) }));
  // Wants (§16 #53) by the same rule: a member of that name here in an admin's import, else the importer. A want is
  // always someone's — there is no former member's — and one each: two names landing on one person keep the earliest.
  let wants: Array<{ userId: number; at: string | null }> | undefined;
  if (m.wants?.length) {
    const byPerson = new Map<number, string | null>();
    for (const w of m.wants) {
      count(w.by, 'wants');
      const userId = resolve(w.by) ?? importer; // never null: parseWantsCell drops a want of nobody
      const had = byPerson.get(userId);
      if (!byPerson.has(userId) || (w.at !== null && (had === null || had === undefined || w.at < had))) byPerson.set(userId, w.at);
    }
    wants = [...byPerson].map(([userId, at]) => ({ userId, at }));
  }
  // Quotes (§16 #77) resolve as a review's writer does; a former member's stay nobody's
  const quotes = m.quotes?.map(({ by, ...quote }) => ({ ...quote, userId: resolve(by) }));
  // and who added it: a name resolves to a member or the importer, never to nobody — an item is always someone's to add
  const addedBy = (m.addedBy ? resolve(m.addedBy) : null) ?? importer;
  return { ...(reads ? { reads } : {}), ...(reviews ? { reviews } : {}), ...(plays ? { plays } : {}), ...(wants ? { wants } : {}), ...(quotes ? { quotes } : {}), addedBy };
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
  // the older export's columns about the household's copy — when and where it was bought, its condition, who it was
  // recommended by — are as private as the copy (§16 #55, #61): never into details (review on #127)
  'original_purchase_date',
  'original_purchase_location',
  'condition',
  'condition_description',
  'bcid',
  'recommended_for',
  'recommended_by',
  // reading: read_count and date_started become reads (ARCH.md §16 #41), so they no longer land in details
  'read_count',
  'date_started',
  // when the book joined the collection over there is when it did here (§16 #90), so it no longer lands in details
  'date_added',
  // not a Goodreads column, but private if a file carried one: never into details (§16 #55, #61)
  'media_condition',
  'sleeve_condition',
  'purchase_price',
  'purchase_currency',
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

/**
 * A file's "date added" — Goodreads' and StoryGraph's Date Added, LibraryThing's Entry Date, libib's `added` — as the
 * item's `added_at` (§16 #90): that day at midnight, in the column's own datetime form, so a book is dated when it
 * joined the collection over there rather than when the file was imported. Nothing when the cell isn't a date, and the
 * row then takes the time of its import as before.
 */
function addedAtOf(raw: string | undefined): { addedAt: string } | Record<string, never> {
  const day = isoDate(raw);
  return day ? { addedAt: `${day} 00:00:00` } : {};
}

function goodreadsStatus(exclusive: string, shelves: string[]): ItemStatus {
  const dnf = (v: string) => v === 'abandoned' || v === 'dnf' || v === 'did-not-finish';
  if (dnf(exclusive)) return 'abandoned';
  if (exclusive === 'read') return 'completed';
  if (exclusive === 'currently-reading') return 'in_progress';
  if (shelves.some(dnf)) return 'abandoned';
  return 'not_started'; // to-read and anything unrecognized
}

// ---------- StoryGraph and LibraryThing (ARCH.md §16 #87) ----------
//
// Two more match-and-merge importers beside Goodreads': each row becomes the importer's own reads, rating and review
// on the book already here that matches (ISBN, then title and author — mergeImportItems) or a new Not owned entry.
// A column name as these files write it, lower-cased, with every run of other characters as one underscore:
// "ISBN/UID" → isbn_uid, "Owned?" → owned, "Character- or Plot-Driven?" → character_or_plot_driven.
const columnKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const keyed = (row: Record<string, string>): Record<string, string> => {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = columnKey(k);
    if (key) r[key] = (v ?? '').trim();
  }
  return r;
};

/** A StoryGraph export is recognised by its Read Status and Dates Read columns, which no other file has. */
export function looksLikeStoryGraph(headers: string[]): boolean {
  const have = new Set(headers.map(columnKey));
  return have.has('read_status') && have.has('dates_read');
}

/** A LibraryThing export is recognised by its Primary Author column beside Entry Date or Book ID. */
export function looksLikeLibraryThing(headers: string[]): boolean {
  const have = new Set(headers.map(columnKey));
  return have.has('primary_author') && (have.has('entry_date') || have.has('book_id'));
}

/** A 0–5 rating with halves or quarters ("4.25", "5.0") as our 1–10, or null when blank, zero or not a number. */
function starsToRating(raw: string | undefined): number | null {
  const n = Number.parseFloat((raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(10, Math.max(1, Math.round(n * 2)));
}

/** A book's format as these files name it, as one of ours — or none. */
function bookFormat(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  if (/audio/.test(v)) return 'audiobook';
  if (/ebook|e-book|kindle|digital|epub/.test(v)) return 'ebook';
  if (/paperback|softcover|mass market|trade/.test(v)) return 'paperback';
  if (/hardcover|hardback|cloth/.test(v)) return 'hardcover';
  return null;
}

/** "2022/01/19" or "2022-01-19" as our date, else null. */
const dateOf = (raw: string | undefined): string | null => isoDate(raw);

const KNOWN_STORYGRAPH = new Set([
  'title',
  'authors',
  'isbn_uid',
  'format',
  'read_status',
  'date_added',
  'last_date_read',
  'dates_read',
  'read_count',
  'star_rating',
  'review',
  'tags',
  'owned',
  // not StoryGraph columns, but private if a file carried them: never into details (§16 #55, #61)
  'media_condition',
  'sleeve_condition',
  'purchase_price',
  'purchase_currency',
]);

/** The reader's impressions StoryGraph exports, as the private notes word them. */
const STORYGRAPH_IMPRESSIONS: ReadonlyArray<readonly [string, string]> = [
  ['moods', 'moods'],
  ['pace', 'pace'],
  ['character_or_plot_driven', 'driven by'],
  ['strong_character_development', 'strong character development'],
  ['loveable_characters', 'loveable characters'],
  ['diverse_characters', 'diverse characters'],
  ['flawed_characters', 'flawed characters'],
  ['content_warnings', 'content warnings'],
  ['content_warning_description', 'content warning description'],
];
const STORYGRAPH_PRIVATE = new Set(STORYGRAPH_IMPRESSIONS.map(([k]) => k));

function storyGraphStatus(raw: string | undefined): ItemStatus {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'read') return 'completed';
  if (v === 'currently-reading') return 'in_progress';
  if (v === 'did-not-finish' || v === 'dnf') return 'abandoned';
  return 'not_started'; // to-read, and anything else
}

/**
 * StoryGraph's "Dates Read": each read as "start-end", several joined by commas, either side possibly blank —
 * "2022/01/04-2022/01/19, -2023/03/02". Dates are written with slashes there (and the dash is the range's), so a
 * range is split on its first dash between two dates; a file with dashed dates is read by the same rule.
 */
function storyGraphRanges(raw: string | undefined): Array<{ start: string | null; end: string | null }> {
  const out: Array<{ start: string | null; end: string | null }> = [];
  for (const part of (raw ?? '').split(',')) {
    const span = part.trim();
    if (!span) continue;
    const m = /^(\d{4}[/-]\d{2}[/-]\d{2})?\s*-\s*(\d{4}[/-]\d{2}[/-]\d{2})?$/.exec(span);
    if (!m) continue;
    const start = dateOf(m[1]);
    const end = dateOf(m[2]);
    if (start || end) out.push({ start, end });
  }
  return out;
}

/**
 * Maps one StoryGraph-export row (ARCH.md §16 #87) onto our item shape; null if unusable. Every dated read in "Dates
 * Read" becomes a read of its own, and Read Count tops them up with undated finishes, as it does a book with no dates
 * and as a merge does; the row's status, last read and count make the `goodreads` reading a merge reconciles with the
 * reads already here (every earlier dated range too — readingsOf in queries.ts). Owned? says whether it is a copy;
 * Format says which. Moods, pace and the rest stay in details.
 */
export function mapStoryGraphRow(row: Record<string, string>): MappedRow | null {
  const r = keyed(row);
  const title = r['title'];
  if (!title) return null;
  const rawUid = (r['isbn_uid'] ?? '').trim();
  const uid = rawUid.replace(/[^0-9Xx]/g, '');
  const isbn13 = /^\d{13}$/.test(uid) ? uid : null;
  const isbn10 = /^\d{9}[\dXx]$/.test(uid) ? uid.toUpperCase() : null;
  const status = storyGraphStatus(r['read_status']);
  const ranges = storyGraphRanges(r['dates_read']);
  const last = ranges.at(-1);
  const countRaw = (r['read_count'] ?? '').trim();
  // the dated reads the file lists, as they are: the last one open while currently reading, or stopped on a DNF
  const dated: ReadDraft[] = ranges.map((x, i) => {
    const lastOne = i === ranges.length - 1;
    if (lastOne && status === 'in_progress' && !x.end) return { status: 'in_progress', beganOn: x.start, endedOn: null };
    if (lastOne && status === 'abandoned') return { status: 'abandoned', beganOn: x.start, endedOn: x.end };
    return { status: 'completed', beganOn: x.start, endedOn: x.end };
  });
  const goodreads: GoodreadsReading = {
    shelf: status,
    dateRead: status === 'in_progress' ? (ranges.filter((x) => x.end).at(-1)?.end ?? null) : (last?.end ?? dateOf(r['last_date_read'])),
    dateStarted: last?.start ?? null,
    // the file's count, else the finished reads it dates — an open or stopped range is never counted as a finish
    readCount: /^\d+$/.test(countRaw) ? Number(countRaw) : dated.filter((x) => x.status === 'completed').length || null,
  };
  // the dated reads, topped up to Read Count with undated finishes; without any, the same rules a merge applies, from none
  const reads: ReadDraft[] = dated.length ? topUpReads(dated, goodreads.readCount) : reconcileGoodreads([], goodreads).map((op) => op.read);
  if (dated.length && status === 'in_progress' && !reads.some((x) => x.status === 'in_progress')) reads.push({ status: 'in_progress', beganOn: null, endedOn: null });
  const state = summarizeReads(reads);
  // the reader's own impressions — moods, pace, what drove the story, the content warnings — are opinions, closer to a
  // review than to catalogue data, so they go to the private notes and never to details, which share pages publish;
  // what is left over (contributors, say) is catalogue data and stays in details
  const impressions = STORYGRAPH_IMPRESSIONS.map(([key, label]) => (r[key] ? `${label}: ${r[key]}` : null)).filter((x): x is string => x !== null);
  const details = leftover(r, KNOWN_STORYGRAPH, (k) => STORYGRAPH_PRIVATE.has(k));
  if (rawUid && !isbn13 && !isbn10) details['storygraph_uid'] = rawUid; // StoryGraph's own id, kept as it is
  const split = parseTitleSeries(title);
  const format = bookFormat(r['format']);
  return {
    series: split?.series ?? null,
    item: {
      mediaType: 'book',
      title: split?.title ?? title,
      creators: r['authors'] || null,
      isbn13,
      isbn10Upc: isbn10,
      publisher: null,
      published: null,
      description: null,
      length: null,
      status: state.status,
      rating: starsToRating(r['star_rating']),
      review: r['review'] || null,
      // a notes column someone added to the file, then the impressions; a location column likewise (never details)
      notes: [r['notes'], impressions.length ? `StoryGraph — ${impressions.join('; ')}` : null].filter(Boolean).join('\n\n') || null,
      location: oneLine(r['location']),
      copies: /^(yes|true|y)$/i.test(r['owned'] ?? '') ? 1 : 0,
      beganOn: state.beganOn,
      completedOn: state.completedOn,
      ...addedAtOf(r['date_added']), // when it joined the collection there is when it did here (§16 #90)
      formats: format ? normalizeFormats('book', [format]) : '',
      details: Object.keys(details).length ? JSON.stringify(details) : '{}',
    },
    reads,
    goodreads,
    tags: (r['tags'] ?? '').split(',').map((t) => t.trim()).filter(Boolean),
  };
}

const KNOWN_LIBRARYTHING = new Set([
  'book_id',
  'title',
  'sort_character',
  'primary_author',
  'primary_author_role',
  'secondary_author',
  'secondary_author_role',
  'secondary_author_roles',
  'publication',
  'date',
  'review',
  'rating',
  'comment',
  'private_comment',
  'summary',
  'media',
  'page_count',
  'date_started',
  'date_read',
  'tags',
  'collections',
  'languages',
  'isbn',
  'isbns',
  'copies',
  'entry_date',
  'series',
  'volume',
  'original_publication_year',
  'barcode',
  'bcid',
  'lending_patron',
  'lending_status',
  'lending_start',
  'lending_end',
  'reading_dates',
  // the household's copy and what it cost (§16 #55, #61), and where it is kept (§16 #51): never into details, which
  // share pages publish — Other Call Number maps to location; the rest are dropped
  'list_price',
  'value',
  'condition',
  'acquired',
  'date_acquired',
  'from_where',
  'source',
  'other_call_number',
  'purchase_price',
  // not LibraryThing columns, but private if a file carried them (§16 #55, #61)
  'media_condition',
  'sleeve_condition',
  'purchase_currency',
]);

/** "Mander, Jerry" as "Jerry Mander" — LibraryThing writes one person surname first; several are kept apart by "|". */
function turnedRound(raw: string | undefined): string[] {
  return (raw ?? '')
    .split('|')
    .map((name) => {
      const m = /^([^,]+),\s*([^,]+)$/.exec(name.trim());
      return m ? `${m[2]!.trim()} ${m[1]!.trim()}` : name.trim();
    })
    .filter(Boolean);
}

/**
 * Maps one LibraryThing-export row (ARCH.md §16 #87) onto our item shape; null if unusable. Date Read is a finish
 * and Date Started a start, as Goodreads' are; the collections say the rest — Currently reading, To read, Wishlist,
 * Read but unowned (read, and not a copy). Media is the format, Comment and Private Comment the notes.
 */
export function mapLibraryThingRow(row: Record<string, string>): MappedRow | null {
  const r = keyed(row);
  const title = r['title'];
  if (!title) return null;
  const codes = `${r['isbns'] ?? ''} ${r['isbn'] ?? ''}`.replace(/[[\]]/g, ' ').split(/[\s,]+/).map((x) => x.replace(/[^0-9Xx]/g, '')).filter(Boolean);
  const isbn13 = codes.find((x) => /^\d{13}$/.test(x)) ?? null;
  const isbn10 = codes.find((x) => /^\d{9}[\dXx]$/.test(x))?.toUpperCase() ?? null;
  const collections = (r['collections'] ?? '').split(/[|,]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const has = (name: string) => collections.includes(name);
  const dateRead = dateOf(r['date_read']);
  const dateStarted = dateOf(r['date_started']);
  const status: ItemStatus = dateRead
    ? 'completed'
    : has('currently reading')
      ? 'in_progress'
      : collections.some((c) => /did not finish|abandoned|dnf/.test(c))
        ? 'abandoned'
        : has('read') || has('read but unowned')
          ? 'completed'
          : 'not_started'; // to read, wishlist, and a book merely catalogued
  const goodreads: GoodreadsReading = { shelf: status, dateRead, dateStarted, readCount: null };
  const reads = reconcileGoodreads([], goodreads).map((op) => op.read);
  const state = summarizeReads(reads);
  const copiesNum = Number.parseInt((r['copies'] ?? '').replace(/\D/g, ''), 10);
  const owned = !has('read but unowned') && !has('wishlist');
  const publication = r['publication'] ?? '';
  const publisher = publication.split(/\s*\(/)[0]?.trim() || null;
  const year = r['date'] || r['original_publication_year'] || /\((\d{4})\)/.exec(publication)?.[1] || null;
  const pages = Number.parseInt((r['page_count'] ?? '').replace(/\D/g, ''), 10);
  const language = languageCode((r['languages'] ?? '').split(/[|,]/)[0] ?? '');
  const details = leftover(r, KNOWN_LIBRARYTHING);
  if (r['book_id']) details['librarything_book_id'] = r['book_id'];
  const split = parseTitleSeries(title);
  const volume = Number.parseFloat(r['volume'] ?? '');
  const series = r['series'] ? { name: r['series'], number: Number.isFinite(volume) ? volume : null, total: null } : (split?.series ?? null);
  const format = bookFormat(r['media']);
  return {
    series,
    item: {
      mediaType: 'book',
      title: r['series'] ? title : (split?.title ?? title),
      creators: [...turnedRound(r['primary_author']), ...turnedRound(r['secondary_author'])].join(', ') || null,
      isbn13,
      isbn10Upc: isbn10,
      publisher,
      published: year,
      description: null,
      length: Number.isFinite(pages) && pages > 0 ? pages : null,
      status: state.status,
      rating: starsToRating(r['rating']),
      review: r['review'] || null,
      notes: [r['comment'], r['private_comment'], r['notes']].filter(Boolean).join('\n\n') || null,
      // a location column someone added, else the household's own shelf mark, which is what Other Call Number is used
      // for: where it is kept, never published (§16 #51)
      location: oneLine(r['location'] || r['other_call_number']),
      copies: owned ? (Number.isFinite(copiesNum) && copiesNum > 0 ? copiesNum : 1) : 0,
      beganOn: state.beganOn,
      completedOn: state.completedOn,
      ...addedAtOf(r['entry_date']), // when it joined the collection there is when it did here (§16 #90)
      formats: format ? normalizeFormats('book', [format]) : '',
      ...(language ? { language } : {}),
      details: Object.keys(details).length ? JSON.stringify(details) : '{}',
    },
    reads,
    goodreads,
    tags: (r['tags'] ?? '').split(/[|,]/).map((t) => t.trim()).filter(Boolean),
  };
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

  const details = leftover(r, KNOWN_GOODREADS);
  if (r['book_id']) details['goodreads_book_id'] = r['book_id'];

  // Read Count: a whole number, or nothing — "abc" isn't a count of anything
  const countRaw = (r['read_count'] ?? '').trim();
  const goodreads: GoodreadsReading = {
    shelf: goodreadsStatus(exclusive, shelves),
    dateRead: isoDate(r['date_read']),
    dateStarted: isoDate(r['date_started']),
    readCount: /^\d+$/.test(countRaw) ? Number(countRaw) : null,
  };
  // a new book's reads come from the same rules a merge applies, starting from none
  const reads = reconcileGoodreads([], goodreads).map((op) => op.read);
  const state = summarizeReads(reads);
  // Goodreads has no series column, but its titles carry one: "The Gunslinger (The Dark Tower, #1)". The suffix
  // becomes the series (§16 #52), and the title reads as a provider's would. Only a new book gets it — a merge never
  // touches bibliographic fields (§16 #14) — and matching ignores the suffix either way.
  const split = parseTitleSeries(title);

  return {
    series: split?.series ?? null,
    item: {
      mediaType: 'book',
      title: split?.title ?? title,
      creators: [r['author'], r['additional_authors']].filter(Boolean).join(', ') || null,
      isbn13: isbn13.length === 13 ? isbn13 : null,
      isbn10Upc: isbn10 || null,
      publisher: r['publisher'] || null,
      published: r['year_published'] || r['original_publication_year'] || null,
      description: null,
      length: Number.isFinite(pages) && pages > 0 ? pages : null,
      status: state.status,
      rating: Number.isFinite(ratingNum) && ratingNum >= 1 && ratingNum <= 5 ? ratingNum * 2 : null,
      review: r['my_review'] ? r['my_review'].replace(/<br\s*\/?>/gi, '\n') : null,
      // Private Notes, then a notes column someone added to the file; a location column likewise (never details)
      notes: [r['private_notes'], r['notes']].filter(Boolean).join('\n\n') || null,
      location: oneLine(r['location']),
      copies: Number.isFinite(ownedNum) && ownedNum > 0 ? ownedNum : 0, // default: reading log, not owned
      beganOn: state.beganOn,
      completedOn: state.completedOn,
      ...addedAtOf(r['date_added']),
      details: Object.keys(details).length ? JSON.stringify(details) : '{}',
    },
    reads,
    goodreads,
    tags: [...tagShelves].filter((sh) => !EXCLUSIVE_SHELVES.has(sh)),
  };
}
