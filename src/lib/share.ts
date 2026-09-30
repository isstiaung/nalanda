// The public-field whitelist for share pages. This is a whitelist on purpose:
// new item columns stay private until explicitly added here (ARCH.md §9).
import { checkPurchaseLink } from './links';
import { withoutMoney } from './money';
import { isPlayable } from './plays';
import { progressPercent } from './progress';
import { matchesStatus } from './reads';
import type { ItemFilters } from '../db/queries';
import type { Item, MediaType, Share } from '../db/schema';

/**
 * Does this item fall inside a share view's scope? Guards the public item-detail
 * route: a token only unlocks items matching ALL of its captured filters, so a
 * "reviews only" view can't be walked into the rest of the shelf by id. `tags` are
 * the item's own tags, checked when the view captured one; `wanters` the ids of the
 * members who want it, checked for a want-list share (§16 #53) — its member's want
 * list as it stands, so an item they no longer want is outside it. A status view
 * filters as the shelf does: In progress holds a re-read too (§16 #64).
 */
export function itemMatchesShare(share: Share, item: Item, tags: string[], wanters: number[]): boolean {
  if (share.libraryId !== null && item.libraryId !== share.libraryId) return false;
  if (share.mediaType !== null && item.mediaType !== share.mediaType) return false;
  if (share.status !== null && !matchesStatus(item, share.status)) return false;
  if (share.owned !== null && item.copies > 0 !== share.owned) return false;
  if (share.tag !== null && !tags.includes(share.tag)) return false;
  if (share.wantUserId !== null && !wanters.includes(share.wantUserId)) return false;
  return true;
}

/**
 * The query-side twin of {@link itemMatchesShare}: the filters a view captured,
 * shaped for listItems/countMatchingItems. Both must agree, or the item route
 * would admit something the listing never showed. Every column itemMatchesShare
 * checks is carried here, and nothing else.
 */
export function shareFilters(share: Share): ItemFilters {
  return {
    mediaTypes: share.mediaType ? [share.mediaType] : undefined,
    statuses: share.status ? [share.status] : undefined,
    owned: share.owned ?? undefined,
    tag: share.tag ?? undefined,
    wantedBy: share.wantUserId ?? undefined,
    sort: share.sort,
  };
}

/** A gift list: one member's want list, published (§16 #53) — not a shelf, and not a slice of one. */
export function isWantListShare(share: Share): share is Share & { wantUserId: number } {
  return share.wantUserId !== null;
}

/**
 * Does this share expose a whole shelf, or one slice of it? Every filter unset
 * means every item on the shelf matches; any filter set means a subset does.
 * The distinction is the difference between "this shelf is public" and "seven of
 * its books are" — worth getting right on a screen whose job is telling you what
 * you've published.
 */
export function isWholeShelfShare(share: Share): boolean {
  // a want list has every shelf filter unset too, yet exposes only what one member wants
  return share.mediaType === null && share.status === null && share.owned === null && share.tag === null && share.wantUserId === null;
}

/**
 * How public a shelf actually is, given the shares published from it. `shelf`
 * means at least one link exposes the shelf entire; `views` means only filtered
 * slices are out there.
 */
export type ShareVisibility = { kind: 'private' | 'shelf' | 'views'; links: number };

