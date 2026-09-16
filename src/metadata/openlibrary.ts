import { fetchWithTimeout, USER_AGENT } from '../env';
import { cleanDescription, type Candidate, type MetadataProvider } from './provider';

type OlDoc = {
  key?: string;
  title?: string;
  author_name?: string[];
  publisher?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  cover_i?: number;
  isbn?: string[];
};

const FIELDS = 'key,title,author_name,publisher,first_publish_year,number_of_pages_median,cover_i,isbn';
// The backfill never reads the isbn list, and it dwarfs the rest: a search for a work with many
// editions answers in 78 KB with it and 17 KB without. A Worker parses that inside a 10 ms CPU
// budget, several times per item — so cover/detail lookups ask for the lean set.
const LEAN_FIELDS = 'key,title,author_name,publisher,first_publish_year,number_of_pages_median,cover_i';

async function searchOl(q: string, limit: number, fields: string = FIELDS): Promise<OlDoc[]> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&fields=${fields}&limit=${limit}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return [];
  const data = (await res.json()) as { docs?: OlDoc[] };
  return data.docs ?? [];
}

function toCandidate(doc: OlDoc, isbn13?: string): Candidate | null {
  if (!doc.title) return null;
  // ?default=false makes OL 404 instead of serving a 1px placeholder for unknown ISBNs
  const coverUrl = doc.cover_i
    ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
    : isbn13
      ? `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg?default=false`
      : undefined;
  return {
    mediaType: 'book',
    title: doc.title,
    creators: doc.author_name?.join(', '),
    publisher: doc.publisher?.[0],
    published: doc.first_publish_year?.toString(),
    length: doc.number_of_pages_median ?? undefined,
    isbn13,
    coverUrl,
    workKey: doc.key?.startsWith('/works/') ? doc.key : undefined,
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
    const docs = await searchOl(`isbn:${code}`, 1, LEAN_FIELDS);
    return docs[0] ? toCandidate(docs[0], code) : null;
  },

  async search(query: string): Promise<Candidate[]> {
    const docs = await searchOl(query, 8);
    return docs
      .map((d) => toCandidate(d, d.isbn?.find((i) => i.length === 13)))
      .filter((c): c is Candidate => !!c);
  },
};

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
export async function olSearchLean(query: string, limit = 5): Promise<Candidate[]> {
  const docs = await searchOl(query, limit, LEAN_FIELDS);
  return docs.map((d) => toCandidate(d)).filter((c): c is Candidate => !!c);
}
