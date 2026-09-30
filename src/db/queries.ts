// All D1 access lives here (plus src/lib/covers.ts for R2) — ARCH.md §13.
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { newSessionKey } from '../lib/auth';
import {
  currentOrderSql,
  displayOrderSql,
  MAX_READS_PER_CELL,
  MAX_READS_PER_ITEM,
  oneOpenReadEach,
  readsFromColumns,
  reconcileGoodreads,
  statusOrderSql,
  summarizeReads,
  type GoodreadsReading,
  type PersonRead,
  type ReadDraft,
  type ReadRow,
} from '../lib/reads';
import { MAX_LINKS_PER_ITEM, type LinkDraft } from '../lib/links';
import { MAX_LOANS_PER_CELL, type LoanDraft } from '../lib/loans';
import { MAX_PLAYS_PER_ITEM, PLAYABLE_TYPES, RECENT_PLAYS, type CellPlay, type PersonPlay } from '../lib/plays';
import { reviewOrderSql, stampReviews, summarizeReviews, type PersonReview, type ReviewDraft } from '../lib/reviews';
import { seriesKey, type SeriesDraft } from '../lib/series';
import * as s from './schema';
import type { Item, ItemStatus, Library, Loan, MediaType, NewItem, ReadStatus, Series, Share, User } from './schema';

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
  // a key of its own, in the insert (§16 #56): its id may have been someone's before
  const [u] = await db(d1).insert(s.users).values({ ...values, sessionKey: newSessionKey() }).returning();
  if (!u) throw new Error('failed to create user');
  return u;
}

/**
 * First-run setup: the admin and the household's starter shelves, in one batch (ARCH.md §16 #39) — or nothing, once
 * anyone exists. Every statement carries the same guard, no user yet, decided inside it; the shelves come first, so
 * nothing in the batch touches users before the admin's insert. The batch is one transaction, so every statement sees
 * the same answer: two setups racing make one admin and one set of shelves. The admin's id and session key (§16 #56,
 * set in the same insert), or null when setup was already done.
 */
export async function createFirstAdmin(
  d1: D1Database,
  values: { username: string; passwordHash: string },
  shelves: readonly string[],
): Promise<{ id: number; sessionKey: string } | null> {
  const noUserYet = 'WHERE NOT EXISTS (SELECT 1 FROM users)';
  const results = await d1.batch([
    ...shelves.map((name) => d1.prepare(`INSERT INTO libraries (name) SELECT ?1 ${noUserYet}`).bind(name)),
    d1
      .prepare(
        `INSERT INTO users (username, password_hash, role, must_change_password, session_key)
         SELECT ?1, ?2, 'admin', 0, ?3 ${noUserYet} RETURNING id, session_key AS sessionKey`,
      )
      .bind(values.username, values.passwordHash, newSessionKey()),
  ]);
  return (results.at(-1)?.results[0] as { id: number; sessionKey: string } | undefined) ?? null;
}

/**
 * An account with no usable session key (§16 #56) — a row inserted by hand, or restored from a backup taken before
 * migration 0029, keeps the column's '' — gets a fresh one when its password signs in, so it can hold a session at
 * all. Only what isSessionKey() refuses is replaced (the same test, in SQL): of two logins racing, the second keeps the
 * first's. The account's id and key, or null if it's gone.
 */
export async function ensureSessionKey(d1: D1Database, id: number): Promise<{ id: number; sessionKey: string } | null> {
  const unusable = `length(session_key) NOT BETWEEN 22 AND 64 OR session_key GLOB '*[^A-Za-z0-9_-]*'`;
  const row = await d1
    .prepare(
      `UPDATE users SET session_key = CASE WHEN ${unusable} THEN ?2 ELSE session_key END
       WHERE id = ?1 RETURNING id, session_key AS sessionKey`,
    )
    .bind(id, newSessionKey())
    .first<{ id: number; sessionKey: string }>();
  return row ?? null;
}

export async function listUsers(d1: D1Database): Promise<User[]> {
  return db(d1).select().from(s.users).orderBy(asc(s.users.id));
}

/**
 * Sets a member's display name (§16 #45) — already normalized (normalizeDisplayName); null clears it. It shows only
 * where an admin has switched names on, and is never a login.
 */
export async function setDisplayName(d1: D1Database, id: number, displayName: string | null): Promise<void> {
  // their entries re-keyed first, only if the name really changes, then the name — one batch (§16 #39)
  await d1.batch([
    ...rekeyMemberActivity(d1, id, displayName),
    d1.prepare('UPDATE users SET display_name = ?2 WHERE id = ?1').bind(id, displayName),
  ]);
}

/**
 * The name a comment or a borrow request carries to a connection (§16 #45): the member's display name while names
 * are switched on for connections, else "A member". Never a username — those never leave the app.
 */
export async function outwardName(d1: D1Database, userId: number): Promise<string> {
  const row = await d1
    .prepare(
      `SELECT u.display_name AS name, coalesce((SELECT names_to_connections FROM site_settings WHERE id = 1), ?2) AS on_
       FROM users u WHERE u.id = ?1`,
    )
    .bind(userId, SITE_DEFAULTS.namesToConnections ? 1 : 0)
    .first<{ name: string | null; on_: number }>();
  return row?.on_ && row.name ? row.name : 'A member';
}

/**
 * Everyone's rating and review of an item, each with its writer's display name — null for a member who has none, or
 * was removed — the household's latest review first. For share pages and connections with names switched on (§16
 * #45): never a username.
 */
export async function namedReviews(
  d1: D1Database,
  itemId: number,
): Promise<Array<{ by: string | null; rating: number | null; review: string | null }>> {
  const rows = await d1
    .prepare(
      `SELECT u.display_name AS by, v.rating, v.review FROM reviews v LEFT JOIN users u ON u.id = v.user_id
       WHERE v.item_id = ?1 ORDER BY ${reviewOrderSql('v')}`,
    )
    .bind(itemId)
    .all<{ by: string | null; rating: number | null; review: string | null }>();
  // a rating of 0 isn't one (as the household's triggers hold), and a review with neither isn't shown
  return rows.results
    .map((r) => ({ by: r.by || null, rating: r.rating && r.rating > 0 ? r.rating : null, review: r.review }))
    .filter((r) => r.rating !== null || r.review !== null);
}

/** Every member's id and name, and no more — what a page needs to say whose read or review something is (§16 #43). */
export async function listPeople(d1: D1Database): Promise<Array<{ id: number; username: string }>> {
  return db(d1).select({ id: s.users.id, username: s.users.username }).from(s.users).orderBy(asc(s.users.username), asc(s.users.id));
}

/** Every column of a member_activity row but its id: what re-keying copies, so an entry keeps all it said (§16 #49). */
const MEMBER_ACTIVITY_COLUMNS = 'item_id, kind, at, read_id, review_id, progress_id, goal_id, goal_target, goal_count';

/**
 * A member's per-person feed entries (§16 #45) given new ids — the same entries, dated as before — so a connection
 * holding the old ones learns from the removal check that they're gone and pulls the new ones: a rename, or a member
 * removed (then unnamed), reaches what connections already hold, not only what they pull next. INSERT OR REPLACE re-keys a read's or a review's entries in place (their unique
 * index); a page's entries are copied, then the older copy goes. Their goal entries too (§16 #49): a goal is only ever
 * shared under a display name, so a name set, changed or cleared re-keys them — withdrawn, then pulled again or not.
 */
function rekeyMemberActivity(d1: D1Database, userId: number, newName?: string | null): D1PreparedStatement[] {
  // with a new name: only when it differs from the one stored — nothing to re-key for a form saved unchanged
  const guard = newName === undefined ? '1' : '(SELECT display_name FROM users WHERE id = ?1) IS NOT ?2';
  const theirs = `(read_id IN (SELECT id FROM reads WHERE reader_id = ?1)
    OR review_id IN (SELECT id FROM reviews WHERE user_id = ?1)
    OR progress_id IN (SELECT p.id FROM reading_progress p JOIN reads r ON r.id = p.read_id WHERE r.reader_id = ?1)
    OR goal_id IN (SELECT id FROM reading_goals WHERE user_id = ?1))`;
  return [
    d1
      .prepare(
        `INSERT OR REPLACE INTO member_activity (${MEMBER_ACTIVITY_COLUMNS})
         SELECT ${MEMBER_ACTIVITY_COLUMNS} FROM member_activity WHERE ${theirs} AND ${guard} ORDER BY id`,
      )
      .bind(...(newName === undefined ? [userId] : [userId, newName])),
    d1
      .prepare(
        `DELETE FROM member_activity WHERE kind = 'progress' AND ${theirs}
           AND EXISTS (SELECT 1 FROM member_activity n WHERE n.progress_id = member_activity.progress_id AND n.id > member_activity.id)`,
      )
      .bind(userId),
  ];
}

/**
 * One read's or one review's per-person entries (§16 #45) given new ids, dated as before, when an admin moves it to
 * another member: a connection holding them under the old name learns from the removal check that they're gone and
 * pulls them again under the new one. Only that read or review — the rest of both members' entries still say who did
 * them. Goes straight after the move's UPDATE in its batch: `changes()` is that statement's, so a move refused (or to
 * the member it already belongs to) re-keys nothing. A read's pages go with it: copied, then the older copy goes. A
 * goal milestone the read crossed stays as it is: it is the goal's member's news, and signed with their name (§16 #49).
 */
function rekeyMoved(d1: D1Database, moved: { readId: number } | { reviewId: number }): D1PreparedStatement[] {
  if ('reviewId' in moved) {
    return [
      d1
        .prepare(
          `INSERT OR REPLACE INTO member_activity (${MEMBER_ACTIVITY_COLUMNS})
           SELECT ${MEMBER_ACTIVITY_COLUMNS} FROM member_activity WHERE review_id = ?1 AND goal_id IS NULL AND changes() > 0 ORDER BY id`,
        )
        .bind(moved.reviewId),
    ];
  }
  const its = `(read_id = ?1 OR progress_id IN (SELECT id FROM reading_progress WHERE read_id = ?1)) AND goal_id IS NULL`;
  return [
    d1
      .prepare(
        `INSERT OR REPLACE INTO member_activity (${MEMBER_ACTIVITY_COLUMNS})
         SELECT ${MEMBER_ACTIVITY_COLUMNS} FROM member_activity WHERE ${its} AND changes() > 0 ORDER BY id`,
      )
      .bind(moved.readId),
    d1
      .prepare(
        `DELETE FROM member_activity WHERE kind = 'progress' AND ${its}
           AND EXISTS (SELECT 1 FROM member_activity n WHERE n.progress_id = member_activity.progress_id AND n.id > member_activity.id)`,
      )
      .bind(moved.readId),
  ];
}

