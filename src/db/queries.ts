// All D1 access lives here (plus src/lib/covers.ts for R2) — ARCH.md §13.
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  currentOrderSql,
  displayOrderSql,
  MAX_READS_PER_ITEM,
  readsFromColumns,
  reconcileGoodreads,
  statusOrderSql,
  summarizeReads,
  type GoodreadsReading,
  type ReadDraft,
  type ReadRow,
} from '../lib/reads';
import * as s from './schema';
import type { Item, ItemStatus, Library, Loan, MediaType, NewItem, ReadStatus, Share, User } from './schema';

const db = (d1: D1Database) => drizzle(d1);

// ---------- users ----------

export async function countUsers(d1: D1Database): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.users);
  return row?.n ?? 0;
}

export async function getUserByUsername(d1: D1Database, username: string): Promise<User | null> {
  const [u] = await db(d1).select().from(s.users).where(eq(s.users.username, username));
  return u ?? null;
}

export async function getUserById(d1: D1Database, id: number): Promise<User | null> {
  const [u] = await db(d1).select().from(s.users).where(eq(s.users.id, id));
  return u ?? null;
}

export async function createUser(
  d1: D1Database,
  values: { username: string; passwordHash: string; role: 'admin' | 'member'; mustChangePassword: boolean },
): Promise<User> {
  const [u] = await db(d1).insert(s.users).values(values).returning();
  if (!u) throw new Error('failed to create user');
  return u;
}

/**
 * First-run setup: the admin and the household's starter shelves, in one batch (ARCH.md §16 #39) — or nothing, once
 * anyone exists. Every statement carries the same guard, no user yet, decided inside it; the shelves come first, so
 * nothing in the batch touches users before the admin's insert. The batch is one transaction, so every statement sees
 * the same answer: two setups racing make one admin and one set of shelves. The admin's id, or null when setup was
 * already done.
 */
export async function createFirstAdmin(
  d1: D1Database,
  values: { username: string; passwordHash: string },
  shelves: readonly string[],
): Promise<number | null> {
  const noUserYet = 'WHERE NOT EXISTS (SELECT 1 FROM users)';
  const results = await d1.batch([
    ...shelves.map((name) => d1.prepare(`INSERT INTO libraries (name) SELECT ?1 ${noUserYet}`).bind(name)),
    d1
      .prepare(
        `INSERT INTO users (username, password_hash, role, must_change_password)
         SELECT ?1, ?2, 'admin', 0 ${noUserYet} RETURNING id`,
      )
      .bind(values.username, values.passwordHash),
  ]);
  return (results.at(-1)?.results[0] as { id: number } | undefined)?.id ?? null;
}

export async function listUsers(d1: D1Database): Promise<User[]> {
  return db(d1).select().from(s.users).orderBy(asc(s.users.id));
}

export async function deleteUser(d1: D1Database, id: number): Promise<void> {
  // Two references to users have no ON DELETE action (migrations 0000 and 0012, both applied): items.added_by
  // and reading_progress.added_by. Either would stop a member being removed — and a member who both added an
  // item and recorded a page hits both — so both are cleared in the same batch. Their items and reading log
  // stay, just unattributed.
  await d1.batch([
    d1.prepare('UPDATE items SET added_by = NULL WHERE added_by = ?1').bind(id),
    d1.prepare('UPDATE reading_progress SET added_by = NULL WHERE added_by = ?1').bind(id),
    d1.prepare('DELETE FROM users WHERE id = ?1').bind(id),
  ]);
}

export async function setPassword(
  d1: D1Database,
  id: number,
  passwordHash: string,
  mustChangePassword: boolean,
): Promise<void> {
  await db(d1).update(s.users).set({ passwordHash, mustChangePassword }).where(eq(s.users.id, id));
}

// ---------- login throttling ----------

export async function recordLoginAttempt(d1: D1Database, ip: string): Promise<void> {
  const dbi = db(d1);
  await dbi.insert(s.loginAttempts).values({ ip });
  // opportunistic prune; keeps the table tiny without any cron
  await dbi.delete(s.loginAttempts).where(sql`${s.loginAttempts.attemptedAt} < datetime('now', '-1 hour')`);
}

export async function recentLoginAttempts(d1: D1Database, ip: string): Promise<number> {
  const [row] = await db(d1)
    .select({ n: count() })
    .from(s.loginAttempts)
    .where(and(eq(s.loginAttempts.ip, ip), sql`${s.loginAttempts.attemptedAt} > datetime('now', '-10 minutes')`));
  return row?.n ?? 0;
}

// ---------- libraries ----------

export async function listLibraries(d1: D1Database): Promise<Array<Library & { itemCount: number }>> {
  const dbi = db(d1);
  const libs = await dbi.select().from(s.libraries).orderBy(asc(s.libraries.position), asc(s.libraries.id));
  const counts = await dbi
    .select({ libraryId: s.items.libraryId, n: count() })
    .from(s.items)
    .groupBy(s.items.libraryId);
  const byId = new Map(counts.map((c) => [c.libraryId, c.n]));
  return libs.map((l) => ({ ...l, itemCount: byId.get(l.id) ?? 0 }));
}

export async function getLibrary(d1: D1Database, id: number): Promise<Library | null> {
  const [l] = await db(d1).select().from(s.libraries).where(eq(s.libraries.id, id));
  return l ?? null;
}

export async function createLibrary(d1: D1Database, name: string): Promise<Library> {
  const [l] = await db(d1).insert(s.libraries).values({ name }).returning();
  if (!l) throw new Error('failed to create library');
  return l;
}

export async function renameLibrary(d1: D1Database, id: number, name: string): Promise<void> {
  await db(d1).update(s.libraries).set({ name }).where(eq(s.libraries.id, id));
}

export async function deleteLibrary(d1: D1Database, id: number): Promise<string[]> {
  const dbi = db(d1);
  const covers = await dbi
    .select({ coverKey: s.items.coverKey })
    .from(s.items)
    .where(and(eq(s.items.libraryId, id), sql`${s.items.coverKey} IS NOT NULL`));
  await dbi.delete(s.libraries).where(eq(s.libraries.id, id)); // items cascade
  return covers.map((c) => c.coverKey).filter((k): k is string => !!k);
}

// ---------- share views ----------
// One row per published view (ARCH.md §16 #18). libraries.share_token is legacy:
// migrated into this table by 0004, no longer read or written.

export type NewShare = {
  token: string;
  name: string;
  libraryId: number | null;
  mediaType?: MediaType | null;
  status?: ItemStatus | null;
  owned?: boolean | null;
  tag?: string | null;
  sort?: 'added' | 'title' | 'rating' | 'completed';
};

export async function createShare(d1: D1Database, values: NewShare): Promise<Share> {
  const [row] = await db(d1).insert(s.shares).values(values).returning();
  if (!row) throw new Error('failed to create share');
  return row;
}

export async function getShareByToken(d1: D1Database, token: string): Promise<Share | null> {
  if (!token) return null;
  const [row] = await db(d1).select().from(s.shares).where(eq(s.shares.token, token));
  return row ?? null;
}

