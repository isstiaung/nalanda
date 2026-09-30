// What a connected household may see of an item (docs/proposals/connections.md §7). A whitelist on
// purpose, like toPublicItem(): a new item column stays private until it is added here, and these
// are the only item fields that ever leave this instance for a connection.
//
// The parse functions are the other direction: everything a connection sends is untrusted, checked
// field by field before it is stored or rendered.
import { ACTIVITY_KINDS, MEDIA_TYPES, type ActivityKind, type Item, type MediaType } from '../db/schema';
import { parsePeerName } from '../lib/names';
import { MAX_PROGRESS_PAGE, progressPercent } from '../lib/progress';
import { toPublicItem, type PublicItem } from '../lib/share';
import { MAX_DETAIL_TEXT_CHARS, MAX_FEED_REVIEW_CHARS, MAX_FEED_TEXT_CHARS } from './config';

/**
 * Share-page fields, plus what connections need on top: when it was last finished and changed, and how many
 * times it has been finished (§16 #41) — the count only, never the reads or their dates. A household on an older
 * version ignores the field.
 */
export type ConnectionItem = PublicItem & { completedOn: string | null; updatedAt: string; readCount: number };

export function toConnectionItem(item: Item): ConnectionItem {
  // No play count: plays stay home (§16 #54), so toPublicItem is given none and leaves `playCount` out
  return { ...toPublicItem(item), completedOn: item.completedOn, updatedAt: item.updatedAt, readCount: item.readCount };
}

/** The page one progress update recorded, and how far through the book that is when its length is known. */
export type FeedProgress = { page: number; percent: number | null };

/** The part of a connection item a feed entry carries: enough to show the activity, small enough to keep. */
export type FeedItem = Pick<
  ConnectionItem,
  'id' | 'mediaType' | 'title' | 'creators' | 'published' | 'coverKey' | 'rating' | 'review' | 'inCollection' | 'completedOn'
> & {
  reviewTruncated: boolean;
  stamp: string;
  progress: FeedProgress | null;
  // §16 #41, null from a household on an older version. On a `finished` entry, how many times the book has been
  // finished ("finished again" from two). On a `progress` entry, how many finished reads came before the one the
  // page belongs to — one or more is a re-read, whenever the entry is served.
  readCount: number | null;
  // §16 #45: whose activity this is, by display name — only on a per-person entry from a household that has switched
  // names on, and only for a member with a display name. Absent everywhere else, so a household's entries are exactly
  // what they were; an older receiver ignores it.
  by?: string;
};

/** A per-person feed entry's own part (§16 #45): whose it is, and that member's rating or review on those kinds. */
export type FeedPerson = { by: string | null; rating: number | null; review: string | null; readCount: number };

/**
 * A feed entry's item, carrying only what its kind shows: the review only on a `reviewed` entry, the
 * rating only on a `rated` one, the page only on a `progress` one — that entry's own page, not wherever
 * the book has got to since. Withdrawing a review then leaves no copy of it in the entries that remain.
 */
export function toFeedItem(
  item: Item,
  kind: ActivityKind,
  stamp: string,
  progressPage: number | null = null,
  readsBefore = 0,
  person?: FeedPerson,
): FeedItem {
  const c = toConnectionItem(item);
  // a per-person entry carries its member's own rating and review, not the household's summary
  // — and that member's own finishes, not the household's (a first read isn't "finished again")
  if (person) Object.assign(c, { rating: person.rating && person.rating > 0 ? person.rating : null, review: person.review, readCount: person.readCount });
  const long = c.review !== null && c.review.length > MAX_FEED_REVIEW_CHARS;
  return keepForKind(
    {
      id: c.id,
      mediaType: c.mediaType,
      title: c.title.slice(0, MAX_FEED_TEXT_CHARS),
      creators: c.creators?.slice(0, MAX_FEED_TEXT_CHARS) ?? null,
      published: c.published?.slice(0, MAX_SHORT_TEXT) ?? null,
      coverKey: c.coverKey,
      rating: c.rating,
      review: long ? c.review!.slice(0, MAX_FEED_REVIEW_CHARS) : c.review,
      reviewTruncated: long,
      inCollection: c.inCollection,
      completedOn: c.completedOn?.slice(0, MAX_SHORT_TEXT) ?? null,
      stamp,
      progress: progressPage ? { page: progressPage, percent: progressPercent(progressPage, item.length) } : null,
      // a page: the finished reads before its own read; anything else: all of them
      readCount: kind === 'progress' ? readsBefore : c.readCount,
      // only a named member's entry has the key at all, so a household's entry serializes exactly as before
      ...(person?.by ? { by: person.by } : {}),
    },
    kind,
  );
}

