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
  key: string;
  /** 'barcode' = exact edition; 'title' = matched by title/author (possibly another edition) */
  method: 'barcode' | 'title';
};

/**
 * Cover backfill: try providers lazily until one yields a storable image.
 * Pass 1 (exact, by barcode): Open Library search → OL edition record → Google Books
 *   → iTunes for ISBNs; Discogs → MusicBrainz/Cover Art Archive for other barcodes.
 * Pass 2 (by title + author, guarded by titlesMatch): OL/Google Books for books,
 *   BGG for board games, Discogs for vinyl — a different edition's cover may be used.
 * Storage is injected so this module stays the only place that talks to provider APIs.
 */
export async function findCover(
  env: Bindings,
  subject: CoverSubject,
  store: (url: string) => Promise<string | null>,
): Promise<CoverResult | null> {
  const tryStore = async (url: string | null | undefined) => (url ? store(url) : null);

  const classified = subject.barcode ? classifyBarcode(subject.barcode) : null;
  if (classified?.kind === 'isbn13') {
    // Unattended rule: never store a cover whose record title doesn't match the item.
    // ISBN indexes contain junk (typos, recycled/polluted ranges) and Google Books
    // fuzzy-matches unknown ISBNs as keywords — a title check catches both.
    const isbn = classified.code;
    const titleOk = (t: string | null | undefined) => !!t && titlesMatch(t, subject.title);

    const ol = await openLibrary.lookupByBarcode(isbn).catch(() => null);
    let key = ol && titleOk(ol.title) ? await tryStore(ol.coverUrl) : null;
    if (key) return { key, method: 'barcode' };

    const edition = await olEditionCover(isbn).catch(() => null);
    key = edition && titleOk(edition.title) ? await tryStore(edition.coverUrl) : null;
    if (key) return { key, method: 'barcode' };

    const gb = await googleBooks(env.GOOGLE_BOOKS_KEY).lookupByBarcode(isbn).catch(() => null);
    if (gb && (gb.isbn13 === isbn || gb.isbn10Upc === isbn || titleOk(gb.title))) {
      key = await tryStore(gb.coverUrl);
      if (key) return { key, method: 'barcode' };
    }

    key = await tryStore(await itunesCoverByIsbn(isbn, subject.title).catch(() => null));
    if (key) return { key, method: 'barcode' };
  } else if (classified) {
    if (env.DISCOGS_TOKEN) {
      const release = await discogs(env.DISCOGS_TOKEN).lookupByBarcode(classified.code).catch(() => null);
      const key = await tryStore(release?.coverUrl);
      if (key) return { key, method: 'barcode' };
    }
    const key = await tryStore(await caaCoverByBarcode(classified.code).catch(() => null));
    if (key) return { key, method: 'barcode' };
  }

  // pass 2: title match guarded by creator match — same-title-different-author
  // is the classic wrong-cover failure
  const { title, creators, mediaType } = subject;
  const firstCreator = creators?.split(',')[0]?.trim();
  const pick = (candidates: Candidate[] | null) =>
    candidates?.find((c) => c.coverUrl && titlesMatch(c.title, title) && creatorsMatch(creators, c.creators))
      ?.coverUrl ?? null;

  if (mediaType === 'boardgame') {
    const key = await tryStore(pick(await bgg.search(title).catch(() => null)));
    return key ? { key, method: 'title' } : null;
  }
  if (mediaType === 'vinyl' || mediaType === 'music') {
    if (!env.DISCOGS_TOKEN) return null;
    const q = firstCreator ? `${firstCreator} ${title}` : title;
    const key = await tryStore(pick(await discogs(env.DISCOGS_TOKEN).search(q).catch(() => null)));
    return key ? { key, method: 'title' } : null;
  }

  const olQuery = firstCreator ? `title:"${title}" author:"${firstCreator}"` : `title:"${title}"`;
  let key = await tryStore(pick(await openLibrary.search(olQuery).catch(() => null)));
  if (key) return { key, method: 'title' };
  const gbQuery = firstCreator ? `intitle:"${title}" inauthor:"${firstCreator}"` : `intitle:"${title}"`;
  key = await tryStore(pick(await googleBooks(env.GOOGLE_BOOKS_KEY).search(gbQuery).catch(() => null)));
  return key ? { key, method: 'title' } : null;
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