export async function listShares(d1: D1Database, libraryId?: number): Promise<Share[]> {
  return db(d1)
    .select()
    .from(s.shares)
    .where(libraryId === undefined ? undefined : eq(s.shares.libraryId, libraryId))
    .orderBy(asc(s.shares.id));
}

/** The links published from one tag's page. */
export async function listTagShares(d1: D1Database, tag: string): Promise<Share[]> {
  return db(d1).select().from(s.shares).where(eq(s.shares.tag, tag)).orderBy(asc(s.shares.id));
}

export async function rotateShare(d1: D1Database, id: number, token: string): Promise<void> {
  await db(d1).update(s.shares).set({ token }).where(eq(s.shares.id, id));
}

export async function deleteShare(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.shares).where(eq(s.shares.id, id));
}

// ---------- items ----------

export const PAGE_SIZE = 60;

export type ItemFilters = {
  mediaTypes?: MediaType[]; // any-of; empty/omitted = all types
  statuses?: ItemStatus[]; // any-of; empty/omitted = any status
  owned?: boolean; // true = copies > 0, false = copies = 0 (reading-log entries)
  q?: string; // title/creators substring, case-insensitive
  tag?: string; // only items carrying this tag (tags are stored lowercase)
  sort?: 'added' | 'title' | 'rating' | 'completed';
  page?: number; // 1-based
};

/** The WHERE behind both listItems and countMatchingItems — one definition, so a
 *  count can never disagree with the list it is counting. */
