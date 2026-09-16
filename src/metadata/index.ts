// Provider chain + barcode routing. Nothing outside src/metadata/ calls external APIs.
import type { Bindings } from '../env';
import type { MediaType } from '../db/schema';
import { bgg } from './bgg';
import { discogs } from './discogs';
import { googleBooks } from './googlebooks';
import { itunesCoverByIsbn } from './itunes';
import { caaCoverByBarcode } from './musicbrainz';
import { olEditionCover, openLibrary } from './openlibrary';
import { creatorsMatch, titlesMatch, type Candidate, type LookupResult } from './provider';

export type { Candidate, LookupResult } from './provider';
export { creatorsMatch, normTitle, titlesMatch } from './provider';

export type BarcodeKind = 'isbn13' | 'upc';

/** EAN-13 starting 978/979 is an ISBN (books); any other EAN/UPC routes to Discogs. */
export function classifyBarcode(raw: string): { kind: BarcodeKind; code: string } | null {
  const code = raw.replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) return null;
  if (code.length === 13 && (code.startsWith('978') || code.startsWith('979'))) {
    return { kind: 'isbn13', code };
  }
  if (code.length === 10) return { kind: 'isbn13', code }; // old ISBN-10, book providers accept it
  return { kind: 'upc', code };
}

/** Prefer Open Library bibliographically; Google Books fills description/cover gaps. */
export function mergeBookCandidates(ol: Candidate | null, gb: Candidate | null): Candidate | null {
  if (!ol && !gb) return null;
  if (!ol) return gb;
  if (!gb) return ol;
  return {
    ...ol,
    description: ol.description || gb.description,
    coverUrl: ol.coverUrl || gb.coverUrl,
    length: ol.length ?? gb.length,
    publisher: ol.publisher || gb.publisher,
    published: ol.published || gb.published,
    isbn10Upc: ol.isbn10Upc || gb.isbn10Upc,
    provider: 'openlibrary+googlebooks',
  };
}

export async function lookupByBarcode(env: Bindings, raw: string): Promise<LookupResult> {
  const classified = classifyBarcode(raw);
  if (!classified) return { candidates: [], notices: ['That does not look like a valid barcode.'] };

  if (classified.kind === 'isbn13') {
    const gb = googleBooks(env.GOOGLE_BOOKS_KEY);
    const [olHit, gbHit] = await Promise.all([
      openLibrary.lookupByBarcode(classified.code).catch(() => null),
      gb.lookupByBarcode(classified.code).catch(() => null),
    ]);
    const merged = mergeBookCandidates(olHit, gbHit);
    return {
      candidates: merged ? [merged] : [],
      notices: merged ? [] : [`No book found for ISBN ${classified.code}. Try the search tab or add manually.`],
    };
  }

  // Non-ISBN EAN/UPC → vinyl (Discogs)
  if (!env.DISCOGS_TOKEN) {
    return {
      candidates: [],
      notices: ['This looks like a music/vinyl barcode. Set the DISCOGS_TOKEN secret to enable Discogs lookups.'],
    };
  }
  const hit = await discogs(env.DISCOGS_TOKEN).lookupByBarcode(classified.code).catch(() => null);
  return {
    candidates: hit ? [hit] : [],
    notices: hit ? [] : [`Discogs has no release for barcode ${classified.code}. Try a name search.`],
  };
}

export type CoverSubject = {
  barcode?: string | null;
  title: string;
  creators?: string | null;
  mediaType: MediaType;
};

export type CoverResult = {
  /** null when a record matched but had no usable image — its details are still worth having. */
  key: string | null;
  /** 'barcode' = exact edition; 'title' = matched by title/author (possibly another edition) */
  method: 'barcode' | 'title';
  /** The record the cover (or the match) came from, for filling in empty fields. */
  candidate: Candidate | null;
};

