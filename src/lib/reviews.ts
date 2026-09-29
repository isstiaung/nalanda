// Each member's rating and review of an item (ARCH.md §16 #43): the rules that turn them into the household's summary
// on the item — the average rating and the latest review — and the export's `reviews` cell. Pure functions;
// refreshReviewState() in src/db/queries.ts is the SQL twin of summarizeReviews, and test/per-member.spec.ts holds
// the two together.

export type ReviewDraft = {
  rating: number | null; // half-stars 1–10
  review: string | null;
  reviewedAt: string | null; // when the text was last written, 'YYYY-MM-DD HH:MM:SS'; null with no text
  // when the rating was last given, likewise; null with no rating, or not known (it then takes now, or `reviewedAt`
  // from an export that has it). Only activity dating reads it — the summary doesn't depend on it.
  ratedAt?: string | null;
};

/**
 * A review in the export's `reviews` cell: whose it is by username, null for a member removed since, or left out for
 * whoever imports it — as a reads token with no `@` is.
 */
export type CellReview = ReviewDraft & { by?: string | null };

/** A review on its way in, and whose it is: a member's id, null for nobody here, or left out for whoever brings it in. */
export type PersonReview = ReviewDraft & { userId?: number | null };

/** SQL ORDER BY for the review the household shows: the one written most recently. */
export const reviewOrderSql = (a: string) => `${a}.reviewed_at IS NULL, ${a}.reviewed_at DESC, ${a}.id DESC`;

/**
 * What the item's rating and review say for a set of reviews — the TypeScript twin of refreshReviewState(), used where
 * an item is inserted with its reviews, so the insert trigger sees what the item will hold (migration 0021). The
 * average of everyone's ratings, rounded half up to the 1–10 scale, as SQLite's round() does for these; and the review
 * written most recently. Reviews are in insertion order: a later one wins a tie.
 */
export function summarizeReviews(reviews: ReviewDraft[]): { rating: number | null; review: string | null } {
  const ratings = reviews.map((r) => r.rating).filter((n): n is number => n !== null);
  const rating = ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null;
  let latest: { review: string; at: string | null; seq: number } | null = null;
  reviews.forEach((r, seq) => {
    if (r.review === null) return;
    const newer =
      latest === null ||
      (r.reviewedAt !== null && (latest.at === null || r.reviewedAt > latest.at)) ||
      (r.reviewedAt === latest.at && seq > latest.seq);
    if (newer) latest = { review: r.review, at: r.reviewedAt, seq };
  });
  return { rating, review: (latest as { review: string } | null)?.review ?? null };
}

/** datetime('now') as SQLite writes it, for a time decided before the statement runs. */
export const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/**
 * Reviews on their way in, each text given a written time — now, when it has none, as a fresh review is written now.
 * Decided here rather than left to the insert, so the summary worked out before the insert (summarizeReviews) and the
 * one the refresh works out after it choose the same review.
 */
export function stampReviews<T extends ReviewDraft>(reviews: T[]): T[] {
  const now = sqlNow();
  return reviews.map((r) => ({
    ...r,
    reviewedAt: r.review !== null && r.reviewedAt === null ? now : r.reviewedAt,
    ratedAt: r.rating === null ? null : (r.ratedAt ?? now),
  }));
}

/** Whitespace-only text is no review; the rest is kept as written. */
export const reviewText = (v: string | null | undefined): string | null => (v && v.trim() ? v : null);

/** A rating on the 1–10 half-star scale, or null. */
export const isRating = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10;

const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// ---------- the export's `reviews` cell ----------
//
// JSON, one object per review, oldest first:
//   [{"by":"asha","rating":8,"review":"…","at":"2026-09-01 10:00:00","ratedAt":"2026-08-30 09:00:00"}]
// `by` is null for a member removed since, and a review with no `by` at all is the importer's. `at` is when the text was
// written, which decides whose review the household shows; `ratedAt` when the rating was given, which dates a "rated"
// entry — an older file without it takes `at`, else the time of the import. The item's own `rating` and `review` columns stay beside it as the household summary, for anything that reads
// only those (a spreadsheet, an older Nalanda).

export function formatReviewsCell(reviews: CellReview[]): string {
  if (!reviews.length) return '';
  return JSON.stringify(
    reviews.map((r) => ({ by: r.by ?? null, rating: r.rating, review: r.review, at: r.reviewedAt, ratedAt: r.rating === null ? null : (r.ratedAt ?? null) })),
  );
}

/** Enough for any household, and a bound on what a crafted CSV can make one row insert. */
export const MAX_REVIEWS_PER_ITEM = 100;

/**
 * A `reviews` cell back into reviews, or null when the cell is empty or isn't ours — the caller then falls back to
 * the rating and review columns. An entry that doesn't parse is dropped and the rest kept; one with neither a rating
 * nor any text is nothing to keep.
 */
export function parseReviewsCell(cell: string | null | undefined): CellReview[] | null {
  const text = (cell ?? '').trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: CellReview[] = [];
  for (const entry of parsed.slice(0, MAX_REVIEWS_PER_ITEM)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    // no `by` at all: the importer's, as a reads token with no `@`; an empty or null one: a member removed since
    const by = !('by' in e) ? undefined : typeof e.by === 'string' && e.by.trim() ? e.by : null;
    const rating = isRating(e.rating) ? e.rating : null;
    const review = typeof e.review === 'string' ? reviewText(e.review) : null;
    if (rating === null && review === null) continue;
    const reviewedAt = review !== null && typeof e.at === 'string' && SQL_DATETIME.test(e.at) ? e.at : null;
    const writtenAt = typeof e.at === 'string' && SQL_DATETIME.test(e.at) ? e.at : null;
    const ratedAt = rating === null ? null : typeof e.ratedAt === 'string' && SQL_DATETIME.test(e.ratedAt) ? e.ratedAt : writtenAt;
    out.push({ ...(by === undefined ? {} : { by }), rating, review, reviewedAt, ratedAt });
  }
  return out;
}