/** Blanks what an entry's kind doesn't show. The receiver applies it again before storing: it's the owner's rule to keep. */
export function keepForKind(item: FeedItem, kind: ActivityKind): FeedItem {
  return {
    ...item,
    review: kind === 'reviewed' ? item.review : null,
    reviewTruncated: kind === 'reviewed' && item.reviewTruncated,
    rating: kind === 'rated' ? item.rating : null,
    progress: kind === 'progress' ? item.progress : null,
    readCount: kind === 'finished' || kind === 'progress' ? item.readCount : null,
  };
}

export type FeedEntry = { id: number; kind: ActivityKind; published: string; item: FeedItem };

const MAX_TITLE = MAX_FEED_TEXT_CHARS;
const MAX_SHORT_TEXT = 200;

// ---------- validating what a connection sends ----------

const COVER_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export const isSqlDatetime = (v: unknown): v is string => typeof v === 'string' && SQL_DATETIME.test(v);

const STAMP = /^[0-9a-f]{16}$/;
export const isStamp = (v: unknown): v is string => typeof v === 'string' && STAMP.test(v);

/**
 * Which book an item id means. SQLite reuses the id of a deleted newest item, so an id alone can come to name a
 * different book; every reference a connection keeps — feed entries, comment threads — carries this stamp too.
 * A hash of the id and when the row was added: stable for the row, opaque to the connection.
 */
export async function itemStamp(item: Pick<Item, 'id' | 'addedAt'>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${item.id}|${item.addedAt}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}
const isText = (v: unknown, max: number): v is string | null => v === null || (typeof v === 'string' && v.length <= max);

export function parseFeedItem(value: unknown): FeedItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isId(v.id)) return null;
  if (!(MEDIA_TYPES as readonly unknown[]).includes(v.mediaType)) return null;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > MAX_TITLE) return null;
  if (!isText(v.creators, MAX_TITLE) || !isText(v.published, MAX_SHORT_TEXT) || !isText(v.completedOn, MAX_SHORT_TEXT)) {
    return null;
  }
  // A cover is only ever a key into the connection's own /covers/ — never a URL of the sender's choosing.
  if (!(v.coverKey === null || (typeof v.coverKey === 'string' && COVER_KEY.test(v.coverKey)))) return null;
  if (!(v.rating === null || (Number.isInteger(v.rating) && (v.rating as number) >= 0 && (v.rating as number) <= 10))) {
    return null;
  }
  if (!isText(v.review, MAX_FEED_REVIEW_CHARS)) return null;
  if (typeof v.reviewTruncated !== 'boolean' || typeof v.inCollection !== 'boolean' || !isStamp(v.stamp)) return null;
  const progress = parseFeedProgress(v.progress);
  if (progress === undefined) return null;
  // absent from a household on an older version, which must not cost it the entry; malformed rejects it
  const readCount = v.readCount === undefined || v.readCount === null ? null : v.readCount;
  if (readCount !== null && !(Number.isSafeInteger(readCount) && (readCount as number) >= 0 && (readCount as number) <= MAX_FEED_READ_COUNT)) {
    return null;
  }
  // absent from an older sender, a household's entry or an unnamed member's; malformed rejects the entry
  const by = parsePeerName(v.by);
  if (by === null) return null;
  return {
    id: v.id,
    mediaType: v.mediaType as MediaType,
    title: v.title,
    creators: v.creators,
    published: v.published,
    coverKey: v.coverKey,
    rating: v.rating as number | null,
    review: v.review,
    reviewTruncated: v.reviewTruncated,
    inCollection: v.inCollection,
    completedOn: v.completedOn,
    stamp: v.stamp,
    progress,
    readCount: readCount as number | null,
    ...(by !== undefined ? { by } : {}),
  };
}

/**
 * Beyond any printed book: a larger page is a broken or hostile sender, not a long read. The same bound the
 * item page enforces when a page is recorded, so nothing is kept here that every connection would drop.
 */
export const MAX_FEED_PAGE = MAX_PROGRESS_PAGE;

/** The most finished reads an entry can claim: well past the 100 reads an item holds (MAX_READS_PER_ITEM). */
export const MAX_FEED_READ_COUNT = 1_000;

