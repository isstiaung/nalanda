import { fetchWithTimeout, USER_AGENT } from '../env';
import { formatFromPhysical } from '../lib/formats';
import { languageFromProvider } from '../lib/language';
import { seriesKey } from '../lib/series';
import { cleanSeriesName, parseSeriesNumber, type SeriesDraft } from '../lib/series';
import { cleanDescription, PAGE_SIZE, type Candidate, type MetadataProvider, type SearchPage } from './provider';

type OlDoc = {
  format?: string[]; // the edition's physical form: 'Paperback', 'Hardcover', 'Audio CD'…
  key?: string;
  title?: string;
  author_name?: string[];
  publisher?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  cover_i?: number;
  isbn?: string[];
  // The work's series, from Open Library's series records (§16 #52): parallel lists, the first series first. Only
  // some works carry them — The Expanse and Discworld do, A Wizard of Earthsea doesn't (checked 2026-09-30) — and a
  // position can be "0.5", or an omnibus's "1-3".
  series_name?: string[];
  series_position?: string[];
  language?: string[]; // ISO 639-2/B codes, 'eng'
};

const FIELDS = 'key,title,author_name,publisher,first_publish_year,number_of_pages_median,cover_i,isbn,series_name,series_position,format,language';
// The backfill never reads the isbn list, and it dwarfs the rest: a search for a work with many
// editions answers in 78 KB with it and 17 KB without. A Worker parses that inside a 10 ms CPU
// budget, several times per item — so cover/detail lookups ask for the lean set.
const LEAN_FIELDS = 'key,title,author_name,publisher,first_publish_year,number_of_pages_median,cover_i,series_name,series_position,format,language';

async function searchOl(q: string, limit: number, fields: string = FIELDS, page = 1): Promise<{ docs: OlDoc[]; found: number }> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&fields=${fields}&limit=${limit}${page > 1 ? `&page=${page}` : ''}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return { docs: [], found: 0 };
  const data = (await res.json()) as { docs?: OlDoc[]; numFound?: number };
  const docs = data.docs ?? [];
  return { docs, found: typeof data.numFound === 'number' ? data.numFound : docs.length };
}

/**
 * A search doc's first series, when it names one. A position that isn't a single number — an omnibus's "1-3" — keeps
 * the series without a number rather than guess which volume it is.
 */
export function seriesOf(doc: Pick<OlDoc, 'series_name' | 'series_position'>): { series?: SeriesDraft } {
  const name = cleanSeriesName(doc.series_name?.[0]);
  if (!name) return {};
  // the two lists are parallel only when they are the same length; otherwise the first position may be another series'
  const aligned = (doc.series_position?.length ?? 0) === (doc.series_name?.length ?? 0);
  return { series: { name, number: aligned ? (parseSeriesNumber(doc.series_position?.[0]) ?? null) : null } };
}

/** A doc as a candidate, with the ISBN it was found by — an ISBN-13, or an ISBN-10, which is never passed off as one. */
function toCandidate(doc: OlDoc, isbn13?: string, isbn10?: string): Candidate | null {
  if (!doc.title) return null;
  // ?default=false makes OL 404 instead of serving a 1px placeholder for unknown ISBNs; either ISBN names the edition
  const isbn = isbn10 ?? isbn13;
  const coverUrl = doc.cover_i
    ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
    : isbn
      ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`
      : undefined;
  return {
    mediaType: 'book',
    title: doc.title,
    creators: doc.author_name?.join(', '),
    publisher: doc.publisher?.[0],
    published: doc.first_publish_year?.toString(),
    length: doc.number_of_pages_median ?? undefined,
    isbn13,
    isbn10Upc: isbn10,
    coverUrl,
    workKey: doc.key?.startsWith('/works/') ? doc.key : undefined,
    ...seriesOf(doc),
    // the edition's physical form, when the index names one clearly (§16 #75)
    ...(formatFromPhysical(doc.format?.find((f) => formatFromPhysical(f))) ? { formats: [formatFromPhysical(doc.format!.find((f) => formatFromPhysical(f)))!] } : {}),
    // the edition's language, when the index names one (§16 #76): the first of the work's, which is usually the only one
    ...(languageFromProvider(doc.language?.[0]) ? { language: languageFromProvider(doc.language?.[0])! } : {}),
    details: {},
    provider: 'openlibrary',
  };
}

/**
 * Deeper dig than the search index: the raw edition record at /isbn/{isbn}.json
 * sometimes carries cover ids for editions the search API misses. Returns the
 * record's title too — callers must verify it (junk ISBN ranges have junk records).
 */
export async function olEditionCover(isbn: string): Promise<{ coverUrl: string; title: string } | null> {
  const res = await fetchWithTimeout(`https://openlibrary.org/isbn/${isbn}.json`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { covers?: number[]; title?: string };
  const id = data.covers?.find((c) => c > 0);
  if (!id || !data.title) return null;
  return { coverUrl: `https://covers.openlibrary.org/b/id/${id}-L.jpg`, title: data.title };
}

