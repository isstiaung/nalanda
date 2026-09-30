// Provider chain + barcode routing. Nothing outside src/metadata/ calls external APIs.
import type { Bindings } from '../env';
import type { MediaType } from '../db/schema';
import { bgg, BggAuthError, BggBusyError, bggGame, type BggGameResult } from './bgg';
import { discogs } from './discogs';
import { googleBooks } from './googlebooks';
import { itunesCoverByIsbn } from './itunes';
import { caaCoverByBarcode } from './musicbrainz';
import { olEditionCover, olSearchLean, olWorkDescription, openLibrary, openLibrarySearchPage } from './openlibrary';
import { creatorsMatch, titlesMatch, type Candidate, type LookupResult } from './provider';

export type { Candidate, LookupResult } from './provider';
export type { DiscogsFailure, PressingResult } from './discogs';
export { cleanDescription, creatorsMatch, normTitle, titlesMatch } from './provider';

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
    // Open Library's alone in practice — Google Books never names a series (§16 #52) — but kept symmetric
    series: ol.series ?? gb.series,
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
  const found = await discogs(env.DISCOGS_TOKEN).lookupByBarcode(classified.code).catch(() => null);
  // the barcode scanned is the record's own: kept on the item, so "Want" on it again finds it (§16 #53)
  const hit = found ? { ...found, isbn10Upc: found.isbn10Upc || classified.code } : null;
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
  // False for an item that already has a cover and only wants details. Its search can then stop at the
  // first description and skip the cover-only lookups — without this, every description-only item ran the
  // whole chain, about three Google Books calls each against a 1,000-a-day quota.
  wantCover?: boolean;
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
  const { title, creators, mediaType } = subject;
  const wantCover = subject.wantCover !== false;
  // nothing is fetched or stored for an item that already has its cover
  const tryStore = async (url: string | null | undefined) => (url && wantCover ? store(url) : null);
  // Providers are complementary: Open Library's search carries no description, Google Books does,
  // so a later record fills what an earlier one left blank rather than replacing it.
  let details: Candidate | null = null;
  let key: string | null = null;
  /** Done once there's a description and either a cover or no wish for one. */
  const satisfied = () => (!!key || !wantCover) && !!details?.description;

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
    if (!key && wantCover) {
      const edition = await olEditionCover(isbn).catch(() => null);
      if (edition && titleOk(edition.title)) key = await tryStore(edition.coverUrl);
    }
    if (!satisfied()) {
      const gb = await googleBooks(env.GOOGLE_BOOKS_KEY).lookupByBarcode(isbn).catch(() => null);
      if (gb && (gb.isbn13 === isbn || gb.isbn10Upc === isbn || titleOk(gb.title))) {
        details = keep(details, gb);
        key ??= await tryStore(gb.coverUrl);
      }
    }
    if (!key && wantCover) key = await tryStore(await itunesCoverByIsbn(isbn, title).catch(() => null));
    if (satisfied()) return { key, method: key ? 'barcode' : 'title', candidate: details };
  } else if (classified) {
    if (env.DISCOGS_TOKEN) {
      const release = await discogs(env.DISCOGS_TOKEN).lookupByBarcode(classified.code).catch(() => null);
      details = keep(details, release);
      key = await tryStore(release?.coverUrl);
    }
    if (!key && wantCover) key = await tryStore(await caaCoverByBarcode(classified.code).catch(() => null));
    if (satisfied()) return { key, method: key ? 'barcode' : 'title', candidate: details };
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
      if (satisfied()) break;
    }
    return key || details ? { key, method: key ? method : 'title', candidate: details } : null;
  };

  const query = searchableTitle(title);
  if (mediaType === 'boardgame') {
    if (!env.BGG_TOKEN) return null; // no token, no BGG — nothing to find a board game's cover with
    return fromSearches([() => bgg(env.BGG_TOKEN).search(query)]);
  }
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
    () => olSearchLean(olQuery),
    () => googleBooks(env.GOOGLE_BOOKS_KEY).search(gbQuery),
    () => olSearchLean(`title:"${query}"`),
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

/**
 * A description for a record that matched, when the provider keeps it outside its search index.
 * Open Library does: one more request to the work record, and no daily quota to exhaust.
 */
export async function findDescription(candidate: Candidate | null): Promise<string | null> {
  if (!candidate?.workKey) return null;
  return olWorkDescription(candidate.workKey).catch(() => null);
}

