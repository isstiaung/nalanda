// What a connected household may see of an item (docs/proposals/connections.md §7). A whitelist on
// purpose, like toPublicItem(): a new item column stays private until it is added here, and these
// are the only item fields that ever leave this instance for a connection.
//
// The parse functions are the other direction: everything a connection sends is untrusted, checked
// field by field before it is stored or rendered.
import { ACTIVITY_KINDS, MEDIA_TYPES, type ActivityKind, type Item, type MediaType } from '../db/schema';
import { toPublicItem, type PublicItem } from '../lib/share';
import { MAX_FEED_REVIEW_CHARS, MAX_FEED_TEXT_CHARS } from './config';

/** Share-page fields, plus what connections need on top: when it was finished and last changed. */
export type ConnectionItem = PublicItem & { completedOn: string | null; updatedAt: string };

export function toConnectionItem(item: Item): ConnectionItem {
  return { ...toPublicItem(item), completedOn: item.completedOn, updatedAt: item.updatedAt };
}

/** The part of a connection item a feed entry carries: enough to show the activity, small enough to keep. */
export type FeedItem = Pick<
  ConnectionItem,
  'id' | 'mediaType' | 'title' | 'creators' | 'published' | 'coverKey' | 'rating' | 'review' | 'inCollection' | 'completedOn'
> & { reviewTruncated: boolean };

/**
 * A feed entry's item, carrying only what its kind shows: the review only on a `reviewed` entry, the
 * rating only on a `rated` one. Withdrawing a review then leaves no copy of it in the entries that remain.
 */
export function toFeedItem(item: Item, kind: ActivityKind): FeedItem {
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
  if (typeof v.reviewTruncated !== 'boolean' || typeof v.inCollection !== 'boolean') return null;
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
