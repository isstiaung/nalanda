import { USER_AGENT } from '../env';
import type { Candidate, MetadataProvider } from './provider';

type OlDoc = {
  title?: string;
  author_name?: string[];
  publisher?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  cover_i?: number;
  isbn?: string[];
};

const FIELDS = 'title,author_name,publisher,first_publish_year,number_of_pages_median,cover_i,isbn';

async function searchOl(q: string, limit: number): Promise<OlDoc[]> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&fields=${FIELDS}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
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
    details: {},
    provider: 'openlibrary',
  };
}

export const openLibrary: MetadataProvider = {
  id: 'openlibrary',
  mediaTypes: ['book'],

  async lookupByBarcode(code: string): Promise<Candidate | null> {
    const docs = await searchOl(`isbn:${code}`, 1);
    return docs[0] ? toCandidate(docs[0], code) : null;
  },

  async search(query: string): Promise<Candidate[]> {
    const docs = await searchOl(query, 8);
    return docs
      .map((d) => toCandidate(d, d.isbn?.find((i) => i.length === 13)))
      .filter((c): c is Candidate => !!c);
  },
};