/**
 * A record's pressing details from Discogs, in exactly one request (ARCH.md §16 #55): the release by its id when
 * one is known — the full answer, tracklist included — or else the first release matching its barcode, which
 * carries everything but the tracklist, and the release id the next refresh then uses. A failed request is a
 * result, never a throw: the page says why.
 */
export async function discogsPressing(
  env: Bindings,
  source: { releaseId: number } | { barcode: string },
): Promise<import('./discogs').PressingResult> {
  if (!env.DISCOGS_TOKEN) return { ok: false, failure: 'refused' };
  const client = discogs(env.DISCOGS_TOKEN);
  try {
    return 'releaseId' in source ? await client.release(source.releaseId) : await client.pressingByBarcode(source.barcode);
  } catch {
    return { ok: false, failure: 'unavailable' }; // a timeout, a dropped connection, a body that wasn't JSON
  }
}

/**
 * BGG asks for about five seconds between requests; an over-eager client is throttled. Search keeps its two requests
 * back to back, but "Refresh from BGG" is a button anyone can press twice, so this isolate lets one refresh through to
 * BGG every BGG_REFRESH_GAP_MS and answers any other as "busy" without asking. Per isolate, so a best effort — BGG's
 * own busy answers (429, 500, 503, 202) come back as the same notice.
 */
export const BGG_REFRESH_GAP_MS = 5000;
let bggRefreshAllowedAt = 0;

/** Tests only: forget the last refresh, so one test's click doesn't pace the next's. */
export function resetBggPacing(): void {
  bggRefreshAllowedAt = 0;
}

/**
 * A board game's BGG record by its id, for "Refresh from BGG" (ARCH.md §16 #60): exactly one `thing` request, or
 * none when the token is missing or the last refresh was too recent. A failure is a code, never BGG's text.
 */
export async function bggRefresh(env: Bindings, bggId: number): Promise<BggGameResult> {
  if (!env.BGG_TOKEN) return { ok: false, failure: 'refused' };
  const now = Date.now();
  if (now < bggRefreshAllowedAt) return { ok: false, failure: 'busy' };
  bggRefreshAllowedAt = now + BGG_REFRESH_GAP_MS;
  try {
    return await bggGame(env.BGG_TOKEN, bggId);
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

export type SearchType = 'book' | 'boardgame' | 'vinyl';

export async function searchByName(env: Bindings, q: string, type: SearchType, page = 1): Promise<LookupResult> {
  // a later page that comes back empty says so plainly, not as though nothing matched at all
  const none = (first: string) => (page > 1 ? ['No more results.'] : [first]);
  if (type === 'book') {
    const found = await openLibrarySearchPage(q, page).catch(() => ({ candidates: [] as Candidate[], more: false }));
    return { candidates: found.candidates, more: found.more, notices: found.candidates.length ? [] : none('No books found on Open Library.') };
  }
  if (type === 'boardgame') {
    if (!env.BGG_TOKEN) {
      return {
        candidates: [],
        notices: ['BoardGameGeek needs a registered app token now. Set the BGG_TOKEN secret to search board games.'],
      };
    }
    try {
      const found = await bgg(env.BGG_TOKEN).searchPage(q, page);
      return {
        candidates: found.candidates,
        more: found.more,
        notices: found.candidates.length ? [] : none('No board games found on BoardGameGeek.'),
      };
    } catch (err) {
      const notice =
        err instanceof BggAuthError
          ? 'BoardGameGeek rejected the BGG_TOKEN — it may have been revoked or mistyped. Issue a new one and set it again.'
          : err instanceof BggBusyError
            ? 'BoardGameGeek is busy — it limits how often apps may ask. Wait a few seconds and search again.'
            : 'BoardGameGeek did not answer — retry in a moment.';
      return { candidates: [], notices: [notice] };
    }
  }
  if (!env.DISCOGS_TOKEN) {
    return { candidates: [], notices: ['Set the DISCOGS_TOKEN secret to enable Discogs vinyl search.'] };
  }
  const found = await discogs(env.DISCOGS_TOKEN)
    .searchPage(q, page)
    .catch(() => ({ candidates: [] as Candidate[], more: false }));
  return { candidates: found.candidates, more: found.more, notices: found.candidates.length ? [] : none('No vinyl releases found on Discogs.') };
}
