// Search operators (ARCH.md §16 #80): what a prefix in the search box means. A query is parsed once, here, into
// words for the full-text index and the operators' values; `searchItems()` in db/queries.ts applies the indexed
// ones (title:, author:) as FTS5 column filters and the rest (tag:, status:, year:, lang:, type:) as plain WHERE
// clauses on `items`, inside the one id query. An unknown prefix, or a value an operator can't read, is searched
// as the text it is — nothing typed is silently dropped.
import type { ItemStatus, MediaType } from '../db/schema';
import { isLanguageCode, LANGUAGES } from './language';

export type YearRange = { from: number; to: number };

export type ParsedSearch = {
  text: string[]; // plain words, matched as prefixes in every indexed column
  title: string[]; // title: phrases, in the title column only
  author: string[]; // author: (or creator:, by:) phrases, in the creators column only
  tags: string[]; // tag: names, lowercase as tags are stored; an item must carry every one
  statuses: ItemStatus[]; // status: any of these (In progress holds a re-read, as every status filter does — §16 #64)
  years: YearRange[]; // year: 2019, or 2010-2019; any of these
  languages: string[]; // lang: ISO 639-1 codes, by code or English name; any of these
  types: MediaType[]; // type: any of these
};

/** The operators, as the page lists them. */
export const OPERATORS = ['author:', 'title:', 'tag:', 'status:', 'year:', 'lang:', 'type:'] as const;

/** The words a status: value may be — the pills' names and the obvious synonyms, never the column's values alone. */
const STATUS_WORDS: Record<string, ItemStatus> = {
  unread: 'not_started',
  'not-started': 'not_started',
  not_started: 'not_started',
  new: 'not_started',
  tbr: 'not_started',
  reading: 'in_progress',
  'in-progress': 'in_progress',
  in_progress: 'in_progress',
  current: 'in_progress',
  rereading: 'in_progress',
  're-reading': 'in_progress',
  read: 'completed',
  completed: 'completed',
  finished: 'completed',
  done: 'completed',
  abandoned: 'abandoned',
  dnf: 'abandoned',
  stopped: 'abandoned',
};

const TYPE_WORDS: Record<string, MediaType> = {
  book: 'book',
  books: 'book',
  game: 'boardgame',
  games: 'boardgame',
  boardgame: 'boardgame',
  boardgames: 'boardgame',
  'board-game': 'boardgame',
  record: 'vinyl',
  records: 'vinyl',
  vinyl: 'vinyl',
  lp: 'vinyl',
  movie: 'movie',
  movies: 'movie',
  film: 'movie',
  music: 'music',
  cd: 'music',
  videogame: 'videogame',
  videogames: 'videogame',
  'video-game': 'videogame',
  other: 'other',
};

const LANGUAGE_BY_NAME = new Map(LANGUAGES.map((l) => [l.name.toLowerCase(), l.code]));

/** A lang: value as a code: "hi" or "Hindi" → "hi"; null when it is neither. */
export function languageCode(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (isLanguageCode(v)) return v;
  return LANGUAGE_BY_NAME.get(v) ?? null;
}

const YEAR = /^(\d{4})(?:-(\d{4}))?$/;

/** Each token: an optional `prefix:` of letters, then a double-quoted phrase or a run of non-space characters (none, after a bare prefix). */
const TOKEN = /(?:([a-z]+):)?(?:"([^"]*)"|(\S*))/gi;

export function parseSearch(q: string): ParsedSearch {
  const out: ParsedSearch = { text: [], title: [], author: [], tags: [], statuses: [], years: [], languages: [], types: [] };
  const words = (v: string) => out.text.push(...v.split(/\s+/).filter(Boolean));
  for (const m of q.matchAll(TOKEN)) {
    if (!m[0]) continue; // the empty match between tokens
    const prefix = m[1]?.toLowerCase();
    const value = (m[2] ?? m[3] ?? '').trim();
    switch (prefix) {
      case undefined:
        words(value);
        break;
      case 'title':
        if (value) out.title.push(value);
        break;
      case 'author':
      case 'creator':
      case 'by':
        if (value) out.author.push(value);
        break;
      case 'tag':
        if (value) out.tags.push(value.toLowerCase());
        break;
      case 'status': {
        const status = STATUS_WORDS[value.toLowerCase()];
        if (status) out.statuses.push(status);
        else words(m[0]);
        break;
      }
      case 'year': {
        const y = YEAR.exec(value);
        if (y) {
          const from = Number(y[1]);
          const to = y[2] ? Number(y[2]) : from;
          out.years.push(from <= to ? { from, to } : { from: to, to: from });
        } else words(m[0]);
        break;
      }
      case 'lang':
      case 'language': {
        const code = languageCode(value);
        if (code) out.languages.push(code);
        else words(m[0]);
        break;
      }
      case 'type': {
        const type = TYPE_WORDS[value.toLowerCase()];
        if (type) out.types.push(type);
        else words(m[0]);
        break;
      }
      default:
        // an unknown prefix is part of the text ("re:zero" is a title)
        words(m[0]);
    }
  }
  return out;
}

/** An FTS5 phrase matched as a prefix, with the characters FTS5 would read as syntax taken out; '' when nothing is left. */
function phrase(t: string): string {
  const clean = t.replace(/["'*^:]/g, ' ').trim();
  return clean ? `"${clean}"*` : '';
}

/**
 * The FTS5 MATCH expression for the indexed parts: every plain word in any column, title: phrases in `title`,
 * author: phrases in `creators`, all required. '' when the query has none — then only the operators' filters apply.
 */
export function ftsMatch(p: ParsedSearch): string {
  return [
    ...p.text.map(phrase),
    ...p.title.map((t) => phrase(t) && `title:${phrase(t)}`),
    ...p.author.map((a) => phrase(a) && `creators:${phrase(a)}`),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Whether any of the non-indexed operators narrows the query. */
export const hasFilters = (p: ParsedSearch): boolean =>
  p.tags.length > 0 || p.statuses.length > 0 || p.years.length > 0 || p.languages.length > 0 || p.types.length > 0;
