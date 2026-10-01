// All D1 access lives here (plus src/lib/covers.ts for R2) — ARCH.md §13.
import { and, asc, count, desc, eq, getTableColumns, gt, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
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
  todayUtc,
} from '../lib/reads';
import { countName, nameKey, sortNames, splitCreators, type NameCount } from '../lib/creators';
import { MAX_EDITIONS_PER_ITEM, type EditionDraft } from '../lib/formats';
import { DEFAULT_LANGUAGE, isLanguageCode } from '../lib/language';
import { MAX_PROGRESS_PER_READ } from '../lib/progress';
import { MAX_QUOTES_PER_ITEM, type CellQuote, type KindleBook, type PersonQuote, type QuoteDraft } from '../lib/quotes';
import { ftsMatch, parseSearch } from '../lib/search';
import { FEWEST_PLAYERS, WEIGHT_BANDS, type GameFilters } from '../lib/games';
import { MAX_LINKS_PER_ITEM, type LinkDraft } from '../lib/links';
import { MAX_LOANS_PER_CELL, type LoanDraft } from '../lib/loans';
import { MAX_PLAYS_PER_ITEM, PLAYABLE_TYPES, RECENT_PLAYS, type CellPlay, type PersonPlay } from '../lib/plays';
import { reviewOrderSql, stampReviews, summarizeReviews, type PersonReview, type ReviewDraft } from '../lib/reviews';
import { isCurrencyCode, type CurrencyTotal } from '../lib/money';
import { seriesKey, type SeriesDraft } from '../lib/series';
import { emptyPlays, emptyStats, PLAYS_TOP, YEAR_TOP, yearRange, type YearReview } from '../lib/yearreview';
import * as s from './schema';
import type { Borrow, Item, ItemStatus, Library, Loan, MediaType, NewItem, ReadStatus, Series, Share, User } from './schema';

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
export async function ensureSessionKey(
  d1: D1Database,
  id: number,
): Promise<{ id: number; sessionKey: string; sessionGeneration: number } | null> {
  const unusable = `length(session_key) NOT BETWEEN 22 AND 64 OR session_key GLOB '*[^A-Za-z0-9_-]*'`;
  const row = await d1
    .prepare(
      `UPDATE users SET session_key = CASE WHEN ${unusable} THEN ?2 ELSE session_key END
       WHERE id = ?1 RETURNING id, session_key AS sessionKey, session_generation AS sessionGeneration`,
    )
    .bind(id, newSessionKey())
    .first<{ id: number; sessionKey: string; sessionGeneration: number }>();
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
  return outwardNameOf(await outwardNameStatement(d1, userId).first());
}

/** outwardName's query, for a caller's batch — the item page's (§16 #58); read its first row with outwardNameOf. */
export function outwardNameStatement(d1: D1Database, userId: number): D1PreparedStatement {
  return d1
    .prepare(
      `SELECT u.display_name AS name, coalesce((SELECT names_to_connections FROM site_settings WHERE id = 1), ?2) AS on_
       FROM users u WHERE u.id = ?1`,
    )
    .bind(userId, SITE_DEFAULTS.namesToConnections ? 1 : 0);
}