function itemFilterWhere(libraryId: number | null, f: ItemFilters): SQL | undefined {
  const conds: SQL[] = [];
  if (libraryId !== null) conds.push(eq(s.items.libraryId, libraryId));
  if (f.mediaTypes?.length) conds.push(inArray(s.items.mediaType, f.mediaTypes));
  if (f.statuses?.length) conds.push(inArray(s.items.status, f.statuses));
  if (f.owned !== undefined) conds.push(f.owned ? gt(s.items.copies, 0) : eq(s.items.copies, 0));
  if (f.tag) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${s.itemTags} INNER JOIN ${s.tags} ON ${s.tags.id} = ${s.itemTags.tagId} WHERE ${s.itemTags.itemId} = ${s.items.id} AND ${s.tags.name} = ${f.tag})`,
    );
  }
  if (f.q) {
    const needle = `%${f.q.replace(/[%_\\]/g, '\\$&')}%`;
    conds.push(sql`(${s.items.title} LIKE ${needle} ESCAPE '\\' OR ${s.items.creators} LIKE ${needle} ESCAPE '\\')`);
  }
  return and(...conds);
}

/** How many items a set of filters exposes, without paying for a page of rows. */
export async function countMatchingItems(
  d1: D1Database,
  libraryId: number | null,
  f: ItemFilters = {},
): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.items).where(itemFilterWhere(libraryId, f));
  return row?.n ?? 0;
}

/**
 * countMatchingItems for many views at once, as one batch — a single D1 call however many views there are
 * (measured: a batch counts once against the per-invocation cap, ARCH.md §16 #37). Each statement keeps its
 * own parameters, so D1's 100-per-statement limit never adds up across views.
 */
export async function countMatchingItemsMany(
  d1: D1Database,
  views: Array<{ libraryId: number | null; filters: ItemFilters }>,
): Promise<number[]> {
  if (!views.length) return [];
  const dbi = db(d1);
  const [first, ...rest] = views.map((v) => dbi.select({ n: count() }).from(s.items).where(itemFilterWhere(v.libraryId, v.filters)));
  const results = await dbi.batch([first!, ...rest]);
  return results.map((rows) => rows[0]?.n ?? 0);
}

export async function listItems(
  d1: D1Database,
  libraryId: number | null, // null = across all shelves (share views)
  f: ItemFilters = {},
): Promise<{ items: Item[]; total: number; page: number; pages: number }> {
  const dbi = db(d1);
  const where = itemFilterWhere(libraryId, f);

  const order =
    f.sort === 'title'
      ? [asc(s.items.title)]
      : f.sort === 'rating'
        ? [sql`${s.items.rating} IS NULL, ${s.items.rating} DESC`, asc(s.items.title)]
        : f.sort === 'completed'
          ? [sql`${s.items.completedOn} IS NULL, ${s.items.completedOn} DESC`, asc(s.items.title)]
          : [desc(s.items.addedAt), desc(s.items.id)];

  const [row] = await dbi.select({ n: count() }).from(s.items).where(where);
  const total = row?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, f.page ?? 1), pages);

  const items = await dbi
    .select()
    .from(s.items)
    .where(where)
    .orderBy(...order)
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  return { items, total, page, pages };
}

export async function getItem(d1: D1Database, id: number): Promise<Item | null> {
  const [i] = await db(d1).select().from(s.items).where(eq(s.items.id, id));
  return i ?? null;
}

/**
 * An item and the reads its status and dates stand for (readsFromColumns), in one batch. The app adds items
 * through createItemWithTags and the imports; tests seed through this, so what they seed is shaped as the app
 * would have made it.
 */
export async function createItem(d1: D1Database, values: NewItem): Promise<Item> {
  const reads = readsFromColumns(values.status ?? 'not_started', values.beganOn, values.completedOn);
  const q = db(d1).insert(s.items).values(withReadState(values, reads)).returning({ id: s.items.id }).toSQL();
  const [created] = await d1.batch([
    d1.prepare(q.sql).bind(...q.params),
    ...readInsertStatements(d1, 'newest', reads),
    refreshReadState(d1, 'newest'),
  ]);
  const id = (created?.results[0] as { id: number } | undefined)?.id;
  const item = id ? await getItem(d1, id) : null;
  if (!item) throw new Error('failed to create item');
  return item;
}

export async function updateItem(d1: D1Database, id: number, values: Partial<NewItem>): Promise<void> {
  await db(d1)
    .update(s.items)
    .set({ ...values, updatedAt: sql`(datetime('now'))` })
    .where(eq(s.items.id, id));
}

export async function deleteItem(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.items).where(eq(s.items.id, id));
}

export async function recentItems(d1: D1Database, limit = 12): Promise<Item[]> {
  return db(d1).select().from(s.items).orderBy(desc(s.items.addedAt), desc(s.items.id)).limit(limit);
}

/** Reading-log entries: cataloged (reviewed, rated) but not physically owned. */
export async function holdingsByType(
  d1: D1Database,
): Promise<{ mediaType: MediaType; owned: number; notOwned: number }[]> {
  return db(d1)
    .select({
      mediaType: s.items.mediaType,
      owned: sql`sum(case when ${s.items.copies} > 0 then 1 else 0 end)`.mapWith(Number),
      notOwned: sql`sum(case when ${s.items.copies} = 0 then 1 else 0 end)`.mapWith(Number),
    })
    .from(s.items)
    .groupBy(s.items.mediaType)
    .orderBy(desc(count()));
}

// ---------- tags ----------

export function normalizeTags(names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
}

/**
 * The statements that link an item to `names`, adding any tag not seen before. `item` is its id, or
 * 'newest' for an item inserted earlier in the same batch: rowids only grow, and nothing else writes inside
 * a batch, so the newest item is that one.
 */
function tagLinkStatements(d1: D1Database, item: number | 'newest', names: string[]): D1PreparedStatement[] {
  const normalized = normalizeTags(names);
  if (!normalized.length) return [];
  const json = JSON.stringify(normalized);
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const params = item === 'newest' ? [json] : [json, item];
  return [
    // "WHERE true" keeps SQLite from reading ON CONFLICT as a join constraint
    d1.prepare('INSERT INTO tags (name) SELECT value FROM json_each(?1) WHERE true ON CONFLICT (name) DO NOTHING').bind(json),
    d1
      .prepare(
        `INSERT INTO item_tags (item_id, tag_id) SELECT ${itemRef}, id FROM tags
         WHERE name IN (SELECT value FROM json_each(?1)) ON CONFLICT DO NOTHING`,
      )
      .bind(...params),
  ];
}

/**
 * Makes an item's tags exactly `names`, in one batch. It cleared the old links, then added the new ones, as
 * separate calls, so a failure partway left the item with no tags until it was saved again.
 */
export async function setItemTags(d1: D1Database, itemId: number, names: string[]): Promise<void> {
  await d1.batch([d1.prepare('DELETE FROM item_tags WHERE item_id = ?1').bind(itemId), ...tagLinkStatements(d1, itemId, names)]);
}

/**
 * A new item, its tags and the read its status and dates stand for, in one batch: a failure between them saved
 * it without them, and the person's second try saved it twice. Returns its id.
 */
export async function createItemWithTags(d1: D1Database, values: NewItem, names: string[]): Promise<number> {
  const reads = readsFromColumns(values.status ?? 'not_started', values.beganOn, values.completedOn);
  const q = db(d1).insert(s.items).values(withReadState(values, reads)).returning({ id: s.items.id }).toSQL();
  const [created] = await d1.batch([
    d1.prepare(q.sql).bind(...q.params),
    ...tagLinkStatements(d1, 'newest', names),
    ...readInsertStatements(d1, 'newest', reads),
    refreshReadState(d1, 'newest'),
  ]);
  const row = created?.results[0] as { id: number } | undefined;
  if (!row) throw new Error('failed to create item');
  return row.id;
}

/**
 * What the edit form says about reading: it describes the read that decides the item's status. `clearReads` is
 * "Not started" for an item with no Reading section to delete reads from — a record, a board game — whose reads
 * then go (the route allows it only there).
 */
export type FormRead = { status: ItemStatus; beganOn: string | null; completedOn: string | null; clearReads?: boolean };

/**
 * An edit, the item's new tags, and what the form says about its reading, in one batch, so a failure can't save
 * one without the others. The form's status and dates edit the read that decides the item's status — the last
 * finished one, or the open one, or the last stopped one — or make the first read of an item that has none;
 * items.status and its neighbours are then recomputed from the reads, never written from the form. "Not
 * started" writes no read: the route refuses it for an item that has reads.
 */
export async function updateItemWithTags(
  d1: D1Database,
  id: number,
  values: Partial<NewItem>,
  names: string[],
  formRead?: FormRead,
): Promise<void> {
  // reading state comes from reads alone
  const { status: _s, beganOn: _b, completedOn: _c, readCount: _n, rereading: _r, progressPage: _p, ...rest } = values;
  const q = db(d1)
    .update(s.items)
    .set({ ...rest, updatedAt: sql`(datetime('now'))` })
    .where(eq(s.items.id, id))
    .toSQL();
  await d1.batch([
    d1.prepare(q.sql).bind(...q.params),
    d1.prepare('DELETE FROM item_tags WHERE item_id = ?1').bind(id),
    ...tagLinkStatements(d1, id, names),
    ...(formRead ? formReadStatements(d1, id, formRead) : []),
    refreshReadState(d1, [id]),
  ]);
}

export async function tagsForItem(d1: D1Database, itemId: number): Promise<string[]> {
  const rows = await db(d1)
    .select({ name: s.tags.name })
    .from(s.itemTags)
    .innerJoin(s.tags, eq(s.itemTags.tagId, s.tags.id))
    .where(eq(s.itemTags.itemId, itemId))
    .orderBy(asc(s.tags.name));
  return rows.map((r) => r.name);
}

/**
 * D1 binds at most 100 parameters per statement, and an `IN (…)` over a long id list is a statement
 * with one parameter per id. Unchunked, the export's 500-id pages threw "too many SQL variables"
 * inside waitUntil and the download came back as a header row and nothing else.
 */
const MAX_IDS_PER_STATEMENT = 90;
function chunked<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += MAX_IDS_PER_STATEMENT) out.push(list.slice(i, i + MAX_IDS_PER_STATEMENT));
  return out;
}

export async function tagsForItems(d1: D1Database, itemIds: number[]): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (!itemIds.length) return result;
  const rows = (
    await Promise.all(
      chunked(itemIds).map((ids) =>
        db(d1)
          .select({ itemId: s.itemTags.itemId, name: s.tags.name })
          .from(s.itemTags)
          .innerJoin(s.tags, eq(s.itemTags.tagId, s.tags.id))
          .where(inArray(s.itemTags.itemId, ids)),
      ),
    )
  ).flat();
  for (const r of rows) {
    const list = result.get(r.itemId) ?? [];
    list.push(r.name);
    result.set(r.itemId, list);
  }
  return result;
}

export async function listTagsWithCounts(d1: D1Database): Promise<Array<{ name: string; n: number }>> {
  return db(d1)
    .select({ name: s.tags.name, n: count(s.itemTags.itemId) })
    .from(s.tags)
    .leftJoin(s.itemTags, eq(s.tags.id, s.itemTags.tagId))
    .groupBy(s.tags.id)
    .orderBy(asc(s.tags.name));
}

// ---------- loans ----------

export async function createLoan(
  d1: D1Database,
  values: { itemId: number; borrower: string; contact?: string | null; dueOn?: string | null; note?: string | null },
): Promise<void> {
  await db(d1).insert(s.loans).values(values);
}

export async function returnLoan(d1: D1Database, id: number): Promise<void> {
  await db(d1)
    .update(s.loans)
    .set({ returnedOn: sql`(date('now'))` })
    .where(and(eq(s.loans.id, id), isNull(s.loans.returnedOn)));
}

export type LoanWithItem = Loan & { itemTitle: string; itemCoverKey: string | null };

async function loansJoined(d1: D1Database, where: SQL, limit: number): Promise<LoanWithItem[]> {
  const rows = await db(d1)
    .select({ loan: s.loans, itemTitle: s.items.title, itemCoverKey: s.items.coverKey })
    .from(s.loans)
    .innerJoin(s.items, eq(s.loans.itemId, s.items.id))
    .where(where)
    .orderBy(desc(s.loans.id))
    .limit(limit);
  return rows.map((r) => ({ ...r.loan, itemTitle: r.itemTitle, itemCoverKey: r.itemCoverKey }));
}

export async function activeLoans(d1: D1Database): Promise<LoanWithItem[]> {
  return loansJoined(d1, isNull(s.loans.returnedOn), 200);
}

export async function loanHistory(d1: D1Database, limit = 100): Promise<LoanWithItem[]> {
  return loansJoined(d1, sql`${s.loans.returnedOn} IS NOT NULL`, limit);
}

/** Every open loan of an item, oldest first — an item held in two copies can be out twice. */
export async function activeLoansForItem(d1: D1Database, itemId: number): Promise<Loan[]> {
  return db(d1)
    .select()
    .from(s.loans)
    .where(and(eq(s.loans.itemId, itemId), isNull(s.loans.returnedOn)))
    .orderBy(asc(s.loans.loanedOn), asc(s.loans.id));
}

/**
 * Lends a copy only while one is free — copies held above copies out, the rule connections' borrowing
 * already uses (availability() in src/db/federation.ts). One conditional insert, so two quick submits
 * can't both take the last copy. False when every copy is out.
 */
export async function lendIfFree(
  d1: D1Database,
  values: { itemId: number; borrower: string; contact: string | null; dueOn: string | null },
): Promise<boolean> {
  const row = await d1
    .prepare(
      `INSERT INTO loans (item_id, borrower, contact, due_on)
       SELECT ?1, ?2, ?3, ?4
       WHERE (SELECT copies FROM items WHERE id = ?1)
           > (SELECT count(*) FROM loans WHERE item_id = ?1 AND returned_on IS NULL)
       RETURNING id`,
    )
    .bind(values.itemId, values.borrower, values.contact, values.dueOn)
    .first<{ id: number }>();
  return !!row;
}

export async function activeLoanItemIds(d1: D1Database, itemIds: number[]): Promise<Set<number>> {
  if (!itemIds.length) return new Set();
  const rows = (
    await Promise.all(
      chunked(itemIds).map((ids) =>
        db(d1)
          .select({ itemId: s.loans.itemId })
          .from(s.loans)
          .where(and(inArray(s.loans.itemId, ids), isNull(s.loans.returnedOn))),
      ),
    )
  ).flat();
  return new Set(rows.map((r) => r.itemId));
}

// ---------- full-text search ----------

/** FTS5 lives outside Drizzle's DSL; ids come from a raw query, rows from Drizzle. */
export async function searchItems(d1: D1Database, query: string, limit = 50): Promise<Item[]> {
  const match = query
    .replace(/["'*^]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' ');
  if (!match) return [];
  const idRows = await d1
    .prepare('SELECT rowid AS id FROM items_fts WHERE items_fts MATCH ?1 ORDER BY rank LIMIT ?2')
    .bind(match, limit)
    .all<{ id: number }>();
  const ids = idRows.results.map((r) => r.id);
  if (!ids.length) return [];
  const rows = await db(d1).select().from(s.items).where(inArray(s.items.id, ids));
  const pos = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
}

/**
 * Id-ordered paging over items for the streaming CSV export, by keyset: the next page starts after the last
 * id seen. OFFSET would read every skipped row again on each page, and D1 bills rows read.
 */
export async function pageItems(
  d1: D1Database,
  opts: { libraryId?: number; afterId: number; limit: number },
): Promise<Item[]> {
  const dbi = db(d1);
  return dbi
    .select()
    .from(s.items)
    .where(and(gt(s.items.id, opts.afterId), opts.libraryId ? eq(s.items.libraryId, opts.libraryId) : undefined))
    .orderBy(asc(s.items.id))
    .limit(opts.limit);
}

/**
 * Tags for every item whose id lies in [fromId, toId]. The export pages through items in id order,
 * so a page is one contiguous id range: one query with two parameters, however large the page,
 * where an IN list would need one parameter per id and, chunked, one query per 90 ids against
 * the 50-query budget. Items outside the page's library filter can come back too; callers look up
 * the ids they have, so those are simply never read.
 */
export async function tagsForIdRange(
  d1: D1Database,
  fromId: number,
  toId: number,
  libraryId?: number,
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  const rows = await db(d1)
    .select({ itemId: s.itemTags.itemId, name: s.tags.name })
    .from(s.itemTags)
    .innerJoin(s.tags, eq(s.itemTags.tagId, s.tags.id))
    .where(
      and(
        gte(s.itemTags.itemId, fromId),
        lte(s.itemTags.itemId, toId),
        // scoped to one shelf, a page's id range can span every other shelf's rows too — skip them in SQL
        libraryId ? sql`${s.itemTags.itemId} IN (SELECT id FROM items WHERE library_id = ${libraryId})` : undefined,
      ),
    );
  for (const r of rows) {
    const list = result.get(r.itemId) ?? [];
    list.push(r.name);
    result.set(r.itemId, list);
  }
  return result;
}

// ---------- site settings ----------

export type SiteSettings = { progressOnShares: boolean; progressToConnections: boolean };
const SITE_DEFAULTS: SiteSettings = { progressOnShares: false, progressToConnections: true };

/** One row, id 1. Absent means defaults, so a fresh instance needs no setup step. */
export async function getSiteSettings(d1: D1Database): Promise<SiteSettings> {
  const [row] = await db(d1).select().from(s.siteSettings).where(eq(s.siteSettings.id, 1));
  return row ? { progressOnShares: row.progressOnShares, progressToConnections: row.progressToConnections } : { ...SITE_DEFAULTS };
}

export async function updateSiteSettings(d1: D1Database, patch: Partial<SiteSettings>): Promise<void> {
  await db(d1)
    .insert(s.siteSettings)
    .values({ id: 1, ...SITE_DEFAULTS, ...patch })
    .onConflictDoUpdate({ target: s.siteSettings.id, set: { ...patch, updatedAt: sql`(datetime('now'))` } });
}

// ---------- reads (ARCH.md §16 #41) ----------
//
// `reads` is the source of truth for reading state. Every write to it carries refreshReadState() in the same
// batch (§16 #39), which recomputes the columns on `items` that shelves, filters, share views, connection views,
// the activity triggers and the export read.

/**
 * The item columns a set of reads decides, in SQL — the twin of summarizeReads() in src/lib/reads.ts, and
 * migration 0023 carries the same text. status, began_on and completed_on come from the read that decides status
 * (a finished one, else the open one, else a stopped one); progress_page from the current read, the open one if
 * any. An item with no reads falls back to pages with no read, which is how a page kept its place before reads.
 */
export const READ_STATE_SET = `
  status = coalesce((SELECT r.status FROM reads r WHERE r.item_id = items.id ORDER BY ${statusOrderSql('r')} LIMIT 1), 'not_started'),
  began_on = (SELECT r.began_on FROM reads r WHERE r.item_id = items.id ORDER BY ${statusOrderSql('r')} LIMIT 1),
  completed_on = (SELECT r.ended_on FROM reads r WHERE r.item_id = items.id ORDER BY ${statusOrderSql('r')} LIMIT 1),
  read_count = (SELECT count(*) FROM reads r WHERE r.item_id = items.id AND r.status = 'completed'),
  rereading = EXISTS (SELECT 1 FROM reads r WHERE r.item_id = items.id AND r.status = 'in_progress')
    AND EXISTS (SELECT 1 FROM reads r WHERE r.item_id = items.id AND r.status = 'completed'),
  progress_page = (SELECT p.page FROM reading_progress p WHERE p.item_id = items.id
    AND p.read_id IS (SELECT r.id FROM reads r WHERE r.item_id = items.id ORDER BY ${currentOrderSql('r')} LIMIT 1)
    ORDER BY p.at DESC, p.id DESC LIMIT 1)`;

/**
 * Brings items' reading columns in line with their reads. `ids` is a list, travelling as one JSON parameter
 * however long, or 'newest' for an item inserted earlier in the same batch (see tagLinkStatements). `touch`
 * stamps updated_at, for a change someone made to the book's reading; a page recorded doesn't (§16 #34).
 * It always writes status and completed_on, so migration 0021's update trigger runs, and records a finish only
 * when one of them actually changed.
 */
export function refreshReadState(d1: D1Database, ids: number[] | 'newest', opts: { touch?: boolean } = {}): D1PreparedStatement {
  const touch = opts.touch ? `, updated_at = datetime('now')` : '';
  return ids === 'newest'
    ? d1.prepare(`UPDATE items SET ${READ_STATE_SET}${touch} WHERE id = (SELECT max(id) FROM items)`)
    : d1.prepare(`UPDATE items SET ${READ_STATE_SET}${touch} WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids));
}