export async function deleteUser(d1: D1Database, id: number): Promise<void> {
  // Three references to users have no ON DELETE action (migrations 0000, 0012 and 0024, all applied — drizzle-kit
  // drops the clause on ALTER TABLE): items.added_by, reading_progress.added_by and reads.reader_id. Any of them
  // would stop a member being removed, so all are cleared in the same batch, and reviews.user_id too, which its
  // table would set null on its own. Their items, reads, pages and reviews stay, unattributed (§16 #43): the
  // household's summary on each item — status, read count, average rating — is everyone's, theirs included, so it
  // doesn't change.
  await d1.batch([
    // first, while their reads still say whose: their named entries get new ids, so connections drop the named copies
    ...rekeyMemberActivity(d1, id),
    d1.prepare('UPDATE items SET added_by = NULL WHERE added_by = ?1').bind(id),
    d1.prepare('UPDATE reading_progress SET added_by = NULL WHERE added_by = ?1').bind(id),
    d1.prepare('UPDATE reads SET reader_id = NULL WHERE reader_id = ?1').bind(id),
    d1.prepare('UPDATE reviews SET user_id = NULL WHERE user_id = ?1').bind(id),
    // their plays are the household's and stay; only who logged them goes (its table would set null on its own too)
    d1.prepare('UPDATE plays SET logged_by = NULL WHERE logged_by = ?1').bind(id),
    // Their want list goes with them, and every gift list published of it (§16 #53): a want is a wish for later, not
    // history, and nobody's wish is nothing to keep — a link to it must not outlive them. shares.want_user_id has no
    // ON DELETE action (drizzle-kit drops it on ALTER TABLE), so it is cleared here, before the user row; wants would
    // go with it by cascade, and are cleared here too, so the batch says everything that leaves with them.
    d1.prepare('DELETE FROM shares WHERE want_user_id = ?1').bind(id),
    d1.prepare('DELETE FROM wants WHERE user_id = ?1').bind(id),
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
  // items cascade, and so may the shelf's connection views: with none left, both activity logs go, as they do when the
  // last view is removed on the Connections page (deleteConnectionView), so a stale log can't outlive every view
  await d1.batch([
    d1.prepare('DELETE FROM libraries WHERE id = ?1').bind(id),
    d1.prepare('DELETE FROM activity_log WHERE NOT EXISTS (SELECT 1 FROM connection_views)'),
    d1.prepare('DELETE FROM member_activity WHERE NOT EXISTS (SELECT 1 FROM connection_views)'),
    pruneSeries(d1), // a series whose volumes were all on this shelf
  ]);
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
  wantUserId?: number | null; // a gift list: this member's want list (§16 #53)
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

/** The gift lists published of one member's want list (§16 #53). */
export async function listWantShares(d1: D1Database, userId: number): Promise<Share[]> {
  return db(d1).select().from(s.shares).where(eq(s.shares.wantUserId, userId)).orderBy(asc(s.shares.id));
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
  q?: string; // title/creators/location substring, case-insensitive — the signed-in shelf's only, never a view's
  tag?: string; // only items carrying this tag (tags are stored lowercase)
  // only items on this member's want list (§16 #53) — what a gift list captures, and the want-list page shows
  wantedBy?: number;
  // 'wanted': newest on the want list first — only with wantedBy
  sort?: 'added' | 'title' | 'rating' | 'completed' | 'wanted';
  page?: number; // 1-based
};

/**
 * Who has read an item, for the shelf's "Read by" filter (ARCH.md §16 #43): finished by someone (`finished`), not
 * finished by them (`unfinished`), or being read by them now (`reading`). `readerId` null means anyone in the
 * household. Deliberately not part of ItemFilters: those are what a share link or a connection view captures, and
 * who read what must never be published — shareFilters() can't carry this because the type has no room for it.
 */
export type ReaderFilter = { readerId: number | null; mode: 'finished' | 'unfinished' | 'reading' };

function readerFilterWhere(r: ReaderFilter): SQL {
  const status = r.mode === 'reading' ? 'in_progress' : 'completed';
  const exists = sql`EXISTS (SELECT 1 FROM ${s.reads} WHERE ${s.reads.itemId} = ${s.items.id} AND ${s.reads.status} = ${status}${
    r.readerId === null ? sql`` : sql` AND ${s.reads.readerId} = ${r.readerId}`
  })`;
  return r.mode === 'unfinished' ? sql`NOT ${exists}` : exists;
}

/** The WHERE behind both listItems and countMatchingItems — one definition, so a
 *  count can never disagree with the list it is counting. */
function itemFilterWhere(libraryId: number | null, f: ItemFilters, reader?: ReaderFilter): SQL | undefined {
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
  if (f.wantedBy !== undefined) {
    conds.push(sql`EXISTS (SELECT 1 FROM ${s.wants} WHERE ${s.wants.itemId} = ${s.items.id} AND ${s.wants.userId} = ${f.wantedBy})`);
  }
  if (f.q) {
    const needle = `%${f.q.replace(/[%_\\]/g, '\\$&')}%`;
    // location is private (§16 #51) and matches here only because no share or connection view captures `q`
    // (shareFilters, shelfPage): a published view filtered by it would reveal where things are kept
    conds.push(
      sql`(${s.items.title} LIKE ${needle} ESCAPE '\\' OR ${s.items.creators} LIKE ${needle} ESCAPE '\\' OR ${s.items.location} LIKE ${needle} ESCAPE '\\')`,
    );
  }
  if (reader) conds.push(readerFilterWhere(reader));
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
  reader?: ReaderFilter, // the signed-in shelf's "Read by" — never a share's (see ReaderFilter)
): Promise<{ items: Item[]; total: number; page: number; pages: number }> {
  const dbi = db(d1);
  const where = itemFilterWhere(libraryId, f, reader);

  const order =
    f.sort === 'wanted' && f.wantedBy !== undefined
      ? [
          sql`(SELECT ${s.wants.createdAt} FROM ${s.wants} WHERE ${s.wants.itemId} = ${s.items.id} AND ${s.wants.userId} = ${f.wantedBy}) DESC`,
          desc(s.items.id),
        ]
      : f.sort === 'title'
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
 * An item and the reads its status and dates stand for (readsFromColumns), and the review its rating and review
 * stand for, in one batch — both its adder's (added_by; nobody's when it has none). The app adds items through
 * createItemWithTags and the imports; tests seed through this, so what they seed is shaped as the app would have
 * made it.
 */
export async function createItem(d1: D1Database, values: NewItem): Promise<Item> {
  const reads = readsFromColumns(values.status ?? 'not_started', values.beganOn, values.completedOn);
  const reviews = stampReviews(reviewsFromColumns(values));
  const q = db(d1).insert(s.items).values(withReviewState(withReadState(values, reads), reviews)).returning({ id: s.items.id }).toSQL();
  const [created] = await d1.batch([
    d1.prepare(q.sql).bind(...q.params),
    ...readInsertStatements(d1, 'newest', reads, values.addedBy ?? null),
    refreshReadState(d1, 'newest'),
    ...reviewInsertStatements(d1, 'newest', reviews, values.addedBy ?? null),
    refreshReviewState(d1, 'newest'),
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

/**
 * Writes what "Refresh from Discogs" filled in (§16 #55) — only if the fields it read are still as it read them.
 * The Discogs request between the read and this write takes a moment; an edit saved meanwhile would otherwise be
 * replaced wholesale by a `details` built from the older copy. False when something changed: nothing is written.
 */
export async function applyPressingFill(
  d1: D1Database,
  id: number,
  before: Pick<Item, 'details' | 'publisher' | 'published' | 'length'>,
  after: Pick<Item, 'details' | 'publisher' | 'published' | 'length'>,
): Promise<boolean> {
  const res = await d1
    .prepare(
      `UPDATE items SET details = ?1, publisher = ?2, published = ?3, length = ?4, updated_at = datetime('now')
       WHERE id = ?5 AND details = ?6 AND publisher IS ?7 AND published IS ?8 AND length IS ?9`,
    )
    .bind(after.details, after.publisher, after.published, after.length, id, before.details, before.publisher, before.published, before.length)
    .run();
  return res.meta.changes > 0;
}

/** Deletes an item, and its series with it if it was the series' last volume here (§16 #52). */
export async function deleteItem(d1: D1Database, id: number): Promise<void> {
  await d1.batch([d1.prepare('DELETE FROM items WHERE id = ?1').bind(id), pruneSeries(d1)]);
}

export async function recentItems(d1: D1Database, limit = 12): Promise<Item[]> {
  return db(d1).select().from(s.items).orderBy(desc(s.items.addedAt), desc(s.items.id)).limit(limit);
}

/** What the Overview's "Read next" card shows of its pick. */
export type ReadNextPick = Pick<Item, 'id' | 'title' | 'creators' | 'coverKey' | 'copies' | 'mediaType'> & { wanted: boolean };

/**
 * A random book for `readerId` to read next, or null when there is none: any book, owned or not, that they haven't
 * finished and aren't reading now — their own reads only, so someone else's finish or open read doesn't take a book
 * out, and a read they stopped doesn't either. `notId` (the pick just shown) sorts last, so "Another" never shows it
 * again while any other book qualifies, and still shows it when it's the only one. One call; the pool is filtered by
 * the reads index, and `LIMIT 1` keeps SQLite's sort to a single row.
 */
export async function pickNextRead(d1: D1Database, readerId: number, notId: number | null = null): Promise<ReadNextPick | null> {
  const [pick] = await db(d1)
    .select({
      id: s.items.id,
      title: s.items.title,
      creators: s.items.creators,
      coverKey: s.items.coverKey,
      copies: s.items.copies,
      mediaType: s.items.mediaType,
      // the "Wanted" badge beside "Not owned" (§16 #53), in the same query
      wanted: sql`${s.items.copies} = 0 AND EXISTS (SELECT 1 FROM ${s.wants} WHERE ${s.wants.itemId} = ${s.items.id})`.mapWith(Boolean),
    })
    .from(s.items)
    .where(
      and(
        eq(s.items.mediaType, 'book'),
        sql`NOT EXISTS (SELECT 1 FROM ${s.reads} WHERE ${s.reads.itemId} = ${s.items.id} AND ${s.reads.readerId} = ${readerId} AND ${s.reads.status} IN ('completed', 'in_progress'))`,
      ),
    )
    .orderBy(...(notId === null ? [] : [sql`${s.items.id} = ${notId}`]), sql`random()`)
    .limit(1);
  return pick ?? null;
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

// ---------- series (ARCH.md §16 #52) ----------

/**
 * The statement that makes sure `draft`'s series exists — the first spelling of a name stays, since the name is
 * unique by its key — and sets its total when the draft carries one. None without a series.
 */
function seriesUpsert(d1: D1Database, draft: SeriesDraft | null | undefined): D1PreparedStatement[] {
  if (!draft) return [];
  return [
    d1
      .prepare(
        'INSERT INTO series (name, key, total) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET total = coalesce(excluded.total, series.total)',
      )
      .bind(draft.name, seriesKey(draft.name), draft.total ?? null),
  ];
}

/** An item's values with its series: the id is looked up by key inside the item's own statement, so it rides one batch. */
function withSeries<T extends Partial<NewItem>>(values: T, draft: SeriesDraft | null | undefined): T {
  return {
    ...values,
    seriesId: draft ? sql`(SELECT id FROM series WHERE key = ${seriesKey(draft.name)})` : null,
    seriesNumber: draft ? draft.number : null,
  };
}

/**
 * Deletes every series no item belongs to any more: the one an item just left, or whose last volume went. Its total
 * goes with it. items.series_id has no ON DELETE (§16 #35), so a series is only ever deleted once nothing points at it.
 */
function pruneSeries(d1: D1Database): D1PreparedStatement {
  return d1.prepare('DELETE FROM series WHERE NOT EXISTS (SELECT 1 FROM items WHERE items.series_id = series.id)');
}

export async function getSeries(d1: D1Database, id: number): Promise<Series | null> {
  const [row] = await db(d1).select().from(s.series).where(eq(s.series.id, id));
  return row ?? null;
}

/** A series' volume, with whether the signed-in member finished it or is reading it now — their own reads. */
export type SeriesVolumeRow = Item & { finishedByMe: boolean; readingByMe: boolean };

/** A series and every volume in it, with the viewer's own reading of each: one D1 call. Null when there's no such series. */
export async function seriesWithVolumes(
  d1: D1Database,
  id: number,
  viewer: number,
): Promise<{ series: Series; volumes: SeriesVolumeRow[] } | null> {
  const dbi = db(d1);
  // Written out, not interpolated: in a select list Drizzle leaves columns unqualified, and "item_id" = "id" inside
  // the subquery would compare the read with itself. Aliased, because a batch returns rows keyed by column name, and
  // the two subqueries' text is the same but for their parameters — one would overwrite the other.
  const mine = (status: 'completed' | 'in_progress') =>
    sql<number>`EXISTS (SELECT 1 FROM reads r WHERE r.item_id = "items"."id" AND r.reader_id = ${viewer} AND r.status = ${status})`.as(
      status === 'completed' ? 'finished_by_me' : 'reading_by_me',
    );
  const [found, rows] = await dbi.batch([
    dbi.select().from(s.series).where(eq(s.series.id, id)),
    dbi
      .select({ item: s.items, finished: mine('completed'), reading: mine('in_progress') })
      .from(s.items)
      .where(eq(s.items.seriesId, id)),
  ]);
  const series = found[0];
  if (!series) return null;
  return { series, volumes: rows.map((r) => ({ ...r.item, finishedByMe: !!r.finished, readingByMe: !!r.reading })) };
}

export type SeriesSummary = { id: number; name: string; total: number | null; volumes: number; numbers: Array<number | null> };

/** Every series the catalog holds a volume of, by name, with the numbers it holds: one query. */
export async function listSeries(d1: D1Database): Promise<SeriesSummary[]> {
  const rows = await db(d1)
    .select({
      id: s.series.id,
      name: s.series.name,
      total: s.series.total,
      volumes: count(s.items.id),
      // a volume without a number is an empty entry, so every volume is in the list: "3,,5"
      numbers: sql<string>`group_concat(coalesce(${s.items.seriesNumber}, ''))`,
    })
    .from(s.series)
    .innerJoin(s.items, eq(s.items.seriesId, s.series.id))
    .groupBy(s.series.id)
    .orderBy(asc(s.series.key));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    total: r.total,
    volumes: r.volumes,
    numbers: String(r.numbers ?? '')
      .split(',')
      .map((n) => (n === '' ? null : Number(n))),
  }));
}

/** Every series' name, for the edit form's suggestions. */
export async function seriesNames(d1: D1Database): Promise<string[]> {
  const rows = await db(d1).select({ name: s.series.name }).from(s.series).orderBy(asc(s.series.key)).limit(1000);
  return rows.map((r) => r.name);
}

/** The series these ids name — the export's one extra query a page (one JSON parameter, however many ids). */
export async function seriesForIds(d1: D1Database, ids: Array<number | null>): Promise<Map<number, Series>> {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
  if (!wanted.length) return new Map();
  const rows = await db(d1)
    .select()
    .from(s.series)
    .where(sql`${s.series.id} IN (SELECT value FROM json_each(${JSON.stringify(wanted)}))`);
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Renames a series and sets its total, in one batch. A name another series already has (by key) merges this one
 * into it: its volumes move there, and the total given — else the one there, else this one's — is kept. Returns
 * the id the series has afterwards. The route checks the series exists first.
 */
export async function updateSeries(d1: D1Database, id: number, name: string, total: number | null): Promise<number | null> {
  const key = seriesKey(name);
  const other = 'EXISTS (SELECT 1 FROM series WHERE key = ?2 AND id <> ?1)';
  const results = await d1.batch([
    d1
      .prepare('UPDATE series SET total = coalesce(?3, total, (SELECT total FROM series WHERE id = ?1)) WHERE key = ?2 AND id <> ?1')
      .bind(id, key, total),
    d1.prepare(`UPDATE items SET series_id = (SELECT id FROM series WHERE key = ?2) WHERE series_id = ?1 AND ${other}`).bind(id, key),
    d1.prepare(`DELETE FROM series WHERE id = ?1 AND ${other}`).bind(id, key),
    d1.prepare('UPDATE series SET name = ?3, key = ?2, total = ?4 WHERE id = ?1').bind(id, key, name, total),
    d1.prepare('SELECT id FROM series WHERE key = ?1').bind(key),
  ]);
  const row = results[4]?.results[0] as { id: number } | undefined;
  return row?.id ?? null;
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
 * A new item, its tags, and the read and review the form's status, dates, rating and review stand for — the adder's
 * (§16 #43) — in one batch: a failure between them saved it without them, and the person's second try saved it
 * twice. `wantedBy`: "Want it" on a scan or search result (§16 #53) — the item joins that member's want list in the
 * same batch. Returns its id.
 */
export async function createItemWithTags(
  d1: D1Database,
  values: NewItem,
  names: string[],
  series: SeriesDraft | null = null,
  opts: { wantedBy?: number } = {},
): Promise<number> {
  const reads = readsFromColumns(values.status ?? 'not_started', values.beganOn, values.completedOn);
  const reviews = stampReviews(reviewsFromColumns(values));
  const q = db(d1)
    .insert(s.items)
    .values(withSeries(withReviewState(withReadState(values, reads), reviews), series))
    .returning({ id: s.items.id })
    .toSQL();
  const upsert = seriesUpsert(d1, series);
  const results = await d1.batch([
    ...upsert,
    d1.prepare(q.sql).bind(...q.params),
    ...tagLinkStatements(d1, 'newest', names),
    ...readInsertStatements(d1, 'newest', reads, values.addedBy ?? null),
    refreshReadState(d1, 'newest'),
    ...reviewInsertStatements(d1, 'newest', reviews, values.addedBy ?? null),
    refreshReviewState(d1, 'newest'),
    ...(opts.wantedBy !== undefined ? wantInsertStatements(d1, 'newest', [{ userId: opts.wantedBy, at: null }]) : []),
  ]);
  const row = results[upsert.length]?.results[0] as { id: number } | undefined;
  if (!row) throw new Error('failed to create item');
  return row.id;
}

/**
 * What the edit form says about its person's reading (§16 #43): it describes that person's read that decides their
 * status. `clearReads` is "Not started" for an item with no Reading section to delete reads from — a record, a board
 * game — whose reads of theirs then go (the route allows it only there).
 */
export type FormRead = { status: ItemStatus; beganOn: string | null; completedOn: string | null; clearReads?: boolean };

/** What the edit form says about its person's rating and review. Both empty means they have none. */
export type FormReview = { rating: number | null; review: string | null };

/**
 * An edit, the item's new tags, and what the form says about its person's reading and review, in one batch, so a
 * failure can't save one without the others. The form's status and dates edit that person's read that decides their
 * status — their last finished one, or their open one, or their last stopped one — or make their first read; its
 * rating and review are theirs. items.status, rating and their neighbours are then recomputed from everyone's reads
 * and reviews, never written from the form. "Not started" writes no read: the route refuses it for a book with
 * reads. `person` is who is editing: the reads and review are theirs whoever else has any.
 */
export async function updateItemWithTags(
  d1: D1Database,
  id: number,
  values: Partial<NewItem>,
  names: string[],
  formRead?: FormRead,
  person: number | null = null,
  formReview?: FormReview,
  series?: SeriesDraft | null, // undefined leaves the item's series as it is; null takes it out of one (§16 #52)
): Promise<void> {
  // reading state and the rating and review come from reads and reviews alone; the series only from `series`
  const {
    status: _s,
    beganOn: _b,
    completedOn: _c,
    readCount: _n,
    rereading: _r,
    progressPage: _p,
    rating: _g,
    review: _v,
    seriesId: _i,
    seriesNumber: _k,
    ...rest
  } = values;
  const q = db(d1)
    .update(s.items)
    .set({ ...(series === undefined ? rest : withSeries(rest, series)), updatedAt: sql`(datetime('now'))` })
    .where(eq(s.items.id, id))
    .toSQL();
  await d1.batch([
    ...seriesUpsert(d1, series),
    d1.prepare(q.sql).bind(...q.params),
    // the series it left, if this was that series' last volume
    ...(series === undefined ? [] : [pruneSeries(d1)]),
    d1.prepare('DELETE FROM item_tags WHERE item_id = ?1').bind(id),
    ...tagLinkStatements(d1, id, names),
    ...(formRead ? formReadStatements(d1, id, person, formRead) : []),
    refreshReadState(d1, [id]),
    // reads first, as everywhere: a rating given with a finish is dated by it inside an import (§16 #40)
    ...(formReview ? reviewWriteStatements(d1, id, person, formReview, 'replace') : []),
    refreshReviewState(d1, [id]),
    redateReviewActivity(d1, [id]),
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

// ---------- bulk edit (ARCH.md §16 #47) ----------
//
// One action on a selection of items: add or remove a tag, move to a shelf, mark owned or not owned, delete. Each is
// one batch (§16 #39) — the tally, any tag it creates, the links and the writes — so a failure anywhere leaves every
// item as it was. The ids travel as one JSON parameter however many there are, as refreshReadState's do.
//
// An item a bulk action changes is changed exactly as an edit of it alone would change it: updated_at stamped, and
// the FTS triggers re-index it on the same UPDATE. An item it doesn't change — tagged already, on that shelf
// already — is left alone, updated_at included. None of these touch reads or reviews, so no household summary moves;
// migration 0021's activity triggers watch review, rating, status and completed_on only, so a move or a re-tag
// records no news for connections. Deleting is the single delete's DELETE, over the selection: the same cascades
// and the same BEFORE DELETE triggers, row by row.

/** The most items one bulk action takes. A page of a shelf shows 60, so this binds only a hand-rolled request. */
export const BULK_MAX = 250;

export type BulkAction = 'tag-add' | 'tag-remove' | 'move' | 'owned' | 'not-owned' | 'delete';
export const BULK_ACTIONS: readonly BulkAction[] = ['tag-add', 'tag-remove', 'move', 'owned', 'not-owned', 'delete'];

/**
 * What a bulk action did: `found` of the selection still exist; `changed` were changed; `same` already were as asked
 * (tagged already, on that shelf already); `skipped` were refused — only owned / not owned, for an item held in two or
 * more copies (§16 #27). `covers` are the deleted items' cover keys, for the caller to remove from R2 once the batch
 * has succeeded.
 */
export type BulkResult = { found: number; changed: number; same: number; skipped: number; covers: string[] };

const SELECTED = 'id IN (SELECT value FROM json_each(?1))';

type Tally = { found: number; changed: number | null; skipped?: number | null };
function tallied(t: Tally | undefined, covers: string[] = []): BulkResult {
  const found = t?.found ?? 0;
  const changed = t?.changed ?? 0;
  const skipped = t?.skipped ?? 0;
  return { found, changed, same: found - changed - skipped, skipped, covers };
}

/** Adds each of `names` (normalized, as every tag write) to every selected item that lacks it, in one batch. */
export async function bulkAddTags(d1: D1Database, ids: number[], names: string[]): Promise<BulkResult> {
  const json = JSON.stringify(ids);
  const tags = JSON.stringify(normalizeTags(names));
  const lacks = `EXISTS (SELECT 1 FROM json_each(?2) n WHERE NOT EXISTS (
    SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = items.id AND t.name = n.value))`;
  const [tally] = await d1.batch([
    d1.prepare(`SELECT count(*) AS found, sum(${lacks}) AS changed FROM items WHERE ${SELECTED}`).bind(json, tags),
    // a tag is created only for an item that will carry it: a selection of nothing adds no tag
    d1
      .prepare(
        `INSERT INTO tags (name) SELECT value FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM items WHERE ${SELECTED})
         ON CONFLICT (name) DO NOTHING`,
      )
      .bind(json, tags),
    // stamped before the links go in, while "lacks" still tells the changed items from the rest
    d1.prepare(`UPDATE items SET updated_at = datetime('now') WHERE ${SELECTED} AND ${lacks}`).bind(json, tags),
    d1
      .prepare(
        `INSERT INTO item_tags (item_id, tag_id)
         SELECT items.id, tags.id FROM items JOIN tags ON tags.name IN (SELECT value FROM json_each(?2))
         WHERE items.${SELECTED} ON CONFLICT DO NOTHING`,
      )
      .bind(json, tags),
  ]);
  return tallied(tally?.results[0] as Tally | undefined);
}

/** Takes each of `names` off every selected item carrying it, in one batch. The tag itself stays, as an edit leaves it. */
export async function bulkRemoveTags(d1: D1Database, ids: number[], names: string[]): Promise<BulkResult> {
  const json = JSON.stringify(ids);
  const tags = JSON.stringify(normalizeTags(names));
  const has = `EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
    WHERE it.item_id = items.id AND t.name IN (SELECT value FROM json_each(?2)))`;
  const [tally] = await d1.batch([
    d1.prepare(`SELECT count(*) AS found, sum(${has}) AS changed FROM items WHERE ${SELECTED}`).bind(json, tags),
    d1.prepare(`UPDATE items SET updated_at = datetime('now') WHERE ${SELECTED} AND ${has}`).bind(json, tags),
    d1
      .prepare(
        `DELETE FROM item_tags WHERE item_id IN (SELECT value FROM json_each(?1))
         AND tag_id IN (SELECT id FROM tags WHERE name IN (SELECT value FROM json_each(?2)))`,
      )
      .bind(json, tags),
  ]);
  return tallied(tally?.results[0] as Tally | undefined);
}

/**
 * Moves every selected item not already there to shelf `libraryId`, in one batch — nothing at all if the shelf is gone
 * by then. Only library_id and updated_at change, so no activity is recorded: a view the items move into serves their
 * existing entries under their old ids, below every follower's cursor, and one they leave withdraws them at the next
 * removal check — as moving each on its edit form would.
 */
export async function bulkMove(d1: D1Database, ids: number[], libraryId: number): Promise<BulkResult> {
  const json = JSON.stringify(ids);
  const moves = `library_id <> ?2 AND EXISTS (SELECT 1 FROM libraries WHERE id = ?2)`;
  const [tally] = await d1.batch([
    d1.prepare(`SELECT count(*) AS found, sum(${moves}) AS changed FROM items WHERE ${SELECTED}`).bind(json, libraryId),
    d1.prepare(`UPDATE items SET library_id = ?2, updated_at = datetime('now') WHERE ${SELECTED} AND ${moves}`).bind(json, libraryId),
  ]);
  return tallied(tally?.results[0] as Tally | undefined);
}

/**
 * Owned sets copies to 1 on every selected item with 0; not owned, to 0 on every one with 1 — the Holding toggle's
 * two moves (§16 #27), in one batch. An item held in two or more copies is skipped either way: the toggle only lands
 * on 0 or 1, and zeroing or flattening a real count would lose a number that round-trips through /export.csv.
 */
export async function bulkSetOwned(d1: D1Database, ids: number[], owned: boolean): Promise<BulkResult> {
  const json = JSON.stringify(ids);
  const [from, to] = owned ? [0, 1] : [1, 0];
  const [tally] = await d1.batch([
    d1
      .prepare(`SELECT count(*) AS found, sum(copies = ?2) AS changed, sum(copies >= 2) AS skipped FROM items WHERE ${SELECTED}`)
      .bind(json, from),
    d1.prepare(`UPDATE items SET copies = ?3, updated_at = datetime('now') WHERE ${SELECTED} AND copies = ?2`).bind(json, from, to),
  ]);
  return tallied(tally?.results[0] as Tally | undefined);
}

/**
 * Deletes every selected item, in one batch: the single delete's DELETE, over a list. Cascades take its tags' links,
 * reads, pages, reviews, loans, activity and comments; the FTS trigger drops it from search; migration 0010's BEFORE
 * DELETE triggers tell a connection that a book lent to it is returned and that a request waiting on it is declined,
 * row by row, as N single deletes would. Returns the cover keys to remove once this has succeeded.
 */
export async function bulkDelete(d1: D1Database, ids: number[]): Promise<BulkResult> {
  const json = JSON.stringify(ids);
  const [found] = await d1.batch([
    d1.prepare(`SELECT id, cover_key AS coverKey FROM items WHERE ${SELECTED}`).bind(json),
    d1.prepare(`DELETE FROM items WHERE ${SELECTED}`).bind(json),
    pruneSeries(d1), // a series whose last volumes were among them goes too (§16 #52), as with a single delete
  ]);
  const rows = (found?.results ?? []) as Array<{ id: number; coverKey: string | null }>;
  const covers = rows.map((r) => r.coverKey).filter((k): k is string => !!k);
  return { found: rows.length, changed: rows.length, same: 0, skipped: 0, covers };
}

/** The selection as a delete's confirmation names it: which still exist, and their titles, in the order they were picked. */
export async function itemsForConfirmation(d1: D1Database, ids: number[]): Promise<Array<{ id: number; title: string }>> {
  if (!ids.length) return [];
  const rows = await d1
    .prepare(`SELECT id, title FROM items WHERE ${SELECTED}`)
    .bind(JSON.stringify(ids))
    .all<{ id: number; title: string }>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is { id: number; title: string } => !!r);
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

/** How many past loans an item's page lists; older ones are counted, not shown. */
export const LENDING_HISTORY_LIMIT = 20;

/**
 * One returned loan, as the item page's "Lent before" lists it. A loan made to a connected household is an
 * ordinary loan linked through connection_loans (lendToConnection), so its return is kept here too; `household`
 * and `member` name them while that link, the connection and the request it answered still exist. Removing a
 * connection drops the link, and the loan keeps the borrower it was lent under — "member (household)".
 */
export type PastLoan = {
  id: number;
  borrower: string;
  loanedOn: string;
  returnedOn: string;
  household: string | null;
  member: string | null;
};

/**
 * An item's returned loans, newest first, at most `limit` of them, and how many there are in all. Loans still
 * out aren't here: the Circulation box shows those. One query however long the history, the total counted by a
 * window over the whole match before the limit applies. In-app only — loans and borrowers never reach share
 * pages or connections.
 */
export async function pastLoansForItem(
  d1: D1Database,
  itemId: number,
  limit = LENDING_HISTORY_LIMIT,
): Promise<{ loans: PastLoan[]; total: number }> {
  const { results } = await d1
    .prepare(
      `SELECT l.id, l.borrower, l.loaned_on, l.returned_on, c.household_name, br.requester_name,
              count(*) OVER () AS total
       FROM loans l
       LEFT JOIN connection_loans cl ON cl.loan_id = l.id
       LEFT JOIN connections c ON c.id = cl.connection_id
       LEFT JOIN borrow_requests br ON br.id = cl.request_id
       WHERE l.item_id = ?1 AND l.returned_on IS NOT NULL
       ORDER BY l.loaned_on DESC, l.id DESC
       LIMIT ?2`,
    )
    .bind(itemId, limit)
    .all<{
      id: number;
      borrower: string;
      loaned_on: string;
      returned_on: string;
      household_name: string | null;
      requester_name: string | null;
      total: number;
    }>();
  return {
    loans: results.map((r) => ({
      id: r.id,
      borrower: r.borrower,
      loanedOn: r.loaned_on,
      returnedOn: r.returned_on,
      household: r.household_name,
      member: r.requester_name,
    })),
    total: results[0]?.total ?? 0,
  };
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

/**
 * Every loan, open and returned, of every item whose id lies in [fromId, toId], each item's in the order they were
 * made — the export's `loans` cell (§16 #57). One query a page, as tagsForIdRange. A loan made to a connected
 * household is an ordinary loan with the borrower it was lent under; the link to that household stays behind.
 * With `limit`, at most that many rows: `cutAt` is then the item the last row belongs to, whose loans may be
 * incomplete, while every item before it has all of its own; null when nothing was cut.
 */
export async function loansForIdRange(
  d1: D1Database,
  fromId: number,
  toId: number,
  libraryId?: number,
  limit?: number,
): Promise<{ loans: Map<number, LoanDraft[]>; cutAt: number | null }> {
  const rows = (await loansRangeStatement(d1, fromId, toId, libraryId, limit).all<LoanDraft & { itemId: number }>()).results;
  return groupLoans(rows, limit);
}

/** loansForIdRange's statement — shared with exportCellsForIdRange, so the page cap can't drift between them. */
function loansRangeStatement(d1: D1Database, fromId: number, toId: number, libraryId?: number, limit?: number): D1PreparedStatement {
  const scoped = libraryId ? 'AND l.item_id IN (SELECT id FROM items WHERE library_id = ?3)' : '';
  return d1
    .prepare(
      `SELECT l.item_id AS itemId, l.borrower, l.loaned_on AS loanedOn, l.due_on AS dueOn, l.returned_on AS returnedOn,
              l.contact, l.note
       FROM loans l
       WHERE l.item_id BETWEEN ?1 AND ?2 ${scoped}
       ORDER BY l.item_id, l.id
       LIMIT ?4`,
    )
    .bind(fromId, toId, libraryId ?? null, limit ?? -1);
}

/** Loan rows by item, and where a `limit` cut them off: the item the last row read belongs to, which may be missing some. */
function groupLoans(rows: Array<LoanDraft & { itemId: number }>, limit?: number): { loans: Map<number, LoanDraft[]>; cutAt: number | null } {
  const loans = new Map<number, LoanDraft[]>();
  for (const { itemId, ...loan } of rows) {
    const list = loans.get(itemId);
    if (list) list.push(loan);
    else loans.set(itemId, [loan]);
  }
  return { loans, cutAt: limit !== undefined && rows.length >= limit ? rows.at(-1)!.itemId : null };
}

/**
 * A row's loans, for the item inserted just before in the same batch ('newest', as readInsertStatements): one
 * statement, the loans as one JSON parameter, inserted in the order given so their ids keep it. Always local loans
 * — connection_loans can't be rebuilt from a file (§16 #57).
 */
function loanInsertStatements(d1: D1Database, loans: LoanDraft[]): D1PreparedStatement[] {
  if (!loans.length) return [];
  const json = JSON.stringify(loans.slice(0, MAX_LOANS_PER_CELL));
  return [
    d1
      .prepare(
        `INSERT INTO loans (item_id, borrower, loaned_on, due_on, returned_on, contact, note)
         SELECT (SELECT max(id) FROM items), json_extract(value, '$.borrower'), json_extract(value, '$.loanedOn'),
                json_extract(value, '$.dueOn'), json_extract(value, '$.returnedOn'), json_extract(value, '$.contact'),
                json_extract(value, '$.note')
         FROM json_each(?1) ORDER BY key`,
      )
      .bind(json),
  ];
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
export async function searchItems(d1: D1Database, query: string, limit = 50, reader?: ReaderFilter): Promise<Item[]> {
  const match = query
    .replace(/["'*^]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' ');
  if (!match) return [];
  // "Read by" narrows the match inside the FTS query, so a filtered search still finds up to `limit` items
  const status = reader?.mode === 'reading' ? 'in_progress' : 'completed';
  const readerSql = !reader
    ? ''
    : `AND rowid ${reader.mode === 'unfinished' ? 'NOT IN' : 'IN'} (SELECT item_id FROM reads WHERE status = '${status}'${
        reader.readerId === null ? '' : ' AND reader_id = ?3'
      })`;
  const stmt = d1.prepare(`SELECT rowid AS id FROM items_fts WHERE items_fts MATCH ?1 ${readerSql} ORDER BY rank LIMIT ?2`);
  const idRows = await (reader && reader.readerId !== null ? stmt.bind(match, limit, reader.readerId) : stmt.bind(match, limit)).all<{ id: number }>();
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

export type SiteSettings = {
  progressOnShares: boolean;
  progressToConnections: boolean;
  namesOnShares: boolean; // §16 #45 — members' display names, ratings and reviews on share pages
  namesToConnections: boolean; // §16 #45 — per-person feed entries and reviews, with display names, to connections
  goalsToConnections: boolean; // §16 #49 — members' reading goals as per-person entries; only while namesToConnections
};
/**
 * What a new instance starts with (§16 #49): names on share pages and to connections, and goals to connections, on;
 * progress on share pages off, and progress to connections on. An instance that had members before reading goals never uses
 * these: migration 0036 pinned its row to what it had — every switch as it was, goals off — so upgrading changes
 * nothing it shows anyone.
 */
const SITE_DEFAULTS: SiteSettings = {
  progressOnShares: false,
  progressToConnections: true,
  namesOnShares: true,
  namesToConnections: true,
  goalsToConnections: true,
};

/** One row, id 1. Absent means defaults — only ever on a new instance — so it needs no setup step. */
export async function getSiteSettings(d1: D1Database): Promise<SiteSettings> {
  const [row] = await db(d1).select().from(s.siteSettings).where(eq(s.siteSettings.id, 1));
  return row
    ? {
        progressOnShares: row.progressOnShares,
        progressToConnections: row.progressToConnections,
        namesOnShares: row.namesOnShares,
        namesToConnections: row.namesToConnections,
        goalsToConnections: row.goalsToConnections,
      }
    : { ...SITE_DEFAULTS };
}

/**
 * Switches goals to connections on or off (§16 #49), and — only when that changes it — gives every goal entry a new
 * id, in the same batch. Off, the removal check withdraws them at each connection's next check; on again, the new ids
 * sit past every connection's cursor, so they are pulled again rather than waiting behind it forever.
 */
export async function setGoalsToConnections(d1: D1Database, on: boolean): Promise<void> {
  const d = SITE_DEFAULTS;
  await d1.batch([
    d1
      .prepare(
        `INSERT OR REPLACE INTO member_activity (${MEMBER_ACTIVITY_COLUMNS})
         SELECT ${MEMBER_ACTIVITY_COLUMNS} FROM member_activity
         WHERE goal_id IS NOT NULL AND coalesce((SELECT goals_to_connections FROM site_settings WHERE id = 1), ?2) IS NOT ?1 ORDER BY id`,
      )
      .bind(on ? 1 : 0, d.goalsToConnections ? 1 : 0),
    d1
      .prepare(
        `INSERT INTO site_settings (id, progress_on_shares, progress_to_connections, names_on_shares, names_to_connections, goals_to_connections)
         VALUES (1, ?2, ?3, ?4, ?5, ?1)
         ON CONFLICT (id) DO UPDATE SET goals_to_connections = ?1, updated_at = datetime('now')`,
      )
      .bind(on ? 1 : 0, d.progressOnShares ? 1 : 0, d.progressToConnections ? 1 : 0, d.namesOnShares ? 1 : 0, d.namesToConnections ? 1 : 0),
  ]);
}

export async function updateSiteSettings(d1: D1Database, patch: Partial<SiteSettings>): Promise<void> {
  await db(d1)
    .insert(s.siteSettings)
    .values({ id: 1, ...SITE_DEFAULTS, ...patch })
    .onConflictDoUpdate({ target: s.siteSettings.id, set: { ...patch, updatedAt: sql`(datetime('now'))` } });
}

// ---------- reads (ARCH.md §16 #41, #43) ----------
//
// `reads` is the source of truth for reading state, one row per time someone read an item. Every write to it carries
// refreshReadState() in the same batch (§16 #39), which recomputes the household's summary on `items` that shelves,
// filters, share views, connection views, the activity triggers and the export read. Readers are matched with `IS`,
// so reads with no reader (a member removed since) behave as one person, "nobody", rather than never matching.

/**
 * Who is changing a read, a page or a review (§16 #43): members change their own, admins anyone's. Checked inside the
 * statement that writes, so the check and the write can't come apart. `id` null only with `admin` — a caller that
 * has already decided.
 */
export type Actor = { id: number | null; admin: boolean };

/** `?admin = 1 OR <owner> = ?id`, for the two parameters an actor binds as. */
const allowed = (owner: string, admin: string, id: string) => `(${admin} = 1 OR ${owner} = ${id})`;
const actorBinds = (by: Actor) => [by.admin ? 1 : 0, by.id] as const;

/**
 * The item columns everyone's reads decide, in SQL — the twin of summarizeReads() in src/lib/reads.ts. status,
 * began_on and completed_on come from the read that decides status across the household (a finished one by anyone,
 * else an open one, else a stopped one), so it is Completed once anyone has finished it and completed_on is the latest
 * finish by anyone; read_count counts everyone's finishes; rereading is an open read, by anyone, of a book finished
 * before, by anyone. progress_page is the latest page recorded in any open read — someone reading it now — or, with
 * none open, the deciding read's last page; an item with no reads falls back to pages with no read, which is how a
 * page kept its place before reads. With one reader this is exactly what migration 0023 carried.
 */
export const READ_STATE_SET = `
  status = coalesce((SELECT r.status FROM reads r WHERE r.item_id = items.id ORDER BY ${statusOrderSql('r')} LIMIT 1), 'not_started'),
  began_on = (SELECT r.began_on FROM reads r WHERE r.item_id = items.id ORDER BY ${statusOrderSql('r')} LIMIT 1),
  completed_on = (SELECT r.ended_on FROM reads r WHERE r.item_id = items.id ORDER BY ${statusOrderSql('r')} LIMIT 1),
  read_count = (SELECT count(*) FROM reads r WHERE r.item_id = items.id AND r.status = 'completed'),
  rereading = EXISTS (SELECT 1 FROM reads r WHERE r.item_id = items.id AND r.status = 'in_progress')
    AND EXISTS (SELECT 1 FROM reads r WHERE r.item_id = items.id AND r.status = 'completed'),
  progress_page = (SELECT p.page FROM reading_progress p WHERE p.item_id = items.id
    AND CASE WHEN EXISTS (SELECT 1 FROM reads o WHERE o.item_id = items.id AND o.status = 'in_progress')
      THEN p.read_id IN (SELECT o.id FROM reads o WHERE o.item_id = items.id AND o.status = 'in_progress')
      ELSE p.read_id IS (SELECT r.id FROM reads r WHERE r.item_id = items.id ORDER BY ${currentOrderSql('r')} LIMIT 1) END
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

/**
 * Inserts `reads` for an item — its id, or 'newest' for one inserted earlier in the batch. One statement, in list
 * order. A read without a reader of its own is `person`'s — whoever adds the item or imports it.
 */
function readInsertStatements(d1: D1Database, item: number | 'newest', reads: PersonRead[], person: number | null): D1PreparedStatement[] {
  if (!reads.length) return [];
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const json = JSON.stringify(
    reads.slice(0, MAX_READS_PER_CELL).map((r) => ({ status: r.status, beganOn: r.beganOn, endedOn: r.endedOn, readerId: r.readerId === undefined ? person : r.readerId })),
  );
  const stmt = d1.prepare(
    `INSERT INTO reads (item_id, reader_id, status, began_on, ended_on)
     SELECT ${itemRef}, json_extract(value, '$.readerId'), json_extract(value, '$.status'), json_extract(value, '$.beganOn'), json_extract(value, '$.endedOn')
     FROM json_each(?1) ORDER BY key`,
  );
  return [item === 'newest' ? stmt.bind(json) : stmt.bind(json, item)];
}

/**
 * The edit form's status and dates, applied to `person`'s read that decides their status — or, when they have no
 * reads of it yet, made their first read. Every statement is conditional on the reads actually there, not on what
 * the item columns say (those are the household's). Reopening a read is skipped while they have another open (the
 * unique index would refuse it). Nobody else's reads are touched.
 */
function formReadStatements(d1: D1Database, itemId: number, person: number | null, form: FormRead): D1PreparedStatement[] {
  if (form.status === 'not_started') {
    // pages first: reading_progress.read_id references its read without a cascade
    const theirPages = `(read_id IN (SELECT id FROM reads WHERE item_id = ?1 AND reader_id IS ?2) OR (read_id IS NULL AND added_by IS ?2))`;
    return form.clearReads
      ? [
          d1
            .prepare(`DELETE FROM activity_log WHERE progress_id IN (SELECT id FROM reading_progress WHERE item_id = ?1 AND ${theirPages})`)
            .bind(itemId, person),
          d1.prepare(`DELETE FROM reading_progress WHERE item_id = ?1 AND ${theirPages}`).bind(itemId, person),
          d1.prepare('DELETE FROM reads WHERE item_id = ?1 AND reader_id IS ?2').bind(itemId, person),
        ]
      : [];
  }
  const ended = form.status === 'in_progress' ? null : form.completedOn;
  return [
    // Marking a book Completed that they hadn't finished is finishing it: it leaves their want list (§16 #53). First,
    // while their reads still say whether they had finished it — an edit of a book they finished before leaves a
    // want to read it again where it is.
    ...(form.status === 'completed' ? [finishedWantStatement(d1, itemId, person)] : []),
    d1
      .prepare(
        `INSERT INTO reads (item_id, reader_id, status, began_on, ended_on)
         SELECT ?1, ?5, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1 AND reader_id IS ?5)`,
      )
      .bind(itemId, form.status, form.beganOn, ended, person),
    d1
      .prepare(
        `UPDATE reads SET status = ?2, began_on = ?3, ended_on = ?4
         WHERE id = (SELECT r.id FROM reads r WHERE r.item_id = ?1 AND r.reader_id IS ?5 ORDER BY ${statusOrderSql('r')} LIMIT 1)
           AND NOT (?2 = 'in_progress' AND EXISTS (
             SELECT 1 FROM reads o WHERE o.item_id = ?1 AND o.reader_id IS ?5 AND o.status = 'in_progress' AND o.id <> reads.id))`,
      )
      .bind(itemId, form.status, form.beganOn, ended, person),
    adoptOrphanPages(d1, itemId, person),
  ];
}

/**
 * Pages recorded before an item had any read — only a book marked not started that had pages when reads arrived —
 * join their recorder's current read once they have one, as migration 0023 put everyone else's. Left behind with no
 * read, they'd drop out of the item page while still being exported and shared. A no-op for every other item.
 */
function adoptOrphanPages(d1: D1Database, itemId: number, person: number | null): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE reading_progress SET read_id = (SELECT r.id FROM reads r WHERE r.item_id = ?1 AND r.reader_id IS ?2 ORDER BY ${currentOrderSql('r')} LIMIT 1)
       WHERE item_id = ?1 AND read_id IS NULL AND added_by IS ?2 AND EXISTS (SELECT 1 FROM reads WHERE item_id = ?1 AND reader_id IS ?2)`,
    )
    .bind(itemId, person);
}

export type ReadEntry = ReadRow & { createdAt: string; readerId: number | null };
export type ReviewEntry = {
  id: number;
  userId: number | null;
  rating: number | null;
  review: string | null;
  reviewedAt: string | null;
  updatedAt: string;
};

/**
 * An item's reads, everyone's, oldest first with the open ones last; its pages; and everyone's reviews, the one the
 * household shows first — one D1 call.
 */
export async function readingLog(
  d1: D1Database,
  itemId: number,
): Promise<{ reads: ReadEntry[]; entries: ProgressEntry[]; reviews: ReviewEntry[] }> {
  return readingLogOf(await d1.batch(readingLogStatements(d1, itemId)));
}

/**
 * The item page's reading log and its want list and purchase links (§16 #53) in the same one D1 call — readingLog's
 * batch with wantsAndLinks' two statements after it — so want lists add nothing to the page's calls.
 */
export async function itemPageLog(
  d1: D1Database,
  itemId: number,
): Promise<{
  reads: ReadEntry[];
  entries: ProgressEntry[];
  reviews: ReviewEntry[];
  want: { wanters: Array<{ id: number; username: string; at: string }>; links: Array<{ id: number; label: string; url: string }> };
}> {
  const results = await d1.batch([...readingLogStatements(d1, itemId), ...wantsAndLinksStatements(d1, itemId)]);
  return { ...readingLogOf(results), want: wantsAndLinksOf(results.slice(3)) };
}

function readingLogStatements(d1: D1Database, itemId: number): D1PreparedStatement[] {
  return [
    d1
      .prepare(
        `SELECT r.id, r.status, r.began_on AS beganOn, r.ended_on AS endedOn, r.created_at AS createdAt, r.reader_id AS readerId
         FROM reads r WHERE r.item_id = ?1 ORDER BY ${displayOrderSql('r')}`,
      )
      .bind(itemId),
    d1
      .prepare('SELECT id, page, at, added_by AS addedBy, read_id AS readId FROM reading_progress WHERE item_id = ?1 ORDER BY at, id')
      .bind(itemId),
    d1
      .prepare(
        `SELECT v.id, v.user_id AS userId, v.rating, v.review, v.reviewed_at AS reviewedAt, v.updated_at AS updatedAt
         FROM reviews v WHERE v.item_id = ?1 ORDER BY ${reviewOrderSql('v')}`,
      )
      .bind(itemId),
  ];
}

function readingLogOf([reads, entries, reviews]: D1Result[]): { reads: ReadEntry[]; entries: ProgressEntry[]; reviews: ReviewEntry[] } {
  return {
    reads: (reads?.results ?? []) as ReadEntry[],
    entries: (entries?.results ?? []) as ProgressEntry[],
    reviews: (reviews?.results ?? []) as ReviewEntry[],
  };
}

/** One read of an item, or null — what a route checks the actor against before it says why a change was refused. */
export async function getRead(d1: D1Database, itemId: number, readId: number): Promise<ReadEntry | null> {
  return d1
    .prepare(
      `SELECT id, status, began_on AS beganOn, ended_on AS endedOn, created_at AS createdAt, reader_id AS readerId
       FROM reads WHERE id = ?1 AND item_id = ?2`,
    )
    .bind(readId, itemId)
    .first<ReadEntry>();
}

/**
 * Opens a read for `reader` — their first, or "Read again" on a book they've finished, which stays Completed and
 * shows as re-reading. Nothing happens while they have one open; someone else's open read doesn't matter. True when
 * a read was opened.
 */
export async function startRead(d1: D1Database, itemId: number, beganOn: string, reader: number | null = null): Promise<boolean> {
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reads (item_id, reader_id, status, began_on)
         SELECT ?1, ?3, 'in_progress', ?2
         WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)
           AND NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1 AND reader_id IS ?3 AND status = 'in_progress')
           AND (SELECT count(*) FROM reads WHERE item_id = ?1 AND reader_id IS ?3) < ${MAX_READS_PER_ITEM}`,
      )
      .bind(itemId, beganOn, reader),
    adoptOrphanPages(d1, itemId, reader),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

/**
 * Closes an open read: finished, or stopped. A finish after the household's last makes completed_on move to its
 * date, and migration 0021's trigger records the finish for connections, dated by it (§16 #40). Only an open read
 * that began by that date closes, and only by its reader or an admin. True when it did.
 */
export async function closeRead(
  d1: D1Database,
  itemId: number,
  readId: number,
  status: Exclude<ReadStatus, 'in_progress'>,
  endedOn: string,
  by: Actor,
): Promise<boolean> {
  const [closed] = await d1.batch([
    d1
      .prepare(
        `UPDATE reads SET status = ?3, ended_on = ?4
         WHERE id = ?1 AND item_id = ?2 AND status = 'in_progress' AND (began_on IS NULL OR began_on <= ?4)
           AND ${allowed('reader_id', '?5', '?6')}`,
      )
      .bind(readId, itemId, status, endedOn, ...actorBinds(by)),
    // A finished book leaves its reader's want list (§16 #53) — straight after the UPDATE, so changes() is its: a
    // finish refused changes nothing, and neither does this. A stop leaves the want: they still mean to read it.
    ...(status === 'completed'
      ? [
          d1
            .prepare(
              `DELETE FROM wants WHERE item_id = ?2 AND user_id = (SELECT reader_id FROM reads WHERE id = ?1 AND item_id = ?2)
                 AND changes() > 0 AND EXISTS (SELECT 1 FROM items WHERE id = ?2 AND media_type = 'book')`,
            )
            .bind(readId, itemId),
        ]
      : []),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (closed?.meta.changes ?? 0) > 0;
}

/** Records one of `reader`'s reads from before — "I also read this in 2010" — finished or stopped. True when it was added. */
export async function addPastRead(d1: D1Database, itemId: number, read: ReadDraft, reader: number | null = null): Promise<boolean> {
  if (read.status === 'in_progress') return false;
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reads (item_id, reader_id, status, began_on, ended_on)
         SELECT ?1, ?5, ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)
           AND (SELECT count(*) FROM reads WHERE item_id = ?1 AND reader_id IS ?5) < ${MAX_READS_PER_ITEM}`,
      )
      .bind(itemId, read.status, read.beganOn, read.endedOn, reader),
    adoptOrphanPages(d1, itemId, reader),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

/**
 * Corrects one read's outcome and dates, by its reader or an admin. Making it an open read is skipped while its
 * reader has another open. True when it changed.
 */
export async function updateRead(d1: D1Database, itemId: number, readId: number, read: ReadDraft, by: Actor): Promise<boolean> {
  const [, updated] = await d1.batch([
    // Correcting an open read to Completed finishes it: the book leaves its reader's want list (§16 #53), as Finish
    // takes it off. First, while the read still says it was open, and on the same conditions the UPDATE below has.
    d1
      .prepare(
        `DELETE FROM wants WHERE ?3 = 'completed' AND item_id = ?2
           AND EXISTS (SELECT 1 FROM items WHERE id = ?2 AND media_type = 'book')
           AND user_id = (SELECT r.reader_id FROM reads r WHERE r.id = ?1 AND r.item_id = ?2 AND r.status = 'in_progress'
             AND ${allowed('r.reader_id', '?4', '?5')})`,
      )
      .bind(readId, itemId, read.status, ...actorBinds(by)),
    d1
      .prepare(
        `UPDATE reads SET status = ?3, began_on = ?4, ended_on = ?5
         WHERE id = ?1 AND item_id = ?2 AND ${allowed('reader_id', '?6', '?7')}
           AND NOT (?3 = 'in_progress' AND EXISTS (
             SELECT 1 FROM reads o WHERE o.item_id = ?2 AND o.status = 'in_progress' AND o.id <> ?1 AND o.reader_id IS reads.reader_id))`,
      )
      .bind(readId, itemId, read.status, read.beganOn, read.status === 'in_progress' ? null : read.endedOn, ...actorBinds(by)),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (updated?.meta.changes ?? 0) > 0;
}

/**
 * Deletes a read and the pages recorded in it — a read's page log only means something inside that read — with
 * those pages' feed entries first, because activity_log.progress_id and reading_progress.read_id reference them
 * without a cascade (§16 #35). Only by its reader or an admin: every statement checks, so a refused delete removes
 * no page either. True when the read went.
 */
export async function deleteRead(d1: D1Database, itemId: number, readId: number, by: Actor): Promise<boolean> {
  const mayDelete = `EXISTS (SELECT 1 FROM reads g WHERE g.id = ?1 AND g.item_id = ?2 AND ${allowed('g.reader_id', '?3', '?4')})`;
  const binds = [readId, itemId, ...actorBinds(by)];
  const results = await d1.batch([
    d1
      .prepare(`DELETE FROM activity_log WHERE progress_id IN (SELECT id FROM reading_progress WHERE read_id = ?1 AND item_id = ?2) AND ${mayDelete}`)
      .bind(...binds),
    d1.prepare(`DELETE FROM reading_progress WHERE read_id = ?1 AND item_id = ?2 AND ${mayDelete}`).bind(...binds),
    d1.prepare(`DELETE FROM reads WHERE id = ?1 AND item_id = ?2 AND ${allowed('reader_id', '?3', '?4')}`).bind(...binds),
    refreshReadState(d1, [itemId], { touch: true }),
  ]);
  return (results[2]?.meta.changes ?? 0) > 0;
}

/**
 * Moves a read, and the pages recorded in it, to another member — an admin fixing history credited to the wrong
 * person (§16 #43), such as everything migration 0025 gave the first admin. Refused for anyone but an admin, for a
 * member who doesn't exist, and for an open read when that member already has one open. The household's summary
 * doesn't change, since it is everyone's, but it is refreshed with the move like every other write. True when it
 * moved.
 */
export async function moveRead(d1: D1Database, itemId: number, readId: number, to: number, by: Actor): Promise<boolean> {
  const [moved] = await d1.batch([
    d1
      .prepare(
        `UPDATE reads SET reader_id = ?3
         WHERE id = ?1 AND item_id = ?2 AND ?4 = 1 AND reader_id IS NOT ?3
           AND EXISTS (SELECT 1 FROM users WHERE id = ?3)
           AND NOT (status = 'in_progress' AND EXISTS (
             SELECT 1 FROM reads o WHERE o.item_id = ?2 AND o.reader_id = ?3 AND o.status = 'in_progress'))
           AND (SELECT count(*) FROM reads c WHERE c.item_id = ?2 AND c.reader_id = ?3) < ${MAX_READS_PER_ITEM}`,
      )
      .bind(readId, itemId, to, by.admin ? 1 : 0),
    // its entries on the per-person feed, re-keyed so connections holding them under the old name pull them again
    ...rekeyMoved(d1, { readId }),
    // its pages are its reader's: they follow it, and only once it has moved
    d1
      .prepare(
        `UPDATE reading_progress SET added_by = ?3
         WHERE read_id = ?1 AND item_id = ?2 AND EXISTS (SELECT 1 FROM reads WHERE id = ?1 AND reader_id = ?3)`,
      )
      .bind(readId, itemId, to),
    refreshReadState(d1, [itemId]),
  ]);
  return (moved?.meta.changes ?? 0) > 0;
}

/**
 * Reads for every item whose id lies in [fromId, toId], each item's in display order, with each reader's username
 * (null for a member removed since) — the export's pages are contiguous in id order, so one query covers a page
 * (see tagsForIdRange).
 */
/** readsForIdRange's statement, shared with exportCellsForIdRange so the two can't drift. */
const readsRangeSql = (scoped: string) =>
  `SELECT r.item_id AS itemId, r.id, r.status, r.began_on AS beganOn, r.ended_on AS endedOn, u.username AS reader
   FROM reads r LEFT JOIN users u ON u.id = r.reader_id
   WHERE r.item_id BETWEEN ?1 AND ?2 ${scoped}
   ORDER BY r.item_id, ${displayOrderSql('r')}`;

export async function readsForIdRange(
  d1: D1Database,
  fromId: number,
  toId: number,
  libraryId?: number,
): Promise<Map<number, Array<ReadRow & { reader: string | null }>>> {
  const stmt = d1.prepare(readsRangeSql(libraryId ? 'AND r.item_id IN (SELECT id FROM items WHERE library_id = ?3)' : ''));
  const rows = (
    await (libraryId ? stmt.bind(fromId, toId, libraryId) : stmt.bind(fromId, toId)).all<ReadRow & { itemId: number; reader: string | null }>()
  ).results;
  const result = new Map<number, Array<ReadRow & { reader: string | null }>>();
  for (const { itemId, ...read } of rows) {
    const list = result.get(itemId) ?? [];
    list.push({ id: read.id, status: read.status, beganOn: read.beganOn, endedOn: read.endedOn, reader: read.reader });
    result.set(itemId, list);
  }
  return result;
}

// ---------- reviews (ARCH.md §16 #43) ----------
//
// `reviews` holds each member's rating and review of an item; items.rating and items.review are the household's
// summary of them — the average rating and the review written most recently — kept by refreshReviewState() in the
// same batch as every write, so share pages, connections, the activity triggers and the export read them as before.

/** Whitespace-insensitive text, as migration 0007's triggers compare reviews: a CRLF resubmitted isn't a new review. */
const normText = (x: string) => `trim(replace(coalesce(${x}, ''), char(13), ''), ' ' || char(9) || char(10))`;

/**
 * Brings items' rating and review in line with their reviews: the average of everyone's ratings, rounded to the 1–10
 * scale, and the review written most recently — the twin of summarizeReviews(). Writes only an item whose summary
 * actually changed, and stamps its updated_at then: connections see that time, and an average that didn't move is
 * no change to the book. The update fires migration 0021's trigger, which records "rated" or "reviewed" when the
 * summary moved — a second member's rating that changes the average is news, dated per §16 #40, and never inside an
 * import's marker. `ids` as refreshReadState's.
 */
export function refreshReviewState(d1: D1Database, ids: number[] | 'newest'): D1PreparedStatement {
  const source = ids === 'newest' ? '(SELECT max(id) AS id FROM items)' : '(SELECT value AS id FROM json_each(?1))';
  const stmt = d1.prepare(
    `UPDATE items SET rating = s.rating, review = s.review, updated_at = datetime('now')
     FROM (SELECT j.id,
             (SELECT CAST(round(avg(v.rating)) AS INTEGER) FROM reviews v WHERE v.item_id = j.id AND v.rating IS NOT NULL) AS rating,
             (SELECT v.review FROM reviews v WHERE v.item_id = j.id AND v.review IS NOT NULL ORDER BY ${reviewOrderSql('v')} LIMIT 1) AS review
           FROM ${source} j) AS s
     WHERE items.id = s.id AND (items.rating IS NOT s.rating OR items.review IS NOT s.review)`,
  );
  return ids === 'newest' ? stmt : stmt.bind(JSON.stringify(ids));
}

/**
 * Dates the household's "reviewed" and "rated" activity by when what they now show was given (§16 #40). When a
 * member's review or rating goes — deleted, or cleared from the edit form — the one the household shows next is
 * older, but migration 0021's trigger sees only that the item's review or rating changed, and dates its replacement
 * now: an old review would reach connections as news. This moves such an entry back to when the review now shown was
 * written (reviewed_at), or the latest remaining rating was given (rated_at — a text edit alone doesn't move it, so
 * an old rating whose review was later reworded isn't re-announced as new). Never forward, so an entry for something just written keeps its time, and
 * an import's, dated by its read, keeps that. The entry keeps its new id, so connections still learn their copy is out
 * of date. Rides in the batch of every write that can remove a review, after refreshReviewState().
 */
function redateReviewActivity(d1: D1Database, ids: number[]): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE activity_log SET at = min(at, coalesce(CASE kind
         WHEN 'reviewed' THEN (SELECT max(v.reviewed_at) FROM reviews v WHERE v.item_id = activity_log.item_id AND v.review IS NOT NULL)
         ELSE (SELECT max(v.rated_at) FROM reviews v WHERE v.item_id = activity_log.item_id AND v.rating IS NOT NULL) END, at))
       WHERE item_id IN (SELECT value FROM json_each(?1)) AND kind IN ('reviewed', 'rated')`,
    )
    .bind(JSON.stringify(ids));
}

/** The item columns for reviews it is inserted with, so its insert trigger sees the rating and review it will have. */
function withReviewState<T extends NewItem>(values: T, reviews: ReviewDraft[]): T {
  return { ...values, ...summarizeReviews(reviews) };
}

/** The review an item's own rating and review columns stand for — how a form, a libib or Goodreads row arrives. */
function reviewsFromColumns(values: Pick<NewItem, 'rating' | 'review'>): ReviewDraft[] {
  const rating = values.rating ?? null;
  const review = values.review ?? null;
  return rating === null && review === null ? [] : [{ rating, review, reviewedAt: null, ratedAt: null }];
}

/**
 * Inserts reviews for an item — its id, or 'newest'. A review without a person of its own is `person`'s. One per
 * person: a second for the same person is dropped here (the unique index would refuse it), and a review with no
 * written time takes now.
 */
function reviewInsertStatements(d1: D1Database, item: number | 'newest', reviews: PersonReview[], person: number | null): D1PreparedStatement[] {
  if (!reviews.length) return [];
  const seen = new Set<number>();
  const rows = [];
  for (const r of reviews) {
    const userId = r.userId === undefined ? person : r.userId;
    if (userId !== null) {
      if (seen.has(userId)) continue;
      seen.add(userId);
    }
    rows.push({ userId, rating: r.rating, review: r.review, reviewedAt: r.reviewedAt, ratedAt: r.ratedAt ?? null });
  }
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const stmt = d1.prepare(
    `INSERT INTO reviews (item_id, user_id, rating, review, reviewed_at, rated_at)
     SELECT ${itemRef}, json_extract(value, '$.userId'), json_extract(value, '$.rating'), json_extract(value, '$.review'),
       CASE WHEN json_extract(value, '$.review') IS NULL THEN NULL ELSE coalesce(json_extract(value, '$.reviewedAt'), datetime('now')) END,
       CASE WHEN json_extract(value, '$.rating') IS NULL THEN NULL ELSE coalesce(json_extract(value, '$.ratedAt'), datetime('now')) END
     FROM json_each(?1) ORDER BY key`,
  );
  const json = JSON.stringify(rows);
  return [item === 'newest' ? stmt.bind(json) : stmt.bind(json, item)];
}

/**
 * `person`'s rating and review of an item, written. `replace` (the edit form) makes them exactly what was sent —
 * both empty removes the review; `merge` (a Goodreads re-import) takes only what was sent, never blanking what is
 * there (§16 #14). The text's written time moves only when the text really changed, so a rating changed alone, or a
 * form saved untouched, doesn't make an old review the household's latest. Update, then insert when there was none:
 * `IS` matches a person of null too, where ON CONFLICT never would.
 */
function reviewWriteStatements(
  d1: D1Database,
  itemId: number,
  person: number | null,
  sent: FormReview,
  mode: 'replace' | 'merge',
): D1PreparedStatement[] {
  const newRating = mode === 'merge' ? 'coalesce(?3, rating)' : '?3';
  const newReview = mode === 'merge' ? 'coalesce(?4, review)' : '?4';
  const differs =
    mode === 'merge'
      ? '((?3 IS NOT NULL AND rating IS NOT ?3) OR (?4 IS NOT NULL AND review IS NOT ?4))'
      : '(rating IS NOT ?3 OR review IS NOT ?4)';
  const binds = [itemId, person, sent.rating, sent.review] as const;
  return [
    d1
      .prepare(
        `UPDATE reviews SET rating = ${newRating}, review = ${newReview}, updated_at = datetime('now'),
           reviewed_at = CASE WHEN ${newReview} IS NULL THEN NULL
             WHEN review IS NOT NULL AND ${normText('review')} = ${normText(newReview)} THEN reviewed_at ELSE datetime('now') END,
           rated_at = CASE WHEN ${newRating} IS NULL THEN NULL WHEN rating IS ${newRating} THEN rated_at ELSE datetime('now') END
         WHERE item_id = ?1 AND user_id IS ?2 AND (?3 IS NOT NULL OR ?4 IS NOT NULL) AND ${differs}`,
      )
      .bind(...binds),
    d1
      .prepare(
        `INSERT INTO reviews (item_id, user_id, rating, review, reviewed_at, rated_at)
         SELECT ?1, ?2, ?3, ?4, CASE WHEN ?4 IS NULL THEN NULL ELSE datetime('now') END, CASE WHEN ?3 IS NULL THEN NULL ELSE datetime('now') END
         WHERE (?3 IS NOT NULL OR ?4 IS NOT NULL) AND EXISTS (SELECT 1 FROM items WHERE id = ?1)
           AND NOT EXISTS (SELECT 1 FROM reviews WHERE item_id = ?1 AND user_id IS ?2)`,
      )
      .bind(...binds),
    ...(mode === 'replace'
      ? [d1.prepare('DELETE FROM reviews WHERE item_id = ?1 AND user_id IS ?2 AND ?3 IS NULL AND ?4 IS NULL').bind(...binds)]
      : []),
  ];
}

/** One review of an item, or null — what a route checks the actor against before it says why a change was refused. */
export async function getReview(d1: D1Database, itemId: number, reviewId: number): Promise<ReviewEntry | null> {
  return d1
    .prepare(
      `SELECT id, user_id AS userId, rating, review, reviewed_at AS reviewedAt, updated_at AS updatedAt
       FROM reviews WHERE id = ?1 AND item_id = ?2`,
    )
    .bind(reviewId, itemId)
    .first<ReviewEntry>();
}

/**
 * Edits one review in place — from the book's page, by its writer or an admin. Both empty deletes it. The household's
 * summary is recomputed in the same batch. True when it changed.
 */
export async function updateReview(d1: D1Database, itemId: number, reviewId: number, sent: FormReview, by: Actor): Promise<boolean> {
  const binds = [reviewId, itemId, sent.rating, sent.review, ...actorBinds(by)] as const;
  const results = await d1.batch([
    d1
      .prepare(
        `UPDATE reviews SET rating = ?3, review = ?4, updated_at = datetime('now'),
           reviewed_at = CASE WHEN ?4 IS NULL THEN NULL
             WHEN review IS NOT NULL AND ${normText('review')} = ${normText('?4')} THEN reviewed_at ELSE datetime('now') END,
           rated_at = CASE WHEN ?3 IS NULL THEN NULL WHEN rating IS ?3 THEN rated_at ELSE datetime('now') END
         WHERE id = ?1 AND item_id = ?2 AND ${allowed('user_id', '?5', '?6')}
           AND (?3 IS NOT NULL OR ?4 IS NOT NULL) AND (rating IS NOT ?3 OR review IS NOT ?4)`,
      )
      .bind(...binds),
    d1
      .prepare(`DELETE FROM reviews WHERE id = ?1 AND item_id = ?2 AND ${allowed('user_id', '?5', '?6')} AND ?3 IS NULL AND ?4 IS NULL`)
      .bind(...binds),
    refreshReviewState(d1, [itemId]),
    redateReviewActivity(d1, [itemId]),
  ]);
  return (results[0]?.meta.changes ?? 0) + (results[1]?.meta.changes ?? 0) > 0;
}

/** Deletes one review, by its writer or an admin, and recomputes the household's summary with it. True when it went. */
export async function deleteReview(d1: D1Database, itemId: number, reviewId: number, by: Actor): Promise<boolean> {
  const [deleted] = await d1.batch([
    d1.prepare(`DELETE FROM reviews WHERE id = ?1 AND item_id = ?2 AND ${allowed('user_id', '?3', '?4')}`).bind(reviewId, itemId, ...actorBinds(by)),
    refreshReviewState(d1, [itemId]),
    redateReviewActivity(d1, [itemId]),
  ]);
  return (deleted?.meta.changes ?? 0) > 0;
}

/**
 * Moves a review to another member, as moveRead does a read. Refused for anyone but an admin, for a member who
 * doesn't exist, and for one who already has a review of this item — one each, so the two would have to become one,
 * which is a person's call: they delete one first. True when it moved.
 */
export async function moveReview(d1: D1Database, itemId: number, reviewId: number, to: number, by: Actor): Promise<boolean> {
  const [moved] = await d1.batch([
    d1
      .prepare(
        `UPDATE reviews SET user_id = ?3
         WHERE id = ?1 AND item_id = ?2 AND ?4 = 1 AND user_id IS NOT ?3
           AND EXISTS (SELECT 1 FROM users WHERE id = ?3)
           AND NOT EXISTS (SELECT 1 FROM reviews o WHERE o.item_id = ?2 AND o.user_id = ?3)`,
      )
      .bind(reviewId, itemId, to, by.admin ? 1 : 0),
    ...rekeyMoved(d1, { reviewId }), // as moveRead's
    refreshReviewState(d1, [itemId]),
  ]);
  return (moved?.meta.changes ?? 0) > 0;
}

/** Reviews for every item whose id lies in [fromId, toId], oldest first, with each writer's username — as readsForIdRange. */
/** reviewsForIdRange's statement, shared with exportCellsForIdRange. */
const reviewsRangeSql = (scoped: string) =>
  `SELECT v.item_id AS itemId, u.username AS by, v.rating, v.review, v.reviewed_at AS reviewedAt, v.rated_at AS ratedAt
   FROM reviews v LEFT JOIN users u ON u.id = v.user_id
   WHERE v.item_id BETWEEN ?1 AND ?2 ${scoped}
   ORDER BY v.item_id, v.id`;

export async function reviewsForIdRange(
  d1: D1Database,
  fromId: number,
  toId: number,
  libraryId?: number,
): Promise<Map<number, Array<ReviewDraft & { by: string | null }>>> {
  const stmt = d1.prepare(reviewsRangeSql(libraryId ? 'AND v.item_id IN (SELECT id FROM items WHERE library_id = ?3)' : ''));
  const rows = (
    await (libraryId ? stmt.bind(fromId, toId, libraryId) : stmt.bind(fromId, toId)).all<ReviewDraft & { itemId: number; by: string | null }>()
  ).results;
  const result = new Map<number, Array<ReviewDraft & { by: string | null }>>();
  for (const { itemId, ...review } of rows) {
    const list = result.get(itemId) ?? [];
    list.push(review);
    result.set(itemId, list);
  }
  return result;
}

// ---------- want lists and purchase links (ARCH.md §16 #53) ----------
//
// `wants` is each member's want list; `purchase_links` the household's pasted links for an item. A want is its member's
// alone: only they change it (the route passes their own id; nothing here takes someone else's). A link is the item's:
// any member adds or removes one. Deleting an item takes both with it (ON DELETE CASCADE); removing a member clears
// their list and their gift lists (deleteUser).

/** A want as an import brings it: a member here, and since when (null: now). */
export type PersonWant = { userId: number; at: string | null };

/** Inserts wants for an item — its id, or 'newest' for one inserted earlier in the batch — skipping any already there, or of nobody. */
function wantInsertStatements(d1: D1Database, item: number | 'newest', wants: PersonWant[]): D1PreparedStatement[] {
  if (!wants.length) return [];
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const stmt = d1.prepare(
    `INSERT INTO wants (item_id, user_id, created_at)
     SELECT ${itemRef}, json_extract(value, '$.userId'), coalesce(json_extract(value, '$.at'), datetime('now'))
     FROM json_each(?1) WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = json_extract(value, '$.userId'))
     ON CONFLICT DO NOTHING`,
  );
  const json = JSON.stringify(wants.map((w) => ({ userId: w.userId, at: w.at })));
  return [item === 'newest' ? stmt.bind(json) : stmt.bind(json, item)];
}

/** Inserts purchase links for an item — its id, or 'newest' — already checked (checkPurchaseLink), at most MAX_LINKS_PER_ITEM. */
function linkInsertStatements(d1: D1Database, item: number | 'newest', links: LinkDraft[]): D1PreparedStatement[] {
  if (!links.length) return [];
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const stmt = d1.prepare(
    `INSERT INTO purchase_links (item_id, label, url)
     SELECT ${itemRef}, json_extract(value, '$.label'), json_extract(value, '$.url') FROM json_each(?1) WHERE true
     ORDER BY key ON CONFLICT DO NOTHING`,
  );
  const json = JSON.stringify(links.slice(0, MAX_LINKS_PER_ITEM).map((l) => ({ label: l.label, url: l.url })));
  return [item === 'newest' ? stmt.bind(json) : stmt.bind(json, item)];
}

/**
 * A book `person` finished leaves their want list: the statement for the edit form's Completed, which goes before the
 * form's read is written — it clears the want only while they have no finished read of the book yet, so saving the
 * form of a book they'd finished before keeps a want to read it again. Books only: a record or a game marked
 * Completed was heard or played, which isn't having it.
 */
function finishedWantStatement(d1: D1Database, itemId: number, person: number | null): D1PreparedStatement {
  return d1
    .prepare(
      `DELETE FROM wants WHERE item_id = ?1 AND user_id IS ?2
         AND EXISTS (SELECT 1 FROM items WHERE id = ?1 AND media_type = 'book')
         AND NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1 AND reader_id IS ?2 AND status = 'completed')`,
    )
    .bind(itemId, person);
}

/**
 * Puts an item on `userId`'s want list, or takes it off — the signed-in member's own list only. Idempotent: wanting
 * what they already want keeps the date it was first wanted; an item that isn't there is wanted by nobody.
 */
export async function setWant(d1: D1Database, itemId: number, userId: number, want: boolean): Promise<void> {
  await (want
    ? d1
        .prepare(
          `INSERT INTO wants (item_id, user_id) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)
           ON CONFLICT DO NOTHING`,
        )
        .bind(itemId, userId)
    : d1.prepare('DELETE FROM wants WHERE item_id = ?1 AND user_id = ?2').bind(itemId, userId)
  ).run();
}

/**
 * Which of these items the household wants and doesn't have (§16 #53): someone's want list holds it and `copies` is 0 —
 * the "Wanted" badge beside "Not owned". A set of ids, never whose. One query, the ids as one JSON parameter.
 */
export async function wantedAmong(d1: D1Database, itemIds: number[]): Promise<Set<number>> {
  if (!itemIds.length) return new Set();
  const rows = await d1.prepare(WANTED_AMONG).bind(JSON.stringify(itemIds)).all<{ id: number }>();
  return new Set(rows.results.map((r) => r.id));
}
const WANTED_AMONG = `SELECT i.id FROM items i WHERE i.id IN (SELECT value FROM json_each(?1)) AND i.copies = 0
  AND EXISTS (SELECT 1 FROM wants w WHERE w.item_id = i.id)`;

/** A shelf page's badges in one D1 call: which items are out on loan, and which are wanted (wantedAmong). */
export async function shelfFlags(d1: D1Database, itemIds: number[]): Promise<{ onLoan: Set<number>; wanted: Set<number> }> {
  if (!itemIds.length) return { onLoan: new Set(), wanted: new Set() };
  const ids = JSON.stringify(itemIds);
  const [loans, wanted] = await d1.batch([
    d1.prepare('SELECT DISTINCT item_id AS id FROM loans WHERE returned_on IS NULL AND item_id IN (SELECT value FROM json_each(?1))').bind(ids),
    d1.prepare(WANTED_AMONG).bind(ids),
  ]);
  const set = (r: D1Result | undefined) => new Set(((r?.results ?? []) as Array<{ id: number }>).map((x) => x.id));
  return { onLoan: set(loans), wanted: set(wanted) };
}

/** Who wants an item — ids and usernames, for the item's page inside the app — and its purchase links, oldest first: one D1 call. */
export async function wantsAndLinks(
  d1: D1Database,
  itemId: number,
): Promise<{ wanters: Array<{ id: number; username: string; at: string }>; links: Array<{ id: number; label: string; url: string }> }> {
  return wantsAndLinksOf(await d1.batch(wantsAndLinksStatements(d1, itemId)));
}

function wantsAndLinksStatements(d1: D1Database, itemId: number): D1PreparedStatement[] {
  return [
    d1
      .prepare('SELECT u.id, u.username, w.created_at AS at FROM wants w JOIN users u ON u.id = w.user_id WHERE w.item_id = ?1 ORDER BY w.created_at, u.id')
      .bind(itemId),
    d1.prepare('SELECT id, label, url FROM purchase_links WHERE item_id = ?1 ORDER BY id').bind(itemId),
  ];
}

function wantsAndLinksOf([w, l]: D1Result[]): {
  wanters: Array<{ id: number; username: string; at: string }>;
  links: Array<{ id: number; label: string; url: string }>;
} {
  return {
    wanters: (w?.results ?? []) as Array<{ id: number; username: string; at: string }>,
    links: (l?.results ?? []) as Array<{ id: number; label: string; url: string }>,
  };
}

/** When `userId` put each of these items on their want list, and the items' purchase links: one D1 call, for the want-list page. */
export async function wantListExtras(
  d1: D1Database,
  userId: number,
  itemIds: number[],
): Promise<{ since: Map<number, string>; links: Map<number, Array<{ id: number; label: string; url: string }>> }> {
  const since = new Map<number, string>();
  const links = new Map<number, Array<{ id: number; label: string; url: string }>>();
  if (!itemIds.length) return { since, links };
  const ids = JSON.stringify(itemIds);
  const [w, l] = await d1.batch([
    d1.prepare('SELECT item_id AS itemId, created_at AS at FROM wants WHERE user_id = ?1 AND item_id IN (SELECT value FROM json_each(?2))').bind(userId, ids),
    d1.prepare('SELECT item_id AS itemId, id, label, url FROM purchase_links WHERE item_id IN (SELECT value FROM json_each(?1)) ORDER BY item_id, id').bind(ids),
  ]);
  for (const r of (w?.results ?? []) as Array<{ itemId: number; at: string }>) since.set(r.itemId, r.at);
  for (const { itemId, ...link } of (l?.results ?? []) as Array<{ itemId: number; id: number; label: string; url: string }>) {
    links.set(itemId, [...(links.get(itemId) ?? []), link]);
  }
  return { since, links };
}

/**
 * What the public item route checks an item against, whatever kind of share it is (itemMatchesShare): its tags, and
 * who wants it. One D1 call, the same work for every id — an item that doesn't exist costs what one outside the view does.
 */
export async function shareGuardFacts(d1: D1Database, itemId: number): Promise<{ tags: string[]; wanters: number[] }> {
  const [t, w] = await d1.batch([
    // no ORDER BY, as tagsForItems() had none: a shelf's share page lists an item's tags as it always did
    d1.prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ?1').bind(itemId),
    d1.prepare('SELECT user_id AS id FROM wants WHERE item_id = ?1').bind(itemId),
  ]);
  return {
    tags: ((t?.results ?? []) as Array<{ name: string }>).map((r) => r.name),
    wanters: ((w?.results ?? []) as Array<{ id: number }>).map((r) => r.id),
  };
}

/**
 * A gift list's page's two facts in one D1 call: its items' purchase links, oldest first, and the name its member goes
 * by in public — their display name only while names are on for share pages (the instance's default when no admin has
 * set it, §16 #49), else null; never a username.
 */
export async function giftExtras(
  d1: D1Database,
  userId: number,
  itemIds: number[],
): Promise<{ owner: string | null; links: Map<number, Array<{ id: number; label: string; url: string }>> }> {
  const [o, l] = await d1.batch([
    d1
      .prepare(
        `SELECT u.display_name AS name, coalesce((SELECT names_on_shares FROM site_settings WHERE id = 1), ?2) AS on_
         FROM users u WHERE u.id = ?1`,
      )
      .bind(userId, SITE_DEFAULTS.namesOnShares ? 1 : 0),
    d1
      .prepare('SELECT item_id AS itemId, id, label, url FROM purchase_links WHERE item_id IN (SELECT value FROM json_each(?1)) ORDER BY item_id, id')
      .bind(JSON.stringify(itemIds)),
  ]);
  const row = (o?.results ?? [])[0] as { name: string | null; on_: number } | undefined;
  const links = new Map<number, Array<{ id: number; label: string; url: string }>>();
  for (const { itemId, ...link } of (l?.results ?? []) as Array<{ itemId: number; id: number; label: string; url: string }>) {
    links.set(itemId, [...(links.get(itemId) ?? []), link]);
  }
  return { owner: row?.on_ && row.name ? row.name : null, links };
}

export type AddLinkResult = 'added' | 'duplicate' | 'full' | 'missing';

/** Adds a checked purchase link to an item — any member may. At most MAX_LINKS_PER_ITEM, and an address once. */
export async function addPurchaseLink(d1: D1Database, itemId: number, link: LinkDraft): Promise<AddLinkResult> {
  const res = await d1
    .prepare(
      `INSERT INTO purchase_links (item_id, label, url)
       SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)
         AND (SELECT count(*) FROM purchase_links WHERE item_id = ?1) < ${MAX_LINKS_PER_ITEM}
       ON CONFLICT DO NOTHING`,
    )
    .bind(itemId, link.label, link.url)
    .run();
  if (res.meta.changes > 0) return 'added';
  const row = await d1
    .prepare(`SELECT EXISTS (SELECT 1 FROM items WHERE id = ?1) AS item, EXISTS (SELECT 1 FROM purchase_links WHERE item_id = ?1 AND url = ?2) AS dup`)
    .bind(itemId, link.url)
    .first<{ item: number; dup: number }>();
  return !row?.item ? 'missing' : row.dup ? 'duplicate' : 'full';
}

/** Removes one of an item's purchase links — any member may. */
export async function deletePurchaseLink(d1: D1Database, itemId: number, linkId: number): Promise<void> {
  await d1.prepare('DELETE FROM purchase_links WHERE id = ?1 AND item_id = ?2').bind(linkId, itemId).run();
}

/**
 * The item already in the catalog that a scan or search result names, if any — "Want" on it then adds a want there
 * rather than a second copy (§16 #53). A book by its ISBN-13; a record by its barcode (in isbn13 or isbn10_upc, digits
 * only) or its Discogs release id; a board game by its BGG id. Ids in details compare as text, whatever JSON type they
 * were stored as. The oldest match, or null. One query.
 */
export async function existingForWant(
  d1: D1Database,
  c: { mediaType: MediaType; isbn13?: string | null; isbn10Upc?: string | null; details: Record<string, unknown> },
): Promise<number | null> {
  const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '') || null;
  const idOf = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^\d{1,15}$/.test(v)) ? String(v) : null;
  const music = c.mediaType === 'vinyl' || c.mediaType === 'music';
  const isbn = c.mediaType === 'book' ? digits(c.isbn13) : null;
  const barcode = music ? (digits(c.isbn10Upc) ?? digits(c.isbn13)) : null;
  const discogs = music ? idOf(c.details['discogs_id']) : null;
  const bgg = c.mediaType === 'boardgame' ? idOf(c.details['bgg_id']) : null;
  if (!isbn && !barcode && !discogs && !bgg) return null;
  const row = await d1
    .prepare(
      `SELECT id FROM items WHERE
         (?1 IS NOT NULL AND isbn13 = ?1)
         OR (?2 IS NOT NULL AND media_type IN ('vinyl', 'music') AND (isbn10_upc = ?2 OR isbn13 = ?2))
         OR (?3 IS NOT NULL AND media_type IN ('vinyl', 'music') AND CAST(json_extract(details, '$.discogs_id') AS TEXT) = ?3)
         OR (?4 IS NOT NULL AND media_type = 'boardgame' AND CAST(json_extract(details, '$.bgg_id') AS TEXT) = ?4)
       ORDER BY id LIMIT 1`,
    )
    .bind(isbn, barcode, discogs, bgg)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export type ExportCells = {
  tags: Map<number, string[]>;
  progress: Map<number, ProgressEntry[]>;
  reads: Map<number, Array<ReadRow & { reader: string | null }>>;
  reviews: Map<number, Array<ReviewDraft & { by: string | null }>>;
  loans: Map<number, LoanDraft[]>;
  // with a loan limit: the item the loans stopped at, which may be missing some (loansForIdRange's cutAt, §16 #57)
  loanCutAt: number | null;
  plays: Map<number, CellPlay[]>;
  series: Map<number, Series>; // every series an item in the range belongs to, by id (§16 #52)
  wants: Map<number, Array<{ by: string; at: string }>>; // each want's member by username (§16 #53)
  links: Map<number, LinkDraft[]>;
};

/**
 * Everything an export page writes beside its items, for every item whose id lies in [fromId, toId] — tags, the reading
 * log, reads and reviews with their people, loans (§16 #57), plays (§16 #54), series (§16 #52), wants and purchase
 * links (§16 #53) — in ONE D1 call, a batch of nine statements, where it took eight calls before want lists and would
 * have taken nine with them. A page is then two calls with its items (three for an item with more loans than a page
 * carries, which goes out alone), so the streamed export stays well inside the 50-call design budget (§16 #37). Each
 * statement is the one its single-purpose twin runs — loans with the same `limit`, so a page ends where it did —
 * rows from other shelves skipped in SQL for a scoped export, ordered as they order them; a test holds the two paths
 * to the same answer. Series are those of the items in the range: the page is exactly the items of its scope in it.
 */
export async function exportCellsForIdRange(
  d1: D1Database,
  fromId: number,
  toId: number,
  libraryId?: number,
  loanLimit?: number,
): Promise<ExportCells> {
  const scoped = (col: string) => (libraryId ? `AND ${col} IN (SELECT id FROM items WHERE library_id = ?3)` : '');
  const bind = (sql: string) => (libraryId ? d1.prepare(sql).bind(fromId, toId, libraryId) : d1.prepare(sql).bind(fromId, toId));
  const results = await d1.batch([
    bind(
      `SELECT it.item_id AS itemId, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
       WHERE it.item_id BETWEEN ?1 AND ?2 ${scoped('it.item_id')}`,
    ),
    bind(
      `SELECT item_id AS itemId, id, page, at, added_by AS addedBy, read_id AS readId FROM reading_progress
       WHERE item_id BETWEEN ?1 AND ?2 ${scoped('item_id')} ORDER BY at, id`,
    ),
    bind(readsRangeSql(scoped('r.item_id'))),
    bind(reviewsRangeSql(scoped('v.item_id'))),
    loansRangeStatement(d1, fromId, toId, libraryId, loanLimit),
    bind(playsRangeSql(scoped('p.item_id'))),
    bind(
      `SELECT s.id, s.name, s.key, s.total, s.created_at AS createdAt FROM series s
       WHERE s.id IN (SELECT series_id FROM items WHERE id BETWEEN ?1 AND ?2 ${libraryId ? 'AND library_id = ?3' : ''})`,
    ),
    bind(
      `SELECT w.item_id AS itemId, u.username AS by, w.created_at AS at FROM wants w JOIN users u ON u.id = w.user_id
       WHERE w.item_id BETWEEN ?1 AND ?2 ${scoped('w.item_id')} ORDER BY w.item_id, w.created_at, u.id`,
    ),
    bind(`SELECT item_id AS itemId, label, url FROM purchase_links WHERE item_id BETWEEN ?1 AND ?2 ${scoped('item_id')} ORDER BY item_id, id`),
  ]);
  const rowsOf = <T,>(i: number) => (results[i]?.results ?? []) as Array<T & { itemId: number }>;
  const group = <T, U>(rows: Array<T & { itemId: number }>, pick: (r: T & { itemId: number }) => U) => {
    const out = new Map<number, U[]>();
    for (const r of rows) out.set(r.itemId, [...(out.get(r.itemId) ?? []), pick(r)]);
    return out;
  };
  const loans = groupLoans(rowsOf<LoanDraft>(4), loanLimit);
  return {
    tags: group(rowsOf<{ name: string }>(0), (r) => r.name),
    progress: group(rowsOf<ProgressEntry>(1), (r) => ({ id: r.id, page: r.page, at: r.at, addedBy: r.addedBy, readId: r.readId })),
    reads: group(rowsOf<ReadRow & { reader: string | null }>(2), (r) => ({ id: r.id, status: r.status, beganOn: r.beganOn, endedOn: r.endedOn, reader: r.reader })),
    reviews: group(rowsOf<ReviewDraft & { by: string | null }>(3), ({ itemId: _i, ...review }) => review),
    loans: loans.loans,
    loanCutAt: loans.cutAt,
    plays: group(rowsOf<{ playedOn: string; by: string | null }>(5), (r) => ({ playedOn: r.playedOn, by: r.by })),
    series: new Map(((results[6]?.results ?? []) as Series[]).map((r) => [r.id, r])),
    wants: group(rowsOf<{ by: string; at: string }>(7), (r) => ({ by: r.by, at: r.at })),
    links: group(rowsOf<LinkDraft>(8), (r) => ({ label: r.label, url: r.url })),
  };
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
 * Records a page `reader` reached, in their open read. One batch, so the page, its read and the copy on `items`
 * can't disagree. Someone with no reads of the book gets their first, opened today, because recording a page is what
 * starting a book looks like (§16 #34); an open read with no start date takes today's, as before. Someone who has
 * finished or stopped it, with no read open, records nothing — reading it again is a deliberate "Read again" first
 * (§16 #41). Anyone else's reads don't matter. True when the page was recorded.
 */
export async function addProgress(d1: D1Database, itemId: number, page: number, reader: number | null): Promise<boolean> {
  const results = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reads (item_id, reader_id, status, began_on)
         SELECT ?1, ?2, 'in_progress', date('now')
         WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1) AND NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1 AND reader_id IS ?2)`,
      )
      .bind(itemId, reader),
    d1
      .prepare(
        `UPDATE reads SET began_on = date('now')
         WHERE item_id = ?1 AND reader_id IS ?2 AND status = 'in_progress' AND (began_on IS NULL OR trim(began_on) = '')`,
      )
      .bind(itemId, reader),
    adoptOrphanPages(d1, itemId, reader),
    d1
      .prepare(
        `INSERT INTO reading_progress (item_id, page, added_by, read_id)
         SELECT ?1, ?3, ?2, id FROM reads WHERE item_id = ?1 AND reader_id IS ?2 AND status = 'in_progress' LIMIT 1`,
      )
      .bind(itemId, reader, page),
    // updated_at is deliberately untouched: connections see it, and a page is its own entry, not an edit of the book
    refreshReadState(d1, [itemId]),
  ]);
  return (results[3]?.meta.changes ?? 0) > 0;
}

/** A page's person: its read's reader, or — for a page from before reads — whoever recorded it. */
const pageOwner = (p: string) => `CASE WHEN ${p}.read_id IS NULL THEN ${p}.added_by ELSE (SELECT r.reader_id FROM reads r WHERE r.id = ${p}.read_id) END`;

/** One page of an item, with its person — what a route checks the actor against. */
export async function getProgressEntry(d1: D1Database, itemId: number, entryId: number): Promise<(ProgressEntry & { ownerId: number | null }) | null> {
  return d1
    .prepare(
      `SELECT p.id, p.page, p.at, p.added_by AS addedBy, p.read_id AS readId, ${pageOwner('p')} AS ownerId
       FROM reading_progress p WHERE p.id = ?1 AND p.item_id = ?2`,
    )
    .bind(entryId, itemId)
    .first<ProgressEntry & { ownerId: number | null }>();
}

/**
 * Removes one entry — a typo, usually — by its person or an admin, and puts `items.progress_page` back to whatever
 * the newest remaining entry says, or to NULL when that was the only one. Its read stays: deleting a mistyped page is
 * not the same as saying you never started the book. True when it went.
 */
export async function deleteProgress(d1: D1Database, itemId: number, entryId: number, by: Actor): Promise<boolean> {
  const mayDelete = `EXISTS (SELECT 1 FROM reading_progress p WHERE p.id = ?1 AND p.item_id = ?2 AND ${allowed(pageOwner('p'), '?3', '?4')})`;
  const binds = [entryId, itemId, ...actorBinds(by)];
  const results = await d1.batch([
    // its feed entry first: activity_log.progress_id references the update without a cascade
    // (SQLite can't add one by ALTER TABLE), and connections learn it's gone from the removal check
    d1.prepare(`DELETE FROM activity_log WHERE progress_id = ?1 AND ${mayDelete}`).bind(...binds),
    d1.prepare(`DELETE FROM reading_progress WHERE id = ?1 AND item_id = ?2 AND ${mayDelete}`).bind(...binds),
    refreshReadState(d1, [itemId]),
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
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

// ---------- plays (ARCH.md §16 #54) ----------
//
// The household's play log for board games and records. A play is one row and nothing depends on it: no item column
// summarizes plays and no trigger watches them, so a play is its own one-statement write — no refresh rides with it,
// and it never reaches connections. `logged_by` decides who may remove a play: whoever logged it, or an admin.

export type PlayEntry = { id: number; playedOn: string; loggedBy: number | null };

/** The SQL list of the media types that take plays, for a statement that checks it itself. */
const PLAYABLE_SQL = PLAYABLE_TYPES.map((t) => `'${t}'`).join(', ');

/**
 * An item's plays, newest first — `limit` of them from `offset` — and how many it has in all, in one D1 call: the count
 * rides on every row, so no plays at all is simply no rows and a count of 0. The item page asks for the first few; its
 * plays page for a page at a time.
 */
export async function playLog(d1: D1Database, itemId: number, limit = RECENT_PLAYS, offset = 0): Promise<{ count: number; plays: PlayEntry[] }> {
  const { results } = await d1
    .prepare(
      `SELECT id, played_on AS playedOn, logged_by AS loggedBy, (SELECT count(*) FROM plays WHERE item_id = ?1) AS total
       FROM plays WHERE item_id = ?1 ORDER BY played_on DESC, id DESC LIMIT ?2 OFFSET ?3`,
    )
    .bind(itemId, limit, offset)
    .all<PlayEntry & { total: number }>();
  // an offset past the end has no rows to carry the count: ask once more, rather than call a page of nothing "0 plays"
  const count = results[0]?.total ?? (offset > 0 ? await playCount(d1, itemId) : 0);
  return { count, plays: results.map(({ id, playedOn, loggedBy }) => ({ id, playedOn, loggedBy })) };
}

/** How many times the household has played an item — all a share page may say of its plays (§9). */
export async function playCount(d1: D1Database, itemId: number): Promise<number> {
  const row = await d1.prepare('SELECT count(*) AS n FROM plays WHERE item_id = ?1').bind(itemId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Logs a play of a board game or a record on `playedOn`, by `loggedBy`. The statement checks for itself that the item
 * takes plays and has room for one more, so a hand-made request for a book logs nothing. True when a play was logged.
 */
export async function logPlay(d1: D1Database, itemId: number, playedOn: string, loggedBy: number): Promise<boolean> {
  const res = await d1
    .prepare(
      `INSERT INTO plays (item_id, played_on, logged_by)
       SELECT ?1, ?2, ?3
       WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1 AND media_type IN (${PLAYABLE_SQL}))
         AND (SELECT count(*) FROM plays WHERE item_id = ?1) < ${MAX_PLAYS_PER_ITEM}`,
    )
    .bind(itemId, playedOn, loggedBy)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** One play of an item, or null — what a route checks the actor against before it says why a removal was refused. */
export async function getPlay(d1: D1Database, itemId: number, playId: number): Promise<PlayEntry | null> {
  return d1
    .prepare('SELECT id, played_on AS playedOn, logged_by AS loggedBy FROM plays WHERE id = ?1 AND item_id = ?2')
    .bind(playId, itemId)
    .first<PlayEntry>();
}

/** Removes a play — one the actor logged, or any for an admin. A play whose logger was removed since is an admin's to remove. */
export async function deletePlay(d1: D1Database, itemId: number, playId: number, by: Actor): Promise<boolean> {
  const res = await d1
    .prepare(`DELETE FROM plays WHERE id = ?1 AND item_id = ?2 AND ${allowed('logged_by', '?3', '?4')}`)
    .bind(playId, itemId, ...actorBinds(by))
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Plays for every item whose id lies in [fromId, toId], oldest first, with who logged each by username — as readsForIdRange. */
/** playsForIdRange's statement, shared with exportCellsForIdRange. */
const playsRangeSql = (scoped: string) =>
  `SELECT p.item_id AS itemId, p.played_on AS playedOn, u.username AS by
   FROM plays p LEFT JOIN users u ON u.id = p.logged_by
   WHERE p.item_id BETWEEN ?1 AND ?2 ${scoped}
   ORDER BY p.item_id, p.played_on, p.id`;

export async function playsForIdRange(
  d1: D1Database,
  fromId: number,
  toId: number,
  libraryId?: number,
): Promise<Map<number, CellPlay[]>> {
  const stmt = d1.prepare(playsRangeSql(libraryId ? 'AND p.item_id IN (SELECT id FROM items WHERE library_id = ?3)' : ''));
  const rows = (
    await (libraryId ? stmt.bind(fromId, toId, libraryId) : stmt.bind(fromId, toId)).all<{ itemId: number; playedOn: string; by: string | null }>()
  ).results;
  const result = new Map<number, CellPlay[]>();
  for (const { itemId, playedOn, by } of rows) {
    const list = result.get(itemId) ?? [];
    list.push({ playedOn, by });
    result.set(itemId, list);
  }
  return result;
}

/**
 * Inserts `plays` for an item inserted earlier in the same batch, in list order. A play that names nobody is
 * `person`'s — whoever imports it.
 */
function playInsertStatements(d1: D1Database, plays: PersonPlay[], person: number | null): D1PreparedStatement[] {
  if (!plays.length) return [];
  const json = JSON.stringify(
    plays.slice(0, MAX_PLAYS_PER_ITEM).map((p) => ({ on: p.playedOn, by: p.loggedBy === undefined ? person : p.loggedBy })),
  );
  return [
    d1
      .prepare(
        `INSERT INTO plays (item_id, played_on, logged_by)
         SELECT (SELECT max(id) FROM items), json_extract(value, '$.on'), json_extract(value, '$.by')
         FROM json_each(?1) ORDER BY key`,
      )
      .bind(json),
  ];
}

// ---------- reading goals (ARCH.md §16 #49) ----------

/**
 * How many books the member of goal row `g` has finished in its year: each finished read of a book (not a record or a
 * game) by them with its end date in that year — re-reads included, an undated finish not. Worked out when asked, so a
 * read added, corrected, moved or deleted counts at once. Migration 0036's milestone triggers carry the same
 * expression, and a test holds the two together.
 */
export const goalCountSql = (g: string) => `(SELECT count(*) FROM reads r JOIN items i ON i.id = r.item_id
  WHERE r.reader_id = ${g}.user_id AND r.status = 'completed' AND i.media_type = 'book'
    AND CAST(substr(r.ended_on, 1, 4) AS INTEGER) = ${g}.year)`;

export type GoalProgress = { id: number; userId: number; year: number; target: number; count: number };

const GOAL_COLUMNS = `g.id, g.user_id AS userId, g.year, g.target, ${goalCountSql('g')} AS count`;

/** A member's goals, newest year first, each with where it stands. */
export async function goalsOf(d1: D1Database, userId: number): Promise<GoalProgress[]> {
  const { results } = await d1
    .prepare(`SELECT ${GOAL_COLUMNS} FROM reading_goals g WHERE g.user_id = ?1 ORDER BY g.year DESC`)
    .bind(userId)
    .all<GoalProgress>();
  return results;
}

/** A member's goal for one year, with where it stands — the Overview's one call — or null. */
export async function goalOf(d1: D1Database, userId: number, year: number): Promise<GoalProgress | null> {
  return d1
    .prepare(`SELECT ${GOAL_COLUMNS} FROM reading_goals g WHERE g.user_id = ?1 AND g.year = ?2`)
    .bind(userId, year)
    .first<GoalProgress>();
}

/** One goal, or null — what a route checks the actor against before it says why a change was refused. */
export async function getGoal(d1: D1Database, id: number): Promise<GoalProgress | null> {
  return d1.prepare(`SELECT ${GOAL_COLUMNS} FROM reading_goals g WHERE g.id = ?1`).bind(id).first<GoalProgress>();
}

/**
 * Sets `userId`'s goal for `year` to `target` books — a new goal, or a new target for the one there. Members set their
 * own, admins anyone's: checked here as well as in the route (§16 #43's Actor rule), so a hand-made request changes
 * nothing. A target saved unchanged changes nothing either. True when the goal now stands at that target.
 *
 * For connections (§16 #49), in the same batch (§16 #39): a new goal or a new target is news as it happens — a
 * `goal_set` entry with the target and the count now, re-keyed if there was one, so a connection holding the old one
 * withdraws it and pulls the new — recorded only while a connection view exists, like every per-person entry. The
 * old target's milestones go: "reached" a goal that now asks for more isn't true. The entry goes out only while
 * goals and names go to connections and the member has a display name (memberStillShows); recorded regardless.
 */
export async function setGoal(d1: D1Database, userId: number, year: number, target: number, by: Actor): Promise<boolean> {
  const results = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reading_goals (user_id, year, target)
         SELECT ?1, ?2, ?3 WHERE ${allowed('?1', '?4', '?5')} AND EXISTS (SELECT 1 FROM users WHERE id = ?1)
         ON CONFLICT (user_id, year) DO UPDATE SET target = excluded.target, updated_at = datetime('now')
           WHERE reading_goals.target <> excluded.target`,
      )
      .bind(userId, year, target, ...actorBinds(by)),
    // straight after the goal's write: `changes()` is that statement's — no entry for a goal refused or unchanged
    d1
      .prepare(
        `INSERT OR REPLACE INTO member_activity (kind, at, goal_id, goal_target, goal_count)
         SELECT 'goal_set', datetime('now'), g.id, g.target, ${goalCountSql('g')}
         FROM reading_goals g WHERE g.user_id = ?1 AND g.year = ?2 AND changes() > 0 AND EXISTS (SELECT 1 FROM connection_views)`,
      )
      .bind(userId, year),
    d1
      .prepare(
        `DELETE FROM member_activity WHERE kind IN ('goal_halfway', 'goal_reached')
           AND goal_id IN (SELECT id FROM reading_goals WHERE user_id = ?1 AND year = ?2 AND target IS NOT member_activity.goal_target)
           AND ${allowed('?1', '?3', '?4')}`,
      )
      .bind(userId, year, ...actorBinds(by)),
    d1
      .prepare(`SELECT 1 AS ok FROM reading_goals WHERE user_id = ?1 AND year = ?2 AND target = ?3 AND ${allowed('?1', '?4', '?5')}`)
      .bind(userId, year, target, ...actorBinds(by)),
  ]);
  return (results.at(-1)?.results.length ?? 0) > 0;
}

/** Deletes a goal, by its member or an admin. True when it went. */
export async function deleteGoal(d1: D1Database, id: number, by: Actor): Promise<boolean> {
  const result = await d1
    .prepare(`DELETE FROM reading_goals WHERE id = ?1 AND ${allowed('user_id', '?2', '?3')}`)
    .bind(id, ...actorBinds(by))
    .run();
  return result.meta.changes > 0;
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
 * column, a Goodreads row); otherwise they come from its status and dates, as a libib row's do. `reviews` likewise
 * (a Nalanda export's `reviews` column); otherwise its rating and review are one review. Whatever doesn't name its
 * person is the importer's — the row's added_by (§16 #43). `loans` are a Nalanda export's, every one restored onto
 * the item the row makes (§16 #57).
 */
export type ImportRow = {
  item: NewItem;
  tags: string[];
  reads?: PersonRead[];
  reviews?: PersonReview[];
  loans?: LoanDraft[];
  // a Nalanda export's `plays` (§16 #54); any other file brings none
  plays?: PersonPlay[];
  goodreads?: GoodreadsReading;
  series?: SeriesDraft | null; // its series, and the series' total when the file gives one (§16 #52)
  // a Nalanda export's want lists and purchase links (§16 #53), each want already resolved to a member here
  wants?: PersonWant[];
  links?: LinkDraft[];
};

/**
 * Batched insert used by /api/import. One network round trip per batch of rows: each item goes in with the
 * reading state its reads decide and the rating and review its reviews decide, so the insert trigger dates it
 * right, then its reads and reviews, then the refreshes that fill in what only they know, then its loans and its
 * plays, which nothing on the item depends on (§16 #54). Loans go only onto the item their row makes, never onto one
 * already here.
 */
export async function importItems(d1: D1Database, rows: ImportRow[]): Promise<number> {
  if (!rows.length) return 0;
  const writes: D1PreparedStatement[] = [];
  const itemAt: number[] = []; // each row's item insert, as an index into the batch's results
  for (const r of rows) {
    const person = r.item.addedBy ?? null;
    const reads = oneOpenReadEach(r.reads ?? readsFromColumns(r.item.status ?? 'not_started', r.item.beganOn, r.item.completedOn), person).reads;
    const reviews = stampReviews(r.reviews ?? reviewsFromColumns(r.item));
    const q = db(d1)
      .insert(s.items)
      .values(withSeries(withReviewState(withReadState(r.item, reads), reviews), r.series))
      .returning({ id: s.items.id })
      .toSQL();
    writes.push(...seriesUpsert(d1, r.series));
    itemAt.push(writes.length + 1); // +1: the marker leads the batch
    writes.push(
      d1.prepare(q.sql).bind(...q.params),
      ...readInsertStatements(d1, 'newest', reads, person),
      refreshReadState(d1, 'newest'),
      ...reviewInsertStatements(d1, 'newest', reviews, person),
      refreshReviewState(d1, 'newest'),
      ...loanInsertStatements(d1, r.loans ?? []),
      ...playInsertStatements(d1, r.plays ?? [], person),
      ...wantInsertStatements(d1, 'newest', r.wants ?? []),
      ...linkInsertStatements(d1, 'newest', r.links ?? []),
    );
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
 *
 * A Goodreads file is one person's (§16 #43): the importer's, every row's added_by. Its reads are reconciled with
 * theirs alone, and its rating and review are theirs — someone else's reads and reviews of the same book are
 * never touched. Private notes stay the item's own, as before.
 */
export async function mergeImportItems(d1: D1Database, rows: ImportRow[], dryRun = false): Promise<MergeImportResult> {
  if (!rows.length) return { inserted: 0, merged: 0, reads: 0 };
  const dbi = db(d1);
  const person = rows[0]!.item.addedBy ?? null;

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

  // the importer's reads already here for the books that matched: one query, the ids as one JSON parameter
  const readsHere = new Map<number, ReadRow[]>();
  if (merges.length) {
    const found = await d1
      .prepare(
        `SELECT item_id AS itemId, id, status, began_on AS beganOn, ended_on AS endedOn FROM reads
         WHERE item_id IN (SELECT value FROM json_each(?1)) AND reader_id IS ?2 ORDER BY id`,
      )
      .bind(JSON.stringify([...new Set(merges.map((m) => m.id))]), person)
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
    writes.push(...readInsertStatements(d1, itemId, fresh, person));
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
      // changed are touched by the refresh, a note is written only when it differs, and the importer's rating and
      // review only when they differ — the item then moves only if the household's summary of them did.
      const touched = ids.filter((id) => work.get(id)?.some((r) => r.changed));
      const untouched = ids.filter((id) => !touched.includes(id));
      const notes = merges
        .filter((m) => m.set.notes)
        .map((m) => {
          const q = dbi
            .update(s.items)
            .set({ notes: m.set.notes, updatedAt: sql`(datetime('now'))` })
            .where(and(eq(s.items.id, m.id), sql`${s.items.notes} IS NOT ${m.set.notes}`))
            .toSQL();
          return d1.prepare(q.sql).bind(...q.params);
        });
      const reviews = merges
        .filter((m) => m.set.rating != null || m.set.review)
        .flatMap((m) => reviewWriteStatements(d1, m.id, person, { rating: m.set.rating ?? null, review: m.set.review ?? null }, 'merge'));
      const refreshes = [
        ...(touched.length ? [refreshReadState(d1, touched, { touch: true })] : []),
        ...(untouched.length ? [refreshReadState(d1, untouched)] : []),
      ];
      // reads and their refresh first, so a rating merged in the same batch is dated by the finish it arrived with
      await d1.batch(asImport(d1, [...writes, ...refreshes, ...reviews, ...notes, refreshReviewState(d1, ids)]));
      const pairs: Array<{ itemId: number; tag: string }> = [];
      for (const m of merges) for (const tag of normalizeTags(m.tags)) pairs.push({ itemId: m.id, tag });
      await linkTags(dbi, pairs);
    }
    await importItems(d1, inserts);
  }
  return { inserted: inserts.length, merged: merges.length, reads: readChanges };
}
