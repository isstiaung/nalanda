// What a connected household may see of an item (docs/proposals/connections.md §7). A whitelist on
// purpose, like toPublicItem(): a new item column stays private until it is added here, and these
// are the only item fields that ever leave this instance for a connection.
//
// The parse functions are the other direction: everything a connection sends is untrusted, checked
// field by field before it is stored or rendered.
import { ACTIVITY_KINDS, MEDIA_TYPES, type ActivityKind, type Item, type MediaType } from '../db/schema';
import { toPublicItem, type PublicItem } from '../lib/share';
import { MAX_DETAIL_TEXT_CHARS, MAX_FEED_REVIEW_CHARS, MAX_FEED_TEXT_CHARS } from './config';

/** Share-page fields, plus what connections need on top: when it was finished and last changed. */
export type ConnectionItem = PublicItem & { completedOn: string | null; updatedAt: string };

export function toConnectionItem(item: Item): ConnectionItem {
  return { ...toPublicItem(item), completedOn: item.completedOn, updatedAt: item.updatedAt };
}

/** The part of a connection item a feed entry carries: enough to show the activity, small enough to keep. */
export type FeedItem = Pick<
  ConnectionItem,
  'id' | 'mediaType' | 'title' | 'creators' | 'published' | 'coverKey' | 'rating' | 'review' | 'inCollection' | 'completedOn'
> & { reviewTruncated: boolean; stamp: string };

/**
 * A feed entry's item, carrying only what its kind shows: the review only on a `reviewed` entry, the
 * rating only on a `rated` one. Withdrawing a review then leaves no copy of it in the entries that remain.
 */
export function toFeedItem(item: Item, kind: ActivityKind, stamp: string): FeedItem {
  const c = toConnectionItem(item);
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
  };
}

export function parseFeedEntry(value: unknown): FeedEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isId(v.id) || !(ACTIVITY_KINDS as readonly unknown[]).includes(v.kind)) return null;
  if (typeof v.published !== 'string' || !SQL_DATETIME.test(v.published)) return null;
  const item = parseFeedItem(v.item);
  return item ? { id: v.id, kind: v.kind as ActivityKind, published: v.published, item } : null;
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
> & { available: boolean };

export function toShelfItem(item: Item, available: boolean): ShelfItem {
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
  };
}

/** One item in full, for its page on a connection's instance: the share-page fields, availability and tags. */
export type ItemDetail = Omit<ConnectionItem, 'details'> & {
  details: Record<string, string | number | boolean>;
  available: boolean;
  tags: string[];
};

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

export function toItemDetail(item: Item, available: boolean, tags: string[]): ItemDetail {
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
  };
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
  if (typeof v.inCollection !== 'boolean' || typeof v.available !== 'boolean') return null;
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
  if (!v.tags.every((t) => typeof t === 'string' && t.length <= 50)) return null;
  return {
    ...base,
    publisher: v.publisher,
    description: v.description,
    length: v.length as number | null,
    review: v.review,
    completedOn: v.completedOn,
    updatedAt: v.updatedAt,
    details: plainDetails(details),
    tags: v.tags as string[],
  };
}