/** The item columns for reads it is inserted with, so its insert trigger sees the status and date it will have. */
function withReadState<T extends NewItem>(values: T, reads: ReadDraft[]): T {
  const state = summarizeReads(reads);
  return { ...values, ...state };
}

/** Inserts `reads` for an item — its id, or 'newest' for one inserted earlier in the batch. One statement, in list order. */
function readInsertStatements(d1: D1Database, item: number | 'newest', reads: ReadDraft[]): D1PreparedStatement[] {
  if (!reads.length) return [];
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const json = JSON.stringify(reads.slice(0, MAX_READS_PER_ITEM));
  const stmt = d1.prepare(
    `INSERT INTO reads (item_id, status, began_on, ended_on)
     SELECT ${itemRef}, json_extract(value, '$.status'), json_extract(value, '$.beganOn'), json_extract(value, '$.endedOn')
     FROM json_each(?1) ORDER BY key`,
  );
  return [item === 'newest' ? stmt.bind(json) : stmt.bind(json, item)];
}

/**
 * The edit form's status and dates, applied to the read that decides the item's status — or, for an item with no
 * reads yet, made its first read. Both statements are conditional on the reads actually there, not on what the
 * item columns say. Reopening a read is skipped while another one is open (the unique index would refuse it).
 */
function formReadStatements(d1: D1Database, itemId: number, form: FormRead): D1PreparedStatement[] {
  if (form.status === 'not_started') {
    // pages first: reading_progress.read_id references its read without a cascade
    return form.clearReads
      ? [
          d1.prepare('DELETE FROM activity_log WHERE progress_id IN (SELECT id FROM reading_progress WHERE item_id = ?1)').bind(itemId),
          d1.prepare('DELETE FROM reading_progress WHERE item_id = ?1').bind(itemId),
          d1.prepare('DELETE FROM reads WHERE item_id = ?1').bind(itemId),
        ]
      : [];
  }
  const ended = form.status === 'in_progress' ? null : form.completedOn;
  return [
    d1
      .prepare(
        `INSERT INTO reads (item_id, status, began_on, ended_on)
         SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1)`,
      )
      .bind(itemId, form.status, form.beganOn, ended),
    d1
      .prepare(
        `UPDATE reads SET status = ?2, began_on = ?3, ended_on = ?4
         WHERE id = (SELECT r.id FROM reads r WHERE r.item_id = ?1 ORDER BY ${statusOrderSql('r')} LIMIT 1)
           AND NOT (?2 = 'in_progress' AND EXISTS (
             SELECT 1 FROM reads o WHERE o.item_id = ?1 AND o.status = 'in_progress' AND o.id <> reads.id))`,
      )
      .bind(itemId, form.status, form.beganOn, ended),
    adoptOrphanPages(d1, itemId),
  ];
}