export const openLibrary: MetadataProvider = {
  id: 'openlibrary',
  mediaTypes: ['book'],

  async lookupByBarcode(code: string): Promise<Candidate | null> {
    // Lean: the ISBN recorded is the one that was scanned, so the doc's edition list is never read —
    // and Open Library sends the whole thing (70 KB for a much-reprinted work) even at limit 1.
    // An ISBN-10 is recorded as one; the ISBN-13 it stands for is the router's to add (lookupByBarcode in index.ts).
    const { docs } = await searchOl(`isbn:${code}`, 1, LEAN_FIELDS);
    if (!docs[0]) return null;
    return code.length === 13 ? toCandidate(docs[0], code) : toCandidate(docs[0], undefined, code);
  },

  async search(query: string): Promise<Candidate[]> {
    return (await openLibrarySearchPage(query, 1)).candidates;
  },
};

/** One page of a book search: Open Library ranks by relevance and pages itself (`page`, eight at a time). */
export async function openLibrarySearchPage(query: string, page: number): Promise<SearchPage> {
  const { docs, found } = await searchOl(query, PAGE_SIZE, FIELDS, page);
  const candidates = docs
    .map((d) => toCandidate(d, d.isbn?.find((i) => i.length === 13)))
    .filter((c): c is Candidate => !!c);
  return { candidates, more: page * PAGE_SIZE < found };
}

/**
 * The description Open Library's search index omits: it lives on the work record. Their text often ends
 * with a markdown source footnote ("([source][1])" plus a link definition), which is dropped here.
 */
export async function olWorkDescription(workKey: string): Promise<string | null> {
  const res = await fetchWithTimeout(`https://openlibrary.org${workKey}.json`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = (await res.json()) as { description?: string | { value?: string } };
  const raw = typeof data.description === 'string' ? data.description : data.description?.value;
  return cleanDescription(raw);
}

/** Cover and description lookups: fewer results, and none of the ISBN bulk the backfill never reads. */
/**
 * An author's works, newest first (ARCH.md §16 #78): one keyless request to the search index by author name, sorted
 * by first publication, so "new from authors you've finished" is one call per author, made on a click. Each doc
 * becomes a candidate with its first ISBN-13 (for "In your catalog") and its cover.
 */
export async function olRecentByAuthor(author: string, limit = 12): Promise<Candidate[] | null> {
  const url = `https://openlibrary.org/search.json?author=${encodeURIComponent(author)}&sort=new&fields=${FIELDS}&limit=${limit}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null; // no answer — a burst block, an outage — is not an empty answer, and is never cached
    const data = (await res.json()) as { docs?: OlDoc[] };
    return (data.docs ?? [])
      .map((d) => toCandidate(d, d.isbn?.find((i) => /^\d{13}$/.test(i))))
      .filter((c): c is Candidate => !!c)
      .sort((a, b) => Number(b.published ?? 0) - Number(a.published ?? 0));
  } catch {
    return null;
  }
}

/**
 * The works Open Library's index places in a series of this name (ARCH.md §16 #79): one keyless search for the
 * name, kept to the docs whose series matches it (seriesKey: case and spacing aside), each as a candidate with its
 * position and its first ISBN-13. Only some works carry series records (checked 2026-09-30: The Expanse and Discworld
 * do, Earthsea doesn't), so an empty answer says nothing about the series.
 */
export async function olSeriesWorks(name: string, limit = 40): Promise<Array<{ candidate: Candidate; position: number | null }> | null> {
  const key = seriesKey(name);
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(name)}&fields=${FIELDS}&limit=${limit}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null; // no answer is not an empty answer, and is never cached
    const docs = ((await res.json()) as { docs?: OlDoc[] }).docs ?? [];
    return docs
      .filter((d) => (d.series_name ?? []).some((n) => seriesKey(n) === key))
      .map((d) => {
        const c = toCandidate(d, d.isbn?.find((i) => /^\d{13}$/.test(i)));
        if (!c) return null;
        // series_name and series_position are parallel lists; when their lengths differ a position may belong to
        // another of the work's series, so the work is listed without one rather than offered under a wrong number
        const names = d.series_name ?? [];
        const at = names.findIndex((n) => seriesKey(n) === key);
        const aligned = (d.series_position?.length ?? 0) === names.length;
        const position = aligned ? (parseSeriesNumber(d.series_position?.[at]) ?? null) : null;
        return { candidate: c, position };
      })
      .filter((x): x is { candidate: Candidate; position: number | null } => x !== null)
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  } catch {
    return null;
  }
}

export async function olSearchLean(query: string, limit = 5): Promise<Candidate[]> {
  const { docs } = await searchOl(query, limit, LEAN_FIELDS);
  return docs.map((d) => toCandidate(d)).filter((c): c is Candidate => !!c);
}
