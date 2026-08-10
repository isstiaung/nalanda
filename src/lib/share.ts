// The public-field whitelist for share pages. This is a whitelist on purpose:
// new item columns stay private until explicitly added here (ARCH.md §9).
import type { ItemFilters } from '../db/queries';
import type { Item, MediaType, Share } from '../db/schema';

/**
 * Does this item fall inside a share view's scope? Guards the public item-detail
 * route: a token only unlocks items matching ALL of its captured filters, so a
 * "reviews only" view can't be walked into the rest of the shelf by id.
 */
export function itemMatchesShare(share: Share, item: Item): boolean {
  if (share.libraryId !== null && item.libraryId !== share.libraryId) return false;
  if (share.mediaType !== null && item.mediaType !== share.mediaType) return false;
  if (share.status !== null && item.status !== share.status) return false;
  if (share.owned !== null && item.copies > 0 !== share.owned) return false;
  return true;
}

/**
 * The query-side twin of {@link itemMatchesShare}: the filters a view captured,
 * shaped for listItems/countMatchingItems. Both must agree, or the item route
 * would admit something the listing never showed.
 */
export function shareFilters(share: Share): ItemFilters {
  return {
    mediaTypes: share.mediaType ? [share.mediaType] : undefined,
    statuses: share.status ? [share.status] : undefined,
    owned: share.owned ?? undefined,
    sort: share.sort,
  };
}

/**
 * Does this share expose a whole shelf, or one slice of it? Every filter unset
 * means every item on the shelf matches; any filter set means a subset does.
 * The distinction is the difference between "this shelf is public" and "seven of
 * its books are" — worth getting right on a screen whose job is telling you what
 * you've published.
 */
export function isWholeShelfShare(share: Share): boolean {
  return share.mediaType === null && share.status === null && share.owned === null;
}

/**
 * How public a shelf actually is, given the shares published from it. `shelf`
 * means at least one link exposes the shelf entire; `views` means only filtered
 * slices are out there.
 */
export type ShareVisibility = { kind: 'private' | 'shelf' | 'views'; links: number };

export function shareVisibility(shares: Share[]): ShareVisibility {
  if (shares.length === 0) return { kind: 'private', links: 0 };
  const kind = shares.some(isWholeShelfShare) ? 'shelf' : 'views';
  return { kind, links: shares.length };
}

/** Pill/eyebrow text for a {@link ShareVisibility}. Title case; uppercase at the call site. */
export function shareVisibilityLabel(v: ShareVisibility): string {
  if (v.kind === 'private') return 'Private';
  if (v.kind === 'shelf') return v.links === 1 ? 'Shared' : `Shared · ${v.links} links`;
  return v.links === 1 ? '1 view shared' : `${v.links} views shared`;
}

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
  inCollection: boolean; // derived from copies > 0 — the count itself stays private
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
    inCollection: item.copies > 0,
    details: parseDetails(item.details),
  };
}

export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
