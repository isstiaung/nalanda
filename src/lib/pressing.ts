// A record's pressing details (ARCH.md §16 #55): public catalogue data from Discogs, kept in the item's `details`
// JSON under the vinyl keys ARCH.md §5 names. This module holds the rules for writing them — what an add takes from
// a release, and what "Refresh from Discogs" may fill — and for reading them back out for a page. No network here:
// src/metadata/discogs.ts fetches and parses; this decides what lands.
import type { Item } from '../db/schema';
import { parseDetails } from './share';

/** One line of a tracklist: a track (or an index track's part), or a heading such as "Side A". */
export type Track = { position?: string; title: string; duration?: string; artist?: string } | { heading: string };

/** What Discogs says about a release, already reduced to plain values. Every field is optional: Discogs' are. */
export type Pressing = {
  discogsId?: number;
  label?: string; // every label, joined — "Parlophone, EMI"
  firstLabel?: string; // the first of them: a record's publisher column
  catno?: string; // every catalogue number, joined
  country?: string;
  year?: number;
  format?: string; // "2×Vinyl, LP, Album, Reissue, 180 Gram, Red Translucent"
  genres?: string[];
  tracklist?: Track[];
};

/** The details keys pressing data lives under, in the order a page lists them. */
export const PRESSING_KEYS = ['label', 'catno', 'country', 'year', 'format'] as const;

/** Everything a refresh may write, and nothing else (§16 #55): these details keys, and three columns when blank. */
export const REFRESH_DETAIL_KEYS = ['discogs_id', 'label', 'catno', 'country', 'year', 'format', 'genres', 'tracklist'] as const;

const asDetails = (p: Pressing): Record<(typeof REFRESH_DETAIL_KEYS)[number], unknown> => ({
  discogs_id: p.discogsId,
  label: p.label,
  catno: p.catno,
  country: p.country,
  year: p.year,
  format: p.format,
  genres: p.genres,
  tracklist: p.tracklist,
});

/** Nothing there: absent, null, blank text or an empty list. Zero is a value. */
export const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

const hasValue = (v: unknown) => !isBlank(v) && !(typeof v === 'number' && !Number.isFinite(v));

/** How many tracks a tracklist holds — a record's `length` (ARCH.md §5). Headings aren't tracks. */
export const trackCount = (tracks: Track[] | undefined): number => (tracks ?? []).filter((t) => !('heading' in t)).length;

type Columns = Pick<Item, 'publisher' | 'published' | 'length'>;

export type Filled = {
  details: string;
  publisher: string | null;
  published: string | null;
  length: number | null;
  /** The details keys and columns that changed, in a stable order — empty when there was nothing to fill. */
  filled: string[];
};

/**
 * Writes a release's pressing details onto an item's details and columns.
 *
 * `gaps` — "Refresh from Discogs": a field is written only while it is blank. Anything with a value stays exactly
 * as it is, whoever put it there, so a hand edit is never overwritten; a field the owner cleared is a gap, and
 * refilled. The columns it may fill are `publisher` (the first label), `published` (the year) and `length` (the
 * track count). Title, creators, description, cover, barcode, notes and condition are never touched.
 *
 * `add` — a record added from a Discogs result, a moment ago: the release is the fuller answer from the same
 * source, so its details keys replace what the search result carried (a flat format, the first label only). The
 * columns are still filled only when blank, since the add form shows them.
 */
export function fillPressing(item: Columns & { details: string | null }, p: Pressing, mode: 'gaps' | 'add'): Filled {
  const details = parseDetails(item.details);
  const filled: string[] = [];
  for (const [k, v] of Object.entries(asDetails(p))) {
    if (!hasValue(v)) continue;
    if (mode === 'gaps' && !isBlank(details[k])) continue;
    if (JSON.stringify(details[k]) === JSON.stringify(v)) continue;
    details[k] = v;
    filled.push(k);
  }
  const firstLabel = p.firstLabel?.trim() || null;
  let { publisher, published, length } = item;
  if (isBlank(publisher) && firstLabel) {
    publisher = firstLabel;
    filled.push('publisher');
  }
  if (isBlank(published) && p.year) {
    published = String(p.year);
    filled.push('published');
  }
  const tracks = trackCount(p.tracklist);
  if ((length === null || length === undefined) && tracks > 0) {
    length = tracks;
    filled.push('length');
  }
  return { details: JSON.stringify(details), publisher: publisher ?? null, published: published ?? null, length: length ?? null, filled };
}

const MAX_TRACKS = 400;
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * A stored tracklist, read back defensively: `details` is editable by hand in the form's JSON box and arrives from a
 * CSV, so anything not shaped like a tracklist is skipped rather than rendered as "[object Object]".
 */
export function readTracklist(value: unknown): Track[] {
  if (!Array.isArray(value)) return [];
  const out: Track[] = [];
  for (const raw of value.slice(0, MAX_TRACKS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const t = raw as Record<string, unknown>;
    const heading = str(t.heading, 300);
    if (heading) {
      out.push({ heading });
      continue;
    }
    const title = str(t.title, 300);
    const position = str(t.position, 20);
    if (!title && !position) continue;
    out.push({
      ...(position ? { position } : {}),
      title: title ?? '',
      ...(str(t.duration, 12) ? { duration: str(t.duration, 12) } : {}),
      ...(str(t.artist, 300) ? { artist: str(t.artist, 300) } : {}),
    });
  }
  return out;
}

/**
 * A record's details, split for its page: the pressing (label, catalogue number, country, year, format) and its
 * tracklist, and the rest — Discogs id, genres, anything else — which the page lists as it always has.
 */
export function splitPressing(details: Record<string, unknown>): {
  pressing: Array<[string, unknown]>;
  tracklist: Track[];
  rest: Record<string, unknown>;
} {
  const rest = { ...details };
  const pressing: Array<[string, unknown]> = [];
  for (const k of PRESSING_KEYS) {
    if (!isBlank(rest[k])) pressing.push([k, rest[k]]);
    delete rest[k];
  }
  const tracklist = readTracklist(rest['tracklist']);
  // a list is a tracklist, shown as one or not at all; anything else someone typed there stays in the plain list
  if (Array.isArray(rest['tracklist'])) delete rest['tracklist'];
  return { pressing, tracklist, rest };
}

/** The Discogs release a record's details name, if any: `discogs_id`, a positive whole number (or its digits). */
export function releaseIdOf(details: Record<string, unknown>): number | null {
  const v = details['discogs_id'];
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A record's barcode, digits only: the EAN column, else the UPC one — whichever holds 8 to 14 digits. */
export function recordBarcode(item: Pick<Item, 'isbn13' | 'isbn10Upc'>): string | null {
  for (const raw of [item.isbn13, item.isbn10Upc]) {
    const digits = (raw ?? '').replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 14) return digits;
  }
  return null;
}
