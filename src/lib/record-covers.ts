// Taking Discogs' images out of storage (ARCH.md §16 #67), as plain functions: which stored record covers came from
// Discogs, and the SQL that swaps each for the Cover Art Archive's or drops it. scripts/record-covers.mjs runs them
// from a laptop against production (runbooks/record-covers.md); test/record-covers.spec.ts runs them against a local
// D1. No network and no bindings here, so both can.
import { releaseIdOf } from './pressing';
import { parseDetails } from './share';

/**
 * Every record with a stored cover, and what its provenance is read from. `from_connection`: the item was made when a
 * connected household's recommendation was wanted (§16 #58), its cover copied from theirs.
 */
export const RECORD_COVERS_SQL = `SELECT i.id, i.added_at, i.updated_at, i.media_type, i.title, i.creators, i.isbn13, i.isbn10_upc,
  i.details, i.cover_key,
  EXISTS (SELECT 1 FROM recommendations r WHERE r.wanted_item_id = i.id) AS from_connection
FROM items i WHERE i.media_type IN ('vinyl', 'music') AND i.cover_key IS NOT NULL ORDER BY i.id`;

export type RecordCoverRow = {
  id: number;
  added_at: string;
  updated_at: string;
  media_type: string;
  title: string;
  creators: string | null;
  isbn13: string | null;
  isbn10_upc: string | null;
  details: string | null;
  cover_key: string;
  from_connection: number | boolean;
};

/**
 * Where a stored record cover came from, as far as the data can tell — it keeps no source for a cover:
 *  - `discogs`: added from a Discogs result (its details hold the release id every Discogs path writes, §16 #63) and
 *    never saved since (`updated_at` is still `added_at`), so its cover is the one that add stored — the result's
 *    Discogs image. Replaced with the Cover Art Archive's, or dropped.
 *  - `user`: added by hand with a cover URL typed into the form — no release id, never saved since, and not from a
 *    connection. Imports bring no covers, so nothing else adds a record with one. Kept.
 *  - `unknown`: saved since it was added — an edit (which can type a new cover URL), the cover backfill (Discogs or
 *    the archive), a refresh, a tag — or copied from a connection's cover. Kept, and counted, for the owner to decide.
 */
export type Provenance = 'discogs' | 'user' | 'unknown';
export type ProvenanceReason = 'discogs-add' | 'typed' | 'saved-since' | 'from-connection';

export function coverProvenance(row: Pick<RecordCoverRow, 'added_at' | 'updated_at' | 'details' | 'from_connection'>): {
  provenance: Provenance;
  reason: ProvenanceReason;
} {
  if (row.from_connection) return { provenance: 'unknown', reason: 'from-connection' };
  if (row.updated_at !== row.added_at) return { provenance: 'unknown', reason: 'saved-since' };
  if (releaseIdOf(parseDetails(row.details)) !== null) return { provenance: 'discogs', reason: 'discogs-add' };
  return { provenance: 'user', reason: 'typed' };
}

/** What happens to one Discogs cover: the archive's image under a new key, or none. */
export type Replacement = { id: number; addedAt: string; oldKey: string; newKey: string | null };

const COVER_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Text as SQL without quoting it: CAST(X'<hex>' AS TEXT). A key or a date from the database is only ever compared,
 * but it's still not pasted into a statement — and wrangler splits a SQL file on semicolons, which hex has none of.
 */
export function sqlText(value: string): string {
  const hex = [...new TextEncoder().encode(value)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `CAST(X'${hex}' AS TEXT)`;
}

/**
 * The one UPDATE for a replacement. It changes the row only while it is still the record it was at export — same id,
 * same added_at (ids are reused) — and still holds the cover it had then: a cover changed since, by anyone, wins, and
 * running the statement twice changes nothing the second time. updated_at moves, so connections see the change and
 * the record no longer reads as an untouched Discogs add.
 */
export function replacementStatement(r: Replacement): string {
  if (!Number.isSafeInteger(r.id) || r.id <= 0) throw new Error(`Unexpected item id: ${r.id}`);
  if (r.newKey !== null && !COVER_KEY.test(r.newKey)) throw new Error(`Unexpected cover key for #${r.id}: ${r.newKey}`);
  const value = r.newKey === null ? 'NULL' : `'${r.newKey}'`;
  return (
    `UPDATE items SET cover_key = ${value}, updated_at = datetime('now') ` +
    `WHERE id = ${r.id} AND added_at = ${sqlText(r.addedAt)} AND cover_key = ${sqlText(r.oldKey)} AND media_type IN ('vinyl', 'music');`
  );
}

/** Statements in batches of `size`: each batch is one D1 call, and the R2 objects it frees go once it's confirmed. */
export function inBatches<T>(list: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('A batch holds at least one statement.');
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The rows a batch touched, as they are now: what tells the apply which replacements landed. */
export function batchCheckSql(batch: readonly Replacement[]): string {
  const ids = batch.map((r) => r.id).filter((id) => Number.isSafeInteger(id) && id > 0);
  return `SELECT id, added_at, cover_key FROM items WHERE id IN (${ids.join(', ') || 'NULL'})`;
}

/** Which of these keys any item still points at: an object is deleted only once nothing does. */
export function referencedKeysSql(keys: readonly string[]): string {
  return `SELECT DISTINCT cover_key FROM items WHERE cover_key IN (${keys.map(sqlText).join(', ') || 'NULL'})`;
}

export type BatchOutcome = {
  /** Replacements the database now shows: the row holds its new key, or none for a drop. */
  landed: Replacement[];
  /** Rows changed since the export (another cover, or deleted): left as they are. */
  skipped: Replacement[];
  /** Objects nothing points at any more, to delete: the old covers that landed, and new ones a skipped row never took. */
  freed: string[];
};

/**
 * After a batch: which replacements landed, and which R2 objects are now unreferenced. `rows` is batchCheckSql's
 * answer; `referenced` is referencedKeysSql's for every key the batch named, old and new.
 */
export function settleBatch(
  batch: readonly Replacement[],
  rows: ReadonlyArray<{ id: number; added_at: string; cover_key: string | null }>,
  referenced: ReadonlySet<string>,
): BatchOutcome {
  const now = new Map(rows.map((r) => [Number(r.id), r]));
  const landed: Replacement[] = [];
  const skipped: Replacement[] = [];
  for (const r of batch) {
    const row = now.get(r.id);
    if (row && row.added_at === r.addedAt && (row.cover_key ?? null) === r.newKey) landed.push(r);
    else skipped.push(r);
  }
  const freed = new Set<string>();
  for (const r of landed) if (!referenced.has(r.oldKey)) freed.add(r.oldKey);
  for (const r of skipped) if (r.newKey && !referenced.has(r.newKey)) freed.add(r.newKey);
  return { landed, skipped, freed: [...freed] };
}
