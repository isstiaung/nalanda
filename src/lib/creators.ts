// Creators and publishers as pages (ARCH.md §16 #72): the people behind the items, read out of the `creators` column —
// authors of books, designers of games, artists of records — and the publishers and labels out of `publisher`. No
// table: a creator is a name, and the pages are built from the strings the items carry, split by the rule below.
import type { MediaType } from '../db/schema';

/**
 * The people in a `creators` string — the TypeScript twin of YEAR_CREATORS in src/db/queries.ts (Year in review's
 * most-read authors, §16 #59), rule for rule, and test/creators.spec.ts holds the two to the same answers. Every
 * provider and importer joins several people with ", ", so a comma usually separates people — but a catalogue typed
 * or imported by hand can hold one person written "Last, First": "Le Guin, Ursula K.", "Tolkien, J. R. R.". Such a
 * string is one person, turned round ("Ursula K. Le Guin") so it meets the same author written the usual way. It is
 * one when it has exactly one comma, no ';' or '&', no full stop before the comma (so "James S. A. Corey, Someone"
 * stays two), and given names after it: a single word, or names ending in an initial ("Ursula K.", "J. R. R."), and
 * not a suffix ("Martin Luther King, Jr." keeps its order, and the lone "Jr." is dropped as nobody). Two full names
 * ("Terry Pratchett, Neil Gaiman") stay two people. ';' and ' & ' separate people too ("Pratchett & Gaiman").
 */
export function splitCreators(creators: string | null | undefined): string[] {
  const cr = sqlTrim(creators ?? '');
  if (!cr) return [];
  const comma = cr.indexOf(',');
  const a = comma >= 0 ? sqlTrim(cr.slice(0, comma)) : '';
  const b = comma >= 0 ? sqlTrim(cr.slice(comma + 1)) : '';
  let names: string;
  if (
    comma >= 0 &&
    !b.includes(',') &&
    !cr.includes(';') &&
    !cr.includes('&') &&
    a !== '' &&
    b !== '' &&
    !a.includes('.') &&
    !SUFFIXES.has(b.toLowerCase()) &&
    (!b.includes(' ') || /[A-Z]\.$/.test(b))
  ) {
    names = `${b} ${a}`;
  } else {
    names = cr.replaceAll(';', ',').replaceAll(' & ', ',');
  }
  return names
    .split(',')
    .map(sqlTrim)
    .filter((n) => n !== '' && !NOBODY.has(n.toLowerCase()));
}

/** SQLite's trim(): spaces only — not tabs, newlines or no-break spaces, which JS's trim() would take and the SQL twin keeps. */
const sqlTrim = (s: string): string => s.replace(/^ +| +$/g, '');

const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);
const NOBODY = new Set(['jr', 'jr.', 'sr', 'sr.']);

/** One name as the pages key it: trimmed, inner whitespace collapsed, compared without case. */
export const nameKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase();

/** What a creator is called for each kind of item: the pages' headings, and the index's groups. */
export const CREATOR_ROLE: Record<MediaType, { one: string; many: string }> = {
  book: { one: 'Author', many: 'Authors' },
  boardgame: { one: 'Designer', many: 'Designers' },
  vinyl: { one: 'Artist', many: 'Artists' },
  music: { one: 'Artist', many: 'Artists' },
  movie: { one: 'Director', many: 'Directors' },
  videogame: { one: 'Developer', many: 'Developers' },
  other: { one: 'Creator', many: 'Creators' },
};

/** What a publisher is called: a record's is its label. */
export const PUBLISHER_ROLE: Record<MediaType, { one: string; many: string }> = {
  book: { one: 'Publisher', many: 'Publishers' },
  boardgame: { one: 'Publisher', many: 'Publishers' },
  vinyl: { one: 'Label', many: 'Labels' },
  music: { one: 'Label', many: 'Labels' },
  movie: { one: 'Studio', many: 'Studios' },
  videogame: { one: 'Publisher', many: 'Publishers' },
  other: { one: 'Publisher', many: 'Publishers' },
};

/** The order the index lists its groups in, and the role a name of several kinds is headed by: the kind it has most of. */
export const ROLE_ORDER: MediaType[] = ['book', 'boardgame', 'vinyl', 'music', 'movie', 'videogame', 'other'];

export type NameCount = { name: string; key: string; total: number; byType: Partial<Record<MediaType, number>> };

/** The kind a name has most of, ties in ROLE_ORDER: what its page and its group call it. */
export function mainType(n: NameCount): MediaType {
  let best: MediaType = 'other';
  let most = -1;
  for (const t of ROLE_ORDER) {
    const c = n.byType[t] ?? 0;
    if (c > most) [best, most] = [t, c];
  }
  return best;
}

/** Adds one item of `type` under `name` — the first spelling seen is the one shown. */
export function countName(into: Map<string, NameCount>, name: string, type: MediaType): void {
  const key = nameKey(name);
  const n = into.get(key) ?? { name: name.replace(/\s+/g, ' ').trim(), key, total: 0, byType: {} };
  n.total += 1;
  n.byType[type] = (n.byType[type] ?? 0) + 1;
  into.set(key, n);
}

/** Names in the index's order: by group (ROLE_ORDER), then by name, letter by letter without case. */
export function sortNames(names: NameCount[]): NameCount[] {
  const rank = (n: NameCount) => ROLE_ORDER.indexOf(mainType(n));
  return [...names].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name, 'en', { sensitivity: 'base' }));
}