/**
 * A progress field from a connection: null when absent — a household on an older version sends none, and
 * that must not cost it its other entries — or when explicitly none; undefined when present but malformed,
 * which rejects the entry the way any other malformed field does.
 */
function parseFeedProgress(value: unknown): FeedProgress | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (!Number.isSafeInteger(p.page) || (p.page as number) < 1 || (p.page as number) > MAX_FEED_PAGE) return undefined;
  if (!(p.percent === null || (Number.isInteger(p.percent) && (p.percent as number) >= 0 && (p.percent as number) <= 100))) {
    return undefined;
  }
  return { page: p.page as number, percent: p.percent as number | null };
}

export function parseFeedEntry(value: unknown): FeedEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isId(v.id) || !(ACTIVITY_KINDS as readonly unknown[]).includes(v.kind)) return null;
  if (typeof v.published !== 'string' || !SQL_DATETIME.test(v.published)) return null;
  const item = parseFeedItem(v.item);
  if (!item) return null;
  // a progress entry is its page; without one there is nothing to show
  if (v.kind === 'progress' && !item.progress) return null;
  return { id: v.id, kind: v.kind as ActivityKind, published: v.published, item };
}

/** A cover on a connection's instance, or null. Only `<their origin>/covers/<uuid>`, ever. */
export function coverUrl(baseUrl: string, coverKey: string | null): string | null {
  return coverKey && COVER_KEY.test(coverKey) ? `${baseUrl}/covers/${coverKey}` : null;
}

export function jsonBytes(value: unknown): { json: string; bytes: number } {
  const json = JSON.stringify(value);
  return { json, bytes: new TextEncoder().encode(json).byteLength };
}

// ---------- shelves and item pages (phase 4) ----------

/** A connection's shelf card: what a card shows, and whether a copy is free to borrow — never who has one. */
export type ShelfItem = Pick<
  ConnectionItem,
  'id' | 'mediaType' | 'title' | 'creators' | 'published' | 'coverKey' | 'rating' | 'inCollection'
> & { available: boolean; stamp: string };

export function toShelfItem(item: Item, available: boolean, stamp: string): ShelfItem {
  const c = toConnectionItem(item);
  return {
    id: c.id,
    mediaType: c.mediaType,
    title: c.title.slice(0, MAX_FEED_TEXT_CHARS),
    creators: c.creators?.slice(0, MAX_FEED_TEXT_CHARS) ?? null,
    published: c.published?.slice(0, MAX_SHORT_TEXT) ?? null,
    coverKey: c.coverKey,
    rating: c.rating,
    inCollection: c.inCollection,
    available: c.inCollection && available,
    stamp,
  };
}

/** One item in full, for its page on a connection's instance: the share-page fields, availability and tags. */
/** One member's rating and review on a connection's item page (§16 #45): by display name, or unsigned (null). */
export type NamedReview = { by: string | null; rating: number | null; review: string | null };

export type ItemDetail = Omit<ConnectionItem, 'details' | 'readCount'> & {
  details: Record<string, string | number | boolean>;
  readCount: number | null; // null from a household on an older version
  available: boolean;
  tags: string[];
  stamp: string;
  // §16 #45: everyone's rating and review, only from a household that has switched names on; absent otherwise
  reviews?: NamedReview[];
};

/** At most this many members' reviews on one item page, from anyone. */
export const MAX_NAMED_REVIEWS = 30;