/**
 * Cover backfill: try providers lazily until one yields a storable image.
 * Pass 1 (exact, by barcode): Open Library search → OL edition record → Google Books
 *   → iTunes for ISBNs; Discogs → MusicBrainz/Cover Art Archive for other barcodes.
 * Pass 2 (by title + author, guarded by titlesMatch): OL/Google Books for books,
 *   BGG for board games, Discogs for vinyl — a different edition's cover may be used.
 * Storage is injected so this module stays the only place that talks to provider APIs.
 */
/**
 * What to ask a provider for. Search indexes are literal: a series suffix ("(Sprawl, #1)"), an
 * issue number, a bracketed note or an ampersand finds nothing, even when the book is right there.
 * Matching still compares the item's real title — this only shapes the query.
 */
export function searchableTitle(title: string): string {
  const cleaned = title
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ')
    .split(':')[0]!
    .replace(/&/g, ' and ')
    .replace(/#\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 3 ? cleaned : title;
}

export async function findCover(
  env: Bindings,
  subject: CoverSubject,
  store: (url: string) => Promise<string | null>,
): Promise<CoverResult | null> {
  const tryStore = async (url: string | null | undefined) => (url ? store(url) : null);
  const { title, creators, mediaType } = subject;
  // Providers are complementary: Open Library's search carries no description, Google Books does,
  // so a later record fills what an earlier one left blank rather than replacing it.
  let details: Candidate | null = null;
  let key: string | null = null;

  const classified = subject.barcode ? classifyBarcode(subject.barcode) : null;
  if (classified?.kind === 'isbn13') {
    // Unattended rule: never store a cover whose record title doesn't match the item.
    // ISBN indexes contain junk (typos, recycled/polluted ranges) and Google Books
    // fuzzy-matches unknown ISBNs as keywords — a title check catches both.
    const isbn = classified.code;
    const titleOk = (t: string | null | undefined) => !!t && titlesMatch(t, title);

    const ol = await openLibrary.lookupByBarcode(isbn).catch(() => null);
    if (ol && titleOk(ol.title)) {
      details = keep(details, ol);
      key = await tryStore(ol.coverUrl);
    }
    if (!key) {
      const edition = await olEditionCover(isbn).catch(() => null);
      if (edition && titleOk(edition.title)) key = await tryStore(edition.coverUrl);
    }
    if (!key || !details?.description) {
      const gb = await googleBooks(env.GOOGLE_BOOKS_KEY).lookupByBarcode(isbn).catch(() => null);
      if (gb && (gb.isbn13 === isbn || gb.isbn10Upc === isbn || titleOk(gb.title))) {
        details = keep(details, gb);
        key ??= await tryStore(gb.coverUrl);
      }
    }
    if (!key) key = await tryStore(await itunesCoverByIsbn(isbn, title).catch(() => null));
    if (key && details?.description) return { key, method: 'barcode', candidate: details };
  } else if (classified) {
    if (env.DISCOGS_TOKEN) {
      const release = await discogs(env.DISCOGS_TOKEN).lookupByBarcode(classified.code).catch(() => null);
      details = keep(details, release);
      key = await tryStore(release?.coverUrl);
    }
    if (!key) key = await tryStore(await caaCoverByBarcode(classified.code).catch(() => null));
    if (key && details?.description) return { key, method: 'barcode', candidate: details };
  }
  const method: CoverResult['method'] = key ? 'barcode' : 'title';

  // pass 2: title match guarded by creator match — same-title-different-author
  // is the classic wrong-cover failure
  const firstCreator = creators?.split(',')[0]?.trim();
  /** The best match: one carrying a cover if any does, else a match whose details are still usable. */
  const pick = (candidates: Candidate[] | null) => {
    const matched = (candidates ?? []).filter((c) => titlesMatch(c.title, title) && creatorsMatch(creators, c.creators));
    return matched.find((c) => c.coverUrl) ?? matched[0] ?? null;
  };
  /** Searches in order, stopping once both a cover and a description are in hand. */
  const fromSearches = async (searches: Array<() => Promise<Candidate[]>>): Promise<CoverResult | null> => {
    for (const search of searches) {
      const candidate = pick(await search().catch(() => null));
      if (!candidate) continue;
      details = keep(details, candidate);
      key ??= await tryStore(candidate.coverUrl);
      if (key && details?.description) break;
    }
    return key || details ? { key, method: key ? method : 'title', candidate: details } : null;
  };

  const query = searchableTitle(title);
  if (mediaType === 'boardgame') return fromSearches([() => bgg.search(query)]);
  if (mediaType === 'vinyl' || mediaType === 'music') {
    if (!env.DISCOGS_TOKEN) return key || details ? { key, method, candidate: details } : null;
    const q = firstCreator ? `${firstCreator} ${query}` : query;
    return fromSearches([() => discogs(env.DISCOGS_TOKEN!).search(q)]);
  }

  const olQuery = firstCreator ? `title:"${query}" author:"${firstCreator}"` : `title:"${query}"`;
  const gbQuery = firstCreator ? `intitle:"${query}" inauthor:"${firstCreator}"` : `intitle:"${query}"`;
  // The author-pinned queries come first, then the same searches without the author. A catalog saying
  // "Mary Wollstonecraft Shelley" finds nothing where the provider credits "Mary Shelley" — but the
  // author guard still runs on whatever comes back, so this widens the search, not what we accept.
  return fromSearches([
    () => openLibrary.search(olQuery),
    () => googleBooks(env.GOOGLE_BOOKS_KEY).search(gbQuery),
    () => openLibrary.search(`title:"${query}"`),
    () => googleBooks(env.GOOGLE_BOOKS_KEY).search(`intitle:"${query}"`),
  ]);
}

/** Keeps the first record, filling its blanks from later ones: providers are complementary. */
function keep(base: Candidate | null, extra: Candidate | null): Candidate | null {
  if (!extra) return base;
  if (!base) return extra;
  return { ...base, ...blanksOf(base, extra) };
}

/** The fields `base` is missing, taken from `extra` — never overwriting what `base` already has. */
function blanksOf(base: Candidate, extra: Candidate): Partial<Candidate> {
  const filled: Partial<Candidate> = {};
  if (!base.creators && extra.creators) filled.creators = extra.creators;
  if (!base.publisher && extra.publisher) filled.publisher = extra.publisher;
  if (!base.published && extra.published) filled.published = extra.published;
  if (!base.description && extra.description) filled.description = extra.description;
  if (!base.length && extra.length) filled.length = extra.length;
  if (!base.isbn13 && extra.isbn13) filled.isbn13 = extra.isbn13;
  if (!base.isbn10Upc && extra.isbn10Upc) filled.isbn10Upc = extra.isbn10Upc;
  if (!base.coverUrl && extra.coverUrl) filled.coverUrl = extra.coverUrl;
  return filled;
}

export type SearchType = 'book' | 'boardgame' | 'vinyl';

export async function searchByName(env: Bindings, q: string, type: SearchType): Promise<LookupResult> {
  if (type === 'book') {
    const candidates = await openLibrary.search(q).catch(() => [] as Candidate[]);
    return { candidates, notices: candidates.length ? [] : ['No books found on Open Library.'] };
  }
  if (type === 'boardgame') {
    const candidates = await bgg.search(q).catch(() => [] as Candidate[]);
    return {
      candidates,
      notices: candidates.length ? [] : ['No board games found on BoardGameGeek (it occasionally throttles — retry).'],
    };
  }
  if (!env.DISCOGS_TOKEN) {
    return { candidates: [], notices: ['Set the DISCOGS_TOKEN secret to enable Discogs vinyl search.'] };
  }
  const candidates = await discogs(env.DISCOGS_TOKEN).search(q).catch(() => [] as Candidate[]);
  return { candidates, notices: candidates.length ? [] : ['No vinyl releases found on Discogs.'] };
}
