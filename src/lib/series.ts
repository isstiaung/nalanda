// Series (ARCH.md §16 #52): an item's place in one, and what the household's volumes say about the rest — which
// numbers are missing, and which volume a member reads next. Pure functions: the queries live in src/db/queries.ts.
import { cleanVisibleText } from './names';

/** Longest series name kept; a longer one is cut here, as every other place names reach the page. */
export const MAX_SERIES_NAME = 200;
/** Highest number or total accepted. Past it a number is a typo, and a gap list would be a wall of numbers. */
export const MAX_SERIES_NUMBER = 9999;

/** Longest title parseTitleSeries() looks into. */
const MAX_TITLE_PARSED = 500;

/** A series as a form, a provider or a file gives it: a name, and the item's number in it if known. */
export type SeriesDraft = { name: string; number: number | null; total?: number | null };

/**
 * A series name tidied for storage, as a display name is (cleanVisibleText): control and format characters dropped,
 * so no bidi override can reorder the text around it — but for the joiners Persian and Indic names need — spaces
 * collapsed, trimmed, capped without splitting a character. Null when nothing is left.
 */
export function cleanSeriesName(raw: unknown): string | null {
  return typeof raw === 'string' ? cleanVisibleText(raw, MAX_SERIES_NAME) : null;
}

/** What makes two names one series: case and spacing don't. Unicode-aware, where SQLite's NOCASE folds ASCII only. */
export function seriesKey(name: string): string {
  return (cleanSeriesName(name) ?? '').toLowerCase();
}

/**
 * A number within a series: "3", "#3", "2.5", "03". `null` for a blank; `undefined` for anything else — "1-3" (an
 * omnibus), "three", a negative, more than two decimals, past MAX_SERIES_NUMBER — so a form can say why.
 */
export function parseSeriesNumber(raw: unknown): number | null | undefined {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const m = /^#?\s*(\d{1,4})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const n = Number(`${m[1]}.${m[2] ?? '0'}`);
  return n <= MAX_SERIES_NUMBER ? n : undefined;
}

