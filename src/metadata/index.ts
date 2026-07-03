// Provider chain + barcode routing. Nothing outside src/metadata/ calls external APIs.
import type { Bindings } from '../env';
import { bgg } from './bgg';
import { discogs } from './discogs';
import { googleBooks } from './googlebooks';
import { openLibrary } from './openlibrary';
import type { Candidate, LookupResult } from './provider';

export type { Candidate, LookupResult } from './provider';

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
