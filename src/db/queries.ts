// All D1 access lives here (plus src/lib/covers.ts for R2) — ARCH.md §13.
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';
import type { Item, ItemStatus, Library, Loan, MediaType, NewItem, User } from './schema';

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

export async function listUsers(d1: D1Database): Promise<User[]> {
  return db(d1).select().from(s.users).orderBy(asc(s.users.id));
}

export async function deleteUser(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.users).where(eq(s.users.id, id));
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

export async function setShareToken(d1: D1Database, id: number, token: string | null): Promise<void> {
  await db(d1).update(s.libraries).set({ shareToken: token }).where(eq(s.libraries.id, id));
}

export async function getLibraryByShareToken(d1: D1Database, token: string): Promise<Library | null> {
  if (!token) return null;
  const [l] = await db(d1).select().from(s.libraries).where(eq(s.libraries.shareToken, token));
  return l ?? null;
}

// ---------- items ----------

export const PAGE_SIZE = 60;

export type ItemFilters = {
  mediaType?: MediaType;
  status?: ItemStatus;
  sort?: 'added' | 'title' | 'rating';
  page?: number; // 1-based
};

export async function listItems(
  d1: D1Database,
  libraryId: number,
  f: ItemFilters = {},
): Promise<{ items: Item[]; total: number; page: number; pages: number }> {
  const dbi = db(d1);
  const conds: SQL[] = [eq(s.items.libraryId, libraryId)];
  if (f.mediaType) conds.push(eq(s.items.mediaType, f.mediaType));
  if (f.status) conds.push(eq(s.items.status, f.status));
  const where = and(...conds);

  const order =
    f.sort === 'title'
      ? [asc(s.items.title)]
      : f.sort === 'rating'
        ? [sql`${s.items.rating} IS NULL, ${s.items.rating} DESC`, asc(s.items.title)]
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

export async function createItem(d1: D1Database, values: NewItem): Promise<Item> {
  const [i] = await db(d1).insert(s.items).values(values).returning();
  if (!i) throw new Error('failed to create item');
  return i;
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

// ---------- tags ----------

export function normalizeTags(names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
}

export async function setItemTags(d1: D1Database, itemId: number, names: string[]): Promise<void> {
  const dbi = db(d1);
  const normalized = normalizeTags(names);
  await dbi.delete(s.itemTags).where(eq(s.itemTags.itemId, itemId));
  if (!normalized.length) return;
  await dbi.batch(
    normalized.map((name) => dbi.insert(s.tags).values({ name }).onConflictDoNothing()) as [never, ...never[]],
  );
  const tagRows = await dbi.select().from(s.tags).where(inArray(s.tags.name, normalized));
  if (tagRows.length) {
    await dbi
      .insert(s.itemTags)
      .values(tagRows.map((t) => ({ itemId, tagId: t.id })))
      .onConflictDoNothing();
  }
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

export async function tagsForItems(d1: D1Database, itemIds: number[]): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (!itemIds.length) return result;
  const rows = await db(d1)
    .select({ itemId: s.itemTags.itemId, name: s.tags.name })
    .from(s.itemTags)
    .innerJoin(s.tags, eq(s.itemTags.tagId, s.tags.id))
    .where(inArray(s.itemTags.itemId, itemIds));
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

export async function itemsByTag(d1: D1Database, name: string): Promise<Item[]> {
  return db(d1)
    .select({ item: s.items })
    .from(s.itemTags)
    .innerJoin(s.tags, eq(s.itemTags.tagId, s.tags.id))
    .innerJoin(s.items, eq(s.itemTags.itemId, s.items.id))
    .where(eq(s.tags.name, name.toLowerCase()))
    .orderBy(asc(s.items.title))
    .then((rows) => rows.map((r) => r.item));
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

export async function activeLoanForItem(d1: D1Database, itemId: number): Promise<Loan | null> {
  const [l] = await db(d1)
    .select()
    .from(s.loans)
    .where(and(eq(s.loans.itemId, itemId), isNull(s.loans.returnedOn)));
  return l ?? null;
}

export async function activeLoanItemIds(d1: D1Database, itemIds: number[]): Promise<Set<number>> {
  if (!itemIds.length) return new Set();
  const rows = await db(d1)
    .select({ itemId: s.loans.itemId })
    .from(s.loans)
    .where(and(inArray(s.loans.itemId, itemIds), isNull(s.loans.returnedOn)));
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

/** Stable id-ordered paging over items — used by the streaming CSV export. */
export async function pageItems(
  d1: D1Database,
  opts: { libraryId?: number; offset: number; limit: number },
): Promise<Item[]> {
  const dbi = db(d1);
  return dbi
    .select()
    .from(s.items)
    .where(opts.libraryId ? eq(s.items.libraryId, opts.libraryId) : undefined)
    .orderBy(asc(s.items.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

// ---------- cover backfill ----------

const backfillable = () =>
  and(isNull(s.items.coverKey), or(isNotNull(s.items.isbn13), isNotNull(s.items.isbn10Upc)));

/** Items that could get a cover: no cover yet, but an ISBN/UPC to look up. */
export async function countBackfillable(d1: D1Database): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.items).where(backfillable());
  return row?.n ?? 0;
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

/** Batched insert used by /api/import. One network round trip per batch of rows. */
export async function importItems(d1: D1Database, rows: Array<{ item: NewItem; tags: string[] }>): Promise<number> {
  if (!rows.length) return 0;
  const dbi = db(d1);
  const inserted = (await dbi.batch(
    rows.map((r) => dbi.insert(s.items).values(r.item).returning({ id: s.items.id })) as [never, ...never[]],
  )) as Array<Array<{ id: number }>>;

  const pairs: Array<{ itemId: number; tag: string }> = [];
  rows.forEach((r, i) => {
    const id = inserted[i]?.[0]?.id;
    if (!id) return;
    for (const tag of normalizeTags(r.tags)) pairs.push({ itemId: id, tag });
  });

  if (pairs.length) {
    const names = [...new Set(pairs.map((p) => p.tag))];
    await dbi.batch(
      names.map((name) => dbi.insert(s.tags).values({ name }).onConflictDoNothing()) as [never, ...never[]],
    );
    const tagRows = await dbi.select().from(s.tags).where(inArray(s.tags.name, names));
    const idByName = new Map(tagRows.map((t) => [t.name, t.id]));
    const links = pairs
      .map((p) => ({ itemId: p.itemId, tagId: idByName.get(p.tag) }))
      .filter((l): l is { itemId: number; tagId: number } => !!l.tagId);
    for (let i = 0; i < links.length; i += 40) {
      const chunk = links.slice(i, i + 40); // stay well under D1's bound-parameter limit
      await dbi.insert(s.itemTags).values(chunk).onConflictDoNothing();
    }
  }
  return rows.length;
}
