// The public-field whitelist for share pages. This is a whitelist on purpose:
// new item columns stay private until explicitly added here (ARCH.md §9).
import type { Item, MediaType } from '../db/schema';

export type PublicItem = {
  id: number;
  mediaType: MediaType;
  title: string;
  creators: string | null;
  publisher: string | null;
  published: string | null;
  description: string | null;
  length: number | null;
  coverKey: string | null;
  rating: number | null;
  review: string | null;
  details: Record<string, unknown>;
};

export function parseDetails(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

export function toPublicItem(item: Item): PublicItem {
  return {
    id: item.id,
    mediaType: item.mediaType,
    title: item.title,
    creators: item.creators,
    publisher: item.publisher,
    published: item.published,
    description: item.description,
    length: item.length,
    coverKey: item.coverKey,
    rating: item.rating,
    review: item.review,
    details: parseDetails(item.details),
  };
}

export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