export function shareVisibility(all: Share[]): ShareVisibility {
  // A want list isn't a shelf's to count (§16 #53): it has no shelf, and says nothing about how public one is.
  const shares = all.filter((v) => !isWantListShare(v));
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
  // Someone in the household wants it, and the household doesn't have it (§16 #53): a derived boolean, only ever `true`
  // — absent otherwise — and never whose want. The key is left out unless the caller says so, so pages that don't ask
  // serialize exactly as before.
  wanted?: true;
  details: Record<string, unknown>;
  // How many times it has been finished, only from twice on — a re-read says something about a book, where a
  // single read is what a finished book already means (§16 #41). Never the reads themselves, or their dates.
  readCount?: number;
  // How many times the household has played a board game or a record (§16 #54), from the first play on — a count
  // only, never a play's date or who logged it. Only when the caller passes the count in: share pages do, connections
  // don't.
  playCount?: number;
  // Only when the household has turned progress on for share pages, and only for a book in progress.
  progress?: { page: number; length: number | null; percent: number | null };
  // Only when an admin has switched names on for share pages (§16 #45): each member's rating and review, signed with
  // their display name or unsigned (null). Never a username, never a read or its date.
  reviews?: Array<{ by: string | null; rating: number | null; review: string | null }>;
  // Its series and number in it (§16 #52): public catalogue data, like the publisher. Only when the caller passed the
  // series in — the share item page does; listings and connections don't, so what they serve is unchanged. Never the
  // gaps or anyone's "next up", which are about the household's shelves and reading.
  series?: { name: string; number: number | null };
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

/**
 * `progress` is opt-in (site_settings.progress_on_shares, off by default) and even then limited to a book
 * being read now — in progress, or finished before and being read again (§16 #41: the setting means "show what
 * I'm reading now", and a re-read keeps its Completed status). A finished book's last page is noise, and an
 * unstarted one has none. The key is left out entirely otherwise, so nothing downstream can render an empty or
 * stale value.
 */
export function toPublicItem(
  item: Item,
  opts: {
    progress?: boolean;
    reviews?: Array<{ by: string | null; rating: number | null; review: string | null }>;
    plays?: number;
    series?: { id: number; name: string } | null;
    // anyone in the household wants it (§16 #53) — shown only while it isn't owned
    wanted?: boolean;
  } = {},
): PublicItem {
  const readingNow = matchesStatus(item, 'in_progress');
  const showProgress = opts.progress === true && item.mediaType === 'book' && readingNow && !!item.progressPage;
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
    ...(opts.wanted === true && item.copies === 0 ? { wanted: true as const } : {}),
    // never money (§16 #61): a libib file's `price` lands in details, and details are otherwise published whole
    details: withoutMoney(parseDetails(item.details)),
    ...(item.readCount >= 2 ? { readCount: item.readCount } : {}),
    // a game's or record's plays, counted; the key only when there are some, and never on a book, which has reads
    ...(opts.plays !== undefined && opts.plays > 0 && isPlayable(item.mediaType) ? { playCount: opts.plays } : {}),
    ...(showProgress
      ? { progress: { page: item.progressPage!, length: item.length, percent: progressPercent(item.progressPage, item.length) } }
      : {}),
    // the key only when the caller passed names in, which it does only with names switched on for share pages
    ...(opts.reviews ? { reviews: opts.reviews.map((r) => ({ by: r.by || null, rating: r.rating, review: r.review })) } : {}),
    // the name from the series row, the number from the item — and only for the item's own series
    ...(opts.series && opts.series.id === item.seriesId ? { series: { name: opts.series.name, number: item.seriesNumber } } : {}),
  };
}

/**
 * What a gift list shows of an item (§16 #53): fewer fields than a shelf's share page — what someone buying it needs
 * to find the right one — plus the one field no other public page has, the household's pasted purchase links. Built
 * from toPublicItem(), so nothing outside that whitelist can reach it: no rating, review, read count, progress, tags,
 * details or names, and never notes, loans, copies or anything about reading.
 */
export type GiftItem = Pick<
  PublicItem,
  'id' | 'mediaType' | 'title' | 'creators' | 'publisher' | 'published' | 'description' | 'length' | 'coverKey' | 'inCollection'
> & { purchaseLinks: Array<{ label: string; url: string }> };

export function toGiftItem(item: Item, links: Array<{ label: string; url: string }>): GiftItem {
  const p = toPublicItem(item);
  return {
    id: p.id,
    mediaType: p.mediaType,
    title: p.title,
    creators: p.creators,
    publisher: p.publisher,
    published: p.published,
    description: p.description,
    length: p.length,
    coverKey: p.coverKey,
    inCollection: p.inCollection,
    // re-checked on the way out: an http(s) address and a label, nothing else, whatever the table holds
    purchaseLinks: links.flatMap((l) => {
      const ok = checkPurchaseLink(l.label, l.url);
      return typeof ok === 'string' ? [] : [ok];
    }),
  };
}

/**
 * A gift list's public title (§16 #53): the member's display name only while an admin has names on for share pages,
 * and they have one — never a username. Otherwise it names nobody.
 */
export function wantListTitle(displayName: string | null): string {
  return displayName ? `${displayName}’s want list` : 'A want list';
}

export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