/**
 * Pages recorded before an item had any read — only a book marked not started that had pages when reads arrived —
 * join its current read once it has one, as migration 0023 put everyone else's. Left behind with no read, they'd
 * drop out of the item page while still being exported and shared. A no-op for every other item.
 */
function adoptOrphanPages(d1: D1Database, itemId: number): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE reading_progress SET read_id = (SELECT r.id FROM reads r WHERE r.item_id = ?1 ORDER BY ${currentOrderSql('r')} LIMIT 1)
       WHERE item_id = ?1 AND read_id IS NULL AND EXISTS (SELECT 1 FROM reads WHERE item_id = ?1)`,
    )
    .bind(itemId);
}

export type ReadEntry = ReadRow & { createdAt: string };

/** An item's reads, oldest first with the open one last, and its pages — one D1 call. */
export async function readingLog(d1: D1Database, itemId: number): Promise<{ reads: ReadEntry[]; entries: ProgressEntry[] }> {
  const [reads, entries] = await d1.batch([
    d1
      .prepare(
        `SELECT r.id, r.status, r.began_on AS beganOn, r.ended_on AS endedOn, r.created_at AS createdAt
         FROM reads r WHERE r.item_id = ?1 ORDER BY ${displayOrderSql('r')}`,
      )
      .bind(itemId),
    d1
      .prepare('SELECT id, page, at, added_by AS addedBy, read_id AS readId FROM reading_progress WHERE item_id = ?1 ORDER BY at, id')
      .bind(itemId),
  ]);
  return { reads: (reads?.results ?? []) as ReadEntry[], entries: (entries?.results ?? []) as ProgressEntry[] };
}

/**
 * Opens a read — the first, or "Read again" on a finished book, which stays Completed and shows as re-reading.
 * Nothing happens while one is already open. True when a read was opened.
 */
export async function startRead(d1: D1Database, itemId: number, beganOn: string): Promise<boolean> {
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reads (item_id, status, began_on)
         SELECT ?1, 'in_progress', ?2
         WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)
           AND NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1 AND status = 'in_progress')
           AND (SELECT count(*) FROM reads WHERE item_id = ?1) < ${MAX_READS_PER_ITEM}`,
      )
      .bind(itemId, beganOn),
    adoptOrphanPages(d1, itemId),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

/**
 * Closes the open read: finished, or stopped. A finish makes it the last finished read, so completed_on moves to
 * its date and migration 0021's trigger records the finish for connections, dated by it (§16 #40). Only an open
 * read that began by that date closes. True when it did.
 */
