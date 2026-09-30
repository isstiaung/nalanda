// Year in review (ARCH.md §16 #59): a year of reading and playing, the signed-in member's beside the household's. In
// the app only — never on share pages or to connections. The counting is SQL (yearInReview() in src/db/queries.ts, one
// batch); this module is the shape of what comes back and the arithmetic around it.

/** One year's figures for one scope: the signed-in member's own reads and reviews, or everyone's. Books only. */
export type YearStats = {
  /** January to December: finishes (re-reads count) and the pages of those with a length. */
  months: Array<{ books: number; pages: number }>;
  books: number;
  pages: number;
  /** how many of `books` had a length, so the page count can say what it covers */
  withLength: number;
  /** by distinct books (title and author, so two editions are one), then finishes */
  authors: Array<{ name: string; books: number; finishes: number }>;
  tags: Array<{ name: string; books: number }>;
  /** the average half-star rating (1–10) given to the year's books by whoever finished them, and how many ratings */
  rating: { average: number; count: number } | null;
  topRated: Array<{ id: number; title: string; creators: string | null; rating: number }>;
  longest: { id: number; title: string; length: number } | null;
  shortest: { id: number; title: string; length: number } | null;
  /** began to ended, counting both days: a book started and finished on one day took 1 */
  fastest: { id: number; title: string; days: number } | null;
};

export type PlayStats = { plays: number; items: number; top: Array<{ id: number; title: string; plays: number }> };

export type YearReview = {
  year: number;
  mine: YearStats;
  household: YearStats;
  /** the household's play log (§16 #54): nobody's own, so shown once */
  plays: { vinyl: PlayStats; boardgame: PlayStats };
  /** finished books with no end date, which are in no year */
  undated: { mine: number; household: number };
  /** the years with a dated finish or a play, newest first */
  years: number[];
  members: number;
};

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** How many authors, tags and top-rated books each list shows, and plays per type. */
export const YEAR_TOP = 5;
export const PLAYS_TOP = 3;

/**
 * A year from `?year=`: four digits, 1000–9998 — anything else is none, and the page shows this year. Not 9999: its
 * range would end at "10000-01-01", which sorts before every date in it.
 */
export function parseYear(raw: string | undefined): number | null {
  if (!raw || !/^\d{4}$/.test(raw)) return null;
  const y = Number(raw);
  return y >= 1000 && y <= 9998 ? y : null;
}

/** The first day of `year` and of the next, as the half-open range a read's `ended_on` is compared with (UTC dates). */
export function yearRange(year: number): [string, string] {
  return [`${year}-01-01`, `${year + 1}-01-01`];
}

/** What the picker offers: every year with data, this year, and the one being shown — newest first, once each. */
export function pickerYears(withData: number[], current: number, shown: number): number[] {
  return [...new Set([...withData, current, shown])].sort((a, b) => b - a);
}

export const emptyStats = (): YearStats => ({
  months: MONTHS.map(() => ({ books: 0, pages: 0 })),
  books: 0,
  pages: 0,
  withLength: 0,
  authors: [],
  tags: [],
  rating: null,
  topRated: [],
  longest: null,
  shortest: null,
  fastest: null,
});

export const emptyPlays = (): PlayStats => ({ plays: 0, items: 0, top: [] });

/** Whether a year has anything to show at all: a dated finish by anyone, or a play. */
export const yearHasData = (r: YearReview) => r.household.books > 0 || r.plays.vinyl.plays > 0 || r.plays.boardgame.plays > 0;

/**
 * Whether the household's column would say nothing the member's doesn't: a household of one whose every finish that
 * year is theirs (a former member's reads, unattributed, still make the two differ).
 */
export const soloYear = (r: YearReview) => r.members <= 1 && JSON.stringify(r.mine) === JSON.stringify(r.household);

/** A half-star average (1–10) as stars out of five, one decimal: 7.5 → "3.8". */
export const outOfFive = (halfStars: number) => (Math.round(halfStars * 5) / 10).toFixed(1);

/** The tallest bar's height in the chart is 100%; others in proportion, and a month with any finish at least a sliver. */
export function barPercent(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0;
  return Math.max(4, Math.round((n / max) * 100));
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
