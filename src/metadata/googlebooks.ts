// Google Books works keyless (lower quota); GOOGLE_BOOKS_KEY raises it.
// It usually contributes the description Open Library's search API lacks.
import { USER_AGENT } from '../env';
import type { Candidate, MetadataProvider } from './provider';

type Volume = {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    pageCount?: number;
    imageLinks?: { thumbnail?: string };
    industryIdentifiers?: Array<{ type: string; identifier: string }>;
  };
};

export function googleBooks(apiKey?: string): MetadataProvider {
  async function query(q: string, limit: number): Promise<Candidate[]> {
    const key = apiKey ? `&key=${apiKey}` : '';
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${limit}${key}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: Volume[] };
    return (data.items ?? [])
      .map((v) => {
        const info = v.volumeInfo;
        if (!info?.title) return null;
        const isbn13 = info.industryIdentifiers?.find((i) => i.type === 'ISBN_13')?.identifier;
        const isbn10 = info.industryIdentifiers?.find((i) => i.type === 'ISBN_10')?.identifier;
        const candidate: Candidate = {
          mediaType: 'book',
          title: info.title,
          creators: info.authors?.join(', '),
          publisher: info.publisher,
          published: info.publishedDate,
          description: info.description,
          length: info.pageCount,
          isbn13,
          isbn10Upc: isbn10,
          coverUrl: info.imageLinks?.thumbnail?.replace(/^http:/, 'https:'),
          details: {},
          provider: 'googlebooks',
        };
        return candidate;
      })
      .filter((c): c is Candidate => !!c);
  }

  return {
    id: 'googlebooks',
    mediaTypes: ['book'],
    async lookupByBarcode(code: string): Promise<Candidate | null> {
      const results = await query(`isbn:${code}`, 1);
      return results[0] ?? null;
    },
    async search(q: string): Promise<Candidate[]> {
      return query(q, 8);
    },
  };
}