/** How many numbered volumes a series has: a whole number from 1, or null for blank; undefined when it isn't one. */
export function parseSeriesTotal(raw: unknown): number | null | undefined {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (!/^\d{1,4}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= MAX_SERIES_NUMBER ? n : undefined;
}

/** "3", "2.5" — never "3.0". REAL columns hand back 3 as 3, so String() is enough; this names the intent. */
export const formatSeriesNumber = (n: number): string => String(n);

/**
 * A title with a Goodreads series suffix — "The Gunslinger (The Dark Tower, #1)", "Guards! Guards! (Discworld, #8;
 * City Watch, #1)" — split into the title and its first series. An omnibus ("#1-3") keeps the series without a
 * number. Null when the title carries no such suffix, or nothing would be left of it.
 */
export function parseTitleSeries(title: string): { title: string; series: SeriesDraft } | null {
  // no real title is this long, and the patterns below backtrack: an import row can't make them spend its CPU
  if (title.length > MAX_TITLE_PARSED) return null;
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(title);
  if (!m) return null;
  const first = m[2]!.split(';')[0]!;
  const part = /^(.*\S),?\s+#\s*([0-9][0-9.]*(?:\s*[-–]\s*[0-9][0-9.]*)?)\s*$/.exec(first.trim());
  if (!part) return null;
  const name = cleanSeriesName(part[1]!.replace(/,\s*$/, ''));
  if (!name) return null;
  const number = /[-–]/.test(part[2]!) ? null : (parseSeriesNumber(part[2]) ?? null);
  return { title: m[1]!, series: { name, number } };
}

/** An inclusive run of whole numbers: [4, 4] is "4", [6, 9] is "6–9". */
export type NumberRange = [number, number];

export const formatRanges = (ranges: NumberRange[]): string =>
  ranges.map(([a, b]) => (a === b ? `#${a}` : `#${a}–${b}`)).join(', ');

export const countRanges = (ranges: NumberRange[]): number => ranges.reduce((n, [a, b]) => n + b - a + 1, 0);

/**
 * The whole-numbered volumes missing, as runs: every whole number from 1 up to the highest the household holds — or
 * to the series' total, when it's known and higher — that no volume carries. A fractional number (a novella at 2.5)
 * fills no whole number and is never missing itself: nothing says a 1.5 exists. Duplicates count once; volumes
 * without a number count for nothing. Linear in the volumes held, not in the numbers spanned.
 */
export function missingNumbers(numbers: Array<number | null>, total: number | null = null): NumberRange[] {
  const held = [...new Set(numbers.filter((n): n is number => n !== null && Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  const top = Math.max(held.at(-1) ?? 0, Math.floor(numbers.reduce<number>((m, n) => (n !== null && n > m ? n : m), 0)), total ?? 0);
  const ranges: NumberRange[] = [];
  let next = 1;
  for (const n of held) {
    if (n > next) ranges.push([next, n - 1]);
    next = n + 1;
  }
  if (top >= next) ranges.push([next, top]);
  return ranges;
}

/** One of a series' volumes, as its page and "next up" see it. */
export type SeriesVolume = {
  id: number;
  title: string;
  seriesNumber: number | null;
  copies: number;
  finishedByMe: boolean; // the signed-in member has a finished read of it (reads.reader_id)
  readingByMe: boolean; // …or has one open now
};

/**
 * The volumes in reading order: numbered first, lowest first, then those without a number by title. Two volumes
 * with one number (two editions of it) keep the owned one first, then the older entry.
 */
export function inSeriesOrder<T extends Pick<SeriesVolume, 'id' | 'title' | 'seriesNumber' | 'copies'>>(volumes: T[]): T[] {
  return [...volumes].sort((a, b) => {
    if (a.seriesNumber !== b.seriesNumber) {
      if (a.seriesNumber === null) return 1;
      if (b.seriesNumber === null) return -1;
      return a.seriesNumber - b.seriesNumber;
    }
    if (a.seriesNumber === null) return a.title.localeCompare(b.title) || a.id - b.id;
    return (b.copies > 0 ? 1 : 0) - (a.copies > 0 ? 1 : 0) || a.id - b.id;
  });
}

export type NextUp =
  // the lowest-numbered volume here the member hasn't finished; `skipped` are missing numbers they'd read first
  | { kind: 'volume'; volume: SeriesVolume; skipped: NumberRange[] }
  // every numbered volume here is finished, and the series goes on past them (a missing number, or the total)
  | { kind: 'missing'; number: number }
  // every numbered volume here is finished, and nothing is known to come after
  | { kind: 'done' }
  // no volume has a number, so there is no order to follow
  | { kind: 'none' };

/**
 * "Next up" for one member: the lowest-numbered volume in the series they haven't finished — their own reads, not the
 * household's status. A number counts as finished when they finished any volume carrying it (two editions of #3).
 * When whole numbers are missing between their last finish below it and it, those are `skipped`: the next volume on
 * the shelf isn't the next in the series.
 */
export function nextUp(volumes: SeriesVolume[], total: number | null = null): NextUp {
  const numbered = inSeriesOrder(volumes).filter((v) => v.seriesNumber !== null);
  if (!numbered.length) return { kind: 'none' };
  const finished = new Set(numbered.filter((v) => v.finishedByMe).map((v) => v.seriesNumber!));
  const missing = missingNumbers(volumes.map((v) => v.seriesNumber), total);
  // among a number's volumes, the one being read, else the first in order (owned before not owned)
  const candidates = numbered.filter((v) => !finished.has(v.seriesNumber!));
  const lowest = candidates[0]?.seriesNumber;
  const next = lowest === undefined ? undefined : (candidates.find((v) => v.seriesNumber === lowest && v.readingByMe) ?? candidates[0]);
  const lastFinishedBelow = (n: number) => Math.max(0, ...[...finished].filter((f) => f < n));
  if (next) {
    const n = next.seriesNumber!;
    const from = lastFinishedBelow(n);
    const skipped = missing
      .map(([a, b]): NumberRange => [Math.max(a, Math.floor(from) + 1), Math.min(b, Math.ceil(n) - 1)])
      .filter(([a, b]) => a <= b);
    return { kind: 'volume', volume: next, skipped };
  }
  const highest = Math.max(...finished);
  const after = missing.find(([, b]) => b > highest);
  return after ? { kind: 'missing', number: Math.max(after[0], Math.floor(highest) + 1) } : { kind: 'done' };
}