export async function closeRead(
  d1: D1Database,
  itemId: number,
  readId: number,
  status: Exclude<ReadStatus, 'in_progress'>,
  endedOn: string,
): Promise<boolean> {
  const [closed] = await d1.batch([
    d1
      .prepare(
        `UPDATE reads SET status = ?3, ended_on = ?4
         WHERE id = ?1 AND item_id = ?2 AND status = 'in_progress' AND (began_on IS NULL OR began_on <= ?4)`,
      )
      .bind(readId, itemId, status, endedOn),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (closed?.meta.changes ?? 0) > 0;
}

/** Records a read from before — "I also read this in 2010" — finished or stopped. True when it was added. */
export async function addPastRead(d1: D1Database, itemId: number, read: ReadDraft): Promise<boolean> {
  if (read.status === 'in_progress') return false;
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reads (item_id, status, began_on, ended_on)
         SELECT ?1, ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1) AND (SELECT count(*) FROM reads WHERE item_id = ?1) < ${MAX_READS_PER_ITEM}`,
      )
      .bind(itemId, read.status, read.beganOn, read.endedOn),
    adoptOrphanPages(d1, itemId),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

/**
 * Corrects one read's outcome and dates. Making it the open read is skipped while another is open. True when it
 * changed.
 */
export async function updateRead(d1: D1Database, itemId: number, readId: number, read: ReadDraft): Promise<boolean> {
  const [updated] = await d1.batch([
    d1
      .prepare(
        `UPDATE reads SET status = ?3, began_on = ?4, ended_on = ?5
         WHERE id = ?1 AND item_id = ?2
           AND NOT (?3 = 'in_progress' AND EXISTS (
             SELECT 1 FROM reads o WHERE o.item_id = ?2 AND o.status = 'in_progress' AND o.id <> ?1))`,
      )
      .bind(readId, itemId, read.status, read.beganOn, read.status === 'in_progress' ? null : read.endedOn),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (updated?.meta.changes ?? 0) > 0;
}

/**
 * Deletes a read and the pages recorded in it — a read's page log only means something inside that read — with
 * those pages' feed entries first, because activity_log.progress_id and reading_progress.read_id reference them
 * without a cascade (§16 #35).
 */
export async function deleteRead(d1: D1Database, itemId: number, readId: number): Promise<void> {
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM activity_log WHERE progress_id IN (SELECT id FROM reading_progress WHERE read_id = ?1 AND item_id = ?2)`,
      )
      .bind(readId, itemId),
    d1.prepare('DELETE FROM reading_progress WHERE read_id = ?1 AND item_id = ?2').bind(readId, itemId),
    d1.prepare('DELETE FROM reads WHERE id = ?1 AND item_id = ?2').bind(readId, itemId),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
}

/**
 * Reads for every item whose id lies in [fromId, toId], each item's in display order — the export's pages are
 * contiguous in id order, so one query covers a page (see tagsForIdRange).
 */
export async function readsForIdRange(d1: D1Database, fromId: number, toId: number, libraryId?: number): Promise<Map<number, ReadRow[]>> {
  const scoped = libraryId ? 'AND r.item_id IN (SELECT id FROM items WHERE library_id = ?3)' : '';
  const stmt = d1.prepare(
    `SELECT r.item_id AS itemId, r.id, r.status, r.began_on AS beganOn, r.ended_on AS endedOn FROM reads r
     WHERE r.item_id BETWEEN ?1 AND ?2 ${scoped}
     ORDER BY r.item_id, ${displayOrderSql('r')}`,
  );
  const rows = (await (libraryId ? stmt.bind(fromId, toId, libraryId) : stmt.bind(fromId, toId)).all<ReadRow & { itemId: number }>())
    .results;
  const result = new Map<number, ReadRow[]>();
  for (const { itemId, ...read } of rows) {
    const list = result.get(itemId) ?? [];
    list.push({ id: read.id, status: read.status, beganOn: read.beganOn, endedOn: read.endedOn });
    result.set(itemId, list);
  }
  return result;
}

// ---------- reading progress ----------

export type ProgressEntry = { id: number; page: number; at: string; addedBy: number | null; readId: number | null };

/** Oldest first: a reading log reads forwards. */
export async function listProgress(d1: D1Database, itemId: number): Promise<ProgressEntry[]> {
  return db(d1)
    .select({
      id: s.readingProgress.id,
      page: s.readingProgress.page,
      at: s.readingProgress.at,
      addedBy: s.readingProgress.addedBy,
      readId: s.readingProgress.readId,
    })
    .from(s.readingProgress)
    .where(eq(s.readingProgress.itemId, itemId))
    .orderBy(asc(s.readingProgress.at), asc(s.readingProgress.id));
}

/**
 * Records a page reached, in the open read. One batch, so the page, its read and the copy on `items` can't
 * disagree. A book with no reads gets its first, opened today, because recording a page is what starting a book
 * looks like (§16 #34); an open read with no start date takes today's, as before. A book finished or stopped with
 * no open read records nothing — reading it again is a deliberate "Read again" first (§16 #41). True when the
 * page was recorded.
 */
