// iTunes Search API — keyless, free, knows book covers by ISBN. Cover backfill only;
// not a full metadata provider (Apple's bibliographic data is thin). The expected
// title is required so junk lookups can't attach a stranger's artwork.
import { USER_AGENT } from '../env';
import { titlesMatch } from './provider';

export async function itunesCoverByIsbn(isbn: string, expectedTitle: string): Promise<string | null> {
  const res = await fetch(`https://itunes.apple.com/lookup?isbn=${encodeURIComponent(isbn)}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: Array<{ artworkUrl100?: string; trackName?: string }> };
  const hit = data.results?.find((r) => r.artworkUrl100 && r.trackName && titlesMatch(r.trackName, expectedTitle));
  return hit?.artworkUrl100 ? hit.artworkUrl100.replace('100x100', '600x600') : null;
}