export function outwardNameOf(row: unknown): string {
  const r = row as { name: string | null; on_: number } | null | undefined;
  return r?.on_ && r.name ? r.name : 'A member';
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

/**
 * Removes a member — by `by`, an admin — never the last admin: the batch's first statement re-sets the leaving row's
 * role to itself only while `by` is still an admin here other than them (so an admin remains); else to NULL, which
 * the column's NOT NULL refuses, and D1 rolls the whole batch back, so nothing of theirs is cleared either. Two
 * admins removing each other at once would otherwise leave nobody, and /setup open to the next visitor. Without
 * `by` — a call from outside the app — an admin still goes only while another remains. False when refused.
 */
export async function deleteUser(d1: D1Database, id: number, by?: number): Promise<boolean> {
  const remains =
    by === undefined
      ? `role <> 'admin' OR EXISTS (SELECT 1 FROM users u WHERE u.role = 'admin' AND u.id <> ?1)`
      : `EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.role = 'admin' AND u.id <> ?1)`;
  const guard = d1.prepare(`UPDATE users SET role = CASE WHEN ${remains} THEN role ELSE NULL END WHERE id = ?1`).bind(...(by === undefined ? [id] : [id, by]));
  // Three references to users have no ON DELETE action (migrations 0000, 0012 and 0024, all applied — drizzle-kit
  // drops the clause on ALTER TABLE): items.added_by, reading_progress.added_by and reads.reader_id. Any of them
  // would stop a member being removed, so all are cleared in the same batch, and reviews.user_id too, which its
  // table would set null on its own. Their items, reads, pages and reviews stay, unattributed (§16 #43): the
  // household's summary on each item — status, read count, average rating — is everyone's, theirs included, so it
  // doesn't change.
  // the saved views naming them in "Read by" (§16 #81) lose that filter: ids are reused (#56), so a view saved as
  // "Read by ravi" must not list a newcomer's reads under the old name once ravi is gone
  const views = await viewsWithoutReader(d1, id);
  try {
    await d1.batch([
      guard,
      ...views,
      // first, while their reads still say whose: their named entries get new ids, so connections drop the named copies
      ...rekeyMemberActivity(d1, id),
      d1.prepare('UPDATE items SET added_by = NULL WHERE added_by = ?1').bind(id),
      d1.prepare('UPDATE reading_progress SET added_by = NULL WHERE added_by = ?1').bind(id),
      d1.prepare('UPDATE reads SET reader_id = NULL WHERE reader_id = ?1').bind(id),
      d1.prepare('UPDATE reviews SET user_id = NULL WHERE user_id = ?1').bind(id),
      d1.prepare('UPDATE quotes SET user_id = NULL WHERE user_id = ?1').bind(id), // their quotes stay, a former member's (§16 #77)
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
  } catch (err) {
    if (refusedBy(err, 'users.role')) return false;
    throw err;
  }
  return true;
}

/**
 * A new password, and the account's other sessions signed out with it (§16 #70): the generation moves on in the same
 * statement, so there is no moment with the new password and the old sessions both good. The device that changed its
 * own password re-issues its cookie from the row this returns; an admin's reset leaves the member to log in again.
 */
export async function setPassword(
  d1: D1Database,
  id: number,
  passwordHash: string,
  mustChangePassword: boolean,
): Promise<{ id: number; sessionKey: string; sessionGeneration: number } | null> {
  // their API tokens go too (§16 #88), as with "Sign out other devices": the generation would refuse them anyway, and
  // a dead token must not sit in the list or count towards the cap — one batch, both or neither
  const [moved] = await d1.batch([
    d1
      .prepare(
        `UPDATE users SET password_hash = ?2, must_change_password = ?3, session_generation = session_generation + 1
         WHERE id = ?1 RETURNING id, session_key AS sessionKey, session_generation AS sessionGeneration`,
      )
      .bind(id, passwordHash, mustChangePassword ? 1 : 0),
    d1.prepare('DELETE FROM api_tokens WHERE user_id = ?1').bind(id),
  ]);
  const row = moved?.results?.[0] as { id: number; sessionKey: string; sessionGeneration: number } | undefined;
  return row ?? null;
}

/**
 * Signs an account out everywhere but the device asking (§16 #70): its sessions' generation moves on, and the caller
 * re-issues this device's cookie from the row returned. An admin's remedy for a member's lost phone is a reset, which
 * does the same and hands out a temporary password besides.
 */
export async function signOutOtherDevices(
  d1: D1Database,
  id: number,
): Promise<{ id: number; sessionKey: string; sessionGeneration: number } | null> {
  // their API tokens go with the other devices (§16 #88): the generation check would refuse them anyway, this keeps
  // the Account page's list honest — one batch, both or neither
  const [moved] = await d1.batch([
    d1
      .prepare(
        `UPDATE users SET session_generation = session_generation + 1
         WHERE id = ?1 RETURNING id, session_key AS sessionKey, session_generation AS sessionGeneration`,
      )
      .bind(id),
    d1.prepare('DELETE FROM api_tokens WHERE user_id = ?1').bind(id),
  ]);
  const row = moved?.results?.[0] as { id: number; sessionKey: string; sessionGeneration: number } | undefined;
  return row ?? null;
}

// ---------- read-only API tokens (ARCH.md §16 #88) ----------

export const MAX_API_TOKENS = 10;
export const MAX_TOKEN_NAME = 60;
/** The API's page: items a request, by id, as the export pages (§16 #38). */
export const API_PAGE = 250;

/** Keeps a new token's hash for the account as it is now — its key and generation — at most MAX_API_TOKENS a member. The id, or null when the member has as many as allowed. */
export async function createApiToken(d1: D1Database, user: { id: number; sessionKey: string; sessionGeneration: number }, name: string, tokenHash: string): Promise<number | null> {
  const row = await d1
    .prepare(
      `INSERT INTO api_tokens (user_id, session_key, generation, name, token_hash)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE (SELECT count(*) FROM api_tokens WHERE user_id = ?1) < ?6 RETURNING id`,
    )
    .bind(user.id, user.sessionKey, user.sessionGeneration, name, tokenHash, MAX_API_TOKENS)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** A member's tokens, oldest first. Every path that moves the account's generation on deletes them, so each listed one works. */
export async function listApiTokens(d1: D1Database, userId: number): Promise<Array<{ id: number; name: string; createdAt: string }>> {
  return (await d1.prepare('SELECT id, name, created_at AS createdAt FROM api_tokens WHERE user_id = ?1 ORDER BY id').bind(userId).all<{ id: number; name: string; createdAt: string }>()).results;
}

/**
 * What the Account page shows of the member beside their tokens (§16 #88): the display name, and every token, in one
 * call — the two statements as one batch, as getUserById was one. Columns are aliased to their names in code: a raw
 * row keeps SQL's names (display_name), which the page would read past.
 */
export async function userWithTokens(d1: D1Database, userId: number): Promise<{ displayName: string | null; tokens: Array<{ id: number; name: string; createdAt: string }> }> {
  const [u, t] = await d1.batch([
    d1.prepare('SELECT display_name AS displayName FROM users WHERE id = ?1').bind(userId),
    d1.prepare('SELECT id, name, created_at AS createdAt FROM api_tokens WHERE user_id = ?1 ORDER BY id').bind(userId),
  ]);
  return {
    displayName: ((u?.results ?? [])[0] as { displayName: string | null } | undefined)?.displayName ?? null,
    tokens: (t?.results ?? []) as Array<{ id: number; name: string; createdAt: string }>,
  };
}

/** Revokes one of the member's own tokens. */
export async function revokeApiToken(d1: D1Database, userId: number, id: number): Promise<boolean> {
  const res = await d1.prepare('DELETE FROM api_tokens WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
  return res.meta.changes > 0;
}

/**
 * The account a token signs in, or null: the token's hash, then the user row it names — still the same key and the
 * same generation, as a session must be (sessionMatches) — in one call.
 */
export type TokenUser = Pick<User, 'id' | 'username' | 'role' | 'mustChangePassword' | 'sessionKey' | 'sessionGeneration'>;
export async function apiTokenUser(d1: D1Database, tokenHash: string): Promise<TokenUser | null> {
  const row = await d1
    .prepare(
      `SELECT u.id, u.username, u.role, u.must_change_password AS mustChangePassword, u.session_key AS sessionKey,
              u.session_generation AS sessionGeneration
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?1 AND u.session_key = t.session_key AND u.session_generation = t.generation`,
    )
    .bind(tokenHash)
    .first<Omit<TokenUser, 'mustChangePassword'> & { mustChangePassword: number }>();
  return row ? { ...row, mustChangePassword: !!row.mustChangePassword } : null;
}

/**
 * The API's items (§16 #88): the shelf's filters — a token sees what its member sees, "Read by" and the decluttering
 * filters included — paged by id after `afterId`, API_PAGE + 1 rows so the caller knows whether a page follows.
 */
export async function apiItems(
  d1: D1Database,
  libraryId: number | null,
  f: ItemFilters,
  reader: ReaderFilter | undefined,
  stale: StaleFilter | undefined,
  afterId: number,
): Promise<Item[]> {
  return db(d1)
    .select()
    .from(s.items)
    .where(and(itemFilterWhere(libraryId, f, reader, stale), gt(s.items.id, afterId)))
    .orderBy(asc(s.items.id))
    .limit(API_PAGE + 1);
}

// ---------- login throttling (ARCH.md §8) ----------

/** Failed password checks an address, or an account, may make in `LOGIN_ATTEMPT_WINDOW_MINUTES` before it is refused. */
export const LOGIN_ATTEMPT_LIMIT = 10;
export const LOGIN_ATTEMPT_WINDOW_MINUTES = 10;

/** A recorded attempt, to take back when the password turns out right (`forgetLoginAttempt()`). */
export type LoginAttempt = { rowid: number };

/**
 * Records a password check *before* it is made — or refuses it. One statement inserts the row only while both the
 * address and the account named are under the limit, and returns nothing once either is over: counting first, in the
 * statement that counts, is what makes a burst of guesses in parallel stop at ten, where a count followed by a check
 * and a record let every one of them through. `username` is as typed, cut to a length — an account's guesses from many
 * addresses count together, and a household's shared address locks out only the accounts guessed at. The hour-old rows
 * are pruned in the same batch, so the table stays tiny without a cron. A right password takes its row back with
 * `forgetLoginAttempt()`: only failures count.
 */
export async function recordLoginAttempt(d1: D1Database, ip: string, username: string): Promise<LoginAttempt | null> {
  const window = `-${LOGIN_ATTEMPT_WINDOW_MINUTES} minutes`;
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO login_attempts (ip, username)
         SELECT ?1, ?2
         WHERE (SELECT count(*) FROM login_attempts WHERE ip = ?1 AND attempted_at > datetime('now', ?4)) < ?3
           AND (SELECT count(*) FROM login_attempts WHERE username = ?2 AND attempted_at > datetime('now', ?4)) < ?3
         RETURNING rowid`,
      )
      .bind(ip, username.slice(0, 200), LOGIN_ATTEMPT_LIMIT, window),
    d1.prepare(`DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 hour')`),
  ]);
  const row = inserted?.results?.[0] as LoginAttempt | undefined;
  return row ?? null;
}

/** The password was right: the attempt recorded for it was no failure, and counts towards nobody's limit. */
export async function forgetLoginAttempt(d1: D1Database, attempt: LoginAttempt): Promise<void> {
  await d1.prepare('DELETE FROM login_attempts WHERE rowid = ?1').bind(attempt.rowid).run();
}

// ---------- libraries ----------

/**
 * Every shelf, with how many items it holds — one statement. The sidebar shows it on every signed-in page, so a page
 * that lists the shelves itself hands its list to page() rather than counting again (§16 #68). The counts read every
 * item's index entry once: about one row read per item, the floor of a signed-in page.
 */
export async function listLibraries(d1: D1Database): Promise<Array<Library & { itemCount: number }>> {
  return db(d1)
    .select({
      ...getTableColumns(s.libraries),
      // written out with its table: a bare "id" inside the subquery would be the item's (see OUTER_ITEM_ID)
      itemCount: sql<number>`(SELECT count(*) FROM "items" WHERE "items"."library_id" = "libraries"."id")`.mapWith(Number),
    })
    .from(s.libraries)
    .orderBy(asc(s.libraries.position), asc(s.libraries.id));
}

/**
 * A shelf's totals (§16 #61): how many items, of which types, and what the household paid for those with a price —
 * one sum per currency, never added across currencies (no exchange rates are invented). `priced` counts the items
 * with a price in any currency.
 */
export type ShelfTotals = {
  items: number;
  byType: Array<{ mediaType: MediaType; count: number }>;
  paid: CurrencyTotal[];
  priced: number;
};

/** The household's items of one type, held (copies > 0) and not (copies = 0) — the Overview's counts. */
export type Holding = { mediaType: MediaType; owned: number; notOwned: number };

type Totals = { shelves: Map<number, ShelfTotals>; currency: string | null };
type ShelfTypeRow = { libraryId: number; mediaType: MediaType; n: number; owned: number; notOwned: number };

/**
 * shelfTotals()'s batch: the items by shelf and type — with how many of them are held, which is what the Overview's
 * holdings add up — what the household paid, and its currency. The first is read in idx_items_library_type's order, so
 * it groups without a sort (§16 #68); the second reads the priced items only (idx_items_paid).
 */
function shelfTotalsStatements(d1: D1Database, libraryId?: number): D1PreparedStatement[] {
  const where = libraryId === undefined ? '' : 'WHERE library_id = ?1';
  const bind = (st: D1PreparedStatement) => (libraryId === undefined ? st : st.bind(libraryId));
  return [
    bind(
      d1.prepare(
        `SELECT library_id AS libraryId, media_type AS mediaType, count(*) AS n,
           sum(CASE WHEN copies > 0 THEN 1 ELSE 0 END) AS owned, sum(CASE WHEN copies = 0 THEN 1 ELSE 0 END) AS notOwned
         FROM items ${where} GROUP BY library_id, media_type`,
      ),
    ),
    bind(
      d1.prepare(
        `SELECT library_id AS libraryId, purchase_currency AS currency, count(*) AS n, CAST(sum(purchase_price) AS TEXT) AS total
         FROM items ${where ? `${where} AND` : 'WHERE'} typeof(purchase_price) = 'integer' AND purchase_price >= 0
           AND purchase_currency GLOB '[A-Z][A-Z][A-Z]'
         GROUP BY library_id, purchase_currency`,
      ),
    ),
    d1.prepare('SELECT currency FROM site_settings WHERE id = 1'),
  ];
}

/**
 * Totals for one shelf, or for every shelf (keyed by shelf id), and the household's currency they're shown against.
 * Summed in SQL, in one D1 call: a batch of two grouped reads and the setting. A sum leaves SQLite as text, so a total
 * is exact however large it grows (formatMoney() takes text).
 */
export async function shelfTotals(d1: D1Database, libraryId?: number): Promise<Totals> {
  return readShelfTotals(await d1.batch(shelfTotalsStatements(d1, libraryId)));
}

/** How many loans are out, and how many of those are overdue by a day — counted in SQL, so exact however many are out. */
export type LoanCounts = { open: number; overdue: number };

/**
 * The statement behind LoanCounts, for a page's batch: the open loans, and those due before `today` (the device's
 * day, §16 #69). The Overview and the Loans page once counted activeLoans()'s list, which stops at the newest
 * ACTIVE_LOANS_SHOWN, so past that both stats under-reported, and an older loan — the likeliest overdue — was never
 * counted. sum() over a comparison is NULL with no rows: coalesced.
 */
const loanCountsStatement = (d1: D1Database, today: string): D1PreparedStatement =>
  d1.prepare('SELECT count(*) AS open, coalesce(sum(due_on < ?1), 0) AS overdue FROM loans WHERE returned_on IS NULL').bind(today);

const readLoanCounts = (r: D1Result | undefined): LoanCounts => {
  const row = (r?.results ?? [])[0] as Partial<LoanCounts> | undefined;
  return { open: row?.open ?? 0, overdue: row?.overdue ?? 0 };
};

/** The open loans and how many are overdue by `today`, one call — the Loans page's heading, whatever its table lists. */
export async function loanCounts(d1: D1Database, today: string): Promise<LoanCounts> {
  return readLoanCounts(await loanCountsStatement(d1, today).all());
}

type Shelves = { shelves: Array<Library & { itemCount: number }>; totals: Totals; holdings: Holding[]; views: SavedView[] };

/**
 * Every shelf with its count, every shelf's totals and the household's holdings by type, in one D1 call (§16 #68).
 * The Overview and a shelf's page each read listLibraries() and shelfTotals() — two passes over every item — and the
 * Overview a third for holdingsByType(); this reads one. A shelf's count is the sum of its types', which is exactly
 * what listLibraries() counts; holdings are holdingsByType()'s, in its order. Given `today`, the loans out and how
 * many are overdue by it join the batch too (`loans`) — the Overview's stats, at no further call.
 */
export async function shelvesWithTotals(d1: D1Database): Promise<Shelves>;
export async function shelvesWithTotals(d1: D1Database, today: string): Promise<Shelves & { loans: LoanCounts }>;
export async function shelvesWithTotals(d1: D1Database, today?: string): Promise<Shelves & { loans?: LoanCounts }> {
  const [libraries, ...rest] = await d1.batch([
    d1.prepare('SELECT id, name, position, share_token AS shareToken, created_at AS createdAt FROM libraries ORDER BY position, id'),
    ...shelfTotalsStatements(d1),
    // every shelf's saved views (§16 #81), in the same batch: the shelf page and the Overview both list them
    d1.prepare(SAVED_VIEWS_SQL),
    ...(today === undefined ? [] : [loanCountsStatement(d1, today)]),
  ]);
  const totals = readShelfTotals(rest);
  const shelves = ((libraries?.results ?? []) as Library[]).map((l) => ({ ...l, itemCount: totals.shelves.get(l.id)?.items ?? 0 }));
  return {
    shelves,
    totals,
    holdings: holdingsOf((rest[0]?.results ?? []) as ShelfTypeRow[]),
    views: (rest[3]?.results ?? []) as SavedView[],
    ...(today === undefined ? {} : { loans: readLoanCounts(rest[4]) }),
  };
}

/**
 * holdingsByType()'s answer from the shelves' type rows: summed across shelves, most items first, and types holding as
 * many in descending media_type order — the order SQLite gave that query's ties before it said so (§16 #68).
 */
function holdingsOf(rows: ShelfTypeRow[]): Holding[] {
  const byType = new Map<MediaType, Holding & { n: number }>();
  for (const r of rows) {
    const h = byType.get(r.mediaType) ?? { mediaType: r.mediaType, owned: 0, notOwned: 0, n: 0 };
    h.owned += r.owned;
    h.notOwned += r.notOwned;
    h.n += r.n;
    byType.set(r.mediaType, h);
  }
  return [...byType.values()]
    .sort((a, b) => b.n - a.n || (a.mediaType < b.mediaType ? 1 : a.mediaType > b.mediaType ? -1 : 0))
    .map(({ mediaType, owned, notOwned }) => ({ mediaType, owned, notOwned }));
}

function readShelfTotals([types, money, setting]: D1Result[]): Totals {
  const out = new Map<number, ShelfTotals>();
  const of = (id: number) => {
    let t = out.get(id);
    if (!t) out.set(id, (t = { items: 0, byType: [], paid: [], priced: 0 }));
    return t;
  };
  for (const r of (types?.results ?? []) as ShelfTypeRow[]) {
    const t = of(r.libraryId);
    t.items += r.n;
    t.byType.push({ mediaType: r.mediaType, count: r.n });
  }
  for (const r of (money?.results ?? []) as Array<{ libraryId: number; currency: string; n: number; total: string }>) {
    // a code Intl doesn't know — only a hand-edited row — is left out, as the item page and the export leave it out
    // (isStoredPrice): the SQL filter only checks its shape
    if (!isCurrencyCode(r.currency)) continue;
    const t = of(r.libraryId);
    t.priced += r.n;
    t.paid.push({ currency: r.currency, count: r.n, total: r.total });
  }
  const currency = ((setting?.results ?? [])[0] as { currency: string | null } | undefined)?.currency ?? SITE_DEFAULTS.currency;
  return { shelves: out, currency };
}

/**
 * A shelf and the household's settings in one call (§16 #76): what an add needs before it writes. Both reads are
 * Drizzle's, so the settings come through settingsOf() as getSiteSettings()'s do.
 */
export async function getLibraryAndSettings(d1: D1Database, id: number): Promise<{ library: Library | null; settings: SiteSettings }> {
  const dbi = db(d1);
  const [libs, rows] = await dbi.batch([
    dbi.select().from(s.libraries).where(eq(s.libraries.id, id)),
    dbi.select().from(s.siteSettings).where(eq(s.siteSettings.id, 1)),
  ]);
  return { library: libs[0] ?? null, settings: settingsOf(rows[0]) };
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

/**
 * Deletes a shelf — an admin's to do (the route checks). Its items go to the trash first (§16 #74), each with its
 * snapshot, in the same batch as the shelf: the snapshot keeps the shelf's name, so a restore goes onto a shelf made
 * again under that name. The shelf's connection views cascade with it, and with none left both activity logs go, as
 * they do when the last view is removed on the Connections page (deleteConnectionView), so a stale log can't outlive
 * every view. `expired` is the cover keys of trash rows purged on the way, for the caller to delete the objects — the
 * shelf's own items keep theirs, for a restore.
 */
export async function deleteLibrary(d1: D1Database, id: number, deletedBy: Deleter = null): Promise<{ trashed: number; expired: string[] }> {
  const [old, , inserted] = await d1.batch([
    ...purgeStatements(d1),
    ...trashStatements(d1, (table) => `${table}library_id = ?1`, id, deletedBy),
    d1.prepare('DELETE FROM libraries WHERE id = ?1').bind(id),
    d1.prepare('DELETE FROM activity_log WHERE NOT EXISTS (SELECT 1 FROM connection_views)'),
    d1.prepare('DELETE FROM member_activity WHERE NOT EXISTS (SELECT 1 FROM connection_views)'),
    pruneSeries(d1), // a series whose volumes were all on this shelf
  ]);
  return { trashed: inserted?.meta?.changes ?? 0, expired: expiredKeys(old) };
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
  sort?: 'added' | 'title' | 'author' | 'rating' | 'completed';
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
  statuses?: ItemStatus[]; // any-of; empty/omitted = any status; In progress includes a re-read (statusWhere, §16 #64)
  owned?: boolean; // true = copies > 0, false = copies = 0 (reading-log entries)
  q?: string; // title/creators/location substring, case-insensitive — the signed-in shelf's only, never a view's
  tag?: string; // only items carrying this tag (tags are stored lowercase)
  // held in any of these formats (§16 #75) — the shelf's filter only: share links don't capture it (shareFilters)
  formats?: string[];
  // only items on this member's want list (§16 #53) — what a gift list captures, and the want-list page shows
  wantedBy?: number;
  // 'wanted': newest on the want list first — only with wantedBy
  sort?: 'added' | 'title' | 'author' | 'rating' | 'completed' | 'wanted'; // author: the first creator's surname (§16 #83)
  page?: number; // 1-based
};

/**
 * Who has read an item, for the shelf's "Read by" filter (ARCH.md §16 #43): finished by someone (`finished`), not
 * finished by them (`unfinished`), or being read by them now (`reading`). `readerId` null means anyone in the
 * household. Deliberately not part of ItemFilters: those are what a share link or a connection view captures, and
 * who read what must never be published — shareFilters() can't carry this because the type has no room for it.
 */
export type ReaderFilter = { readerId: number | null; mode: 'finished' | 'unfinished' | 'reading' };

/**
 * The decluttering filters (ARCH.md §16 #81): items added `addedYearsAgo` years ago or more, and games and records
 * with no play in the last `unplayedMonths` months (never played counts). In the app only, like ReaderFilter — a
 * share or connection view has no room for them, so "not played in a year" is never published. `today` is the
 * device's day (#69), handed in by the route.
 */
export type StaleFilter = {
  today: string;
  addedYearsAgo?: number;
  unplayedMonths?: number;
  // the Holding filter once Borrowed is among its choices (§16 #82): any of these, in the app only — a share captures
  // `owned` alone, so it can never say what is borrowed from whom
  holding?: Array<'owned' | 'not_owned' | 'borrowed'>;
};

function readerFilterWhere(r: ReaderFilter): SQL {
  const status = r.mode === 'reading' ? 'in_progress' : 'completed';
  const reader = r.readerId === null ? sql`` : sql` AND ${s.reads.readerId} = ${r.readerId}`;
  if (r.mode === 'unfinished') {
    return sql`NOT EXISTS (SELECT 1 FROM ${s.reads} WHERE ${s.reads.itemId} = ${s.items.id} AND ${s.reads.status} = ${status}${reader})`;
  }
  // the same set as EXISTS (reads.item_id is never NULL), found from the reads — by idx_reads_status_ended — rather than
  // by probing every item on the shelf (§16 #68)
  return sql`${s.items.id} IN (SELECT ${s.reads.itemId} FROM ${s.reads} WHERE ${s.reads.status} = ${status}${reader})`;
}

/**
 * A Status filter as SQL — the twin of matchesStatus() (§16 #64): any of `statuses`, and with In progress among them a
 * book being read again too, which keeps its Completed status. Shelves, share links and connection views filter by it.
 */
export function statusWhere(statuses: readonly ItemStatus[]): SQL | undefined {
  if (!statuses.length) return undefined;
  const any = inArray(s.items.status, [...statuses]);
  return statuses.includes('in_progress') ? or(any, eq(s.items.rereading, true)) : any;
}

const CREATORS_SQL = "trim(coalesce(creators, ''))";

/**
 * The first creator's surname, lower-cased, for the shelf's "Author A–Z" (ARCH.md §16 #83) — the SQL twin of
 * splitCreators()'s "Last, First" rule (YEAR_CREATORS carries it too): one person written "Le Guin, Ursula K." sorts
 * under "le guin"; otherwise the first person — before a ',', ';' or ' & ' — sorts under their last word ("Ursula K.
 * Le Guin" under "guin", "N. K. Jemisin" under "jemisin"), as surname() takes it. SQLite has no "last word", so the
 * trailing word is what remains when rtrim() strips every non-space character from the right; a trailing suffix
 * ("Martin Luther King Jr.", "Ralph Bunche II") gives way to the word before it. Nobody named sorts last. lower() folds
 * ASCII only — a surname starting with Å or Č keeps its capital and sorts after every ASCII name (a known limit).
 */
const AUTHOR_SORT_SQL = (() => {
  const cr = CREATORS_SQL;
  const a = `trim(substr(${cr}, 1, instr(${cr}, ',') - 1))`;
  const b = `trim(substr(${cr}, instr(${cr}, ',') + 1))`;
  const onePerson = `(instr(${cr}, ',') > 0 AND instr(${b}, ',') = 0 AND instr(${cr}, ';') = 0 AND instr(${cr}, '&') = 0 AND ${a} <> '' AND ${b} <> '' AND instr(${a}, '.') = 0 AND lower(${b}) NOT IN ('jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv') AND (instr(${b}, ' ') = 0 OR ${b} GLOB '*[A-Z].'))`;
  const names = `replace(replace(${cr}, ';', ','), ' & ', ',')`;
  const first = `trim(substr(${names}, 1, instr(${names} || ',', ',') - 1))`;
  const lastWordOf = (x: string) => `substr(${x}, length(rtrim(${x}, replace(${x}, ' ', ''))) + 1)`;
  const last = lastWordOf(first);
  const beforeSuffix = `trim(substr(${first}, 1, length(${first}) - length(${last})))`;
  const surname = `CASE WHEN lower(${last}) IN ('jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv') AND ${beforeSuffix} <> '' THEN ${lastWordOf(beforeSuffix)} ELSE ${last} END`;
  return `lower(CASE WHEN ${onePerson} THEN ${a} ELSE ${surname} END)`;
})();

/** The WHERE behind both listItems and countMatchingItems — one definition, so a
 *  count can never disagree with the list it is counting. */
function itemFilterWhere(libraryId: number | null, f: ItemFilters, reader?: ReaderFilter, stale?: StaleFilter): SQL | undefined {
  const conds: SQL[] = [];
  if (libraryId !== null) conds.push(eq(s.items.libraryId, libraryId));
  if (f.mediaTypes?.length) conds.push(inArray(s.items.mediaType, f.mediaTypes));
  if (f.statuses?.length) conds.push(statusWhere(f.statuses)!);
  if (f.owned !== undefined) conds.push(f.owned ? gt(s.items.copies, 0) : eq(s.items.copies, 0));
  if (f.formats?.length) {
    // the column is a comma-joined set; a code matches between commas, so "cd" never matches "cdr"
    conds.push(or(...f.formats.map((code) => sql`(',' || ${s.items.formats} || ',') LIKE ${`%,${code},%`}`))!);
  }
  // The tag's and the want list's items as IN, not a correlated EXISTS: the same set (neither item_id is ever NULL), but
  // SQLite starts from the tag's links (idx_item_tags_tag) or the member's wants (their primary key) instead of probing
  // every item in the catalogue — 829 rows read rather than 4,274 to count a tag of 276 items (§16 #68).
  if (f.tag) {
    conds.push(
      sql`${s.items.id} IN (SELECT ${s.itemTags.itemId} FROM ${s.itemTags} INNER JOIN ${s.tags} ON ${s.tags.id} = ${s.itemTags.tagId} WHERE ${s.tags.name} = ${f.tag})`,
    );
  }
  if (f.wantedBy !== undefined) {
    conds.push(sql`${s.items.id} IN (SELECT ${s.wants.itemId} FROM ${s.wants} WHERE ${s.wants.userId} = ${f.wantedBy})`);
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
  if (stale?.addedYearsAgo !== undefined) {
    conds.push(sql`substr(${s.items.addedAt}, 1, 10) <= date(${stale.today}, ${`-${stale.addedYearsAgo} years`})`);
  }
  if (stale?.unplayedMonths !== undefined) {
    conds.push(inArray(s.items.mediaType, [...PLAYABLE_TYPES]));
    conds.push(
      sql`NOT EXISTS (SELECT 1 FROM ${s.plays} WHERE ${s.plays.itemId} = ${s.items.id} AND ${s.plays.playedOn} >= date(${stale.today}, ${`-${stale.unplayedMonths} months`}))`,
    );
  }
  if (stale?.holding?.length) {
    const kinds = stale.holding.map((h) =>
      h === 'owned'
        ? gt(s.items.copies, 0)
        : h === 'not_owned'
          ? eq(s.items.copies, 0)
          : sql`(${s.items.copies} = 0 AND ${s.items.id} IN (SELECT ${s.borrows.itemId} FROM ${s.borrows} WHERE ${s.borrows.returnedOn} IS NULL))`,
    );
    conds.push(or(...kinds)!);
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
  reader?: ReaderFilter, // the signed-in shelf's "Read by" — never a share's (see ReaderFilter)
  // How many items `f` and `reader` select, when the caller already counted them: an unfiltered shelf's count is
  // listLibraries()'s, which the shelf page has read anyway. Saves counting every item on the shelf again (§16 #68).
  knownTotal?: number,
  stale?: StaleFilter, // the signed-in shelf's decluttering filters (§16 #81) — never a share's, like `reader`
): Promise<{ items: Item[]; total: number; page: number; pages: number }> {
  const dbi = db(d1);
  const where = itemFilterWhere(libraryId, f, reader, stale);

  const order =
    f.sort === 'wanted' && f.wantedBy !== undefined
      ? [
          sql`(SELECT ${s.wants.createdAt} FROM ${s.wants} WHERE ${s.wants.itemId} = ${s.items.id} AND ${s.wants.userId} = ${f.wantedBy}) DESC`,
          desc(s.items.id),
        ]
      : f.sort === 'title'
      ? [asc(s.items.title)]
      : f.sort === 'author'
        ? [sql.raw(`${CREATORS_SQL} = ''`), sql.raw(AUTHOR_SORT_SQL), sql`lower(${s.items.creators})`, asc(s.items.title)]
      : f.sort === 'rating'
        ? [sql`${s.items.rating} IS NULL, ${s.items.rating} DESC`, asc(s.items.title)]
        : f.sort === 'completed'
          ? [sql`${s.items.completedOn} IS NULL, ${s.items.completedOn} DESC`, asc(s.items.title)]
          : [desc(s.items.addedAt), desc(s.items.id)];

  const total = knownTotal ?? (await dbi.select({ n: count() }).from(s.items).where(where))[0]?.n ?? 0;
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

/** Who is writing an item (ARCH.md §16 #84): the member's id and session key, for the history triggers; null when nobody is. */
export type Writer = Deleter;

/**
 * `writes` between the statements that set and clear the `acting` row (§16 #84), so the item-history triggers know who
 * — one batch, one transaction, so no other request ever sees the row. With nobody writing, the writes as they are.
 */
function asWriter(d1: D1Database, who: Writer | undefined, writes: D1PreparedStatement[]): D1PreparedStatement[] {
  // every item write also lets the history past HISTORY_DAYS go — one indexed delete, so retention holds without a page
  const sweep = d1.prepare(`DELETE FROM item_history WHERE at < datetime('now', '-${HISTORY_DAYS} days')`);
  // and the trash's snapshots past TRASH_DAYS (§16 #74) — the private part: notes, location, borrowers, everyone's
  // reads — so that retention holds in a household that deletes nothing for a month and never opens the page. The
  // line stays, with its cover's key, for the next delete or Trash visit to purge with the object: a statement has no
  // hand to delete objects with. A restore is refused by the row's date, whatever it holds.
  const letGo = d1.prepare(`UPDATE trash SET payload = '{}' WHERE deleted_at < datetime('now', '-${TRASH_DAYS} days') AND payload <> '{}'`);
  if (!who) return [...writes, sweep, letGo];
  return [
    d1.prepare('INSERT OR REPLACE INTO acting (id, user_id, session_key) VALUES (1, ?1, ?2)').bind(who.id, who.sessionKey),
    ...writes,
    sweep,
    letGo,
    d1.prepare('DELETE FROM acting WHERE id = 1'),
  ];
}

export async function updateItem(d1: D1Database, id: number, values: Partial<NewItem>, who?: Writer): Promise<void> {
  const q = db(d1)
    .update(s.items)
    .set({ ...values, updatedAt: sql`(datetime('now'))` })
    .where(eq(s.items.id, id))
    .toSQL();
  await d1.batch(asWriter(d1, who, [d1.prepare(q.sql).bind(...q.params)]));
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
  who?: Writer,
): Promise<boolean> {
  const stmt = d1
    .prepare(
      `UPDATE items SET details = ?1, publisher = ?2, published = ?3, length = ?4, updated_at = datetime('now')
       WHERE id = ?5 AND details = ?6 AND publisher IS ?7 AND published IS ?8 AND length IS ?9`,
    )
    .bind(after.details, after.publisher, after.published, after.length, id, before.details, before.publisher, before.published, before.length);
  const results = await d1.batch(asWriter(d1, who, [stmt]));
  return (results[who ? 1 : 0]?.meta.changes ?? 0) > 0;
}

/**
 * Writes what "Refresh from BGG" filled in (§16 #60) — only if the game's details and length are still as it read
 * them, so an edit saved while BGG was asked wins. False when something changed: nothing is written.
 */
export async function applyGameFill(
  d1: D1Database,
  id: number,
  before: Pick<Item, 'details' | 'length'>,
  after: Pick<Item, 'details' | 'length'>,
  who?: Writer,
): Promise<boolean> {
  const stmt = d1
    .prepare(
      `UPDATE items SET details = ?1, length = ?2, updated_at = datetime('now')
       WHERE id = ?3 AND media_type = 'boardgame' AND details = ?4 AND length IS ?5`,
    )
    .bind(after.details, after.length, id, before.details, before.length);
  const results = await d1.batch(asWriter(d1, who, [stmt]));
  return (results[who ? 1 : 0]?.meta.changes ?? 0) > 0;
}

/**
 * Deletes an item into the trash (§16 #74), and its series with it if it was the series' last volume here (§16 #52).
 * The cover keys of trash rows purged on the way, for the caller to delete the objects.
 */
export async function deleteItem(d1: D1Database, id: number, deletedBy: Deleter = null): Promise<string[]> {
  return (await trashItems(d1, [id], deletedBy)).expired;
}

/**
 * `items.id` and `items.copies`, written out with their table. Drizzle writes a column inside a single-table select's
 * `sql` field bare ("id"), and inside a subquery a bare name means the subquery's own table first: `"item_id" = "id"`
 * under `FROM loans` compares loans.item_id with loans.id. WHERE and ORDER BY qualify their columns; select fields
 * don't, so a correlated subquery there names the outer row through these.
 */
const OUTER_ITEM_ID = sql.raw('"items"."id"');
const OUTER_ITEM_COPIES = sql.raw('"items"."copies"');
/** On someone's want list and not owned — the "Wanted" badge (§16 #53) — as a select field of a query over items. */
const wantedField = () => sql`${OUTER_ITEM_COPIES} = 0 AND EXISTS (SELECT 1 FROM ${s.wants} WHERE ${s.wants.itemId} = ${OUTER_ITEM_ID})`;

/** The newest items, with the badges a shelf gives them — "Lent", and "Wanted" beside "Not owned" (§16 #53) — in the same query. */
export async function recentItems(d1: D1Database, limit = 12): Promise<Array<Item & { onLoan: boolean; wanted: boolean }>> {
  return db(d1)
    .select({
      ...getTableColumns(s.items),
      onLoan: sql`EXISTS (SELECT 1 FROM ${s.loans} WHERE ${s.loans.itemId} = ${OUTER_ITEM_ID} AND ${s.loans.returnedOn} IS NULL)`.mapWith(Boolean),
      wanted: wantedField().mapWith(Boolean),
    })
    .from(s.items)
    .orderBy(desc(s.items.addedAt), desc(s.items.id))
    .limit(limit);
}

/** What the Overview's "Read next" card shows of its pick. */
export type ReadNextPick = Pick<Item, 'id' | 'title' | 'creators' | 'coverKey' | 'copies' | 'mediaType'> & { wanted: boolean };

/**
 * A random book for `readerId` to read next, or null when there is none: any book, owned or not, that they haven't
 * finished and aren't reading now — their own reads only, so someone else's finish or open read doesn't take a book
 * out, and a read they stopped doesn't either. `notId` (the pick just shown) sorts last, so "Another" never shows it
 * again while any other book qualifies, and still shows it when it's the only one. One call; the pool is filtered by
 * the reads index.
 *
 * The pick is the book with the least random key, kept in one pass: with a single `min()` in the query, SQLite takes
 * the other columns from the row that holds it. `ORDER BY random() LIMIT 1` picked the same way, uniformly, but D1
 * counts every row a sort passes through as read again, so it read the pool twice (§16 #68). Each key is
 * `random() >> 2`, within ±2^61; `notId`'s has 2^62 added, so it is least only when it is alone, and nothing overflows.
 * Only whether there was a key comes back — a key is wider than a JavaScript number holds — and with no book in the
 * pool there wasn't: the one row the aggregate returns is all NULL, and there is no pick.
 */
export async function pickNextRead(d1: D1Database, readerId: number, notId: number | null = null): Promise<ReadNextPick | null> {
  const [row] = await db(d1)
    .select({
      id: s.items.id,
      title: s.items.title,
      creators: s.items.creators,
      coverKey: s.items.coverKey,
      copies: s.items.copies,
      mediaType: s.items.mediaType,
      // the "Wanted" badge beside "Not owned" (§16 #53), in the same query
      wanted: wantedField().mapWith(Boolean),
      none: sql<number>`min((random() >> 2)${notId === null ? sql`` : sql` + (${OUTER_ITEM_ID} = ${notId}) * 4611686018427387904`}) IS NULL`,
    })
    .from(s.items)
    .where(
      and(
        eq(s.items.mediaType, 'book'),
        sql`NOT EXISTS (SELECT 1 FROM ${s.reads} WHERE ${s.reads.itemId} = ${s.items.id} AND ${s.reads.readerId} = ${readerId} AND ${s.reads.status} IN ('completed', 'in_progress'))`,
      ),
    );
  if (!row || row.none) return null;
  const { none: _none, ...pick } = row;
  return pick;
}

// ---------- what should we play tonight (ARCH.md §16 #60) ----------

/** A game as "What should we play tonight?" lists it: what it's filtered on, as the query read it, and its last play. */
export type TonightGame = Pick<Item, 'id' | 'title' | 'creators' | 'coverKey' | 'mediaType'> & {
  playersMin: number | null;
  playersMax: number | null;
  minutes: number | null;
  weight: number | null;
  lastPlayed: string | null;
};

/**
 * A number from a game's details: a JSON number, or text that is only a number (a libib import keeps every value as
 * text). Anything else is no value. `key` is one of this file's constants, never input.
 */
const detailNumber = (key: string) => {
  const at = `'$.${key}'`;
  const v = `json_extract(d, ${at})`;
  return `CASE json_type(d, ${at})
      WHEN 'integer' THEN ${v}
      WHEN 'real' THEN ${v}
      WHEN 'text' THEN CASE WHEN trim(${v}) GLOB '[0-9]*' AND trim(${v}) NOT GLOB '*[^0-9.]*' AND trim(${v}) NOT GLOB '*.*.*'
        THEN CAST(trim(${v}) AS REAL) END
    END`;
};
const atLeastOne = (expr: string) => `CASE WHEN (${expr}) >= 1 THEN (${expr}) END`;

/**
 * Every board game that could come out tonight, each classed against the filters: `fit` 1 when everything asked
 * about is known and fits, 0 when nothing known rules it out but something asked about is missing ("not enough
 * details"), and NULL when something known rules it out. ?1 players, ?2 minutes, ?3–?4 the weight band; NULL is any.
 *
 * - Only games that are here: in the collection (copies > 0) with a copy not out on loan.
 * - Players: inside [players_min, players_max], a range typed backwards read the right way round. Only a maximum starts
 *   the range at FEWEST_PLAYERS (1); only a minimum reads as exactly that many (src/lib/games.ts).
 * - Time, conservatively: the longer end of the playing time its details give (playtime_max, else playtime_min, the
 *   larger when both are there), else the Length column (BGG's playing time), and it fits only within the minutes.
 * - Weight: BGG's 1–5 average, in the band's [from, below).
 */
const TONIGHT_CTE = `
WITH here AS (
  SELECT i.id, i.title, i.creators, i.cover_key, i.media_type, i.length,
         CASE WHEN json_valid(i.details) THEN i.details ELSE '{}' END AS d
  FROM items i
  WHERE i.media_type = 'boardgame'
    AND i.copies > (SELECT count(*) FROM loans l WHERE l.item_id = i.id AND l.returned_on IS NULL)
),
-- MATERIALIZED: each game's numbers are worked out once. Left to itself SQLite flattens these CTEs into the query,
-- copying every json_extract into each place a later step names the value — enough copies to run it out of memory.
raw AS MATERIALIZED (
  SELECT id, title, creators, cover_key, media_type, length,
         ${atLeastOne(detailNumber('players_min'))} AS p1,
         ${atLeastOne(detailNumber('players_max'))} AS p2,
         ${atLeastOne(detailNumber('playtime_min'))} AS t1,
         ${atLeastOne(detailNumber('playtime_max'))} AS t2,
         ${detailNumber('weight')} AS w
  FROM here
),
g AS MATERIALIZED (
  SELECT id, title, creators, cover_key, media_type,
         CASE WHEN p1 IS NULL AND p2 IS NOT NULL THEN ${FEWEST_PLAYERS} ELSE min(coalesce(p1, p2), coalesce(p2, p1)) END AS pmin,
         max(coalesce(p1, p2), coalesce(p2, p1)) AS pmax,
         coalesce(max(coalesce(t2, t1), coalesce(t1, t2)), CASE WHEN length >= 1 THEN length END) AS minutes,
         CASE WHEN w >= 1 AND w <= 5 THEN w END AS weight
  FROM raw
),
c AS (
  SELECT g.*,
    CASE
      WHEN (?1 IS NOT NULL AND pmin IS NOT NULL AND NOT (pmin <= ?1 AND ?1 <= pmax))
        OR (?2 IS NOT NULL AND minutes IS NOT NULL AND minutes > ?2)
        OR (?3 IS NOT NULL AND weight IS NOT NULL AND NOT (weight >= ?3 AND weight < ?4)) THEN NULL
      WHEN (?1 IS NOT NULL AND pmin IS NULL) OR (?2 IS NOT NULL AND minutes IS NULL) OR (?3 IS NOT NULL AND weight IS NULL) THEN 0
      ELSE 1
    END AS fit
  FROM g
)`;

const TONIGHT_COLUMNS = `id, title, creators, cover_key AS coverKey, media_type AS mediaType, pmin AS playersMin, pmax AS playersMax,
  minutes, weight, (SELECT max(p.played_on) FROM plays p WHERE p.item_id = r.id) AS lastPlayed`;

const tonightBinds = (f: GameFilters) => {
  const band = f.weight ? WEIGHT_BANDS[f.weight] : null;
  return [f.players, f.minutes, band?.from ?? null, band?.below ?? null];
};

/**
 * The games that fit tonight and the ones missing a detail it needs, each in random order and at most `limit` of
 * each, with how many there are in all. One D1 call, however big the catalog: the classing is one pass over the
 * board games, the random order and the counts are window functions, and the last play is read from
 * `idx_plays_item_played` for the rows returned.
 */
export async function gamesForTonight(
  d1: D1Database,
  filters: GameFilters,
  limit: number,
): Promise<{ fit: TonightGame[]; fitTotal: number; unknown: TonightGame[]; unknownTotal: number }> {
  const { results } = await d1
    .prepare(
      `${TONIGHT_CTE}
       SELECT ${TONIGHT_COLUMNS}, fit, n FROM (
         SELECT c.*, row_number() OVER (PARTITION BY fit ORDER BY random()) AS rn, count(*) OVER (PARTITION BY fit) AS n
         FROM c WHERE fit IS NOT NULL
       ) r
       WHERE rn <= ?5
       ORDER BY fit DESC, rn`,
    )
    .bind(...tonightBinds(filters), limit)
    .all<TonightGame & { fit: number; n: number }>();
  const out = { fit: [] as TonightGame[], fitTotal: 0, unknown: [] as TonightGame[], unknownTotal: 0 };
  for (const { fit, n, ...game } of results) {
    if (fit === 1) {
      out.fit.push(game);
      out.fitTotal = n;
    } else {
      out.unknown.push(game);
      out.unknownTotal = n;
    }
  }
  return out;
}

/**
 * "Pick one for us": one random game among those that fit, or null when none does — with how many fit and how many
 * are missing a detail, for the page to say so. `notId` (the pick just shown) sorts last, so "Pick another" shows it
 * again only when it is the only game that fits. One D1 call.
 */
export async function pickGameForTonight(
  d1: D1Database,
  filters: GameFilters,
  notId: number | null = null,
): Promise<{ pick: TonightGame | null; fitTotal: number; unknownTotal: number }> {
  const row = await d1
    .prepare(
      `${TONIGHT_CTE}
       SELECT ${TONIGHT_COLUMNS}, fit, sum(fit) OVER () AS fits, count(*) OVER () AS n
       FROM c r WHERE fit IS NOT NULL
       ORDER BY fit DESC, id = ?5, random()
       LIMIT 1`,
    )
    .bind(...tonightBinds(filters), notId ?? 0)
    .first<TonightGame & { fit: number; fits: number; n: number }>();
  if (!row) return { pick: null, fitTotal: 0, unknownTotal: 0 };
  const { fit, fits, n, ...game } = row;
  return { pick: fit === 1 ? game : null, fitTotal: fits, unknownTotal: n - fits };
}

/**
 * Reading-log entries: cataloged (reviewed, rated) but not physically owned. Most items first; types holding as many
 * come in descending media_type order, which is the order SQLite gave them before it was written down — checked for
 * every pattern of ties among the seven types (§16 #68). The Overview reads the same from shelvesWithTotals().
 */
export async function holdingsByType(d1: D1Database): Promise<Holding[]> {
  return db(d1)
    .select({
      mediaType: s.items.mediaType,
      owned: sql`sum(case when ${s.items.copies} > 0 then 1 else 0 end)`.mapWith(Number),
      notOwned: sql`sum(case when ${s.items.copies} = 0 then 1 else 0 end)`.mapWith(Number),
    })
    .from(s.items)
    .groupBy(s.items.mediaType)
    .orderBy(desc(count()), desc(s.items.mediaType));
}

// ---------- series (ARCH.md §16 #52) ----------

/**
 * The statement that makes sure `draft`'s series exists — the first spelling of a name stays, since the name is
 * unique by its key — and sets its total when the draft carries one. None without a series. `totalFrom` 'series'
 * keeps the total a series already has over the draft's (a trash restore's snapshot is older than a total corrected
 * since), filling it in only where the series has none; a new series takes the draft's either way.
 */
function seriesUpsert(d1: D1Database, draft: SeriesDraft | null | undefined, totalFrom: 'draft' | 'series' = 'draft'): D1PreparedStatement[] {
  if (!draft) return [];
  const total = totalFrom === 'draft' ? 'coalesce(excluded.total, series.total)' : 'coalesce(series.total, excluded.total)';
  return [
    d1
      .prepare(`INSERT INTO series (name, key, total) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET total = ${total}`)
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
 * into it: its volumes move there — an item write, so `who` is named in each volume's history (§16 #84) — and the
 * total given — else the one there, else this one's — is kept. Returns the id the series has afterwards. The
 * route checks the series exists first.
 */
export async function updateSeries(d1: D1Database, id: number, name: string, total: number | null, who?: Writer): Promise<number | null> {
  const key = seriesKey(name);
  const other = 'EXISTS (SELECT 1 FROM series WHERE key = ?2 AND id <> ?1)';
  const results = await d1.batch(asWriter(d1, who, [
    d1
      .prepare('UPDATE series SET total = coalesce(?3, total, (SELECT total FROM series WHERE id = ?1)) WHERE key = ?2 AND id <> ?1')
      .bind(id, key, total),
    d1.prepare(`UPDATE items SET series_id = (SELECT id FROM series WHERE key = ?2) WHERE series_id = ?1 AND ${other}`).bind(id, key),
    d1.prepare(`DELETE FROM series WHERE id = ?1 AND ${other}`).bind(id, key),
    d1.prepare('UPDATE series SET name = ?3, key = ?2, total = ?4 WHERE id = ?1').bind(id, key, name, total),
    d1.prepare('SELECT id FROM series WHERE key = ?1').bind(key),
  ]));
  const row = results[(who ? 1 : 0) + 4]?.results[0] as { id: number } | undefined;
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
 * same batch. `before` and `after`: statements of the same change that go first and last in that batch — a
 * recommendation taken onto the want list (§16 #58) claims itself first, so a claim that can't be made writes nothing.
 * Returns its id.
 */
export async function createItemWithTags(
  d1: D1Database,
  values: NewItem,
  names: string[],
  series: SeriesDraft | null = null,
  opts: { wantedBy?: number; before?: D1PreparedStatement[]; after?: D1PreparedStatement[]; editions?: EditionDraft[] } = {},
): Promise<number> {
  const reads = readsFromColumns(values.status ?? 'not_started', values.beganOn, values.completedOn);
  const reviews = stampReviews(reviewsFromColumns(values));
  const q = db(d1)
    .insert(s.items)
    .values(withSeries(withReviewState(withReadState(values, reads), reviews), series))
    .returning({ id: s.items.id })
    .toSQL();
  const upsert = seriesUpsert(d1, series);
  const before = opts.before ?? [];
  const results = await d1.batch([
    ...before,
    ...upsert,
    d1.prepare(q.sql).bind(...q.params),
    ...tagLinkStatements(d1, 'newest', names),
    ...readInsertStatements(d1, 'newest', reads, values.addedBy ?? null),
    refreshReadState(d1, 'newest'),
    ...reviewInsertStatements(d1, 'newest', reviews, values.addedBy ?? null),
    refreshReviewState(d1, 'newest'),
    ...(opts.wantedBy !== undefined ? wantInsertStatements(d1, 'newest', [{ userId: opts.wantedBy, at: null }]) : []),
    ...editionInsertStatements(d1, 'newest', opts.editions ?? []),
    ...(opts.after ?? []),
  ]);
  const row = results[before.length + upsert.length]?.results[0] as { id: number } | undefined;
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
 *
 * A `copies` given never goes below what is out on loan (§16 #13), and never counts a copy while a borrow is open
 * (§16 #82) — both checked in the statement: it sets NULL instead, the column's NOT NULL fails the whole batch, and
 * D1 rolls a batch back, so a refused count saves nothing of the form — tags, reads and review included — rather
 * than everything but the count. False then: the route reads what refused it and says so.
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
  editions?: EditionDraft[], // undefined leaves "also held as" as it is; a list replaces it (§16 #75)
  who?: Writer, // who is saving, for the item's history (§16 #84)
): Promise<boolean> {
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
  const copies = rest.copies;
  const guarded: Partial<NewItem> =
    copies === undefined || copies === null
      ? rest
      : {
          ...rest,
          // an SQL value where the row's shape says a number, as withSeries does for the series' id
          copies: sql`CASE WHEN ${copies} >= (SELECT count(*) FROM loans WHERE item_id = ${s.items.id} AND returned_on IS NULL)
                 AND (${copies} = 0 OR NOT EXISTS (SELECT 1 FROM borrows WHERE item_id = ${s.items.id} AND returned_on IS NULL))
            THEN ${copies} ELSE NULL END` as unknown as number,
        };
  const q = db(d1)
    .update(s.items)
    .set({ ...(series === undefined ? guarded : withSeries(guarded, series)), updatedAt: sql`(datetime('now'))` })
    .where(eq(s.items.id, id))
    .toSQL();
  try {
    await d1.batch(asWriter(d1, who, [
      ...seriesUpsert(d1, series),
      d1.prepare(q.sql).bind(...q.params),
      // the series it left, if this was that series' last volume
      ...(series === undefined ? [] : [pruneSeries(d1)]),
      d1.prepare('DELETE FROM item_tags WHERE item_id = ?1').bind(id),
      ...tagLinkStatements(d1, id, names),
      ...(editions ? [d1.prepare('DELETE FROM editions WHERE item_id = ?1').bind(id), ...editionInsertStatements(d1, id, editions)] : []),
      ...(formRead ? formReadStatements(d1, id, person, formRead) : []),
      refreshReadState(d1, [id]),
      // reads first, as everywhere: a rating given with a finish is dated by it inside an import (§16 #40)
      ...(formReview ? reviewWriteStatements(d1, id, person, formReview, 'replace') : []),
      refreshReviewState(d1, [id]),
      redateReviewActivity(d1, [id]),
    ]));
  } catch (err) {
    if (refusedBy(err, 'items.copies')) return false;
    throw err;
  }
  return true;
}

/**
 * Whether a batch failed on the NOT NULL constraint of `column` — the one way a statement in a batch can refuse the
 * whole of it: a guard that sets NULL where a value isn't allowed, so nothing in the batch lands (D1 rolls it back).
 * Anything else that failed is still an error.
 */
const refusedBy = (err: unknown, column: string): boolean =>
  String(err instanceof Error ? err.message : err).includes(`NOT NULL constraint failed: ${column}`);

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
export async function bulkMove(d1: D1Database, ids: number[], libraryId: number, who?: Writer): Promise<BulkResult> {
  const json = JSON.stringify(ids);
  const moves = `library_id <> ?2 AND EXISTS (SELECT 1 FROM libraries WHERE id = ?2)`;
  const results = await d1.batch(asWriter(d1, who, [
    d1.prepare(`SELECT count(*) AS found, sum(${moves}) AS changed FROM items WHERE ${SELECTED}`).bind(json, libraryId),
    d1.prepare(`UPDATE items SET library_id = ?2, updated_at = datetime('now') WHERE ${SELECTED} AND ${moves}`).bind(json, libraryId),
  ]));
  return tallied(results[who ? 1 : 0]?.results[0] as Tally | undefined);
}

/**
 * Owned sets copies to 1 on every selected item with 0; not owned, to 0 on every one with 1 — the Holding toggle's
 * two moves (§16 #27), in one batch. An item held in two or more copies is skipped either way: the toggle only lands
 * on 0 or 1, and zeroing or flattening a real count would lose a number that round-trips through /export.csv.
 */
export async function bulkSetOwned(d1: D1Database, ids: number[], owned: boolean, who?: Writer): Promise<BulkResult> {
  const json = JSON.stringify(ids);
  const [from, to] = owned ? [0, 1] : [1, 0];
  // an item borrowed from someone (§16 #82) is theirs until marked returned: "Mark owned" skips it, as the toggle refuses;
  // a copy out on loan is still ours (§16 #13): "Mark not owned" skips it, as the toggle refuses
  const borrowed = 'EXISTS (SELECT 1 FROM borrows b WHERE b.item_id = items.id AND b.returned_on IS NULL)';
  const lent = 'EXISTS (SELECT 1 FROM loans l WHERE l.item_id = items.id AND l.returned_on IS NULL)';
  const changes = owned ? `copies = ?2 AND NOT ${borrowed}` : `copies = ?2 AND NOT ${lent}`;
  const skips = owned ? `copies >= 2 OR (copies = 0 AND ${borrowed})` : `copies >= 2 OR (copies = 1 AND ${lent})`;
  const results = await d1.batch(asWriter(d1, who, [
    d1.prepare(`SELECT count(*) AS found, sum(${changes}) AS changed, sum(${skips}) AS skipped FROM items WHERE ${SELECTED}`).bind(json, from),
    d1.prepare(`UPDATE items SET copies = ?3, updated_at = datetime('now') WHERE ${SELECTED} AND ${changes}`).bind(json, from, to),
  ]));
  return tallied(results[who ? 1 : 0]?.results[0] as Tally | undefined);
}

/**
 * Deletes every selected item, in one batch: the single delete's DELETE, over a list. Cascades take its tags' links,
 * reads, pages, reviews, loans, activity and comments; the FTS trigger drops it from search; migration 0010's BEFORE
 * DELETE triggers tell a connection that a book lent to it is returned and that a request waiting on it is declined,
 * row by row, as N single deletes would. Returns the cover keys to remove once this has succeeded.
 */
export async function bulkDelete(d1: D1Database, ids: number[], deletedBy: Deleter = null): Promise<BulkResult> {
  const { trashed, expired } = await trashItems(d1, ids, deletedBy);
  // the covers to delete are not these items' — those stay until their rows are purged — but the purged rows' (§16 #74)
  return { found: trashed, changed: trashed, same: 0, skipped: 0, covers: expired };
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

/** Marks a loan returned on `today`, the device's day (§16 #69) — once; a loan already back keeps its date. */
export async function returnLoan(d1: D1Database, id: number, today: string = todayUtc()): Promise<void> {
  await db(d1)
    .update(s.loans)
    .set({ returnedOn: today })
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

/** How many open loans activeLoans() lists, newest first; the counts past it are loanCounts()'s. */
export const ACTIVE_LOANS_SHOWN = 200;

export async function activeLoans(d1: D1Database): Promise<LoanWithItem[]> {
  return loansJoined(d1, isNull(s.loans.returnedOn), ACTIVE_LOANS_SHOWN);
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
  values: { itemId: number; borrower: string; loanedOn?: string; contact: string | null; dueOn: string | null; edition?: string | null },
): Promise<boolean> {
  const row = await d1
    .prepare(
      `INSERT INTO loans (item_id, borrower, loaned_on, contact, due_on, edition)
       SELECT ?1, ?2, ?5, ?3, ?4, ?6
       WHERE (SELECT copies FROM items WHERE id = ?1)
           > (SELECT count(*) FROM loans WHERE item_id = ?1 AND returned_on IS NULL)
       RETURNING id`,
    )
    .bind(values.itemId, values.borrower, values.contact, values.dueOn, values.loanedOn ?? todayUtc(), values.edition ?? null)
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
              l.contact, l.note, l.edition
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
        `INSERT INTO loans (item_id, borrower, loaned_on, due_on, returned_on, contact, note, edition)
         SELECT (SELECT max(id) FROM items), json_extract(value, '$.borrower'), json_extract(value, '$.loanedOn'),
                json_extract(value, '$.dueOn'), json_extract(value, '$.returnedOn'), json_extract(value, '$.contact'),
                json_extract(value, '$.note'), json_extract(value, '$.edition')
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

// ---------- borrowed from someone not on Nalanda (ARCH.md §16 #82) ----------

const BORROW_COLUMNS = 'id, item_id AS itemId, lender, contact, borrowed_on AS borrowedOn, due_on AS dueOn, returned_on AS returnedOn, note';

/**
 * Records a borrow — only on an item not owned (copies = 0), only one open at a time, and never while a copy of it is
 * out on loan (an item is never lent and borrowed at once), all checked in the statement. True when recorded.
 */
export async function borrowIfNotOwned(
  d1: D1Database,
  values: { itemId: number; lender: string; borrowedOn: string; contact: string | null; dueOn: string | null; note: string | null },
): Promise<boolean> {
  const row = await d1
    .prepare(
      `INSERT INTO borrows (item_id, lender, contact, borrowed_on, due_on, note)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT copies FROM items WHERE id = ?1) = 0
         AND NOT EXISTS (SELECT 1 FROM borrows WHERE item_id = ?1 AND returned_on IS NULL)
         AND NOT EXISTS (SELECT 1 FROM loans WHERE item_id = ?1 AND returned_on IS NULL)
       RETURNING id`,
    )
    .bind(values.itemId, values.lender, values.contact, values.borrowedOn, values.dueOn, values.note)
    .first<{ id: number }>();
  return !!row;
}

/** The lender of an item's open borrow, or null — what refuses counting a copy as yours (the Holding toggle, the edit form). */
export async function openBorrowLender(d1: D1Database, itemId: number): Promise<string | null> {
  const row = await d1.prepare('SELECT lender FROM borrows WHERE item_id = ?1 AND returned_on IS NULL LIMIT 1').bind(itemId).first<{ lender: string }>();
  return row?.lender ?? null;
}

/**
 * The Holding toggle's owning half: copies 0 → 1, unless a borrow is open — a borrowed book is theirs until it is marked
 * returned, so it is never owned and borrowed at once (checked in the statement). True when it changed.
 */
export async function markOwnedUnlessBorrowed(d1: D1Database, id: number, who?: Writer): Promise<boolean> {
  const stmt = d1
    .prepare(
      `UPDATE items SET copies = 1, updated_at = datetime('now') WHERE id = ?1 AND copies = 0 AND NOT EXISTS (SELECT 1 FROM borrows WHERE item_id = ?1 AND returned_on IS NULL)`,
    )
    .bind(id);
  const results = await d1.batch(asWriter(d1, who, [stmt]));
  return (results[who ? 1 : 0]?.meta.changes ?? 0) > 0;
}

/**
 * The Holding toggle's other half: copies 1 → 0, unless the copy is out on loan — a lent copy is still ours, and Not
 * owned means not lendable (§16 #13) — and only the single copy the toggle knows (§16 #27), both checked in the
 * statement, so a count saved on the form meanwhile is never zeroed. True when it changed.
 */
export async function markNotOwnedUnlessLent(d1: D1Database, id: number, who?: Writer): Promise<boolean> {
  const stmt = d1
    .prepare(
      `UPDATE items SET copies = 0, updated_at = datetime('now') WHERE id = ?1 AND copies = 1 AND NOT EXISTS (SELECT 1 FROM loans WHERE item_id = ?1 AND returned_on IS NULL)`,
    )
    .bind(id);
  const results = await d1.batch(asWriter(d1, who, [stmt]));
  return (results[who ? 1 : 0]?.meta.changes ?? 0) > 0;
}

/** Marks a borrow returned on `today`, the device's day (§16 #69) — once; one already back keeps its date. */
export async function returnBorrow(d1: D1Database, id: number, today: string): Promise<void> {
  await d1.prepare('UPDATE borrows SET returned_on = ?2 WHERE id = ?1 AND returned_on IS NULL').bind(id, today).run();
}

export type BorrowWithItem = Borrow & { itemTitle: string; itemCoverKey: string | null };

async function borrowsJoined(d1: D1Database, where: string, limit: number): Promise<BorrowWithItem[]> {
  return (
    await d1
      .prepare(
        `SELECT b.id, b.item_id AS itemId, b.lender, b.contact, b.borrowed_on AS borrowedOn, b.due_on AS dueOn, b.returned_on AS returnedOn, b.note,
                i.title AS itemTitle, i.cover_key AS itemCoverKey
         FROM borrows b JOIN items i ON i.id = b.item_id WHERE ${where} ORDER BY b.id DESC LIMIT ?1`,
      )
      .bind(limit)
      .all<BorrowWithItem>()
  ).results;
}

/** Everything borrowed from people and not yet returned, newest first. */
export async function activeBorrows(d1: D1Database): Promise<BorrowWithItem[]> {
  return borrowsJoined(d1, 'b.returned_on IS NULL', 200);
}

/** Borrows given back, newest first. */
export async function borrowHistory(d1: D1Database, limit = 100): Promise<BorrowWithItem[]> {
  return borrowsJoined(d1, 'b.returned_on IS NOT NULL', limit);
}

/** An item's borrows, newest first: the open one, if any, then the past ones. */
export async function borrowsForItem(d1: D1Database, itemId: number): Promise<Borrow[]> {
  return (await d1.prepare(`SELECT ${BORROW_COLUMNS} FROM borrows WHERE item_id = ?1 ORDER BY id DESC`).bind(itemId).all<Borrow>()).results;
}

/** A row's borrows onto the item inserted earlier in the batch — the export's `borrowed` cell, read as the loans cell is (§16 #57). */
function borrowInsertStatements(d1: D1Database, borrows: LoanDraft[]): D1PreparedStatement[] {
  if (!borrows.length) return [];
  const json = JSON.stringify(borrows.slice(0, MAX_LOANS_PER_CELL));
  return [
    d1
      .prepare(
        `INSERT INTO borrows (item_id, lender, borrowed_on, due_on, returned_on, contact, note)
         SELECT (SELECT max(id) FROM items), json_extract(value, '$.borrower'), json_extract(value, '$.loanedOn'),
                json_extract(value, '$.dueOn'), json_extract(value, '$.returnedOn'), json_extract(value, '$.contact'),
                json_extract(value, '$.note')
         FROM json_each(?1) ORDER BY key`,
      )
      .bind(json),
  ];
}

// ---------- saved views (ARCH.md §16 #81) ----------

export type SavedView = typeof s.savedViews.$inferSelect;
/** The most views one shelf keeps: a row of pills, not a second catalogue. */
export const MAX_SAVED_VIEWS_PER_SHELF = 20;
export const MAX_VIEW_NAME = 60;

const SAVED_VIEWS_SQL =
  'SELECT id, library_id AS libraryId, name, params, created_by AS createdBy, created_at AS createdAt FROM saved_views ORDER BY library_id, name COLLATE NOCASE';

/** The household's saved views — one shelf's, or every shelf's — by shelf, then name. The pages read them inside shelvesWithTotals()'s batch. */
export async function listSavedViews(d1: D1Database, libraryId?: number): Promise<SavedView[]> {
  const all = (await d1.prepare(SAVED_VIEWS_SQL).all<SavedView>()).results;
  return libraryId === undefined ? all : all.filter((v) => v.libraryId === libraryId);
}

/**
 * Saves a view, or replaces the one of that name on the shelf — any member's to save or replace. A shelf holds at
 * most MAX_SAVED_VIEWS_PER_SHELF, checked in the statement. The id of the view saved, or null when the shelf is
 * full or gone.
 */
export async function saveView(
  d1: D1Database,
  v: { libraryId: number; name: string; params: string; createdBy: number },
): Promise<number | null> {
  const row = await d1
    .prepare(
      `INSERT INTO saved_views (library_id, name, params, created_by)
       SELECT ?1, ?2, ?3, ?4
       WHERE EXISTS (SELECT 1 FROM libraries WHERE id = ?1)
         AND ((SELECT count(*) FROM saved_views WHERE library_id = ?1) < ?5
              OR EXISTS (SELECT 1 FROM saved_views WHERE library_id = ?1 AND name = ?2))
       ON CONFLICT(library_id, name) DO UPDATE SET params = excluded.params, created_by = excluded.created_by
       RETURNING id`,
    )
    .bind(v.libraryId, v.name, v.params, v.createdBy, MAX_SAVED_VIEWS_PER_SHELF)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/**
 * The views that name a member in "Read by" — `readBy=<id>` or `now-<id>` — each rewritten without it, for
 * deleteUser()'s batch. The id would otherwise name whoever is given it next (#56); `me`, `not-me` and `anyone`
 * name nobody in particular and stay. Compared as numbers, as the bar reads them: a view saved before readByValue()
 * wrote the id canonically may still hold `02`, which named member 2 and yet escaped a comparison of strings.
 */
async function viewsWithoutReader(d1: D1Database, id: number): Promise<D1PreparedStatement[]> {
  const views = (await d1.prepare(SAVED_VIEWS_SQL).all<SavedView>()).results;
  const out: D1PreparedStatement[] = [];
  for (const v of views) {
    const sp = new URLSearchParams(v.params);
    const m = /^(now-)?0*(\d+)$/.exec(sp.get('readBy') ?? '');
    if (!m || Number(m[2]) !== id) continue;
    sp.delete('readBy');
    // only the version read: a view re-saved between the read and the batch keeps its newer filters
    out.push(d1.prepare('UPDATE saved_views SET params = ?2 WHERE id = ?1 AND params = ?3').bind(v.id, sp.toString(), v.params));
  }
  return out;
}

/** Removes a view — any member's to remove. */
export async function deleteSavedView(d1: D1Database, libraryId: number, id: number): Promise<boolean> {
  const res = await d1.prepare('DELETE FROM saved_views WHERE id = ?1 AND library_id = ?2').bind(id, libraryId).run();
  return res.meta.changes > 0;
}

// ---------- share feeds (ARCH.md §16 #86) ----------

/** A share link's feed: the newest items among those it exposes, each with when it was added — never a read's date. */
export async function feedItems(d1: D1Database, libraryId: number | null, f: ItemFilters, limit: number): Promise<Array<{ item: Item; at: string }>> {
  const rows = await db(d1).select().from(s.items).where(itemFilterWhere(libraryId, f)).orderBy(desc(s.items.addedAt), desc(s.items.id)).limit(limit);
  return rows.map((item) => ({ item, at: item.addedAt }));
}

/** A gift list's feed (§16 #53): the member's newest wants among the items the list exposes, each dated by the want. */
export async function wantFeedItems(d1: D1Database, userId: number, f: ItemFilters, limit: number): Promise<Array<{ item: Item; at: string }>> {
  const rows = await db(d1)
    .select({ item: s.items, at: s.wants.createdAt })
    .from(s.wants)
    .innerJoin(s.items, eq(s.items.id, s.wants.itemId))
    .where(and(eq(s.wants.userId, userId), itemFilterWhere(null, f)))
    .orderBy(desc(s.wants.createdAt), desc(s.items.id))
    .limit(limit);
  return rows.map((r) => ({ item: r.item, at: r.at }));
}

// ---------- full-text search ----------

/**
 * The year an item's `published` names, in SQL: the four digits it starts with ("2019", "2019-05-01") or ends with
 * ("May 2019", "c. 1999"), else NULL. The page's yearOf() reads the first four digits anywhere; SQLite has no regex,
 * and these two shapes are what providers and files write.
 */
const PUBLISHED_YEAR_SQL = `CASE WHEN published GLOB '[0-9][0-9][0-9][0-9]*' THEN CAST(substr(published, 1, 4) AS INTEGER)
       WHEN published GLOB '*[0-9][0-9][0-9][0-9]' THEN CAST(substr(published, -4) AS INTEGER) END`;

/**
 * FTS5 lives outside Drizzle's DSL; ids come from a raw query, rows from Drizzle. The query's operators (§16 #80,
 * src/lib/search.ts) are applied inside that one id query: title: and author: as FTS5 column filters, tag:, status:,
 * year:, lang: and type: as a subquery on `items` — so a narrowed search still finds up to `limit` items, and the
 * page makes the same two calls whatever was typed. A query of operators alone lists by title instead of by rank.
 */
export async function searchItems(d1: D1Database, query: string, limit = 50, reader?: ReaderFilter): Promise<Item[]> {
  const parsed = parseSearch(query);
  const match = ftsMatch(parsed);
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `?${params.length}`;
  };
  const conds: string[] = [];
  for (const tag of parsed.tags) {
    conds.push(`id IN (SELECT item_id FROM item_tags INNER JOIN tags ON tags.id = item_tags.tag_id WHERE tags.name = ${p(tag)})`);
  }
  if (parsed.statuses.length) {
    // the twin of statusWhere(): In progress holds a re-read (§16 #64)
    const list = parsed.statuses.map(p).join(', ');
    conds.push(parsed.statuses.includes('in_progress') ? `(status IN (${list}) OR rereading = 1)` : `status IN (${list})`);
  }
  if (parsed.years.length) {
    conds.push(`(${parsed.years.map((y) => `${PUBLISHED_YEAR_SQL} BETWEEN ${p(y.from)} AND ${p(y.to)}`).join(' OR ')})`);
  }
  if (parsed.languages.length) {
    // an item with no language of its own is in the household's (§16 #76), as its pill says
    conds.push(
      `coalesce(language, (SELECT language FROM site_settings WHERE id = 1), ${p(DEFAULT_LANGUAGE)}) IN (${parsed.languages.map(p).join(', ')})`,
    );
  }
  if (parsed.types.length) conds.push(`media_type IN (${parsed.types.map(p).join(', ')})`);
  if (!match && !conds.length) return [];
  // "Read by" narrows the match inside the query too, so a filtered search still finds up to `limit` items
  const readerSql = (idCol: string) => {
    if (!reader) return '';
    const status = reader.mode === 'reading' ? 'in_progress' : 'completed';
    const who = reader.readerId === null ? '' : ` AND reader_id = ${p(reader.readerId)}`;
    return `AND ${idCol} ${reader.mode === 'unfinished' ? 'NOT IN' : 'IN'} (SELECT item_id FROM reads WHERE status = ${p(status)}${who})`;
  };
  const idSql = match
    ? `SELECT rowid AS id FROM items_fts WHERE items_fts MATCH ${p(match)} ${
        conds.length ? `AND rowid IN (SELECT id FROM items WHERE ${conds.join(' AND ')})` : ''
      } ${readerSql('rowid')} ORDER BY rank LIMIT ${p(limit)}`
    : `SELECT id FROM items WHERE ${conds.join(' AND ')} ${readerSql('id')} ORDER BY title COLLATE NOCASE, id LIMIT ${p(limit)}`;
  const idRows = await d1
    .prepare(idSql)
    .bind(...params)
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

export type SiteSettings = {
  progressOnShares: boolean;
  progressToConnections: boolean;
  namesOnShares: boolean; // §16 #45 — members' display names, ratings and reviews on share pages
  namesToConnections: boolean; // §16 #45 — per-person feed entries and reviews, with display names, to connections
  goalsToConnections: boolean; // §16 #49 — members' reading goals as per-person entries; only while namesToConnections
  currency: string | null; // §16 #61 — the household's ISO 4217 code, what purchase prices are entered in; null until an admin sets it
  language: string; // §16 #76 — the household's default language, ISO 639-1: what an added item takes unless told otherwise
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
  currency: null,
  language: DEFAULT_LANGUAGE,
};

/** One row, id 1. Absent means defaults — only ever on a new instance — so it needs no setup step. */
export async function getSiteSettings(d1: D1Database): Promise<SiteSettings> {
  const [row] = await db(d1).select().from(s.siteSettings).where(eq(s.siteSettings.id, 1));
  return settingsOf(row);
}

/**
 * The settings a row holds — the one place that reads the row, so every reader (getSiteSettings, the add path's
 * getLibraryAndSettings) says the same thing, and a setting added later is mapped once or not at all.
 */
function settingsOf(row: typeof s.siteSettings.$inferSelect | undefined): SiteSettings {
  return row
    ? {
        progressOnShares: row.progressOnShares,
        progressToConnections: row.progressToConnections,
        namesOnShares: row.namesOnShares,
        namesToConnections: row.namesToConnections,
        goalsToConnections: row.goalsToConnections,
        currency: row.currency,
        language: isLanguageCode(row.language) ? row.language : DEFAULT_LANGUAGE,
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
 * batch with wantsAndLinks' two statements after it — so want lists add nothing to the page's calls. `extra`: the
 * caller's own read-only statements, run last in the same batch, their results handed back in order — "Recommend
 * to…"'s households and signing name (§16 #58), which then cost the page no call either.
 */
export async function itemPageLog(
  d1: D1Database,
  itemId: number,
  extra: D1PreparedStatement[] = [],
): Promise<{
  reads: ReadEntry[];
  entries: ProgressEntry[];
  reviews: ReviewEntry[];
  want: { wanters: Array<{ id: number; username: string; at: string }>; links: Array<{ id: number; label: string; url: string }> };
  editions: EditionDraft[]; // "also held as" (§16 #75), in the same call
  householdLanguage: string; // the household's default (§16 #76), read in the same call, for the language pill
  quotes: QuoteEntry[]; // the household's quotes on it (§16 #77), in the same call
  borrows: Borrow[]; // borrowed from someone not on Nalanda (§16 #82), newest first, in the same call
  extra: D1Result[];
}> {
  const own = [
    ...readingLogStatements(d1, itemId),
    ...wantsAndLinksStatements(d1, itemId),
    d1.prepare('SELECT language FROM site_settings WHERE id = 1'),
    d1.prepare('SELECT format, isbn, publisher, year FROM editions WHERE item_id = ?1 ORDER BY id').bind(itemId),
    d1.prepare(`SELECT ${QUOTE_COLUMNS} FROM quotes WHERE item_id = ?1 ORDER BY at, id`).bind(itemId),
    d1.prepare(`SELECT ${BORROW_COLUMNS} FROM borrows WHERE item_id = ?1 ORDER BY id DESC`).bind(itemId),
  ];
  const results = await d1.batch([...own, ...extra]);
  const lang = (results[own.length - 4]?.results?.[0] as { language?: string } | undefined)?.language;
  return {
    ...readingLogOf(results),
    want: wantsAndLinksOf(results.slice(3)),
    householdLanguage: isLanguageCode(lang) ? lang : DEFAULT_LANGUAGE,
    editions: (results[own.length - 3]?.results ?? []) as EditionDraft[],
    quotes: ((results[own.length - 2]?.results ?? []) as QuoteRow[]).map((q) => ({ ...q, shared: !!q.shared })),
    borrows: (results[own.length - 1]?.results ?? []) as Borrow[],
    extra: results.slice(own.length),
  };
}

// ---------- quotes and highlights (ARCH.md §16 #77) ----------

export type QuoteEntry = { id: number; itemId: number; userId: number | null; text: string; page: string | null; note: string | null; shared: boolean; source: string | null; at: string };
/** A quotes row as D1 hands it back: `shared` an integer. */
type QuoteRow = Omit<QuoteEntry, 'shared'> & { shared: number };
const QUOTE_COLUMNS = 'id, item_id AS itemId, user_id AS userId, text, page, note, shared, source, at';

/**
 * Adds a member's quote to an item, dated now unless the draft says. True when added; false when the item is gone,
 * they have that text on it already, or the item holds MAX_QUOTES_PER_ITEM (checked in the statement).
 */
export async function addQuote(d1: D1Database, itemId: number, userId: number, draft: QuoteDraft): Promise<boolean> {
  const [res] = await d1.batch(quoteInsertStatements(d1, itemId, [{ ...draft, userId }], userId));
  return (res?.meta?.changes ?? 0) > 0;
}

/** How many quotes an item holds — what tells a refused quote at the cap from one already there. */
export async function quoteCount(d1: D1Database, itemId: number): Promise<number> {
  const row = await d1.prepare('SELECT count(*) AS n FROM quotes WHERE item_id = ?1').bind(itemId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getQuote(d1: D1Database, itemId: number, quoteId: number): Promise<QuoteEntry | null> {
  const row = await d1.prepare(`SELECT ${QUOTE_COLUMNS} FROM quotes WHERE id = ?1 AND item_id = ?2`).bind(quoteId, itemId).first<QuoteRow>();
  return row ? { ...row, shared: !!row.shared } : null;
}

/** Edits a quote — its text, page, note and whether it is shared — the writer's own, or anyone's for an admin (the guard in the statement too). */
export async function updateQuote(d1: D1Database, itemId: number, quoteId: number, draft: QuoteDraft, by: Actor): Promise<boolean> {
  const res = await d1
    .prepare(`UPDATE quotes SET text = ?3, page = ?4, note = ?5, shared = ?6 WHERE id = ?1 AND item_id = ?2 AND (?7 = 1 OR user_id = ?8)`)
    .bind(quoteId, itemId, draft.text, draft.page, draft.note, draft.shared ? 1 : 0, by.admin ? 1 : 0, by.id)
    .run();
  return res.meta.changes > 0;
}

export async function deleteQuote(d1: D1Database, itemId: number, quoteId: number, by: Actor): Promise<boolean> {
  const res = await d1
    .prepare('DELETE FROM quotes WHERE id = ?1 AND item_id = ?2 AND (?3 = 1 OR user_id = ?4)')
    .bind(quoteId, itemId, by.admin ? 1 : 0, by.id)
    .run();
  return res.meta.changes > 0;
}

export type MemberQuote = QuoteEntry & { title: string; creators: string | null; coverKey: string | null; mediaType: MediaType };
export const QUOTES_PER_PAGE = 50;

/** One member's quotes, newest first, with the item each is on: one page, and whether there are more. */
export async function quotesOf(d1: D1Database, userId: number, pageNum: number): Promise<{ quotes: MemberQuote[]; more: boolean }> {
  const offset = (Math.max(1, pageNum) - 1) * QUOTES_PER_PAGE;
  const rows = (
    await d1
      .prepare(
        `SELECT q.id, q.item_id AS itemId, q.user_id AS userId, q.text, q.page, q.note, q.shared, q.source, q.at,
                i.title, i.creators, i.cover_key AS coverKey, i.media_type AS mediaType
         FROM quotes q JOIN items i ON i.id = q.item_id WHERE q.user_id = ?1 ORDER BY q.at DESC, q.id DESC LIMIT ?2 OFFSET ?3`,
      )
      .bind(userId, QUOTES_PER_PAGE + 1, offset)
      .all<Omit<MemberQuote, 'shared'> & { shared: number }>()
  ).results;
  return { quotes: rows.slice(0, QUOTES_PER_PAGE).map((q) => ({ ...q, shared: !!q.shared })), more: rows.length > QUOTES_PER_PAGE };
}

/**
 * The Kindle import (§16 #77): each posted book's highlights become the importer's quotes on the book here that
 * matches it by title and first author (the Goodreads matcher's rule), or on a Not owned reading-log entry made for
 * it — a book you highlighted is one you read. One call to read the catalog's books, then one batch per book.
 * Re-imported highlights bring nothing twice (quoteInsertStatements). `dryRun` only matches.
 */
export async function importKindle(
  d1: D1Database,
  books: KindleBook[],
  into: { libraryId: number; userId: number },
  dryRun = false,
): Promise<{ matched: number; created: number; quotes: number; duplicates: number; titles: Array<{ title: string; found: boolean }> }> {
  const existing = await db(d1)
    .select({ id: s.items.id, title: s.items.title, creators: s.items.creators })
    .from(s.items)
    .where(eq(s.items.mediaType, 'book'));
  const byTitle = new Map<string, number>();
  for (const e of existing) byTitle.set(titleKey(e.title, e.creators), e.id);
  const out = { matched: 0, created: 0, quotes: 0, duplicates: 0, titles: [] as Array<{ title: string; found: boolean }> };
  for (const book of books) {
    const id = byTitle.get(titleKey(book.title, book.author));
    out.titles.push({ title: book.title, found: id !== undefined });
    if (id !== undefined) out.matched++;
    else out.created++;
    if (dryRun) {
      out.quotes += book.highlights.length;
      continue;
    }
    const quotes: PersonQuote[] = book.highlights.map((h) => ({ text: h.text, page: h.page, note: h.note, shared: false, at: h.at, source: 'kindle', userId: into.userId }));
    if (id !== undefined) {
      const [res] = await d1.batch(quoteInsertStatements(d1, id, quotes, into.userId));
      const added = res?.meta?.changes ?? 0;
      out.quotes += added;
      out.duplicates += quotes.length - added;
    } else {
      const newId = await createItemWithTags(
        d1,
        { libraryId: into.libraryId, mediaType: 'book', title: book.title, creators: book.author, copies: 0, addedBy: into.userId, details: '{}' },
        [],
        null,
        { after: quoteInsertStatements(d1, 'newest', quotes, into.userId) },
      );
      byTitle.set(titleKey(book.title, book.author), newId);
      out.quotes += quotes.length;
    }
  }
  return out;
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
  await (want ? wantStatement(d1, itemId, userId) : d1.prepare('DELETE FROM wants WHERE item_id = ?1 AND user_id = ?2').bind(itemId, userId)).run();
}

/** setWant's want, as a statement for a caller's batch — a recommendation taken onto the want list (§16 #58). */
export function wantStatement(d1: D1Database, itemId: number, userId: number): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO wants (item_id, user_id) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)
       ON CONFLICT DO NOTHING`,
    )
    .bind(itemId, userId);
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
export async function shelfFlags(d1: D1Database, itemIds: number[]): Promise<{ onLoan: Set<number>; wanted: Set<number>; borrowed: Set<number> }> {
  if (!itemIds.length) return { onLoan: new Set(), wanted: new Set(), borrowed: new Set() };
  const ids = JSON.stringify(itemIds);
  const [loans, wanted, borrowed] = await d1.batch([
    d1.prepare('SELECT DISTINCT item_id AS id FROM loans WHERE returned_on IS NULL AND item_id IN (SELECT value FROM json_each(?1))').bind(ids),
    d1.prepare(WANTED_AMONG).bind(ids),
    // borrowed from someone (§16 #82), in the same batch
    d1.prepare('SELECT DISTINCT item_id AS id FROM borrows WHERE returned_on IS NULL AND item_id IN (SELECT value FROM json_each(?1))').bind(ids),
  ]);
  const set = (r: D1Result | undefined) => new Set(((r?.results ?? []) as Array<{ id: number }>).map((x) => x.id));
  return { onLoan: set(loans), wanted: set(wanted), borrowed: set(borrowed) };
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
export async function shareGuardFacts(
  d1: D1Database,
  itemId: number,
): Promise<{ tags: string[]; wanters: number[]; quotes: Array<{ by: string | null; text: string; page: string | null }> }> {
  const [t, w, q] = await d1.batch([
    // no ORDER BY, as tagsForItems() had none: a shelf's share page lists an item's tags as it always did
    d1.prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ?1').bind(itemId),
    d1.prepare('SELECT user_id AS id FROM wants WHERE item_id = ?1').bind(itemId),
    // the quotes marked shared (§16 #77), with their writers' display names for the route to keep only while names are on
    d1
      .prepare(
        `SELECT u.display_name AS by, q.text, q.page FROM quotes q LEFT JOIN users u ON u.id = q.user_id
         WHERE q.item_id = ?1 AND q.shared = 1 ORDER BY q.at, q.id`,
      )
      .bind(itemId),
  ]);
  return {
    tags: ((t?.results ?? []) as Array<{ name: string }>).map((r) => r.name),
    wanters: ((w?.results ?? []) as Array<{ id: number }>).map((r) => r.id),
    quotes: ((q?.results ?? []) as Array<{ by: string | null; text: string; page: string | null }>).map((r) => ({ by: r.by || null, text: r.text, page: r.page })),
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
type CatalogProbe = { mediaType: MediaType; isbn13?: string | null; isbn10Upc?: string | null; details: Record<string, unknown> };

/** What names a scan or search result in the catalog: a book's ISBN-13; a record's barcode or Discogs id; a game's BGG id. */
function catalogKeys(c: CatalogProbe): { isbn: string | null; barcode: string | null; discogs: string | null; bgg: string | null } {
  const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '') || null;
  const idOf = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^\d{1,15}$/.test(v)) ? String(v) : null;
  const music = c.mediaType === 'vinyl' || c.mediaType === 'music';
  return {
    isbn: c.mediaType === 'book' ? digits(c.isbn13) : null,
    barcode: music ? (digits(c.isbn10Upc) ?? digits(c.isbn13)) : null,
    discogs: music ? idOf(c.details['discogs_id']) : null,
    bgg: c.mediaType === 'boardgame' ? idOf(c.details['bgg_id']) : null,
  };
}

/**
 * For each scan or search result, the item already in the catalog it names — by the same keys as existingForWant — or
 * null: the Add page's "In your catalog" pill. The oldest match. One query for the whole list, none when no result has
 * a key to match by.
 */
/**
 * Which shelf an Add result of each type starts on: the one already holding most items of that type (ties: the
 * shelf listed first). Shelves have no type of their own, so the household's own filing says where games and records
 * go — without it every result, a board game included, started on whichever shelf is listed first. A type the
 * catalog doesn't hold yet has no entry, and its results start on the first shelf. One query, whatever the results.
 */
export async function shelfForType(d1: D1Database): Promise<Partial<Record<MediaType, number>>> {
  const { results } = await d1
    .prepare(
      `SELECT i.media_type AS mediaType, i.library_id AS libraryId, count(*) AS n
       FROM items i JOIN libraries l ON l.id = i.library_id
       GROUP BY i.media_type, i.library_id
       ORDER BY n DESC, l.position, l.id`,
    )
    .all<{ mediaType: MediaType; libraryId: number; n: number }>();
  const shelf: Partial<Record<MediaType, number>> = {};
  for (const r of results) shelf[r.mediaType] ??= r.libraryId;
  return shelf;
}

export async function catalogMatches(d1: D1Database, candidates: CatalogProbe[]): Promise<Array<number | null>> {
  const keys = candidates.map(catalogKeys);
  const list = (k: 'isbn' | 'barcode' | 'discogs' | 'bgg') => JSON.stringify([...new Set(keys.map((x) => x[k]).filter((v): v is string => !!v))]);
  if (!keys.some((k) => k.isbn || k.barcode || k.discogs || k.bgg)) return candidates.map(() => null);
  const { results } = await d1
    .prepare(
      `SELECT id, media_type AS mediaType, isbn13, isbn10_upc AS isbn10Upc,
         CAST(json_extract(details, '$.discogs_id') AS TEXT) AS discogs, CAST(json_extract(details, '$.bgg_id') AS TEXT) AS bgg
       FROM items WHERE
         isbn13 IN (SELECT value FROM json_each(?1))
         OR (media_type IN ('vinyl', 'music') AND (isbn10_upc IN (SELECT value FROM json_each(?2)) OR isbn13 IN (SELECT value FROM json_each(?2))))
         OR (media_type IN ('vinyl', 'music') AND CAST(json_extract(details, '$.discogs_id') AS TEXT) IN (SELECT value FROM json_each(?3)))
         OR (media_type = 'boardgame' AND CAST(json_extract(details, '$.bgg_id') AS TEXT) IN (SELECT value FROM json_each(?4)))
         OR id IN (SELECT item_id FROM editions WHERE isbn IN (SELECT value FROM json_each(?1)) OR isbn IN (SELECT value FROM json_each(?2)))
       ORDER BY id`,
    )
    .bind(list('isbn'), list('barcode'), list('discogs'), list('bgg'))
    .all<{ id: number; mediaType: MediaType; isbn13: string | null; isbn10Upc: string | null; discogs: string | null; bgg: string | null }>();
  // another edition's identifier finds the same item (§16 #75): one more call, only when something matched at all
  const alsoHeld = results.length
    ? (
        await d1
          .prepare(`SELECT item_id AS id, isbn FROM editions WHERE item_id IN (SELECT value FROM json_each(?1)) AND isbn IS NOT NULL`)
          .bind(JSON.stringify(results.map((r) => r.id)))
          .all<{ id: number; isbn: string }>()
      ).results
    : [];
  const heldAs = (r: { id: number }, code: string) => alsoHeld.some((e) => e.id === r.id && e.isbn === code);
  const music = (t: MediaType) => t === 'vinyl' || t === 'music';
  return keys.map(
    (k) =>
      results.find(
        (r) =>
          (k.isbn !== null && (r.isbn13 === k.isbn || heldAs(r, k.isbn))) ||
          (k.barcode !== null && music(r.mediaType) && (r.isbn10Upc === k.barcode || r.isbn13 === k.barcode || heldAs(r, k.barcode))) ||
          (k.discogs !== null && music(r.mediaType) && r.discogs === k.discogs) ||
          (k.bgg !== null && r.mediaType === 'boardgame' && r.bgg === k.bgg),
      )?.id ?? null,
  );
}

export async function existingForWant(d1: D1Database, c: CatalogProbe): Promise<number | null> {
  const { isbn, barcode, discogs, bgg } = catalogKeys(c);
  if (!isbn && !barcode && !discogs && !bgg) return null;
  const row = await d1
    .prepare(
      `SELECT id FROM items WHERE
         (?1 IS NOT NULL AND isbn13 = ?1)
         OR (?2 IS NOT NULL AND media_type IN ('vinyl', 'music') AND (isbn10_upc = ?2 OR isbn13 = ?2))
         OR (?3 IS NOT NULL AND media_type IN ('vinyl', 'music') AND CAST(json_extract(details, '$.discogs_id') AS TEXT) = ?3)
         OR (?4 IS NOT NULL AND media_type = 'boardgame' AND CAST(json_extract(details, '$.bgg_id') AS TEXT) = ?4)
         OR id IN (SELECT item_id FROM editions WHERE (?1 IS NOT NULL AND isbn = ?1) OR (?2 IS NOT NULL AND isbn = ?2))
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
  borrows: Map<number, LoanDraft[]>; // borrowed from people (§16 #82), as the loans cell carries a loan
  plays: Map<number, CellPlay[]>;
  series: Map<number, Series>; // every series an item in the range belongs to, by id (§16 #52)
  wants: Map<number, Array<{ by: string; at: string }>>; // each want's member by username (§16 #53)
  links: Map<number, LinkDraft[]>;
  editions: Map<number, EditionDraft[]>; // "also held as" (§16 #75)
  quotes: Map<number, CellQuote[]>; // quotes and highlights by username (§16 #77)
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
    bind(`SELECT item_id AS itemId, format, isbn, publisher, year FROM editions WHERE item_id BETWEEN ?1 AND ?2 ${scoped('item_id')} ORDER BY item_id, id`),
    bind(
      `SELECT q.item_id AS itemId, u.username AS by, q.text, q.page, q.note, q.shared, q.at, q.source FROM quotes q LEFT JOIN users u ON u.id = q.user_id
       WHERE q.item_id BETWEEN ?1 AND ?2 ${scoped('q.item_id')} ORDER BY q.item_id, q.at, q.id`,
    ),
    bind(
      `SELECT item_id AS itemId, lender AS borrower, borrowed_on AS loanedOn, due_on AS dueOn, returned_on AS returnedOn, contact, note
       FROM borrows WHERE item_id BETWEEN ?1 AND ?2 ${scoped('item_id')} ORDER BY item_id, id`,
    ),
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
    editions: group(rowsOf<EditionDraft>(9), (r) => ({ format: r.format, isbn: r.isbn, publisher: r.publisher, year: r.year })),
    quotes: group(rowsOf<{ by: string | null; text: string; page: string | null; note: string | null; shared: number; at: string; source: string | null }>(10), (r) => ({
      by: r.by,
      text: r.text,
      page: r.page,
      note: r.note,
      shared: !!r.shared,
      at: r.at,
      source: r.source,
    })),
    borrows: group(rowsOf<LoanDraft>(11), (r) => ({ borrower: r.borrower, loanedOn: r.loanedOn, dueOn: r.dueOn, returnedOn: r.returnedOn, contact: r.contact, note: r.note })),
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
 * starting a book looks like (§16 #34); an open read with no start date takes today's, as before — `today` being the
 * reader's device's day (§16 #69), not the server's. Someone who has
 * finished or stopped it, with no read open, records nothing — reading it again is a deliberate "Read again" first
 * (§16 #41). Anyone else's reads don't matter. True when the page was recorded.
 */
export async function addProgress(
  d1: D1Database,
  itemId: number,
  page: number,
  reader: number | null,
  today: string = todayUtc(), // a route passes the device's day; the default is for calls with no device (tests)
): Promise<boolean> {
  const results = await d1.batch([
    d1
      .prepare(
        `INSERT INTO reads (item_id, reader_id, status, began_on)
         SELECT ?1, ?2, 'in_progress', ?3
         WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1) AND NOT EXISTS (SELECT 1 FROM reads WHERE item_id = ?1 AND reader_id IS ?2)`,
      )
      .bind(itemId, reader, today),
    d1
      .prepare(
        `UPDATE reads SET began_on = ?3
         WHERE item_id = ?1 AND reader_id IS ?2 AND status = 'in_progress' AND (began_on IS NULL OR trim(began_on) = '')`,
      )
      .bind(itemId, reader, today),
    adoptOrphanPages(d1, itemId, reader),
    // at most MAX_PROGRESS_PER_READ pages on the read, checked in the statement
    d1
      .prepare(
        `INSERT INTO reading_progress (item_id, page, added_by, read_id)
         SELECT ?1, ?3, ?2, id FROM reads WHERE item_id = ?1 AND reader_id IS ?2 AND status = 'in_progress'
           AND (SELECT count(*) FROM reading_progress p WHERE p.read_id = reads.id) < ${MAX_PROGRESS_PER_READ}
         LIMIT 1`,
      )
      .bind(itemId, reader, page),
    // updated_at is deliberately untouched: connections see it, and a page is its own entry, not an edit of the book
    refreshReadState(d1, [itemId]),
  ]);
  return (results[3]?.meta.changes ?? 0) > 0;
}

/** How many pages `reader`'s open read of an item has recorded — what tells a refused page apart from no read open. */
export async function openReadPages(d1: D1Database, itemId: number, reader: number | null): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT count(*) AS n FROM reading_progress p JOIN reads r ON r.id = p.read_id
       WHERE r.item_id = ?1 AND r.reader_id IS ?2 AND r.status = 'in_progress'`,
    )
    .bind(itemId, reader)
    .first<{ n: number }>();
  return row?.n ?? 0;
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

// ---------- year in review (ARCH.md §16 #59) ----------
//
// A year of reading and playing, counted in SQL and fetched in one batch — one D1 call, however large the catalogue.
// A finish counts in the year its `ended_on` falls in (calendar dates, UTC); an undated finish is in no year. Reading
// is books only, as a goal's count is (§16 #49). Every reading statement returns rows for two scopes, 'mine' (the
// member's own reads, `reader_id`) and 'household' (everyone's, former members' included), from the one CTE below, so
// the two columns can never be counted two different ways. Plays are the household's log (§16 #54), counted once.

/**
 * The year's finished books, twice over: `?1` is the member, `?2`/`?3` the year's first day and the next year's. `work`
 * is the book whatever the edition — its title and creators, folded — so two editions of one book count once where a
 * list counts books; a finish is still a finish, so re-reads count wherever finishes do. `fin` is materialized and the
 * two scopes joined onto it, so each statement reads the year's finishes from `reads` once, not once per scope.
 */
const YEAR_FINISHES = `WITH fin AS MATERIALIZED (
    SELECT r.item_id, r.reader_id, r.began_on, r.ended_on, i.title, i.creators, i.length,
      lower(trim(i.title)) || char(31) || lower(trim(coalesce(i.creators, ''))) AS work
    FROM reads r JOIN items i ON i.id = r.item_id
    WHERE r.status = 'completed' AND r.ended_on >= ?2 AND r.ended_on < ?3 AND i.media_type = 'book'
  ),
  scoped AS (
    SELECT s.scope, fin.* FROM (SELECT 'mine' AS scope UNION ALL SELECT 'household') s CROSS JOIN fin
    WHERE s.scope = 'household' OR fin.reader_id = ?1
  )`;

/**
 * Each reader's rating of each book they finished that year — once per reader and book, however often they finished it
 * and in however many editions, so neither a re-read nor a second edition counts a rating twice: a reader who rated two
 * editions of one book gave it the average of the two. Only the editions they finished that year count. A former
 * member's reads (no reader) meet former members' reviews (no writer), as the app's own checks treat them as one nobody
 * (§16 #43), so former members together are one reader here too.
 */
const YEAR_RATED = `${YEAR_FINISHES},
  pairs AS (SELECT scope, reader_id, item_id, work, max(ended_on) AS last FROM scoped GROUP BY scope, reader_id, item_id),
  rated AS (
    SELECT p.scope, min(p.item_id) AS item_id, p.work, max(p.last) AS last, avg(rv.rating) AS rating FROM pairs p
    JOIN reviews rv ON rv.item_id = p.item_id AND rv.user_id IS p.reader_id
    WHERE rv.rating IS NOT NULL
    GROUP BY p.scope, p.reader_id, p.work
  )`;

/**
 * The creators of the year's finishes, one row each, ready to split into people on commas. Every provider and importer
 * joins several authors with ", " (Open Library, Google Books, BoardGameGeek, Goodreads' author and additional authors),
 * so a comma usually separates people — but a catalogue typed or imported by hand can hold one person written
 * "Last, First": "Le Guin, Ursula K.", "Tolkien, J. R. R.", "Herbert, Frank". Such a string is one person, turned round
 * ("Ursula K. Le Guin") so it meets the same author written the usual way. It is one when it has exactly one comma, no
 * ';' or '&', no full stop before the comma (so "James S. A. Corey, Someone" stays two), and given names after it: a
 * single word, or names ending in an initial ("Ursula K.", "J. R. R."), and not a suffix ("Martin Luther King, Jr."
 * keeps its order, and the lone "Jr." is dropped as nobody). Two full names ("Terry Pratchett, Neil Gaiman") stay two
 * people. ';' and ' & ' separate people too ("Pratchett & Gaiman").
 */
export const YEAR_CREATORS = `named AS (
    SELECT scope, work, ended_on, cr, trim(substr(cr, 1, instr(cr, ',') - 1)) AS a, trim(substr(cr, instr(cr, ',') + 1)) AS b
    FROM (SELECT scope, work, ended_on, trim(coalesce(creators, '')) AS cr FROM scoped)
  ),
  people AS (
    SELECT scope, work, ended_on,
      CASE WHEN instr(cr, ',') > 0 AND instr(b, ',') = 0 AND instr(cr, ';') = 0 AND instr(cr, '&') = 0
             AND a <> '' AND b <> '' AND instr(a, '.') = 0
             AND lower(b) NOT IN ('jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv')
             AND (instr(b, ' ') = 0 OR b GLOB '*[A-Z].')
           THEN b || ' ' || a
           ELSE replace(replace(cr, ';', ','), ' & ', ',')
      END AS names
    FROM named
  )`;

/**
 * The years with a dated finish of a book or a play of a record or game, newest first: every year's first four
 * characters of `ended_on` or `played_on` that look like a year. Read by skipping from year to year on the indexes
 * (§16 #68) — the latest date, then the latest before that year's first four characters, and so on, each one index
 * seek — rather than reading every dated finish and play to list a dozen years. Strings sort by their first four
 * characters first, so every date before `y` has a prefix before `y`, and the skip visits each prefix once. A year then
 * counts only if a book finish (or a playable item's play) has that prefix: a range [y, the next prefix) on the index,
 * stopped at the first one found. Before §16 #68 this was a UNION over every row, and it lists the same years.
 */
const YEARS_WITH_DATA = `WITH RECURSIVE
    finish_prefix(y) AS (
      SELECT substr(max(ended_on), 1, 4) FROM reads WHERE status = 'completed'
      UNION ALL
      SELECT (SELECT substr(max(r.ended_on), 1, 4) FROM reads r WHERE r.status = 'completed' AND r.ended_on < f.y)
      FROM finish_prefix f WHERE f.y IS NOT NULL
    ),
    play_prefix(y) AS (
      SELECT substr(max(played_on), 1, 4) FROM plays
      UNION ALL
      SELECT (SELECT substr(max(p.played_on), 1, 4) FROM plays p WHERE p.played_on < f.y) FROM play_prefix f WHERE f.y IS NOT NULL
    )
  SELECT y FROM (
    SELECT y FROM finish_prefix WHERE y GLOB '[1-9][0-9][0-9][0-9]' AND EXISTS (
      SELECT 1 FROM reads r JOIN items i ON i.id = r.item_id
      WHERE r.status = 'completed' AND r.ended_on >= y AND r.ended_on < substr(y, 1, 3) || char(unicode(substr(y, 4)) + 1)
        AND i.media_type = 'book'
    )
    UNION
    SELECT y FROM play_prefix WHERE y GLOB '[1-9][0-9][0-9][0-9]' AND EXISTS (
      SELECT 1 FROM plays p JOIN items i ON i.id = p.item_id
      WHERE p.played_on >= y AND p.played_on < substr(y, 1, 3) || char(unicode(substr(y, 4)) + 1)
        AND i.media_type IN (${PLAYABLE_SQL})
    )
  ) ORDER BY y DESC`;

/** The first `n` rows of `inner` in each scope, by `order`. */
const topPerScope = (inner: string, order: string, n: number) =>
  `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY scope ORDER BY ${order}) AS rn FROM (${inner})) WHERE rn <= ${n}`;

const scopeOf = (s: string): 'mine' | 'household' => (s === 'mine' ? 'mine' : 'household');

/**
 * Everything the Year in review page shows for `year`, for `userId` and for the household, in one D1 batch: ten
 * statements, each an aggregate over at most a year of finishes or plays, returning a few dozen rows between them.
 */
export async function yearInReview(d1: D1Database, userId: number, year: number): Promise<YearReview> {
  const [from, to] = yearRange(year);
  const inYear = (query: string) => d1.prepare(query).bind(userId, from, to);
  const [months, authors, tags, ratings, topRated, lengths, fastest, plays, meta, years] = await d1.batch([
    // finishes and pages by month
    inYear(
      `${YEAR_FINISHES}
       SELECT scope, CAST(substr(ended_on, 6, 2) AS INTEGER) AS month, count(*) AS books,
         coalesce(sum(CASE WHEN length > 0 THEN length END), 0) AS pages, count(CASE WHEN length > 0 THEN 1 END) AS withLength
       FROM scoped GROUP BY scope, month`,
    ),
    // most-read authors: creators split into people (YEAR_CREATORS: "A, B" is two, "Le Guin, Ursula K." one), and a
    // lone "Jr." is nobody
    inYear(
      `${YEAR_FINISHES},
       ${YEAR_CREATORS},
       split(scope, work, ended_on, name, rest) AS (
         SELECT scope, work, ended_on, '', names || ',' FROM people
         UNION ALL
         SELECT scope, work, ended_on, trim(substr(rest, 1, instr(rest, ',') - 1)), substr(rest, instr(rest, ',') + 1)
         FROM split WHERE rest <> ''
       )
       ${topPerScope(
         `SELECT scope, min(name) AS name, count(DISTINCT work) AS books, count(*) AS finishes, max(ended_on) AS last
          FROM split WHERE name <> '' AND lower(name) NOT IN ('jr', 'jr.', 'sr', 'sr.')
          GROUP BY scope, lower(name)`,
         'books DESC, finishes DESC, last DESC, name',
         YEAR_TOP,
       )} ORDER BY scope, rn`,
    ),
    // most-used tags on the year's books — grouped by the tag's id first, so each tag's name is looked up once rather
    // than once per finish carrying it (§16 #68)
    inYear(
      `${YEAR_FINISHES}
       ${topPerScope(
         `SELECT g.scope, t.name, g.books, g.finishes, g.last FROM (
            SELECT s.scope, it.tag_id, count(DISTINCT s.work) AS books, count(*) AS finishes, max(s.ended_on) AS last
            FROM scoped s CROSS JOIN item_tags it ON it.item_id = s.item_id
            GROUP BY s.scope, it.tag_id
          ) g JOIN tags t ON t.id = g.tag_id`,
         'books DESC, finishes DESC, last DESC, name',
         YEAR_TOP,
       )} ORDER BY scope, rn`,
    ),
    // the average rating given
    inYear(`${YEAR_RATED} SELECT scope, avg(rating) AS average, count(*) AS n FROM rated GROUP BY scope`),
    // the highest-rated books: a book's ratings averaged across its readers and editions
    inYear(
      `${YEAR_RATED}
       SELECT t.scope, t.item_id AS id, i.title, i.creators, t.rating FROM (
         ${topPerScope(
           'SELECT scope, work, min(item_id) AS item_id, avg(rating) AS rating, max(last) AS last FROM rated GROUP BY scope, work',
           'rating DESC, last DESC, item_id',
           YEAR_TOP,
         )}
       ) t JOIN items i ON i.id = t.item_id ORDER BY t.scope, t.rn`,
    ),
    // the longest and the shortest book with a length
    inYear(
      `${YEAR_FINISHES}
       SELECT 'longest' AS which, * FROM (${topPerScope('SELECT scope, item_id, title, length, ended_on FROM scoped WHERE length > 0', 'length DESC, ended_on DESC, item_id', 1)})
       UNION ALL
       SELECT 'shortest' AS which, * FROM (${topPerScope('SELECT scope, item_id, title, length, ended_on FROM scoped WHERE length > 0', 'length ASC, ended_on DESC, item_id', 1)})`,
    ),
    // the fastest read, began to ended with both days counted; a read with no start, or ending before it starts, has none
    inYear(
      `${YEAR_FINISHES}
       ${topPerScope(
         `SELECT scope, item_id, title, CAST(julianday(ended_on) - julianday(began_on) AS INTEGER) + 1 AS days, ended_on
          FROM scoped WHERE julianday(began_on) IS NOT NULL AND julianday(ended_on) >= julianday(began_on)`,
         'days ASC, ended_on DESC, item_id',
         1,
       )}`,
    ),
    // the household's plays: a total and the most played, per type — a range on idx_plays_played_item
    d1
      .prepare(
        `WITH p AS (
           SELECT i.media_type AS type, p.item_id, i.title, count(*) AS plays, max(p.played_on) AS last
           FROM plays p JOIN items i ON i.id = p.item_id
           WHERE p.played_on >= ?1 AND p.played_on < ?2 AND i.media_type IN (${PLAYABLE_SQL})
           GROUP BY p.item_id
         )
         SELECT type, NULL AS id, NULL AS title, sum(plays) AS plays, count(*) AS items, 0 AS rn FROM p GROUP BY type
         UNION ALL
         SELECT type, item_id, title, plays, 1, rn FROM (
           SELECT *, row_number() OVER (PARTITION BY type ORDER BY plays DESC, last DESC, title, item_id) AS rn FROM p
         ) WHERE rn <= ${PLAYS_TOP}
         ORDER BY type, rn`,
      )
      .bind(from, to),
    // the finished books with no end date, which are in no year, and how many members there are
    d1
      .prepare(
        `SELECT (SELECT count(*) FROM users) AS members,
           count(CASE WHEN r.reader_id = ?1 THEN 1 END) AS mine, count(*) AS household
         FROM reads r JOIN items i ON i.id = r.item_id
         WHERE r.status = 'completed' AND r.ended_on IS NULL AND i.media_type = 'book'`,
      )
      .bind(userId),
    // the years there is anything to show for
    d1.prepare(YEARS_WITH_DATA),
  ]);

  const review: YearReview = {
    year,
    mine: emptyStats(),
    household: emptyStats(),
    plays: { vinyl: emptyPlays(), boardgame: emptyPlays() },
    undated: { mine: 0, household: 0 },
    years: [],
    members: 0,
  };
  const rowsOf = <T>(r: D1Result | undefined) => (r?.results ?? []) as T[];
  for (const m of rowsOf<{ scope: string; month: number; books: number; pages: number; withLength: number }>(months)) {
    const s = review[scopeOf(m.scope)];
    const slot = s.months[m.month - 1];
    if (!slot) continue; // not a month: a date the app never writes
    slot.books = m.books;
    slot.pages = m.pages;
    s.books += m.books;
    s.pages += m.pages;
    s.withLength += m.withLength;
  }
  for (const a of rowsOf<{ scope: string; name: string; books: number; finishes: number }>(authors)) {
    review[scopeOf(a.scope)].authors.push({ name: a.name, books: a.books, finishes: a.finishes });
  }
  for (const t of rowsOf<{ scope: string; name: string; books: number }>(tags)) {
    review[scopeOf(t.scope)].tags.push({ name: t.name, books: t.books });
  }
  for (const r of rowsOf<{ scope: string; average: number; n: number }>(ratings)) {
    review[scopeOf(r.scope)].rating = { average: r.average, count: r.n };
  }
  for (const r of rowsOf<{ scope: string; id: number; title: string; creators: string | null; rating: number }>(topRated)) {
    review[scopeOf(r.scope)].topRated.push({ id: r.id, title: r.title, creators: r.creators, rating: r.rating });
  }
  for (const l of rowsOf<{ which: string; scope: string; item_id: number; title: string; length: number }>(lengths)) {
    review[scopeOf(l.scope)][l.which === 'longest' ? 'longest' : 'shortest'] = { id: l.item_id, title: l.title, length: l.length };
  }
  for (const f of rowsOf<{ scope: string; item_id: number; title: string; days: number }>(fastest)) {
    review[scopeOf(f.scope)].fastest = { id: f.item_id, title: f.title, days: f.days };
  }
  for (const p of rowsOf<{ type: string; id: number | null; title: string | null; plays: number; items: number; rn: number }>(plays)) {
    const log = p.type === 'vinyl' ? review.plays.vinyl : p.type === 'boardgame' ? review.plays.boardgame : null;
    if (!log) continue;
    if (p.rn === 0) Object.assign(log, { plays: p.plays, items: p.items });
    else if (p.id !== null) log.top.push({ id: p.id, title: p.title ?? '', plays: p.plays });
  }
  const counts = rowsOf<{ members: number; mine: number; household: number }>(meta)[0];
  review.undated = { mine: counts?.mine ?? 0, household: counts?.household ?? 0 };
  review.members = counts?.members ?? 0;
  review.years = rowsOf<{ y: string }>(years).map((r) => Number(r.y));
  return review;
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
  // borrowed from someone not on Nalanda (§16 #82): a Nalanda export's `borrowed` cell, or the trash's
  borrows?: LoanDraft[];
  // a Nalanda export's `plays` (§16 #54); any other file brings none
  plays?: PersonPlay[];
  goodreads?: GoodreadsReading;
  series?: SeriesDraft | null; // its series, and the series' total when the file gives one (§16 #52)
  // a trash restore's (§16 #74): the series' own total stays over the snapshot's, which may be older than a correction
  keepSeriesTotal?: boolean;
  // a Nalanda export's want lists and purchase links (§16 #53), each want already resolved to a member here
  wants?: PersonWant[];
  links?: LinkDraft[];
  // the pages recorded, each with the read it belonged to — only a restore from the trash brings these (§16 #74)
  progress?: ProgressDraft[];
  // "also held as" (§16 #75): a Nalanda export's, or the trash's
  editions?: EditionDraft[];
  // quotes and highlights (§16 #77), each already resolved to a member here, nobody (null) or the importer
  quotes?: PersonQuote[];
};


/** Inserts an item's editions — its id, or 'newest' for one inserted earlier in the batch — at most MAX_EDITIONS_PER_ITEM. */
function editionInsertStatements(d1: D1Database, item: number | 'newest', editions: EditionDraft[]): D1PreparedStatement[] {
  if (!editions.length) return [];
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const json = JSON.stringify(editions.slice(0, MAX_EDITIONS_PER_ITEM));
  const stmt = d1.prepare(
    `INSERT INTO editions (item_id, format, isbn, publisher, year)
     SELECT ${itemRef}, json_extract(value, '$.format'), json_extract(value, '$.isbn'), json_extract(value, '$.publisher'), json_extract(value, '$.year')
     FROM json_each(?1) ORDER BY key`,
  );
  return [item === 'newest' ? stmt.bind(json) : stmt.bind(json, item)];
}

/**
 * Inserts quotes for an item — its id, or 'newest' for one inserted earlier in the batch — skipping any the same
 * person already has of the same text on it (a Kindle file imported twice brings nothing twice), at most
 * MAX_QUOTES_PER_ITEM on the item, counted in the statement with what it holds already. `person` is whose a quote
 * with no `userId` is.
 */
function quoteInsertStatements(d1: D1Database, item: number | 'newest', quotes: PersonQuote[], person: number | null): D1PreparedStatement[] {
  if (!quotes.length) return [];
  const itemRef = item === 'newest' ? '(SELECT max(id) FROM items)' : '?2';
  const json = JSON.stringify(
    quotes.slice(0, MAX_QUOTES_PER_ITEM).map((q) => ({
      userId: q.userId === undefined ? person : q.userId,
      text: q.text,
      page: q.page,
      note: q.note,
      shared: q.shared ? 1 : 0,
      at: q.at ?? null,
      source: q.source ?? null,
    })),
  );
  const stmt = d1.prepare(
    `INSERT INTO quotes (item_id, user_id, text, page, note, shared, source, at)
     SELECT ${itemRef}, json_extract(j.value, '$.userId'), json_extract(j.value, '$.text'), json_extract(j.value, '$.page'),
            json_extract(j.value, '$.note'), json_extract(j.value, '$.shared'), json_extract(j.value, '$.source'),
            coalesce(json_extract(j.value, '$.at'), datetime('now'))
     FROM json_each(?1) AS j
     WHERE NOT EXISTS (SELECT 1 FROM quotes q WHERE q.item_id = ${itemRef} AND q.user_id IS json_extract(j.value, '$.userId') AND q.text = json_extract(j.value, '$.text'))
       AND (SELECT count(*) FROM quotes q WHERE q.item_id = ${itemRef}) + j.key < ${MAX_QUOTES_PER_ITEM}
     ORDER BY j.key`,
  );
  return [item === 'newest' ? stmt.bind(json) : stmt.bind(json, item)];
}

/** An item's "also held as" lines, in the order they were entered. */
export async function editionsOf(d1: D1Database, itemId: number): Promise<EditionDraft[]> {
  return (
    await d1.prepare('SELECT format, isbn, publisher, year FROM editions WHERE item_id = ?1 ORDER BY id').bind(itemId).all<EditionDraft>()
  ).results;
}

/** A page recorded, as the trash keeps it: its read named by what it was, since ids are new on restore. */
export type ProgressDraft = { page: number; at: string; addedBy: number | null; read: PersonRead | null };

/**
 * Pages recorded, for an item inserted earlier in the batch, each pointed at its read — found again by its reader,
 * status and dates among the reads inserted just before (readInsertStatements), or at no read when it had none.
 */
function progressInsertStatements(d1: D1Database, progress: ProgressDraft[]): D1PreparedStatement[] {
  if (!progress.length) return [];
  const json = JSON.stringify(progress.slice(0, MAX_PROGRESS_ROWS));
  return [
    d1
      .prepare(
        `INSERT INTO reading_progress (item_id, page, at, added_by, read_id)
         SELECT (SELECT max(id) FROM items), json_extract(value, '$.page'), json_extract(value, '$.at'), json_extract(value, '$.addedBy'),
           (SELECT r.id FROM reads r WHERE r.item_id = (SELECT max(id) FROM items)
              AND json_type(value, '$.read') = 'object'
              AND r.reader_id IS json_extract(value, '$.read.readerId') AND r.status = json_extract(value, '$.read.status')
              AND r.began_on IS json_extract(value, '$.read.beganOn') AND r.ended_on IS json_extract(value, '$.read.endedOn')
            ORDER BY r.id LIMIT 1)
         FROM json_each(?1) ORDER BY key`,
      )
      .bind(json),
  ];
}
const MAX_PROGRESS_ROWS = 5_000;

/**
 * Batched insert used by /api/import. One network round trip per batch of rows: each item goes in with the
 * reading state its reads decide and the rating and review its reviews decide, so the insert trigger dates it
 * right, then its tags, its reads and reviews, then the refreshes that fill in what only they know, then its loans
 * and its plays, which nothing on the item depends on (§16 #54). Loans go only onto the item their row makes, never
 * onto one already here. One batch, the tags inside it (§16 #39): linked after it, as they once were, a failure
 * there left the items committed without them — and a restore's trash row gone. The ids the rows were given, in
 * their order, from the batch's own results.
 */
export async function importItems(d1: D1Database, rows: ImportRow[], extra: D1PreparedStatement[] = []): Promise<number[]> {
  if (!rows.length) return [];
  const writes: D1PreparedStatement[] = [];
  const itemAt: number[] = []; // each row's item insert, as an index into the batch's results
  for (const r of rows) {
    const person = r.item.addedBy ?? null;
    const reads = oneOpenReadEach(r.reads ?? readsFromColumns(r.item.status ?? 'not_started', r.item.beganOn, r.item.completedOn), person).reads;
    const reviews = stampReviews(r.reviews ?? reviewsFromColumns(r.item));
    // A row dated by its file (§16 #90) keeps the time of its insert in created_at, so its stamp to connections is
    // still the second it was made here: ids are reused, and two books added over there on one day are the common case.
    // A row that brings its own time — a trash restore, giving the book back the stamp it had — keeps that.
    const values = withSeries(withReviewState(withReadState(r.item, reads), reviews), r.series);
    const q = db(d1)
      .insert(s.items)
      .values(r.item.addedAt && r.item.createdAt == null ? { ...values, createdAt: sql`(datetime('now'))` } : values)
      .returning({ id: s.items.id })
      .toSQL();
    writes.push(...seriesUpsert(d1, r.series, r.keepSeriesTotal ? 'series' : 'draft'));
    itemAt.push(writes.length + 1); // +1: the marker leads the batch
    writes.push(
      d1.prepare(q.sql).bind(...q.params),
      ...tagLinkStatements(d1, 'newest', r.tags),
      ...readInsertStatements(d1, 'newest', reads, person),
      refreshReadState(d1, 'newest'),
      ...reviewInsertStatements(d1, 'newest', reviews, person),
      refreshReviewState(d1, 'newest'),
      ...loanInsertStatements(d1, r.loans ?? []),
      ...borrowInsertStatements(d1, r.borrows ?? []),
      ...playInsertStatements(d1, r.plays ?? [], person),
      ...wantInsertStatements(d1, 'newest', r.wants ?? []),
      ...linkInsertStatements(d1, 'newest', r.links ?? []),
      ...progressInsertStatements(d1, r.progress ?? []),
      ...editionInsertStatements(d1, 'newest', r.editions ?? []),
      ...quoteInsertStatements(d1, 'newest', r.quotes ?? [], person),
    );
  }
  const results = await d1.batch(asImport(d1, [...writes, ...extra]));
  return rows.map((_, i) => (results[itemAt[i]!]?.results[0] as { id: number }).id);
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

export const titleKey = (title: string, creators: string | null) => `${normTitle(title)}|${surname(creators)}`;

/** `dated`: the matched books whose date added the file would change — and did, when the caller asked for dates. */
export type MergeImportResult = { inserted: number; merged: number; reads: number; dated: number };

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
 *
 * A row's `addedAt` is when the book joined the collection over there (§16 #90): a new book is dated by it, and a
 * matched one only with `dates` — the import page's box — since it moves the book on every newest-first shelf. That
 * write keeps the row's own time in `created_at` (the stamp connections hold is taken from it) and never moves
 * `updated_at`: nothing a connection sees has changed. `dated` counts the matches whose date differs from the file's,
 * whether or not they were written, so a dry run can say what the box would do.
 */
export async function mergeImportItems(d1: D1Database, rows: ImportRow[], dryRun = false, who?: Writer, dates = false): Promise<MergeImportResult> {
  if (!rows.length) return { inserted: 0, merged: 0, reads: 0, dated: 0 };
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
      addedAt: s.items.addedAt,
    })
    .from(s.items);
  const byIsbn13 = new Map<string, number>();
  const byIsbn10 = new Map<string, number>();
  const byTitle = new Map<string, number>();
  const addedHere = new Map<number, string>();
  for (const e of existing) {
    if (e.isbn13) byIsbn13.set(e.isbn13, e.id);
    if (e.isbn10Upc) byIsbn10.set(e.isbn10Upc.toUpperCase(), e.id);
    byTitle.set(titleKey(e.title, e.creators), e.id);
    addedHere.set(e.id, e.addedAt);
  }

  const inserts: ImportRow[] = [];
  const merges: Array<{ id: number; set: Partial<NewItem>; tags: string[]; reading: GoodreadsReading }> = [];
  const redate = new Map<number, string>(); // matched books the file dates differently; a later row for the same book wins
  for (const r of rows) {
    const id =
      (r.item.isbn13 ? byIsbn13.get(r.item.isbn13) : undefined) ??
      (r.item.isbn10Upc ? byIsbn10.get(r.item.isbn10Upc.toUpperCase()) : undefined) ??
      byTitle.get(titleKey(r.item.title, r.item.creators ?? null));
    if (!id) {
      inserts.push(r);
      continue;
    }
    if (r.item.addedAt && addedHere.get(id) !== r.item.addedAt) redate.set(id, r.item.addedAt);
    else if (r.item.addedAt) redate.delete(id);
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
      // the household's notes are kept, and the file's added (§16 #87): empty takes them; ones already holding the text
      // stay as they are — a re-import changes nothing, and an unchanged row isn't re-dated — else a blank line and the text
      const notes = merges
        .filter((m) => m.set.notes)
        .map((m) =>
          d1
            .prepare(
              `UPDATE items SET notes = CASE WHEN notes IS NULL OR notes = '' THEN ?2 ELSE notes || char(10) || char(10) || ?2 END,
                 updated_at = datetime('now')
               WHERE id = ?1 AND (notes IS NULL OR instr(notes, ?2) = 0)`,
            )
            .bind(m.id, m.set.notes),
        );
      const reviews = merges
        .filter((m) => m.set.rating != null || m.set.review)
        .flatMap((m) => reviewWriteStatements(d1, m.id, person, { rating: m.set.rating ?? null, review: m.set.review ?? null }, 'merge'));
      const refreshes = [
        ...(touched.length ? [refreshReadState(d1, touched, { touch: true })] : []),
        ...(untouched.length ? [refreshReadState(d1, untouched)] : []),
      ];
      // the file's dates, when asked (§16 #90): one statement over the pairs as JSON. The SET sees the row as it was,
      // so created_at takes the added_at being replaced — only the first time; a book re-dated again keeps it.
      const redates = dates && redate.size
        ? [
            d1
              .prepare(
                `UPDATE items SET created_at = coalesce(created_at, added_at), added_at = j.at
                 FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.at') AS at FROM json_each(?1)) AS j
                 WHERE items.id = j.id AND items.added_at <> j.at`,
              )
              .bind(JSON.stringify([...redate].map(([id, at]) => ({ id, at })))),
          ]
        : [];
      // the file's tags onto the books it matched, additive, in the same batch (§16 #39)
      const tags = merges.flatMap((m) => tagLinkStatements(d1, m.id, m.tags));
      // reads and their refresh first, so a rating merged in the same batch is dated by the finish it arrived with
      await d1.batch(asImport(d1, asWriter(d1, who, [...writes, ...refreshes, ...reviews, ...notes, ...redates, refreshReviewState(d1, ids), ...tags])));
    }
    await importItems(d1, inserts);
  }
  return { inserted: inserts.length, merged: merges.length, reads: readChanges, dated: redate.size };
}

// ---------- creators and publishers (ARCH.md §16 #72) ----------

/**
 * Every creator the catalog names, with how many items of each kind: one pass over `creators`, split into people in
 * TypeScript (splitCreators, the twin of YEAR_CREATORS). Reads one row per item that has creators — a 2,000-item
 * catalogue reads 2,000 — once per visit to the index.
 */
export async function listCreators(d1: D1Database): Promise<NameCount[]> {
  const rows = await d1
    .prepare(`SELECT media_type AS mediaType, creators FROM items WHERE creators IS NOT NULL AND trim(creators) <> ''`)
    .all<{ mediaType: MediaType; creators: string }>();
  const counts = new Map<string, NameCount>();
  for (const r of rows.results) for (const name of splitCreators(r.creators)) countName(counts, name, r.mediaType);
  return sortNames([...counts.values()]);
}

/** Every publisher (a record's label), with how many items of each kind: grouped in SQL, one row per name and kind. */
export async function listPublishers(d1: D1Database): Promise<NameCount[]> {
  const rows = await d1
    .prepare(
      `SELECT min(trim(publisher)) AS name, media_type AS mediaType, count(*) AS n FROM items
       WHERE publisher IS NOT NULL AND trim(publisher) <> ''
       GROUP BY lower(trim(publisher)), media_type`,
    )
    .all<{ name: string; mediaType: MediaType; n: number }>();
  const counts = new Map<string, NameCount>();
  for (const r of rows.results) for (let i = 0; i < r.n; i++) countName(counts, r.name, r.mediaType);
  return sortNames([...counts.values()]);
}

export type ByNameRow = Item & { finishedByMe: boolean };

/**
 * Every item one creator is named on, by title, with whether the viewer has finished it. The column holds several
 * people in one string, so SQL narrows to rows that contain the name's last word and TypeScript keeps those where the
 * split names it exactly, without case: "Ann Leckie" is not on "Ann Leckie Jr."'s page, and "Le Guin, Ursula K." is on
 * Ursula K. Le Guin's. SQLite's lower() folds ASCII only, so the narrowing is used only when that word is plain ASCII;
 * "Jens Østergaard" reads every row with creators instead — one row per item, as the index does — and the exact match
 * decides.
 */
export async function itemsByCreator(d1: D1Database, name: string, viewer: number): Promise<ByNameRow[]> {
  const key = nameKey(name);
  if (!key) return [];
  const last = key.split(' ').at(-1) ?? '';
  const narrow = /^[\x00-\x7f]+$/.test(last)
    ? sql`instr(lower(${s.items.creators}), ${last}) > 0`
    : sql`${s.items.creators} IS NOT NULL AND trim(${s.items.creators}) <> ''`;
  const rows = await db(d1)
    .select({ item: s.items, finished: finishedByViewer(viewer) })
    .from(s.items)
    .where(narrow)
    .orderBy(asc(s.items.title), asc(s.items.id));
  return rows
    .filter((r) => splitCreators(r.item.creators).some((n) => nameKey(n) === key))
    .map((r) => ({ ...r.item, finishedByMe: !!r.finished }));
}

/** Every item one publisher put out, by title, with whether the viewer has finished it. An exact name, without case. */
export async function itemsByPublisher(d1: D1Database, name: string, viewer: number): Promise<ByNameRow[]> {
  const key = nameKey(name);
  if (!key) return [];
  const rows = await db(d1)
    .select({ item: s.items, finished: finishedByViewer(viewer) })
    .from(s.items)
    .where(sql`lower(trim(${s.items.publisher})) = ${key}`)
    .orderBy(asc(s.items.title), asc(s.items.id));
  return rows.filter((r) => nameKey(r.item.publisher ?? '') === key).map((r) => ({ ...r.item, finishedByMe: !!r.finished }));
}

/** Whether the viewer has a finished read of the item — as seriesWithVolumes() asks it. */
const finishedByViewer = (viewer: number) =>
  sql<number>`EXISTS (SELECT 1 FROM reads r WHERE r.item_id = "items"."id" AND r.reader_id = ${viewer} AND r.status = 'completed')`.as(
    'finished_by_me',
  );
/**
 * Points an item at a cover, or at none (§16 #73): the key it had before, so the caller can delete that object. One
 * batch — a RETURNING clause sees the row as updated, so the old key is read in the statement before the write.
 */
export async function setCover(d1: D1Database, id: number, coverKey: string | null, who?: Writer): Promise<{ before: string | null } | null> {
  const results = await d1.batch(asWriter(d1, who, [
    d1.prepare('SELECT cover_key AS before FROM items WHERE id = ?1').bind(id),
    d1.prepare(`UPDATE items SET cover_key = ?2, updated_at = datetime('now') WHERE id = ?1`).bind(id, coverKey),
  ]));
  const [was, did] = results.slice(who ? 1 : 0);
  const row = (was?.results?.[0] as { before: string | null } | undefined) ?? null;
  return row && did?.meta?.changes ? row : null;
}

// ---------- item history (ARCH.md §16 #84) ----------

/** How long a change to an item's own fields is kept. */
export const HISTORY_DAYS = 90;
/** The most entries the item page lists. */
export const HISTORY_SHOWN = 200;

export type HistoryEntry = {
  id: number;
  field: string;
  before: string | null;
  after: string | null;
  at: string;
  /** who: the member's username while it is still their account (#56), 'a former member' once not, null when nobody was named */
  by: string | null;
};

/**
 * The item page's history read, for admins, in the page's batch — read-only: the item's entries inside HISTORY_DAYS,
 * newest first, with the username only while the account is still the one that made the change. The sweep past
 * HISTORY_DAYS is every item write's (asWriter), never a page's; the window here means a row the sweep hasn't reached
 * yet is never shown either.
 */
export function itemHistoryStatements(d1: D1Database, itemId: number): D1PreparedStatement[] {
  return [
    d1
      .prepare(
        `SELECT h.id, h.field, h.before, h.after, h.at, h.changed_by AS changedBy, u.username, (u.session_key = h.changed_key) AS same
         FROM item_history h LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.item_id = ?1 AND h.at >= datetime('now', '-${HISTORY_DAYS} days') ORDER BY h.id DESC LIMIT ${HISTORY_SHOWN}`,
      )
      .bind(itemId),
  ];
}

export function historyOf(result: D1Result | undefined): HistoryEntry[] {
  type Row = { id: number; field: string; before: string | null; after: string | null; at: string; changedBy: number | null; username: string | null; same: number | null };
  return ((result?.results ?? []) as Row[]).map((r) => ({
    id: r.id,
    field: r.field,
    before: r.before,
    after: r.after,
    at: r.at,
    by: r.changedBy === null ? null : r.same && r.username ? r.username : 'a former member',
  }));
}

// ---------- the trash (ARCH.md §16 #74) ----------

/** How long a deleted item can be restored. Past it, the row and its cover's object are purged. */
export const TRASH_DAYS = 30;

/** SQL text for one JSON array of objects over `from`, in `order` — wrapped in json() so it nests as JSON, not as a string. */
const jsonRows = (fields: string, from: string, order = 'id') =>
  `json((SELECT coalesce(json_group_array(json_object(${fields})), '[]') FROM (SELECT * FROM ${from} ORDER BY ${order})))`;

/**
 * The snapshot an item leaves in the trash, built by SQLite in the delete's own batch. The item's columns come from
 * the schema, so a column added later is in the snapshot the day it exists (a test holds the keys to the table's);
 * what hangs off it is each dependent table as the import's row shape takes it back (ImportRow).
 */
function trashPayloadSql(): string {
  const cols = Object.entries(getTableColumns(s.items))
    .filter(([key]) => key !== 'id')
    .map(([key, col]) => `'${key}', i.${col.name}`)
    .join(', ');
  return `json_object(
    'item', json_object(${cols}),
    'tags', json((SELECT coalesce(json_group_array(name), '[]') FROM (SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id ORDER BY t.name))),
    'series', json((SELECT json_object('name', sr.name, 'number', i.series_number, 'total', sr.total) FROM series sr WHERE sr.id = i.series_id)),
    'reads', ${jsonRows("'status', status, 'beganOn', began_on, 'endedOn', ended_on, 'readerId', reader_id", 'reads WHERE item_id = i.id')},
    'reviews', ${jsonRows("'userId', user_id, 'rating', rating, 'review', review, 'reviewedAt', reviewed_at, 'ratedAt', rated_at", 'reviews WHERE item_id = i.id')},
    'loans', ${jsonRows("'borrower', borrower, 'loanedOn', loaned_on, 'dueOn', due_on, 'returnedOn', returned_on, 'contact', contact, 'note', note, 'edition', edition", 'loans WHERE item_id = i.id')},
    'borrows', ${jsonRows("'borrower', lender, 'loanedOn', borrowed_on, 'dueOn', due_on, 'returnedOn', returned_on, 'contact', contact, 'note', note", 'borrows WHERE item_id = i.id')},
    'plays', ${jsonRows("'playedOn', played_on, 'loggedBy', logged_by", 'plays WHERE item_id = i.id')},
    'wants', ${jsonRows("'userId', user_id, 'at', created_at", 'wants WHERE item_id = i.id', 'created_at, user_id')},
    'links', ${jsonRows("'label', label, 'url', url", 'purchase_links WHERE item_id = i.id')},
    'editions', ${jsonRows("'format', format, 'isbn', isbn, 'publisher', publisher, 'year', year", 'editions WHERE item_id = i.id')},
    'quotes', ${jsonRows("'userId', user_id, 'text', text, 'page', page, 'note', note, 'shared', shared, 'at', at, 'source', source", 'quotes WHERE item_id = i.id', 'at, id')},
    'people', json((SELECT coalesce(json_group_object(id, session_key), '{}') FROM users)),
    'progress', json((SELECT coalesce(json_group_array(json_object(
        'page', page, 'at', at, 'addedBy', added_by,
        'read', json(CASE WHEN rid IS NULL THEN NULL ELSE json_object('status', rstatus, 'beganOn', rbegan, 'endedOn', rended, 'readerId', rreader) END)
      )), '[]')
      FROM (SELECT p.page, p.at, p.added_by, r.id AS rid, r.status AS rstatus, r.began_on AS rbegan, r.ended_on AS rended, r.reader_id AS rreader
            FROM reading_progress p LEFT JOIN reads r ON r.id = p.read_id WHERE p.item_id = i.id ORDER BY p.id)))
  )`;
}

/** Who is deleting, as the trash names them (§16 #56): the id and the account's key, never the id alone. */
export type Deleter = { id: number; sessionKey: string } | null;

/**
 * Deletes items into the trash: each one's snapshot is written, then the rows go, in one batch — nothing is ever
 * deleted without its snapshot, and nothing snapshotted stays. The delete is the one it always was: cascades take
 * the dependents, triggers tell connections, the series is pruned (§16 #52). The cover's object is left in storage.
 * The same batch purges what is past its 30 days first, so the retention holds whether or not anyone opens the
 * Trash page: `expired` is the purged rows' cover keys, for the caller to delete the objects.
 */
export async function trashItems(d1: D1Database, ids: number[], deletedBy: Deleter): Promise<{ trashed: number; expired: string[] }> {
  if (!ids.length) return { trashed: 0, expired: [] };
  const [old, , inserted] = await d1.batch([
    ...purgeStatements(d1),
    ...trashStatements(d1, (table) => `${table}${SELECTED}`, JSON.stringify(ids), deletedBy),
    pruneSeries(d1),
  ]);
  return { trashed: inserted?.meta?.changes ?? 0, expired: expiredKeys(old) };
}

/**
 * The two statements that move the items `where` selects into the trash — the snapshot of each, then the delete —
 * for a batch that leads with the purge. `where` is given the table prefix to write its column under ('i.' for the
 * snapshot's select, '' for the delete); `bind` is its ?1.
 */
function trashStatements(d1: D1Database, where: (table: string) => string, bind: unknown, deletedBy: Deleter): [D1PreparedStatement, D1PreparedStatement] {
  return [
    d1
      .prepare(
        `INSERT INTO trash (item_id, library_id, library_name, media_type, title, creators, cover_key, payload, deleted_by, deleted_by_key)
         SELECT i.id, i.library_id, (SELECT l.name FROM libraries l WHERE l.id = i.library_id), i.media_type, i.title, i.creators, i.cover_key,
                ${trashPayloadSql()}, ?2, ?3
         FROM items i WHERE ${where('i.')} ORDER BY i.id`,
      )
      .bind(bind, deletedBy?.id ?? null, deletedBy?.sessionKey ?? null),
    d1.prepare(`DELETE FROM items WHERE ${where('')}`).bind(bind),
  ];
}

const purgeStatements = (d1: D1Database): [D1PreparedStatement, D1PreparedStatement] => {
  const cutoff = `datetime('now', '-${TRASH_DAYS} days')`;
  return [
    d1.prepare(`SELECT cover_key AS coverKey FROM trash WHERE deleted_at < ${cutoff} AND cover_key IS NOT NULL`),
    d1.prepare(`DELETE FROM trash WHERE deleted_at < ${cutoff}`),
  ];
};
const expiredKeys = (old: D1Result | undefined): string[] => ((old?.results ?? []) as Array<{ coverKey: string }>).map((r) => r.coverKey);

export type TrashRow = {
  id: number;
  itemId: number;
  libraryId: number | null;
  libraryName: string | null;
  mediaType: MediaType;
  title: string;
  creators: string | null;
  coverKey: string | null;
  deletedAt: string;
  deletedBy: number | null;
  deletedByKey: string | null;
};

const TRASH_COLUMNS = `id, item_id AS itemId, library_id AS libraryId, library_name AS libraryName, media_type AS mediaType, title, creators,
  cover_key AS coverKey, deleted_at AS deletedAt, deleted_by AS deletedBy, deleted_by_key AS deletedByKey`;

/** What the trash holds, newest first. */
export async function listTrash(d1: D1Database): Promise<TrashRow[]> {
  return (await d1.prepare(`SELECT ${TRASH_COLUMNS} FROM trash ORDER BY deleted_at DESC, id DESC`).all<TrashRow>()).results;
}

/** One trash row with its snapshot, and whether it is past TRASH_DAYS — then it is only waiting for the purge. */
export async function getTrash(d1: D1Database, id: number): Promise<(TrashRow & { payload: string; expired: boolean }) | null> {
  const row = await d1
    .prepare(`SELECT ${TRASH_COLUMNS}, payload, (deleted_at < datetime('now', ?2)) AS expired FROM trash WHERE id = ?1`)
    .bind(id, `-${TRASH_DAYS} days`)
    .first<TrashRow & { payload: string; expired: number }>();
  return row ? { ...row, expired: !!row.expired } : null;
}

/** The snapshot, as the trash row holds it. */
export type TrashPayload = {
  item: Record<string, unknown>;
  tags: string[];
  series: { name: string; number: number | null; total: number | null } | null;
  reads: Array<{ status: ReadStatus; beganOn: string | null; endedOn: string | null; readerId: number | null }>;
  reviews: Array<{ userId: number | null; rating: number | null; review: string | null; reviewedAt: string | null; ratedAt: string | null }>;
  loans: LoanDraft[];
  borrows?: LoanDraft[]; // borrowed from someone (§16 #82), as the loans are
  plays: Array<{ playedOn: string; loggedBy: number | null }>;
  wants: Array<{ userId: number; at: string | null }>;
  links: LinkDraft[];
  progress: ProgressDraft[];
  editions?: EditionDraft[];
  quotes?: Array<{ userId: number | null; text: string; page: string | null; note: string | null; shared: number | boolean; at: string | null; source: string | null }>;
  /** every member at the time, id to session key (§16 #56): an id is a person only while it still has that key */
  people: Record<string, string>;
};

/**
 * Why a restore couldn't happen: the row is gone (restored or let go already), past its TRASH_DAYS, or its shelf is
 * gone — by id and name, or by name alone — and must be made first.
 */
export type RestoreRefusal = { refused: 'gone' } | { refused: 'expired' } | { refused: 'no-shelf'; shelf: string | null };

/**
 * Restores a trashed item: its snapshot goes back through the import's insert — the item under a new id, its series,
 * tags, reads, reviews, pages, plays, wants, links and loans — and the trash row goes in the same batch. The insert
 * takes the item's title through the trash row itself, while the row is still within its days: a row restored or
 * purged meanwhile — a Restore clicked twice — has none, the column's NOT NULL fails the whole batch, and D1 rolls it
 * back, so the restore can't happen twice and nothing of a second one lands (the insert alone gated would leave the
 * statements after it, which find the item as the newest, writing the snapshot's reads onto whatever is newest).
 * A member removed since is nobody on their reads, reviews, plays and pages, and their wants are dropped:
 * `members` is who exists now. Bracketed as an import, so old reads aren't news to connections (§16 #40). The new
 * item's id, from the insert's own RETURNING, or why not.
 */
export async function restoreFromTrash(d1: D1Database, trashId: number, members: Map<number, string>): Promise<{ id: number } | RestoreRefusal> {
  const row = await getTrash(d1, trashId);
  if (!row) return { refused: 'gone' };
  if (row.expired) return { refused: 'expired' };
  const p = JSON.parse(row.payload) as TrashPayload;
  if (!p.item) return { refused: 'expired' }; // a snapshot the sweep has let go of
  // a person only while the id still has the key it had (§16 #56): a member given the id since gets nothing of theirs
  const people = p.people ?? {};
  const who = (id: number | null | undefined): number | null =>
    id !== null && id !== undefined && people[String(id)] !== undefined && members.get(id) === people[String(id)] ? id : null;
  // its shelf: the one it was on, if still so named (shelf ids are reused too); else a shelf of that name; else none
  const shelf = await shelfForRestore(d1, row.libraryId, row.libraryName);
  if (shelf === null) return { refused: 'no-shelf', shelf: row.libraryName };
  const { seriesId: _series, title: _title, ...rest } = p.item as Record<string, unknown> & { seriesId?: unknown; title?: unknown };
  // the time its stamp to connections was taken from (§16 #90): kept only when the book comes back under its own id,
  // which the insert decides for itself — under any other id it would be the stamp of whatever book had that id at
  // that second — else the insert's own time, as a file-dated row takes
  const stampedAt = (rest['createdAt'] as string | null | undefined) ?? (rest['addedAt'] as string);
  const item = {
    ...rest,
    title: sql`(SELECT title FROM trash WHERE id = ${trashId} AND deleted_at >= datetime('now', ${`-${TRASH_DAYS} days`}))` as unknown as string,
    libraryId: shelf,
    addedBy: who(rest['addedBy'] as number | null),
    createdAt: sql`CASE WHEN (SELECT coalesce(max(id), 0) + 1 FROM items) = ${row.itemId} THEN ${stampedAt} ELSE datetime('now') END` as unknown as string,
  } as NewItem;
  const importRow: ImportRow = {
    item,
    tags: p.tags ?? [],
    series: p.series ? { name: p.series.name, number: p.series.number, total: p.series.total } : null,
    keepSeriesTotal: true, // the series' total as it is now, if the series is still here: the snapshot's may be older
    reads: (p.reads ?? []).map((r) => ({ status: r.status, beganOn: r.beganOn, endedOn: r.endedOn, readerId: who(r.readerId) })),
    reviews: (p.reviews ?? []).map((r) => ({ rating: r.rating, review: r.review, reviewedAt: r.reviewedAt, ratedAt: r.ratedAt, userId: who(r.userId) })),
    loans: p.loans ?? [],
    borrows: p.borrows ?? [],
    plays: (p.plays ?? []).map((pl) => ({ playedOn: pl.playedOn, loggedBy: who(pl.loggedBy) })),
    wants: (p.wants ?? []).filter((w) => who(w.userId) !== null),
    links: p.links ?? [],
    editions: p.editions ?? [],
    quotes: (p.quotes ?? []).map((q) => ({ text: q.text, page: q.page, note: q.note, shared: !!q.shared, at: q.at, source: q.source, userId: who(q.userId) })),
    progress: (p.progress ?? []).map((pr) => ({
      page: pr.page,
      at: pr.at,
      addedBy: who(pr.addedBy),
      read: pr.read ? { ...pr.read, readerId: who(pr.read.readerId) } : null,
    })),
  };
  // the latest page reached is the item's own column (progress_page), which an insert derives from its reads alone —
  // the pages are inserted after it, so it is written back from the snapshot once they are
  const latestPage = typeof rest['progressPage'] === 'number' ? rest['progressPage'] : null;
  try {
    const [id] = await importItems(d1, [importRow], [
      ...(latestPage === null ? [] : [d1.prepare('UPDATE items SET progress_page = ?1 WHERE id = (SELECT max(id) FROM items)').bind(latestPage)]),
      d1.prepare('DELETE FROM trash WHERE id = ?1').bind(trashId),
    ]);
    return id === undefined ? { refused: 'gone' } : { id };
  } catch (err) {
    if (refusedBy(err, 'items.title')) return { refused: 'gone' }; // restored or purged since it was read
    throw err;
  }
}

/** The shelf a restore goes to: the id it had while that shelf is still so named, else a shelf so named, else null. */
async function shelfForRestore(d1: D1Database, id: number | null, name: string | null): Promise<number | null> {
  if (id !== null) {
    const byId = await d1.prepare('SELECT name FROM libraries WHERE id = ?1').bind(id).first<{ name: string }>();
    if (byId && (name === null || byId.name === name)) return id;
  }
  if (name === null) return null;
  const byName = await d1.prepare('SELECT id FROM libraries WHERE lower(name) = lower(?1) ORDER BY id LIMIT 1').bind(name).first<{ id: number }>();
  return byName?.id ?? null;
}

/** Deletes one trash row for good: its cover's key, for the caller to delete the object. */
export async function discardTrash(d1: D1Database, id: number): Promise<string | null> {
  const row = await d1.prepare('DELETE FROM trash WHERE id = ?1 RETURNING cover_key AS coverKey').bind(id).first<{ coverKey: string | null }>();
  return row?.coverKey ?? null;
}

/** Purges rows older than TRASH_DAYS, in one batch: the cover keys of what went, for the caller to delete the objects. */
export async function purgeTrash(d1: D1Database): Promise<string[]> {
  const [old] = await d1.batch(purgeStatements(d1));
  return expiredKeys(old);
}

/** Everyone, with the key that says which account each id is now (§16 #56) — what a restore checks the snapshot's people against. */
export async function listMembersWithKeys(d1: D1Database): Promise<Array<{ id: number; username: string; sessionKey: string }>> {
  return (await d1.prepare('SELECT id, username, session_key AS sessionKey FROM users ORDER BY id').all<{ id: number; username: string; sessionKey: string }>()).results;
}

/** The members a restore may hand things back to, by id and key. */
export const memberKeys = (members: Array<{ id: number; sessionKey: string }>): Map<number, string> => new Map(members.map((m) => [m.id, m.sessionKey]));

// ---------- new from authors you've finished (ARCH.md §16 #78) ----------

/**
 * The authors of the books a member has finished, most finished first: the creators of each book with one of their
 * completed reads, split into people (splitCreators), each counted once per book. One query, reading only their
 * finished reads.
 */
export async function finishedAuthors(d1: D1Database, userId: number, limit = 20): Promise<Array<{ name: string; books: number }>> {
  const rows = (
    await d1
      .prepare(
        `SELECT DISTINCT i.id, i.creators FROM reads r JOIN items i ON i.id = r.item_id
         WHERE r.reader_id = ?1 AND r.status = 'completed' AND i.media_type = 'book' AND i.creators IS NOT NULL`,
      )
      .bind(userId)
      .all<{ id: number; creators: string }>()
  ).results;
  const counts = new Map<string, { name: string; books: number }>();
  for (const r of rows) {
    for (const name of splitCreators(r.creators)) {
      const key = nameKey(name);
      const c = counts.get(key) ?? { name, books: 0 };
      c.books += 1;
      counts.set(key, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.books - a.books || a.name.localeCompare(b.name, 'en')).slice(0, limit);
}

/** The catalog's books that name an author, lightly: id, title, creators and ISBN, for telling a found work from one already here. */
export async function booksNamed(d1: D1Database, author: string): Promise<Array<{ id: number; title: string; creators: string | null; isbn13: string | null }>> {
  const key = nameKey(author);
  if (!key) return [];
  const last = key.split(' ').at(-1) ?? '';
  const narrow = /^[\x00-\x7f]+$/.test(last) ? sql`instr(lower(${s.items.creators}), ${last}) > 0` : sql`${s.items.creators} IS NOT NULL`;
  const rows = await db(d1)
    .select({ id: s.items.id, title: s.items.title, creators: s.items.creators, isbn13: s.items.isbn13 })
    .from(s.items)
    .where(and(eq(s.items.mediaType, 'book'), narrow));
  return rows.filter((r) => splitCreators(r.creators).some((n) => nameKey(n) === key));
}