export async function addProgress(d1: D1Database, itemId: number, page: number, userId: number | null): Promise<boolean> {
  const results = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reads (item_id, status, began_on)
         SELECT ?1, 'in_progress', date('now')
         WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1) AND NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1)`,
      )
      .bind(itemId),
    d1
      .prepare(
        `UPDATE reads SET began_on = date('now')
         WHERE item_id = ?1 AND status = 'in_progress' AND (began_on IS NULL OR trim(began_on) = '')`,
      )
      .bind(itemId),
    adoptOrphanPages(d1, itemId),
    d1
      .prepare(
        `INSERT INTO reading_progress (item_id, page, added_by, read_id)
         SELECT ?1, ?2, ?3, id FROM reads WHERE item_id = ?1 AND status = 'in_progress'`,
      )
      .bind(itemId, page, userId),
    // updated_at is deliberately untouched: connections see it, and a page is its own entry, not an edit of the book
    refreshReadState(d1, [itemId]),
  ]);
  return (results[3]?.meta.changes ?? 0) > 0;
}

/**
 * Removes one entry — a typo, usually — and puts `items.progress_page` back to whatever the newest
 * remaining entry of the current read says, or to NULL when that was the only one. Its read stays:
 * deleting a mistyped page is not the same as saying you never started the book.
 */
export async function deleteProgress(d1: D1Database, itemId: number, entryId: number): Promise<void> {
  await d1.batch([
    // its feed entry first: activity_log.progress_id references the update without a cascade
    // (SQLite can't add one by ALTER TABLE), and connections learn it's gone from the removal check
    d1.prepare(
      `DELETE FROM activity_log WHERE progress_id = ?1
         AND EXISTS (SELECT 1 FROM reading_progress WHERE id = ?1 AND item_id = ?2)`,
    ).bind(entryId, itemId),
    d1.prepare('DELETE FROM reading_progress WHERE id = ?1 AND item_id = ?2').bind(entryId, itemId),
    refreshReadState(d1, [itemId]),
  ]);
}

/**
 * Progress history for every item whose id lies in [fromId, toId] — the export's pages are contiguous
 * in id order, so one query covers a page (see tagsForIdRange for why not an IN list).
 */
export async function progressForIdRange(
  d1: D1Database,
  fromId: number,
  toId: number,
  libraryId?: number,
): Promise<Map<number, ProgressEntry[]>> {
  const result = new Map<number, ProgressEntry[]>();
  const rows = await db(d1)
    .select({
      itemId: s.readingProgress.itemId,
      id: s.readingProgress.id,
      page: s.readingProgress.page,
      at: s.readingProgress.at,
      addedBy: s.readingProgress.addedBy,
      readId: s.readingProgress.readId,
    })
    .from(s.readingProgress)
    .where(
      and(
        gte(s.readingProgress.itemId, fromId),
        lte(s.readingProgress.itemId, toId),
        // as tagsForIdRange: a scoped page's range can span other shelves' rows
        libraryId ? sql`${s.readingProgress.itemId} IN (SELECT id FROM items WHERE library_id = ${libraryId})` : undefined,
      ),
    )
    .orderBy(asc(s.readingProgress.at), asc(s.readingProgress.id));
  for (const r of rows) {
    const list = result.get(r.itemId) ?? [];
    list.push({ id: r.id, page: r.page, at: r.at, addedBy: r.addedBy, readId: r.readId });
    result.set(r.itemId, list);
  }
  return result;
}

// ---------- cover backfill ----------

// Anything short of a cover or a description qualifies: the barcode pass needs an ISBN/UPC, but the
// title-and-author pass works for identifier-less items too, and every matched record carries details.
const backfillable = () => or(isNull(s.items.coverKey), isNull(s.items.description), eq(s.items.description, ''));

export type BackfillCounts = { total: number; noCover: number; noDescription: number };

/**
 * Items that could gain a cover or details: how many in all (what a run walks), and how many lack
 * each. The two gaps overlap, so noCover + noDescription can exceed total. One query either way.
 */
export async function countBackfillable(d1: D1Database): Promise<BackfillCounts> {
  const [row] = await db(d1)
    .select({
      total: count(),
      noCover: sql<number>`coalesce(sum(case when ${s.items.coverKey} is null then 1 else 0 end), 0)`,
      noDescription: sql<number>`coalesce(sum(case when ${s.items.description} is null or ${s.items.description} = '' then 1 else 0 end), 0)`,
    })
    .from(s.items)
    .where(backfillable());
  return { total: row?.total ?? 0, noCover: Number(row?.noCover ?? 0), noDescription: Number(row?.noDescription ?? 0) };
}

/** Cursor-paged (by id) so the client can walk the whole catalog in small batches. */
export async function nextBackfillable(d1: D1Database, afterId: number, limit: number): Promise<Item[]> {
  return db(d1)
    .select()
    .from(s.items)
    .where(and(backfillable(), gt(s.items.id, afterId)))
    .orderBy(asc(s.items.id))
    .limit(limit);
}

// ---------- bulk import ----------

/** Ensure tags exist and link them to items — additive, existing links kept. */
async function linkTags(dbi: ReturnType<typeof db>, pairs: Array<{ itemId: number; tag: string }>): Promise<void> {
  if (!pairs.length) return;
  const names = [...new Set(pairs.map((p) => p.tag))];
  await dbi.batch(
    names.map((name) => dbi.insert(s.tags).values({ name }).onConflictDoNothing()) as [never, ...never[]],
  );
  // one JSON parameter however many names: an import batch can carry more distinct tags than D1's
  // 100 bound parameters, and the items were already committed when this used to throw
  const tagRows = await dbi.select().from(s.tags).where(sql`${s.tags.name} IN (SELECT value FROM json_each(${JSON.stringify(names)}))`);
  const idByName = new Map(tagRows.map((t) => [t.name, t.id]));
  const links = pairs
    .map((p) => ({ itemId: p.itemId, tagId: idByName.get(p.tag) }))
    .filter((l): l is { itemId: number; tagId: number } => !!l.tagId);
  for (let i = 0; i < links.length; i += 40) {
    const chunk = links.slice(i, i + 40); // stay well under D1's bound-parameter limit
    await dbi.insert(s.itemTags).values(chunk).onConflictDoNothing();
  }
}

/**
 * An import's writes, between the statements that set and clear the marker the activity triggers look for
 * (migration 0021): an imported read is dated by its completed_on, or left out of the feed, rather than reaching
 * connections as today's news. One batch, so the marker can't outlast the import or miss a row of it.
 */
function asImport(d1: D1Database, writes: D1PreparedStatement[]): D1PreparedStatement[] {
  return [
    d1.prepare('INSERT INTO import_in_progress (id) VALUES (1) ON CONFLICT DO NOTHING'),
    ...writes,
    d1.prepare('DELETE FROM import_in_progress'),
  ];
}

/**
 * A row as the importers hand it over. `reads` are its reads when the file says (a Nalanda export's `reads`
 * column, a Goodreads row); otherwise they come from its status and dates, as a libib row's do.
 */
export type ImportRow = { item: NewItem; tags: string[]; reads?: ReadDraft[]; goodreads?: GoodreadsReading };

/**
 * Batched insert used by /api/import. One network round trip per batch of rows: each item goes in with the
 * reading state its reads decide, so the insert trigger dates it right, then its reads, then the refresh that
 * fills in what only the reads know.
 */
export async function importItems(d1: D1Database, rows: ImportRow[]): Promise<number> {
  if (!rows.length) return 0;
  const writes: D1PreparedStatement[] = [];
  const itemAt: number[] = []; // each row's item insert, as an index into the batch's results
  for (const r of rows) {
    const reads = r.reads ?? readsFromColumns(r.item.status ?? 'not_started', r.item.beganOn, r.item.completedOn);
    const q = db(d1).insert(s.items).values(withReadState(r.item, reads)).returning({ id: s.items.id }).toSQL();
    itemAt.push(writes.length + 1); // +1: the marker leads the batch
    writes.push(d1.prepare(q.sql).bind(...q.params), ...readInsertStatements(d1, 'newest', reads), refreshReadState(d1, 'newest'));
  }
  const results = await d1.batch(asImport(d1, writes));

  const pairs: Array<{ itemId: number; tag: string }> = [];
  rows.forEach((r, i) => {
    const id = (results[itemAt[i]!]?.results[0] as { id: number } | undefined)?.id;
    if (!id) return;
    for (const tag of normalizeTags(r.tags)) pairs.push({ itemId: id, tag });
  });
  await linkTags(db(d1), pairs);
  return rows.length;
}

// ---------- Goodreads match-and-merge import ----------

/** Series suffixes and subtitles differ between sources; compare the stem only. */
const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .split(':')[0]!
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** First author's surname, initials-insensitive ("N.K. Jemisin" ≈ "N. K. Jemisin"). */
const surname = (creators: string | null) => {
  const first = (creators ?? '').split(',')[0]!.replace(/\./g, ' ').trim();
  const tokens = first.split(/\s+/).filter(Boolean);
  return tokens[tokens.length - 1]?.toLowerCase() ?? '';
};

const titleKey = (title: string, creators: string | null) => `${normTitle(title)}|${surname(creators)}`;

export type MergeImportResult = { inserted: number; merged: number; reads: number };

/** What a row says about reading, for one that came without a Goodreads reading (a test, or an older caller). */
const readingOf = (item: NewItem): GoodreadsReading => ({
  shelf: item.status ?? 'not_started',
  dateRead: item.completedOn ?? null,
  dateStarted: item.beganOn ?? null,
  readCount: null,
});

/**
 * Rows matching an existing item (by ISBN-13, then ISBN-10, then normalized
 * title + first-author surname) merge their reading data onto it — Goodreads wins
 * for rating, review and notes (ARCH.md §16 #14) but never blanks a field it has no
 * value for, and never touches copies or bibliographic metadata. Its reading state
 * arrives as reads, which it adds and never removes (reconcileGoodreads, §16 #41):
 * a to-read shelf over there doesn't undo a read recorded here. Unmatched rows insert
 * as new items (typically copies = 0 reading-log entries). Re-runs are safe: rows
 * inserted last time match by ISBN or title on the next run and merge instead of
 * duplicating, and every reads rule checks for its own result first. `reads` counts
 * the reads the run adds or dates.
 */
export async function mergeImportItems(d1: D1Database, rows: ImportRow[], dryRun = false): Promise<MergeImportResult> {
  if (!rows.length) return { inserted: 0, merged: 0, reads: 0 };
  const dbi = db(d1);

  // Household scale: load every item's match keys once per batch — simpler and cheaper
  // than chunked IN() lookups under D1's bound-parameter limit.
  const existing = await dbi
    .select({
      id: s.items.id,
      isbn13: s.items.isbn13,
      isbn10Upc: s.items.isbn10Upc,
      title: s.items.title,
      creators: s.items.creators,
    })
    .from(s.items);
  const byIsbn13 = new Map<string, number>();
  const byIsbn10 = new Map<string, number>();
  const byTitle = new Map<string, number>();
  for (const e of existing) {
    if (e.isbn13) byIsbn13.set(e.isbn13, e.id);
    if (e.isbn10Upc) byIsbn10.set(e.isbn10Upc.toUpperCase(), e.id);
    byTitle.set(titleKey(e.title, e.creators), e.id);
  }

  const inserts: ImportRow[] = [];
  const merges: Array<{ id: number; set: Partial<NewItem>; tags: string[]; reading: GoodreadsReading }> = [];
  for (const r of rows) {
    const id =
      (r.item.isbn13 ? byIsbn13.get(r.item.isbn13) : undefined) ??
      (r.item.isbn10Upc ? byIsbn10.get(r.item.isbn10Upc.toUpperCase()) : undefined) ??
      byTitle.get(titleKey(r.item.title, r.item.creators ?? null));
    if (!id) {
      inserts.push(r);
      continue;
    }
    const set: Partial<NewItem> = {};
    if (r.item.rating != null) set.rating = r.item.rating;
    if (r.item.review) set.review = r.item.review;
    if (r.item.notes) set.notes = r.item.notes;
    merges.push({ id, set, tags: r.tags, reading: r.goodreads ?? readingOf(r.item) });
  }

  // the reads already here for the books that matched: one query, the ids as one JSON parameter
  const readsHere = new Map<number, ReadRow[]>();
  if (merges.length) {
    const found = await d1
      .prepare(
        `SELECT item_id AS itemId, id, status, began_on AS beganOn, ended_on AS endedOn FROM reads
         WHERE item_id IN (SELECT value FROM json_each(?1)) ORDER BY id`,
      )
      .bind(JSON.stringify([...new Set(merges.map((m) => m.id))]))
      .all<ReadRow & { itemId: number }>();
    for (const { itemId, ...read } of found.results) readsHere.set(itemId, [...(readsHere.get(itemId) ?? []), read]);
  }
  // Reconciled row by row against a working copy, so a second row for the same book (two editions matching one
  // item) sees what the first added — and may date a read the first made, which is still only a planned insert.
  // Statements are built once every row is in: new reads as inserts, changed ones as updates.
  type Working = ReadRow & { fresh: boolean; changed: boolean };
  const work = new Map<number, Working[]>();
  let standIn = 0; // ids for reads this run will insert; negative, so they never meet a real one
  for (const m of merges) {
    const list = work.get(m.id) ?? (readsHere.get(m.id) ?? []).map((r) => ({ ...r, fresh: false, changed: false }));
    for (const op of reconcileGoodreads(list, m.reading)) {
      if (op.op === 'insert') list.push({ ...op.read, id: --standIn, fresh: true, changed: true });
      else Object.assign(list.find((r) => r.id === op.id)!, op.read, { changed: true });
    }
    work.set(m.id, list);
  }
  const writes: D1PreparedStatement[] = [];
  let readChanges = 0;
  for (const [itemId, list] of work) {
    const fresh = list.filter((r) => r.fresh).map(({ status, beganOn, endedOn }) => ({ status, beganOn, endedOn }));
    writes.push(...readInsertStatements(d1, itemId, fresh));
    for (const r of list.filter((x) => !x.fresh && x.changed)) {
      writes.push(
        d1.prepare('UPDATE reads SET status = ?2, began_on = ?3, ended_on = ?4 WHERE id = ?1').bind(r.id, r.status, r.beganOn, r.endedOn),
      );
    }
    readChanges += list.filter((r) => r.changed).length;
  }
  for (const r of inserts) readChanges += (r.reads ?? readsFromColumns(r.item.status ?? 'not_started', r.item.beganOn, r.item.completedOn)).length;

  if (!dryRun) {
    if (merges.length) {
      const ids = [...new Set(merges.map((m) => m.id))];
      // A re-import that changes nothing leaves updated_at alone — connections see it. Only books whose reads
      // changed are touched by the refresh, and a rating, review or notes value is written only when it differs.
      const touched = ids.filter((id) => work.get(id)?.some((r) => r.changed));
      const untouched = ids.filter((id) => !touched.includes(id));
      const merged = { rating: s.items.rating, review: s.items.review, notes: s.items.notes } as const;
      const updates = merges
        .filter((m) => Object.keys(m.set).length)
        .map((m) => {
          const differs = or(
            ...Object.entries(m.set).map(([k, v]) => sql`${merged[k as keyof typeof merged]} IS NOT ${v}`),
          );
          const q = dbi
            .update(s.items)
            .set({ ...m.set, updatedAt: sql`(datetime('now'))` })
            .where(and(eq(s.items.id, m.id), differs))
            .toSQL();
          return d1.prepare(q.sql).bind(...q.params);
        });
      const refreshes = [
        ...(touched.length ? [refreshReadState(d1, touched, { touch: true })] : []),
        ...(untouched.length ? [refreshReadState(d1, untouched)] : []),
      ];
      // reads and their refresh first, so a rating merged in the same batch is dated by the finish it arrived with
      await d1.batch(asImport(d1, [...writes, ...refreshes, ...updates]));
      const pairs: Array<{ itemId: number; tag: string }> = [];
      for (const m of merges) for (const tag of normalizeTags(m.tags)) pairs.push({ itemId: m.id, tag });
      await linkTags(dbi, pairs);
    }
    await importItems(d1, inserts);
  }
  return { inserted: inserts.length, merged: merges.length, reads: readChanges };
}
