// The public-field whitelist for share pages. This is a whitelist on purpose:
// new item columns stay private until explicitly added here (ARCH.md §9).
import { checkPurchaseLink } from './links';
import { publicCustom, type PublicCustom } from './custom';
import { withoutMoney } from './money';
import { formatsOf } from './formats';
import { isPlayable } from './plays';
import { progressPercent } from './progress';
import { matchesStatus } from './reads';
import type { ItemFilters } from '../db/queries';
import type { CustomField, Item, MediaType, Share } from '../db/schema';

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
  // The forms it is held in (§16 #75): public catalogue data, like the publisher — the codes, for the page's pills.
  // Never the editions' identifiers, which are as private as the main ISBN.
  formats: string[];
  // Its language (ISO 639-1; null on an item from before the column, which reads as the household's) and the title it
  // was first published under (§16 #76): public catalogue data, like the publisher.
  language: string | null;
  originalTitle: string | null;
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
  // Quotes a member marked shared (§16 #77): the text and its page, signed with a display name only while names are on
  // for share pages (else null, shown as "A member"). Never a note, never a username, absent when there are none.
  quotes?: Array<{ by: string | null; text: string; page: string | null }>;
  // Only when an admin has switched names on for share pages (§16 #45): each member's rating and review, signed with
  // their display name or unsigned (null). Never a username, never a read or its date.
  reviews?: Array<{ by: string | null; rating: number | null; review: string | null }>;
  // Its series and number in it (§16 #52): public catalogue data, like the publisher. Only when the caller passed the
  // series in — the share item page does; listings and connections don't, so what they serve is unchanged. Never the
  // gaps or anyone's "next up", which are about the household's shelves and reading.
  series?: { name: string; number: number | null };
  // The household's custom fields' values (§16 #95), each by its field's name — only the fields whose own "Show on
  // share pages" switch is on, and only when the caller passed the fields in, which the share item page does;
  // listings, feeds, gift lists and connections don't, so what they serve is unchanged. Never a field's id, never
  // the raw column, never a value of a field whose switch is off.
  custom?: PublicCustom[];
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
 *
 * A Not owned item never claims a read (§16 #13): neither `readCount` nor `progress` is added while `copies` is 0.
 * A reading-log entry — a Goodreads import, a library book — is in the catalogue and not on the shelves, and what
 * the household read of it is its own; "Not owned" is all the page says.
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
    // the quotes marked shared (§16 #77), each signed with a display name only while names are on for share pages
    quotes?: Array<{ by: string | null; text: string; page: string | null }>;
    // the household's custom fields (§16 #95): publicCustom() keeps only those switched on for share pages
    customFields?: CustomField[];
  } = {},
): PublicItem {
  const owned = item.copies > 0;
  const custom = opts.customFields ? publicCustom(item.custom, opts.customFields) : [];
  const readingNow = matchesStatus(item, 'in_progress');
  const showProgress = owned && opts.progress === true && item.mediaType === 'book' && readingNow && !!item.progressPage;
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
    inCollection: owned,
    formats: formatsOf(item),
    language: item.language,
    originalTitle: item.originalTitle,
    ...(opts.wanted === true && item.copies === 0 ? { wanted: true as const } : {}),
    // never money (§16 #61): a libib file's `price` lands in details, and details are otherwise published whole
    details: withoutMoney(parseDetails(item.details)),
    // how often the household finished it, from twice on (§16 #41) — and never of an item it doesn't own
    ...(owned && item.readCount >= 2 ? { readCount: item.readCount } : {}),
    // a game's or record's plays, counted; the key only when there are some, and never on a book, which has reads
    ...(opts.plays !== undefined && opts.plays > 0 && isPlayable(item.mediaType) ? { playCount: opts.plays } : {}),
    ...(showProgress
      ? { progress: { page: item.progressPage!, length: item.length, percent: progressPercent(item.progressPage, item.length) } }
      : {}),
    // the key only when the caller passed names in, which it does only with names switched on for share pages
    ...(opts.reviews ? { reviews: opts.reviews.map((r) => ({ by: r.by || null, rating: r.rating, review: r.review })) } : {}),
    // the name from the series row, the number from the item — and only for the item's own series
    ...(opts.series && opts.series.id === item.seriesId ? { series: { name: opts.series.name, number: item.seriesNumber } } : {}),
    // only the quotes marked shared, and only when the caller passed them: never a note, never a username
    ...(opts.quotes?.length ? { quotes: opts.quotes.map((q) => ({ by: q.by || null, text: q.text, page: q.page })) } : {}),
    // only the fields switched on for share pages, by name, and only when the caller passed the fields: the item page does
    ...(custom.length ? { custom } : {}),
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
  'id' | 'mediaType' | 'title' | 'creators' | 'publisher' | 'published' | 'description' | 'length' | 'coverKey' | 'inCollection' | 'formats' | 'language' | 'originalTitle'
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
    formats: p.formats, // which form is held: what someone buying another needs to know (§16 #75)
    language: p.language, // which language, and which title, to buy (§16 #76)
    originalTitle: p.originalTitle,
    // re-checked on the way out: an http(s) address and a label, nothing else, whatever the table holds
    purchaseLinks: links.flatMap((l) => {
      const ok = checkPurchaseLink(l.label, l.url);
      return typeof ok === 'string' ? [] : [ok];
    }),
  };
}

/**
 * What a link to a share page says about itself where it's pasted (ARCH.md §16 #71): the Open Graph tags a chat app or
 * a feed reads to draw the preview. Only what the page itself shows — its name, a count, an item's title and creators,
 * a cover already served at /covers/ — and never a token-free way in, a name the switches keep off, or anything the
 * whitelist keeps back. Built by the share routes, from public items only.
 */
export type LinkPreview = {
  title: string;
  description: string;
  /** An absolute URL of a cover the page shows, or null: a preview then has no picture, which is fine. */
  image: string | null;
  /** Whose cover it is — the item's title, on a listing the first item's — for the picture's alt text. */
  imageAlt: string | null;
  /** The page's own URL, the token included: whoever has the link has the token already. */
  url: string;
};

/** Text for a preview's one line: whitespace collapsed, cut at a word before `max` characters with an ellipsis. */
export function previewText(text: string | null | undefined, max = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = Array.from(flat).slice(0, max - 1).join(''); // by code point: never half an emoji
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:—–-]+$/, '')}…`;
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