/** Details reduced to short, plain values — the only shape a connection's item page renders. */
function plainDetails(details: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details).slice(0, 30)) {
    if (key.length > 40) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function toItemDetail(item: Item, available: boolean, tags: string[], stamp: string, reviews?: NamedReview[]): ItemDetail {
  const c = toConnectionItem(item);
  return {
    ...c,
    title: c.title.slice(0, MAX_FEED_TEXT_CHARS),
    creators: c.creators?.slice(0, MAX_FEED_TEXT_CHARS) ?? null,
    publisher: c.publisher?.slice(0, MAX_FEED_TEXT_CHARS) ?? null,
    published: c.published?.slice(0, MAX_SHORT_TEXT) ?? null,
    description: c.description?.slice(0, MAX_DETAIL_TEXT_CHARS) ?? null,
    review: c.review?.slice(0, MAX_DETAIL_TEXT_CHARS) ?? null,
    completedOn: c.completedOn?.slice(0, MAX_SHORT_TEXT) ?? null,
    details: plainDetails(c.details),
    available: c.inCollection && available,
    tags: tags.slice(0, 50).map((t) => t.slice(0, 50)),
    stamp,
    // with names off the key is absent, so the page serializes exactly as before
    ...(reviews
      ? {
          reviews: reviews.slice(0, MAX_NAMED_REVIEWS).map((r) => ({
            by: r.by,
            rating: r.rating,
            review: r.review?.slice(0, MAX_DETAIL_TEXT_CHARS) ?? null,
          })),
        }
      : {}),
  };
}

/**
 * A connection's list of members' reviews: undefined when absent (an older household, or names off), null when
 * malformed — which rejects the page, as any malformed field does.
 */
function parseNamedReviews(value: unknown): NamedReview[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_NAMED_REVIEWS) return null;
  const out: NamedReview[] = [];
  for (const raw of value) {
    const r = asRecord(raw);
    if (!r) return null;
    const by = parsePeerName(r.by);
    if (by === null) return null;
    if (!(r.rating === null || r.rating === undefined || (Number.isInteger(r.rating) && (r.rating as number) >= 1 && (r.rating as number) <= 10))) return null;
    if (!(r.review === null || r.review === undefined || (typeof r.review === 'string' && r.review.length <= MAX_DETAIL_TEXT_CHARS))) return null;
    const rating = (r.rating as number | null | undefined) ?? null;
    const review = (r.review as string | null | undefined) ?? null;
    if (rating === null && review === null) continue;
    out.push({ by: by ?? null, rating, review });
  }
  return out;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The fields a shelf card and an item page share, checked as feed items are. */
function shelfBase(v: Record<string, unknown>): ShelfItem | null {
  if (!isId(v.id) || !(MEDIA_TYPES as readonly unknown[]).includes(v.mediaType)) return null;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > MAX_TITLE) return null;
  if (!isText(v.creators, MAX_TITLE) || !isText(v.published, MAX_SHORT_TEXT)) return null;
  if (!(v.coverKey === null || (typeof v.coverKey === 'string' && COVER_KEY.test(v.coverKey)))) return null;
  if (!(v.rating === null || (Number.isInteger(v.rating) && (v.rating as number) >= 0 && (v.rating as number) <= 10))) return null;
  if (typeof v.inCollection !== 'boolean' || typeof v.available !== 'boolean' || !isStamp(v.stamp)) return null;
  return {
    id: v.id,
    mediaType: v.mediaType as MediaType,
    title: v.title,
    creators: v.creators,
    published: v.published,
    coverKey: v.coverKey,
    rating: v.rating as number | null,
    inCollection: v.inCollection,
    available: v.inCollection && v.available,
    stamp: v.stamp,
  };
}

export function parseShelfItem(value: unknown): ShelfItem | null {
  const v = asRecord(value);
  return v ? shelfBase(v) : null;
}

export function parseItemDetail(value: unknown): ItemDetail | null {
  const v = asRecord(value);
  const base = v ? shelfBase(v) : null;
  if (!v || !base) return null;
  if (!isText(v.publisher, MAX_TITLE) || !isText(v.description, MAX_DETAIL_TEXT_CHARS) || !isText(v.review, MAX_DETAIL_TEXT_CHARS)) {
    return null;
  }
  if (!isText(v.completedOn, MAX_SHORT_TEXT) || typeof v.updatedAt !== 'string' || v.updatedAt.length > MAX_SHORT_TEXT) return null;
  if (!(v.length === null || (Number.isSafeInteger(v.length) && (v.length as number) >= 0))) return null;
  const details = asRecord(v.details);
  if (!details || !Array.isArray(v.tags) || v.tags.length > 50) return null;
  const readCount = v.readCount === undefined || v.readCount === null ? null : v.readCount;
  if (readCount !== null && !(Number.isSafeInteger(readCount) && (readCount as number) >= 0 && (readCount as number) <= MAX_FEED_READ_COUNT)) {
    return null;
  }
  if (!v.tags.every((t) => typeof t === 'string' && t.length <= 50)) return null;
  const reviews = parseNamedReviews(v.reviews);
  if (reviews === null) return null;
  return {
    ...(reviews ? { reviews } : {}),
    ...base,
    publisher: v.publisher,
    description: v.description,
    length: v.length as number | null,
    review: v.review,
    completedOn: v.completedOn,
    updatedAt: v.updatedAt,
    details: plainDetails(details),
    tags: v.tags as string[],
    readCount: readCount as number | null,
  };
}

