// MusicBrainz (barcode → release) + Cover Art Archive (release → front cover).
// Both keyless and free; the canonical fallback when Discogs misses a music barcode.
// Cover backfill only. MusicBrainz asks for a real User-Agent — we always send one.
import { USER_AGENT } from '../env';

export async function caaCoverByBarcode(barcode: string): Promise<string | null> {
  const res = await fetch(
    `https://musicbrainz.org/ws/2/release/?query=barcode:${encodeURIComponent(barcode)}&fmt=json&limit=1`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { releases?: Array<{ id?: string }> };
  const id = data.releases?.[0]?.id;
  // 404s when the release has no art in the archive — storeCover handles that.
  return id ? `https://coverartarchive.org/release/${id}/front-500` : null;
}
