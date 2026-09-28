// Reading progress arithmetic, shared by the item page, share pages and (phase 2) the connections feed.

/**
 * Percent read, or null when it can't be known: no page recorded, or no page count for the book.
 * Clamped at 100 because provider page counts are often lower than the edition in someone's hands.
 */
export function progressPercent(page: number | null, length: number | null): number | null {
  if (!page || !length || length <= 0) return null;
  return Math.min(100, Math.round((page / length) * 100));
}

/**
 * The highest page anyone can record. Beyond any printed book, and the same bound connections apply to what
 * they receive — a page above it would be kept here and silently dropped by every one of them.
 */
export const MAX_PROGRESS_PAGE = 100_000;
