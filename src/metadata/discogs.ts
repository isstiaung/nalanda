// Discogs — the vinyl database. Free personal access token; DOES support barcode
// search, which makes scanning a record sleeve work like scanning a book.
import { USER_AGENT } from '../env';
import type { Candidate, MetadataProvider } from './provider';

type DiscogsResult = {
  id?: number;
  title?: string; // "Artist - Title"
  year?: string;
  label?: string[];
  catno?: string;
  format?: string[];
  genre?: string[];
  cover_image?: string;
};

export function discogs(token: string | undefined): MetadataProvider {
  async function query(params: string, limit: number): Promise<Candidate[]> {
    if (!token) return [];
    const url = `https://api.discogs.com/database/search?${params}&per_page=${limit}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Authorization: `Discogs token=${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: DiscogsResult[] };
    return (data.results ?? [])
      .map((r) => {
        if (!r.title) return null;
        const [artist, ...rest] = r.title.split(' - ');
        const title = rest.length ? rest.join(' - ').trim() : r.title;
        const creators = rest.length ? artist?.trim() : undefined;
        const candidate: Candidate = {
          mediaType: 'vinyl',
          title,
          creators,
          publisher: r.label?.[0],
          published: r.year,
          coverUrl: r.cover_image,
          details: {
            discogs_id: r.id,
            format: r.format?.join(', '),
            label: r.label?.[0],
            catno: r.catno,
            year: r.year ? Number.parseInt(r.year, 10) : undefined,
            genres: r.genre,
          },
          provider: 'discogs',
        };
        return candidate;
      })
      .filter((c): c is Candidate => !!c);
  }

  return {
    id: 'discogs',
    mediaTypes: ['vinyl', 'music'],
    async lookupByBarcode(code: string): Promise<Candidate | null> {
      const results = await query(`barcode=${encodeURIComponent(code)}&type=release`, 3);
      return results[0] ?? null;
    },
    async search(q: string): Promise<Candidate[]> {
      return query(`q=${encodeURIComponent(q)}&type=release&format=Vinyl`, 8);
    },
  };
}
