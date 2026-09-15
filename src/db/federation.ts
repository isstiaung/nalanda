// All D1 access for connections between instances (docs/proposals/connections.md). Its own
// module so queries.ts stays untouched, while src/db/ remains the only code touching D1.
import { and, asc, count, desc, eq, gt, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { listItems } from './queries';
import * as s from './schema';
import {
  BACKFILL_ENTRIES,
  MAX_FEED_REVIEW_CHARS,
  MAX_STORED_ENTRIES_PER_CONNECTION,
  OUTBOX_PULL_MINUTES,
  OUTBOX_RETENTION_DAYS,
  VOLUME_WINDOW_DAYS,
} from '../federation/config';
import type {
  ActivityKind,
  BorrowedItem,
  BorrowRequestRow,
  BorrowStatus,
  Comment,
  Connection,
  ConnectionInvite,
  ConnectionStatus,
  ConnectionView,
  FederationSettings,
  FeedSubscription,
  Item,
  ItemStatus,
  MediaType,
  OutboxRow,
} from './schema';

const db = (d1: D1Database) => drizzle(d1);

// ---------- settings: a singleton row, id 1 ----------

export async function getFederationSettings(d1: D1Database): Promise<FederationSettings | null> {
  const [row] = await db(d1).select().from(s.federationSettings).where(eq(s.federationSettings.id, 1));
  return row ?? null;
}

export async function saveFederationSettings(
  d1: D1Database,
  values: { householdName: string; baseUrl: string },
): Promise<void> {
  await db(d1)
    .insert(s.federationSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: s.federationSettings.id, set: { ...values, updatedAt: sql`(datetime('now'))` } });
}

// ---------- invites ----------

export async function createInvite(
  d1: D1Database,
  values: { tokenHash: string; createdBy: number; ttlDays: number },
): Promise<ConnectionInvite> {
  const [row] = await db(d1)
    .insert(s.connectionInvites)
    .values({
      tokenHash: values.tokenHash,
      createdBy: values.createdBy,
      // SQLite's own clock and format, so expiry compares cleanly with datetime('now')
      expiresAt: sql`(datetime('now', ${`+${values.ttlDays} days`}))`,
    })
    .returning();
  if (!row) throw new Error('failed to create invite');
  return row;
}

export async function listInvites(d1: D1Database): Promise<ConnectionInvite[]> {
  return db(d1).select().from(s.connectionInvites).orderBy(desc(s.connectionInvites.id));
}

/** Revokes an invite that hasn't been used. A used one is history, not a credential. */
export async function revokeInvite(d1: D1Database, id: number): Promise<void> {
  await db(d1)
    .delete(s.connectionInvites)
    .where(and(eq(s.connectionInvites.id, id), isNull(s.connectionInvites.usedAt)));
}

const redeemable = (tokenHashOrId: ReturnType<typeof eq>) =>
  and(tokenHashOrId, isNull(s.connectionInvites.usedAt), sql`${s.connectionInvites.expiresAt} > datetime('now')`);

/** An unused, unexpired invite for this token hash. Read only — consuming it is separate and atomic. */
export async function findRedeemableInvite(d1: D1Database, tokenHash: string): Promise<ConnectionInvite | null> {
  const [row] = await db(d1)
    .select()
    .from(s.connectionInvites)
    .where(redeemable(eq(s.connectionInvites.tokenHash, tokenHash)));
  return row ?? null;
}

/** Unused, unexpired invitations — each one names this library's address. */
export async function countOpenInvites(d1: D1Database): Promise<number> {
  const [row] = await db(d1)
    .select({ n: count() })
    .from(s.connectionInvites)
    .where(and(isNull(s.connectionInvites.usedAt), sql`${s.connectionInvites.expiresAt} > datetime('now')`));
  return row?.n ?? 0;
}

export type Redemption = 'pending' | 'invitation gone' | 'limit reached' | 'already connected';

/**
 * Records the pending connection and uses the invitation up in one transaction: both or neither. The
 * insert happens only while the invitation is still redeemable and the connection limit has room, so
 * two redemptions racing can't both win or push past the limit.
 */
export async function redeemInvite(
  d1: D1Database,
  inviteId: number,
  peer: { baseUrl: string; householdName: string; publicKey: string },
  maxConnections: number,
): Promise<Redemption> {
  let inserted: unknown[];
  try {
    const [insert] = await d1.batch([
      d1
        .prepare(
          `INSERT INTO connections (base_url, household_name, public_key, status, invite_id)
           SELECT ?1, ?2, ?3, 'awaiting_us', ?4
           WHERE EXISTS (SELECT 1 FROM connection_invites
                         WHERE id = ?4 AND used_at IS NULL AND expires_at > datetime('now'))
             AND (SELECT count(*) FROM connections) < ?5
           RETURNING id`,
        )
        .bind(peer.baseUrl, peer.householdName, peer.publicKey, inviteId, maxConnections),
      d1
        .prepare(
          `UPDATE connection_invites SET used_at = datetime('now')
           WHERE id = ?1 AND used_at IS NULL AND EXISTS (SELECT 1 FROM connections WHERE invite_id = ?1)`,
        )
        .bind(inviteId),
    ]);
    inserted = insert?.results ?? [];
  } catch (err) {
    // Their address is unique: they redeemed another invitation from us meanwhile. Nothing was committed.
    if (String(err).includes('UNIQUE')) return 'already connected';
    throw err;
  }
  if (inserted.length === 1) return 'pending';
  const [invite] = await db(d1)
    .select({ id: s.connectionInvites.id })
    .from(s.connectionInvites)
    .where(redeemable(eq(s.connectionInvites.id, inviteId)));
  return invite ? 'limit reached' : 'invitation gone';
}

// ---------- connections ----------

export async function listConnections(d1: D1Database): Promise<Connection[]> {
  return db(d1).select().from(s.connections).orderBy(asc(s.connections.householdName), asc(s.connections.id));
}

export async function getConnection(d1: D1Database, id: number): Promise<Connection | null> {
  const [row] = await db(d1).select().from(s.connections).where(eq(s.connections.id, id));
  return row ?? null;
}

export async function getConnectionByBaseUrl(d1: D1Database, baseUrl: string): Promise<Connection | null> {
  const [row] = await db(d1).select().from(s.connections).where(eq(s.connections.baseUrl, baseUrl));
  return row ?? null;
}

/** Every connection in any state, so pending requests count toward the limit too. */
export async function countConnections(d1: D1Database): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.connections);
  return row?.n ?? 0;
}

export async function createConnection(
  d1: D1Database,
  values: { baseUrl: string; householdName: string; publicKey: string; status: ConnectionStatus; inviteId?: number },
): Promise<Connection> {
  const [row] = await db(d1).insert(s.connections).values(values).returning();
  if (!row) throw new Error('failed to create connection');
  return row;
}

/** Moves a connection to active, only from the state the caller expects. False if it wasn't in that state. */
export async function activateConnection(d1: D1Database, id: number, from: ConnectionStatus): Promise<boolean> {
  const rows = await db(d1)
    .update(s.connections)
    .set({ status: 'active', confirmedAt: sql`(datetime('now'))` })
    .where(and(eq(s.connections.id, id), eq(s.connections.status, from)))
    .returning({ id: s.connections.id });
  return rows.length === 1;
}

export async function deleteConnection(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.connections).where(eq(s.connections.id, id));
}

// ---------- replay protection ----------

/**
 * True the first time an activity id arrives; false on a replay. Each new id also prunes a few entries
 * older than an hour, through the index, so the table stays small without a scan per message.
 */
export async function markActivitySeen(d1: D1Database, activityId: string): Promise<boolean> {
  const rows = await db(d1)
    .insert(s.federationSeen)
    .values({ activityId })
    .onConflictDoNothing()
    .returning({ activityId: s.federationSeen.activityId });
  if (rows.length !== 1) return false;
  await d1
    .prepare(
      `DELETE FROM federation_seen WHERE activity_id IN (
         SELECT activity_id FROM federation_seen WHERE seen_at < datetime('now', '-1 hour') LIMIT 20)`,
    )
    .run();
  return true;
}

/**
 * Counts a message from a connection toward today's limit. False once the limit is reached — and then
 * nothing is written, so a connection past its limit costs reads only.
 */
export async function countPush(d1: D1Database, connectionId: number, limit: number): Promise<boolean> {
  const row = await d1
    .prepare(
      `INSERT INTO connection_push_counts (connection_id, day, pushes) VALUES (?1, date('now'), 1)
       ON CONFLICT (connection_id, day) DO UPDATE SET pushes = pushes + 1 WHERE pushes < ?2
       RETURNING pushes`,
    )
    .bind(connectionId, limit)
    .first<{ pushes: number }>();
  if (!row) return false;
  if (row.pushes === 1) {
    await d1.prepare(`DELETE FROM connection_push_counts WHERE day < date('now', '-1 day')`).run();
  }
  return true;
}

// ---------- connection views: what this household shares (phase 2) ----------

/** Items inside a view. The same meaning as a share's captured filters (src/lib/share.ts). */
function inView(view: ConnectionView): SQL | undefined {
  const conds: SQL[] = [];
  if (view.libraryId !== null) conds.push(eq(s.items.libraryId, view.libraryId));
  if (view.mediaType !== null) conds.push(eq(s.items.mediaType, view.mediaType));
  if (view.status !== null) conds.push(eq(s.items.status, view.status));
  if (view.owned !== null) conds.push(view.owned ? gt(s.items.copies, 0) : eq(s.items.copies, 0));
  return and(...conds);
}

/**
 * Whether an item has a review, as connections see it: carriage returns dropped and surrounding whitespace
 * trimmed, the same normalisation migration 0007's triggers apply — so the CRLF a browser submits for a
 * review stored with LF is neither an edit nor a review.
 */
const hasReview = sql`trim(replace(coalesce(${s.items.review}, ''), char(13), ''), ' ' || char(9) || char(10)) <> ''`;

/** An activity is shared only while its item still shows it: a review entry needs its review. */
const stillShows = sql`(
  (${s.activityLog.kind} = 'reviewed' AND ${hasReview})
  OR (${s.activityLog.kind} = 'rated' AND coalesce(${s.items.rating}, 0) > 0)
  OR (${s.activityLog.kind} = 'finished' AND ${s.items.status} = 'completed')
)`;

export async function listConnectionViews(d1: D1Database): Promise<ConnectionView[]> {
  return db(d1).select().from(s.connectionViews).orderBy(asc(s.connectionViews.name), asc(s.connectionViews.id));
}

export async function getConnectionView(d1: D1Database, id: number): Promise<ConnectionView | null> {
  const [row] = await db(d1).select().from(s.connectionViews).where(eq(s.connectionViews.id, id));
  return row ?? null;
}

export async function countConnectionViews(d1: D1Database): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.connectionViews);
  return row?.n ?? 0;
}

export async function createConnectionView(
  d1: D1Database,
  values: {
    name: string;
    libraryId: number | null;
    mediaType: MediaType | null;
    status: ItemStatus | null;
    owned: boolean | null;
  },
): Promise<ConnectionView> {
  const first = (await countConnectionViews(d1)) === 0;
  const [row] = await db(d1).insert(s.connectionViews).values(values).returning();
  if (!row) throw new Error('failed to create connection view');
  if (first) await recordRecentActivity(d1);
  return row;
}

/**
 * The triggers only record while a view exists, so a household sharing its first view would have nothing
 * for connections to follow. This starts the log with recent activity — the last VOLUME_WINDOW_DAYS, newest
 * BACKFILL_ENTRIES — in time order, so ids follow time. Only for a first view: later ones share the log.
 */
async function recordRecentActivity(d1: D1Database): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO activity_log (item_id, kind, at)
       SELECT item_id, kind, at FROM (
         SELECT id AS item_id, 'reviewed' AS kind, datetime(updated_at) AS at FROM items
           WHERE trim(replace(coalesce(review, ''), char(13), ''), ' ' || char(9) || char(10)) <> ''
             AND datetime(updated_at) > datetime('now', ?1)
         UNION ALL
         SELECT id, 'rated', datetime(updated_at) FROM items
           WHERE coalesce(rating, 0) > 0 AND datetime(updated_at) > datetime('now', ?1)
         UNION ALL
         SELECT id, 'finished', datetime(updated_at) FROM items
           WHERE status = 'completed' AND datetime(updated_at) > datetime('now', ?1)
         ORDER BY at DESC LIMIT ?2
       ) ORDER BY at ASC`,
    )
    .bind(`-${VOLUME_WINDOW_DAYS} days`, BACKFILL_ENTRIES)
    .run();
}

/**
 * With the last view gone the triggers stop recording, and the log would go stale: an edit made meanwhile
 * never replaces its row, so an old review would still look current. The log is cleared instead, and the
 * next first view starts it again under new ids.
 */
export async function deleteConnectionView(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.connectionViews).where(eq(s.connectionViews.id, id));
  if ((await countConnectionViews(d1)) === 0) await d1.prepare('DELETE FROM activity_log').run();
}

export async function countItemsInView(d1: D1Database, view: ConnectionView): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.items).where(inView(view));
  return row?.n ?? 0;
}

export type SharedActivity = { id: number; kind: ActivityKind; at: string; item: Item };

/**
 * Activity in a view after a cursor, oldest first, so a busy stretch arrives over several pulls instead
 * of being cut. With no cursor — a new subscriber — the newest come first instead: a feed starts from the
 * present rather than replaying the past. `fromStart` says which the caller got.
 */
export async function activityInView(
  d1: D1Database,
  view: ConnectionView,
  since: number,
  limit: number,
): Promise<{ fromStart: boolean; rows: SharedActivity[] }> {
  const dbi = db(d1);
  const [top] = await dbi
    .select({ latest: sql`coalesce(max(${s.activityLog.id}), 0)`.mapWith(Number) })
    .from(s.activityLog);
  // A cursor past the end came from before a restore: start again rather than wait forever.
  const from = since > (top?.latest ?? 0) ? 0 : since;
  const rows = await dbi
    .select({ id: s.activityLog.id, kind: s.activityLog.kind, at: s.activityLog.at, item: s.items })
    .from(s.activityLog)
    .innerJoin(s.items, eq(s.activityLog.itemId, s.items.id))
    .where(and(gt(s.activityLog.id, from), inView(view), stillShows))
    .orderBy(from === 0 ? desc(s.activityLog.id) : asc(s.activityLog.id))
    .limit(limit);
  return { fromStart: from === 0, rows };
}

/** Which of these activity ids are still shared through this view. ids travel as one JSON parameter. */
export async function stillShared(d1: D1Database, view: ConnectionView, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db(d1)
    .select({ id: s.activityLog.id })
    .from(s.activityLog)
    .innerJoin(s.items, eq(s.activityLog.itemId, s.items.id))
    .where(
      and(sql`${s.activityLog.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`, inView(view), stillShows),
    );
  return new Set(rows.map((r) => r.id));
}

/** Activity in a view over the last `days`, and roughly what storing it as feed entries costs. */
export async function viewVolume(
  d1: D1Database,
  view: ConnectionView,
  days: number,
): Promise<{ activities: number; bytes: number }> {
  const [row] = await db(d1)
    .select({
      activities: count(),
      // an entry is its JSON: ~360 bytes of keys and short fields, plus title, creators and review
      bytes: sql`coalesce(sum(360 + length(${s.items.title}) + coalesce(length(${s.items.creators}), 0)
        + CASE WHEN ${s.activityLog.kind} = 'reviewed'
               THEN min(coalesce(length(${s.items.review}), 0), ${MAX_FEED_REVIEW_CHARS}) ELSE 0 END), 0)`.mapWith(Number),
    })
    .from(s.activityLog)
    .innerJoin(s.items, eq(s.activityLog.itemId, s.items.id))
    .where(and(sql`${s.activityLog.at} > datetime('now', ${`-${days} days`})`, inView(view), stillShows));
  return { activities: row?.activities ?? 0, bytes: row?.bytes ?? 0 };
}

// ---------- subscriptions: what this household follows (phase 2) ----------

export type SubscriptionWithUsage = FeedSubscription & { entries: number; bytes: number };

export async function listSubscriptions(d1: D1Database, connectionId: number): Promise<SubscriptionWithUsage[]> {
  const rows = await db(d1)
    .select({
      sub: s.feedSubscriptions,
      entries: sql`count(${s.remoteActivities.id})`.mapWith(Number),
      bytes: sql`coalesce(sum(${s.remoteActivities.bytes}), 0)`.mapWith(Number),
    })
    .from(s.feedSubscriptions)
    .leftJoin(s.remoteActivities, eq(s.remoteActivities.subscriptionId, s.feedSubscriptions.id))
    .where(eq(s.feedSubscriptions.connectionId, connectionId))
    .groupBy(s.feedSubscriptions.id)
    .orderBy(asc(s.feedSubscriptions.viewName), asc(s.feedSubscriptions.id));
  return rows.map((r) => ({ ...r.sub, entries: r.entries, bytes: r.bytes }));
}

export async function countSubscriptions(d1: D1Database): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.feedSubscriptions);
  return row?.n ?? 0;
}

/** Entries and bytes stored per connection, for the Connections page. */
export async function storageByConnection(d1: D1Database): Promise<Map<number, { entries: number; bytes: number }>> {
  const rows = await db(d1)
    .select({
      connectionId: s.feedSubscriptions.connectionId,
      entries: sql`count(${s.remoteActivities.id})`.mapWith(Number),
      bytes: sql`coalesce(sum(${s.remoteActivities.bytes}), 0)`.mapWith(Number),
    })
    .from(s.feedSubscriptions)
    .leftJoin(s.remoteActivities, eq(s.remoteActivities.subscriptionId, s.feedSubscriptions.id))
    .groupBy(s.feedSubscriptions.connectionId);
  return new Map(rows.map((r) => [r.connectionId, { entries: r.entries, bytes: r.bytes }]));
}

export async function getSubscription(
  d1: D1Database,
  connectionId: number,
  id: number,
): Promise<FeedSubscription | null> {
  const [row] = await db(d1)
    .select()
    .from(s.feedSubscriptions)
    .where(and(eq(s.feedSubscriptions.id, id), eq(s.feedSubscriptions.connectionId, connectionId)));
  return row ?? null;
}

export type SubscriptionSettings = { intervalMinutes: number; retentionDays: number; maxEntries: number };

/** Null when this household already follows that view. A subscription to a view they withdrew is replaced. */
export async function createSubscription(
  d1: D1Database,
  values: SubscriptionSettings & { connectionId: number; viewId: number; viewName: string },
): Promise<FeedSubscription | null> {
  const dbi = db(d1);
  await dbi
    .delete(s.feedSubscriptions)
    .where(
      and(
        eq(s.feedSubscriptions.connectionId, values.connectionId),
        eq(s.feedSubscriptions.viewId, values.viewId),
        isNotNull(s.feedSubscriptions.goneAt),
      ),
    );
  const [row] = await dbi.insert(s.feedSubscriptions).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

export async function updateSubscription(d1: D1Database, id: number, values: SubscriptionSettings): Promise<void> {
  await db(d1).update(s.feedSubscriptions).set(values).where(eq(s.feedSubscriptions.id, id));
}

/** Unsubscribing deletes the subscription's entries with it (foreign key cascade). */
export async function deleteSubscription(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.feedSubscriptions).where(eq(s.feedSubscriptions.id, id));
}

export async function purgeSubscription(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.remoteActivities).where(eq(s.remoteActivities.subscriptionId, id));
}

export type DueSubscription = FeedSubscription & { connection: Connection };

/** Subscriptions past their pull interval, on active connections, least recently pulled first. */
export async function dueSubscriptions(d1: D1Database, limit: number): Promise<DueSubscription[]> {
  const rows = await db(d1)
    .select({ sub: s.feedSubscriptions, connection: s.connections })
    .from(s.feedSubscriptions)
    .innerJoin(s.connections, eq(s.feedSubscriptions.connectionId, s.connections.id))
    .where(
      and(
        eq(s.connections.status, 'active'),
        isNull(s.feedSubscriptions.goneAt),
        sql`(${s.feedSubscriptions.lastPulledAt} IS NULL
          OR ${s.feedSubscriptions.lastPulledAt} <= datetime('now', '-' || ${s.feedSubscriptions.intervalMinutes} || ' minutes'))`,
      ),
    )
    .orderBy(sql`${s.feedSubscriptions.lastPulledAt} IS NOT NULL`, asc(s.feedSubscriptions.lastPulledAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.sub, connection: r.connection }));
}

/**
 * Stamps a pull as started, only if nobody else has since this subscription was read as due — so two
 * page loads at once don't both pull it. False when another request got there first.
 */
export async function claimSubscription(d1: D1Database, id: number, lastPulledAt: string | null): Promise<boolean> {
  const rows = await db(d1)
    .update(s.feedSubscriptions)
    .set({ lastPulledAt: sql`(datetime('now'))` })
    .where(
      and(
        eq(s.feedSubscriptions.id, id),
        lastPulledAt === null ? isNull(s.feedSubscriptions.lastPulledAt) : eq(s.feedSubscriptions.lastPulledAt, lastPulledAt),
      ),
    )
    .returning({ id: s.feedSubscriptions.id });
  return rows.length === 1;
}

/**
 * What a pull came to. `again`, when the owner has more waiting, makes the subscription due at once — but
 * stamped as pulled one interval ago rather than never, so it queues behind every subscription that has
 * waited longer instead of jumping ahead of them.
 */
export async function recordPull(
  d1: D1Database,
  sub: Pick<FeedSubscription, 'id' | 'intervalMinutes'>,
  result: { cursor?: number; error: string | null; again?: boolean },
): Promise<void> {
  await db(d1)
    .update(s.feedSubscriptions)
    .set({
      lastError: result.error,
      ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
      ...(result.again ? { lastPulledAt: sql`(datetime('now', ${`-${sub.intervalMinutes} minutes`}))` } : {}),
    })
    .where(eq(s.feedSubscriptions.id, sub.id));
}

/** They stopped sharing the view: everything stored from it goes, and the Feed page says how much. */
export async function markSubscriptionGone(d1: D1Database, id: number): Promise<void> {
  const removed = await db(d1)
    .delete(s.remoteActivities)
    .where(eq(s.remoteActivities.subscriptionId, id))
    .returning({ id: s.remoteActivities.id });
  await d1
    .prepare(
      `UPDATE feed_subscriptions SET gone_at = datetime('now'), last_error = NULL,
         removed_unseen = removed_unseen + ?1 WHERE id = ?2`,
    )
    .bind(removed.length, id)
    .run();
}

// ---------- stored feed entries (phase 2) ----------

export type NewRemoteActivity = {
  remoteId: number;
  itemRemoteId: number;
  itemStamp: string;
  kind: ActivityKind;
  publishedAt: string;
  item: string;
  bytes: number;
};

/**
 * One statement whatever the page size: entries travel as a single JSON parameter (D1 caps bound parameters
 * at 100). A date from the future is stored as now, so it can neither top the Feed page nor outlive retention.
 */
export async function storeEntries(d1: D1Database, subscriptionId: number, entries: NewRemoteActivity[]): Promise<void> {
  if (!entries.length) return;
  await d1
    .prepare(
      `INSERT OR IGNORE INTO remote_activities
         (subscription_id, remote_id, item_remote_id, item_stamp, kind, published_at, item, bytes)
       SELECT ?1, json_extract(value, '$.remoteId'), json_extract(value, '$.itemRemoteId'),
              json_extract(value, '$.itemStamp'), json_extract(value, '$.kind'),
              min(json_extract(value, '$.publishedAt'), datetime('now')), json_extract(value, '$.item'),
              json_extract(value, '$.bytes')
       FROM json_each(?2)`,
    )
    .bind(subscriptionId, JSON.stringify(entries))
    .run();
}

/**
 * How many of `wanted` new feed entries a connection may still store today — counted as taken. Honest
 * households stay far below the limit; it caps the D1 writes a flood from a modified one could cause.
 */
export async function takeFeedAllowance(d1: D1Database, connectionId: number, wanted: number, limit: number): Promise<number> {
  if (wanted <= 0) return 0;
  const today = await d1
    .prepare(`SELECT feed_entries FROM connection_push_counts WHERE connection_id = ?1 AND day = date('now')`)
    .bind(connectionId)
    .first<{ feed_entries: number }>();
  const allowed = Math.max(0, Math.min(wanted, limit - (today?.feed_entries ?? 0)));
  if (allowed > 0) {
    await d1
      .prepare(
        `INSERT INTO connection_push_counts (connection_id, day, pushes, feed_entries) VALUES (?1, date('now'), 0, ?2)
         ON CONFLICT (connection_id, day) DO UPDATE SET feed_entries = feed_entries + ?2`,
      )
      .bind(connectionId, allowed)
      .run();
  }
  return allowed;
}

export async function storedRemoteIds(d1: D1Database, subscriptionId: number): Promise<number[]> {
  const rows = await db(d1)
    .select({ remoteId: s.remoteActivities.remoteId })
    .from(s.remoteActivities)
    .where(eq(s.remoteActivities.subscriptionId, subscriptionId));
  return rows.map((r) => r.remoteId);
}

/** Deletes entries their owner no longer shares, and counts them for the Feed page's notice. */
export async function removeEntries(d1: D1Database, subscriptionId: number, remoteIds: number[]): Promise<number> {
  if (!remoteIds.length) return 0;
  const removed = await db(d1)
    .delete(s.remoteActivities)
    .where(
      and(
        eq(s.remoteActivities.subscriptionId, subscriptionId),
        sql`${s.remoteActivities.remoteId} IN (SELECT value FROM json_each(${JSON.stringify(remoteIds)}))`,
      ),
    )
    .returning({ id: s.remoteActivities.id });
  if (removed.length) {
    await d1
      .prepare('UPDATE feed_subscriptions SET removed_unseen = removed_unseen + ?1 WHERE id = ?2')
      .bind(removed.length, subscriptionId)
      .run();
  }
  return removed.length;
}

/**
 * The receiver's own rules: entries older than the retention period go, then all but the newest
 * `maxEntries`, then all but the newest MAX_STORED_ENTRIES_PER_CONNECTION across the connection.
 */
export async function applyLifecycle(
  d1: D1Database,
  sub: Pick<FeedSubscription, 'id' | 'connectionId' | 'retentionDays' | 'maxEntries'>,
): Promise<void> {
  await d1.batch([
    d1
      .prepare(`DELETE FROM remote_activities WHERE subscription_id = ?1 AND published_at < datetime('now', ?2)`)
      .bind(sub.id, `-${sub.retentionDays} days`),
    d1
      .prepare(
        `DELETE FROM remote_activities WHERE subscription_id = ?1 AND id NOT IN (
           SELECT id FROM remote_activities WHERE subscription_id = ?1
           ORDER BY published_at DESC, id DESC LIMIT ?2)`,
      )
      .bind(sub.id, sub.maxEntries),
    d1
      .prepare(
        `DELETE FROM remote_activities
         WHERE subscription_id IN (SELECT id FROM feed_subscriptions WHERE connection_id = ?1)
           AND id NOT IN (
             SELECT ra.id FROM remote_activities ra
             JOIN feed_subscriptions fs ON fs.id = ra.subscription_id
             WHERE fs.connection_id = ?1
             ORDER BY ra.published_at DESC, ra.id DESC LIMIT ?2)`,
      )
      .bind(sub.connectionId, MAX_STORED_ENTRIES_PER_CONNECTION),
  ]);
}

export type StoredEntry = {
  id: number;
  remoteId: number;
  itemRemoteId: number;
  itemStamp: string;
  kind: ActivityKind;
  publishedAt: string;
  item: string;
  bytes: number;
  connectionId: number;
  householdName: string;
  baseUrl: string;
};

export type FeedCursor = { publishedAt: string; id: number };

/**
 * A page of stored entries from active connections, newest first and within their subscriptions'
 * retention: at most `maxEntries`, and no more than `maxBytes` of entry JSON beyond the first. Sizes are
 * chosen from a narrow read before any entry JSON is fetched. `next` continues after the last one shown.
 */
export async function feedPage(
  d1: D1Database,
  opts: { before: FeedCursor | null; maxEntries: number; maxBytes: number },
): Promise<{ entries: StoredEntry[]; next: FeedCursor | null }> {
  const { results: candidates } = await d1
    .prepare(
      `SELECT ra.id, ra.bytes, ra.published_at AS publishedAt FROM remote_activities ra
       JOIN feed_subscriptions fs ON fs.id = ra.subscription_id
       JOIN connections c ON c.id = fs.connection_id
       WHERE c.status = 'active'
         AND ra.published_at >= datetime('now', '-' || fs.retention_days || ' days')
         AND (?1 IS NULL OR ra.published_at < ?1 OR (ra.published_at = ?1 AND ra.id < ?2))
       ORDER BY ra.published_at DESC, ra.id DESC
       LIMIT ?3`,
    )
    .bind(opts.before?.publishedAt ?? null, opts.before?.id ?? 0, opts.maxEntries + 1)
    .all<{ id: number; bytes: number; publishedAt: string }>();

  const chosen: typeof candidates = [];
  let bytes = 0;
  for (const row of candidates) {
    if (chosen.length === opts.maxEntries || (chosen.length > 0 && bytes + row.bytes > opts.maxBytes)) break;
    chosen.push(row);
    bytes += row.bytes;
  }
  const last = chosen[chosen.length - 1];
  if (!last) return { entries: [], next: null };
  const next = chosen.length < candidates.length ? { publishedAt: last.publishedAt, id: last.id } : null;

  const { results } = await d1
    .prepare(
      `SELECT ra.id, ra.remote_id AS remoteId, ra.item_remote_id AS itemRemoteId, ra.item_stamp AS itemStamp, ra.kind,
              ra.published_at AS publishedAt, ra.item, ra.bytes,
              c.id AS connectionId, c.household_name AS householdName, c.base_url AS baseUrl
       FROM remote_activities ra
       JOIN feed_subscriptions fs ON fs.id = ra.subscription_id
       JOIN connections c ON c.id = fs.connection_id
       WHERE ra.id IN (SELECT value FROM json_each(?1))
       ORDER BY ra.published_at DESC, ra.id DESC`,
    )
    .bind(JSON.stringify(chosen.map((r) => r.id)))
    .all<StoredEntry>();
  return { entries: results, next };
}

/** How many entries owners removed since the Feed page last said so — and resets the count. */
export async function takeRemovedCount(d1: D1Database): Promise<number> {
  const [row] = await db(d1)
    .select({ n: sql`coalesce(sum(${s.feedSubscriptions.removedUnseen}), 0)`.mapWith(Number) })
    .from(s.feedSubscriptions);
  const n = row?.n ?? 0;
  if (n > 0) await d1.prepare('UPDATE feed_subscriptions SET removed_unseen = 0 WHERE removed_unseen > 0').run();
  return n;
}

// ---------- comments (phase 3) ----------

/** Does this item fall inside a connection view? The in-memory twin of inView() — the two must agree. */
export function itemMatchesView(view: ConnectionView, item: Item): boolean {
  if (view.libraryId !== null && item.libraryId !== view.libraryId) return false;
  if (view.mediaType !== null && item.mediaType !== view.mediaType) return false;
  if (view.status !== null && item.status !== view.status) return false;
  if (view.owned !== null && item.copies > 0 !== view.owned) return false;
  return true;
}

/** Whether connections can see this item at all: inside at least one connection view. */
export async function itemIsShared(d1: D1Database, item: Item): Promise<boolean> {
  return (await listConnectionViews(d1)).some((view) => itemMatchesView(view, item));
}

export type ThreadComment = Comment & { householdName: string; connectionStatus: ConnectionStatus };

/** The comments on one of our items, oldest first, with the household each thread is with. */
export async function commentsOnOurItem(d1: D1Database, itemId: number): Promise<ThreadComment[]> {
  const rows = await db(d1)
    .select({ comment: s.comments, householdName: s.connections.householdName, connectionStatus: s.connections.status })
    .from(s.comments)
    .innerJoin(s.connections, eq(s.comments.connectionId, s.connections.id))
    .where(and(eq(s.comments.ourItemId, itemId), isNull(s.comments.deletedAt)))
    .orderBy(asc(s.comments.createdAt), asc(s.comments.id));
  return rows.map((r) => ({ ...r.comment, householdName: r.householdName, connectionStatus: r.connectionStatus }));
}

/** Our copies of the threads on their reviews, for these [connection, their item, stamp] keys, oldest first. */
export async function commentsOnTheirItems(d1: D1Database, keys: Array<[number, number, string]>): Promise<Comment[]> {
  if (!keys.length) return [];
  return db(d1)
    .select()
    .from(s.comments)
    .where(
      and(
        isNull(s.comments.deletedAt),
        isNotNull(s.comments.theirItemId),
        sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(keys)}) AS pair
                    WHERE json_extract(pair.value, '$[0]') = ${s.comments.connectionId}
                      AND json_extract(pair.value, '$[1]') = ${s.comments.theirItemId}
                      AND json_extract(pair.value, '$[2]') = ${s.comments.theirItemStamp})`,
      ),
    )
    .orderBy(asc(s.comments.createdAt), asc(s.comments.id));
}

export type RecentComment = {
  id: number;
  itemId: number;
  itemTitle: string;
  authorName: string;
  householdName: string;
  createdAt: string;
};

/** Comments connections left on our reviews recently, newest first — for the top of the Feed page. */
export async function recentCommentsOnOurReviews(d1: D1Database, days: number, limit: number): Promise<RecentComment[]> {
  return db(d1)
    .select({
      id: s.comments.id,
      itemId: s.items.id,
      itemTitle: s.items.title,
      authorName: s.comments.authorName,
      householdName: s.connections.householdName,
      createdAt: s.comments.createdAt,
    })
    .from(s.comments)
    .innerJoin(s.items, eq(s.comments.ourItemId, s.items.id))
    .innerJoin(s.connections, eq(s.comments.connectionId, s.connections.id))
    .where(
      and(
        eq(s.comments.fromUs, false),
        isNull(s.comments.deletedAt),
        sql`${s.comments.createdAt} > datetime('now', ${`-${days} days`})`,
      ),
    )
    .orderBy(desc(s.comments.createdAt), desc(s.comments.id))
    .limit(limit);
}

export async function getComment(d1: D1Database, id: number): Promise<Comment | null> {
  const [row] = await db(d1).select().from(s.comments).where(eq(s.comments.id, id));
  return row ?? null;
}

/** A comment in a thread with this connection, by its activity id. */
export async function commentByActivity(d1: D1Database, connectionId: number, activityId: string): Promise<Comment | null> {
  const [row] = await db(d1)
    .select()
    .from(s.comments)
    .where(and(eq(s.comments.connectionId, connectionId), eq(s.comments.activityId, activityId)));
  return row ?? null;
}

/** Whether a comment id is unknown here, present, or deleted. */
export async function commentState(d1: D1Database, activityId: string): Promise<'absent' | 'present' | 'deleted'> {
  const [row] = await db(d1)
    .select({ deletedAt: s.comments.deletedAt })
    .from(s.comments)
    .where(eq(s.comments.activityId, activityId));
  return !row ? 'absent' : row.deletedAt ? 'deleted' : 'present';
}

export type NewComment = {
  activityId: string;
  connectionId: number;
  ourItemId?: number | null;
  theirItemId?: number | null;
  theirItemStamp?: string | null;
  fromUs: boolean;
  authorName: string;
  authorId?: number | null;
  body: string;
  createdAt: string;
};

/** Null when a comment with that activity id exists already — including one deleted since. */
export async function insertComment(d1: D1Database, values: NewComment): Promise<Comment | null> {
  const [row] = await db(d1).insert(s.comments).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

/** Deleting keeps the row with its body cleared, so a copy still waiting in an outbox can't bring it back. */
export async function softDeleteComment(d1: D1Database, id: number): Promise<void> {
  await db(d1)
    .update(s.comments)
    .set({ body: null, deletedAt: sql`(datetime('now'))` })
    .where(eq(s.comments.id, id));
}

/** A deletion that arrived before its comment: kept as an empty, deleted row, so the comment never appears. */
export async function recordDeletionFirst(d1: D1Database, connectionId: number, activityId: string): Promise<void> {
  await db(d1)
    .insert(s.comments)
    .values({ activityId, connectionId, fromUs: false, authorName: '', body: null, deletedAt: sql`(datetime('now'))` })
    .onConflictDoNothing();
}

/** Whether this household holds a feed entry for that connection's review of this book — i.e. follows it. */
export async function holdsReviewEntry(d1: D1Database, connectionId: number, itemRemoteId: number, stamp: string): Promise<boolean> {
  const [row] = await db(d1)
    .select({ id: s.remoteActivities.id })
    .from(s.remoteActivities)
    .innerJoin(s.feedSubscriptions, eq(s.remoteActivities.subscriptionId, s.feedSubscriptions.id))
    .where(
      and(
        eq(s.feedSubscriptions.connectionId, connectionId),
        eq(s.remoteActivities.itemRemoteId, itemRemoteId),
        eq(s.remoteActivities.itemStamp, stamp),
        eq(s.remoteActivities.kind, 'reviewed'),
      ),
    )
    .limit(1);
  return !!row;
}

/** Whether this household has commented on that connection's review of this book — the thread is ours to have started. */
export async function weCommented(d1: D1Database, connectionId: number, theirItemId: number, stamp: string): Promise<boolean> {
  const [row] = await db(d1)
    .select({ id: s.comments.id })
    .from(s.comments)
    .where(
      and(
        eq(s.comments.connectionId, connectionId),
        eq(s.comments.theirItemId, theirItemId),
        eq(s.comments.theirItemStamp, stamp),
        eq(s.comments.fromUs, true),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * One of our items, only if it has a review and is inside a connection view — one query, so an unknown item, an
 * unreviewed one and an unshared one can't be told apart by how long the answer takes. The view test is the SQL
 * twin of itemMatchesView().
 */
export async function sharedReviewedItem(d1: D1Database, itemId: number): Promise<Item | null> {
  const [row] = await db(d1)
    .select()
    .from(s.items)
    .where(
      and(
        eq(s.items.id, itemId),
        hasReview,
        sql`EXISTS (SELECT 1 FROM connection_views v
                    WHERE (v.library_id IS NULL OR v.library_id = ${s.items.libraryId})
                      AND (v.media_type IS NULL OR v.media_type = ${s.items.mediaType})
                      AND (v.status IS NULL OR v.status = ${s.items.status})
                      AND (v.owned IS NULL OR v.owned = (${s.items.copies} > 0)))`,
      ),
    );
  return row ?? null;
}

/** Whether that household has commented on our item — replies go into threads they started. */
export async function theyStartedThread(d1: D1Database, connectionId: number, ourItemId: number): Promise<boolean> {
  const [row] = await db(d1)
    .select({ id: s.comments.id })
    .from(s.comments)
    .where(and(eq(s.comments.connectionId, connectionId), eq(s.comments.ourItemId, ourItemId), eq(s.comments.fromUs, false)))
    .limit(1);
  return !!row;
}

/**
 * Our copies of threads on their reviews go with the feed entries they hang from: once no stored `reviewed`
 * entry remains for that book — the same id and stamp — its thread is deleted here too. Callers skip this after
 * a pull that stopped partway, when an edited review's new entry may still be waiting on a later page.
 */
export async function pruneOrphanThreads(d1: D1Database): Promise<void> {
  await d1
    .prepare(
      `DELETE FROM comments WHERE their_item_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM remote_activities ra JOIN feed_subscriptions fs ON fs.id = ra.subscription_id
         WHERE fs.connection_id = comments.connection_id AND ra.item_remote_id = comments.their_item_id
           AND ra.item_stamp = comments.their_item_stamp AND ra.kind = 'reviewed')`,
    )
    .run();
}

/** Deletions remembered for comments that never arrived, dropped once no outbox could still hold those comments. */
export async function pruneTombstones(d1: D1Database): Promise<void> {
  await d1
    .prepare(
      `DELETE FROM comments WHERE our_item_id IS NULL AND their_item_id IS NULL
         AND deleted_at < datetime('now', ?1)`,
    )
    .bind(`-${OUTBOX_RETENTION_DAYS * 2} days`)
    .run();
}

/** Which of these comment ids are known here, and whether each is deleted. */
export async function commentStates(d1: D1Database, activityIds: string[]): Promise<Map<string, 'present' | 'deleted'>> {
  if (!activityIds.length) return new Map();
  const rows = await db(d1)
    .select({ activityId: s.comments.activityId, deletedAt: s.comments.deletedAt })
    .from(s.comments)
    .where(sql`${s.comments.activityId} IN (SELECT value FROM json_each(${JSON.stringify(activityIds)}))`);
  return new Map(rows.map((r) => [r.activityId, r.deletedAt ? 'deleted' : 'present']));
}

/** Messages queued for a connection since midnight UTC. */
export async function sentToday(d1: D1Database, connectionId: number): Promise<number> {
  const [row] = await db(d1)
    .select({ n: count() })
    .from(s.outbox)
    .where(and(eq(s.outbox.connectionId, connectionId), sql`${s.outbox.createdAt} >= date('now')`));
  return row?.n ?? 0;
}

// ---------- the outbox (phase 3) ----------

/**
 * Queues a message for a connection under that connection's next sequence number, pruning what has waited
 * longer than any pull would.
 */
export async function enqueueOutbox(d1: D1Database, connectionId: number, message: { id: string }): Promise<OutboxRow> {
  const counter = await d1
    .prepare('UPDATE connections SET outbox_seq = outbox_seq + 1 WHERE id = ?1 RETURNING outbox_seq AS seq')
    .bind(connectionId)
    .first<{ seq: number }>();
  if (!counter) throw new Error('no such connection to queue a message for');
  const dbi = db(d1);
  const [row] = await dbi
    .insert(s.outbox)
    .values({
      connectionId,
      seq: counter.seq,
      activityId: message.id,
      message: JSON.stringify(message),
      attemptedAt: sql`(datetime('now'))`,
    })
    .returning();
  if (!row) throw new Error('failed to queue message');
  await dbi
    .delete(s.outbox)
    .where(
      and(
        eq(s.outbox.connectionId, connectionId),
        sql`${s.outbox.createdAt} < datetime('now', ${`-${OUTBOX_RETENTION_DAYS} days`})`,
      ),
    );
  return row;
}

/** The last sequence number queued for a connection. */
export async function outboxHead(d1: D1Database, connectionId: number): Promise<number> {
  const [row] = await db(d1).select({ seq: s.connections.outboxSeq }).from(s.connections).where(eq(s.connections.id, connectionId));
  return row?.seq ?? 0;
}

export async function markDelivered(d1: D1Database, id: number): Promise<void> {
  await db(d1)
    .update(s.outbox)
    .set({ deliveredAt: sql`(datetime('now'))` })
    .where(eq(s.outbox.id, id));
}

/** A connection's queued messages after a cursor in its own sequence, oldest first. */
export async function outboxAfter(d1: D1Database, connectionId: number, since: number, limit: number): Promise<OutboxRow[]> {
  return db(d1)
    .select()
    .from(s.outbox)
    .where(and(eq(s.outbox.connectionId, connectionId), gt(s.outbox.seq, since)))
    .orderBy(asc(s.outbox.seq))
    .limit(limit);
}

/** Active connections whose outbox is due a pull, least recently pulled first. */
export async function dueOutboxes(d1: D1Database, minutes: number, limit: number): Promise<Connection[]> {
  return db(d1)
    .select()
    .from(s.connections)
    .where(
      and(
        eq(s.connections.status, 'active'),
        sql`(${s.connections.outboxPulledAt} IS NULL
          OR ${s.connections.outboxPulledAt} <= datetime('now', ${`-${minutes} minutes`}))`,
      ),
    )
    .orderBy(sql`${s.connections.outboxPulledAt} IS NOT NULL`, asc(s.connections.outboxPulledAt))
    .limit(limit);
}

/** Stamps an outbox pull as started, unless another request already did since it was read as due. */
export async function claimOutbox(d1: D1Database, connectionId: number, pulledAt: string | null): Promise<boolean> {
  const rows = await db(d1)
    .update(s.connections)
    .set({ outboxPulledAt: sql`(datetime('now'))` })
    .where(
      and(
        eq(s.connections.id, connectionId),
        pulledAt === null ? isNull(s.connections.outboxPulledAt) : eq(s.connections.outboxPulledAt, pulledAt),
      ),
    )
    .returning({ id: s.connections.id });
  return rows.length === 1;
}

/**
 * Where a pull got to. `again`, when more was waiting, makes the outbox due at once — stamped as pulled one
 * interval ago rather than never, so it queues behind outboxes that have waited longer.
 */
export async function recordOutboxPull(d1: D1Database, connectionId: number, result: { cursor: number; again?: boolean }): Promise<void> {
  await db(d1)
    .update(s.connections)
    .set({
      outboxCursor: result.cursor,
      ...(result.again ? { outboxPulledAt: sql`(datetime('now', ${`-${OUTBOX_PULL_MINUTES} minutes`}))` } : {}),
    })
    .where(eq(s.connections.id, connectionId));
}

/** A message the other household refused outright: nothing is left to deliver. */
export async function dropOutbox(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.outbox).where(eq(s.outbox.id, id));
}

export type PendingPush = OutboxRow & { connection: Connection };

/**
 * Outbox messages whose push never landed, recent enough to be worth retrying, and not tried in the last
 * `retryMinutes` — including ones a trigger queued without pushing at all. Oldest first.
 */
export async function undeliveredOutbox(d1: D1Database, limit: number, retryMinutes: number, days: number): Promise<PendingPush[]> {
  const rows = await db(d1)
    .select({ row: s.outbox, connection: s.connections })
    .from(s.outbox)
    .innerJoin(s.connections, eq(s.outbox.connectionId, s.connections.id))
    .where(
      and(
        eq(s.connections.status, 'active'),
        isNull(s.outbox.deliveredAt),
        sql`${s.outbox.createdAt} > datetime('now', ${`-${days} days`})`,
        sql`(${s.outbox.attemptedAt} IS NULL OR ${s.outbox.attemptedAt} <= datetime('now', ${`-${retryMinutes} minutes`}))`,
      ),
    )
    .orderBy(asc(s.outbox.id))
    .limit(limit);
  return rows.map((r) => ({ ...r.row, connection: r.connection }));
}

export async function claimPushAttempt(d1: D1Database, id: number, attemptedAt: string | null): Promise<boolean> {
  const rows = await db(d1)
    .update(s.outbox)
    .set({ attemptedAt: sql`(datetime('now'))` })
    .where(and(eq(s.outbox.id, id), attemptedAt === null ? isNull(s.outbox.attemptedAt) : eq(s.outbox.attemptedAt, attemptedAt)))
    .returning({ id: s.outbox.id });
  return rows.length === 1;
}

// ---------- borrowing (phase 4) ----------

/** A copy is free to lend while the household holds more copies than are out on loan. Nothing about who has them. */
export async function availability(d1: D1Database, items: Item[]): Promise<Map<number, boolean>> {
  if (!items.length) return new Map();
  const { results } = await d1
    .prepare(
      `SELECT item_id AS itemId, count(*) AS n FROM loans
       WHERE returned_on IS NULL AND item_id IN (SELECT value FROM json_each(?1)) GROUP BY item_id`,
    )
    .bind(JSON.stringify(items.map((i) => i.id)))
    .all<{ itemId: number; n: number }>();
  const out = new Map(results.map((r) => [r.itemId, r.n]));
  return new Map(items.map((i) => [i.id, i.copies > (out.get(i.id) ?? 0)]));
}

/** One page of a connection view, in its own order — the listing its share-link twin would show. */
export function shelfPage(d1: D1Database, view: ConnectionView, page: number) {
  return listItems(d1, view.libraryId, {
    mediaTypes: view.mediaType ? [view.mediaType] : undefined,
    statuses: view.status ? [view.status] : undefined,
    owned: view.owned ?? undefined,
    sort: view.sort,
    page,
  });
}

export type NewBorrowRequest = {
  activityId: string;
  connectionId: number;
  incoming: boolean;
  ourItemId?: number | null;
  theirItemId?: number | null;
  theirItemStamp?: string | null;
  theirViewId?: number | null;
  itemTitle: string;
  coverKey?: string | null;
  requesterName: string;
  requesterId?: number | null;
  note: string | null;
};

/** Null when a request with that activity id exists already. */
export async function insertBorrowRequest(d1: D1Database, values: NewBorrowRequest): Promise<BorrowRequestRow | null> {
  const [row] = await db(d1).insert(s.borrowRequests).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

export async function getBorrowRequest(d1: D1Database, id: number): Promise<BorrowRequestRow | null> {
  const [row] = await db(d1).select().from(s.borrowRequests).where(eq(s.borrowRequests.id, id));
  return row ?? null;
}

/** A request between this household and that connection, in one direction, by its activity id. */
export async function requestByActivity(
  d1: D1Database,
  connectionId: number,
  activityId: string,
  incoming: boolean,
): Promise<BorrowRequestRow | null> {
  const [row] = await db(d1)
    .select()
    .from(s.borrowRequests)
    .where(
      and(
        eq(s.borrowRequests.connectionId, connectionId),
        eq(s.borrowRequests.activityId, activityId),
        eq(s.borrowRequests.incoming, incoming),
      ),
    );
  return row ?? null;
}

/** The status of each of these requests known here, by activity id. One query. */
export async function requestStatuses(d1: D1Database, activityIds: string[]): Promise<Map<string, BorrowStatus>> {
  if (!activityIds.length) return new Map();
  const rows = await db(d1)
    .select({ activityId: s.borrowRequests.activityId, status: s.borrowRequests.status })
    .from(s.borrowRequests)
    .where(sql`${s.borrowRequests.activityId} IN (SELECT value FROM json_each(${JSON.stringify(activityIds)}))`);
  return new Map(rows.map((r) => [r.activityId, r.status]));
}

/** Which of these requests' borrowed books are already marked returned here. One query. */
export async function returnedRequests(d1: D1Database, requestActivityIds: string[]): Promise<Set<string>> {
  if (!requestActivityIds.length) return new Set();
  const rows = await db(d1)
    .select({ requestActivityId: s.borrowedItems.requestActivityId })
    .from(s.borrowedItems)
    .where(
      and(
        isNotNull(s.borrowedItems.returnedOn),
        sql`${s.borrowedItems.requestActivityId} IN (SELECT value FROM json_each(${JSON.stringify(requestActivityIds)}))`,
      ),
    );
  return new Set(rows.map((r) => r.requestActivityId));
}

export async function requestStatus(d1: D1Database, activityId: string): Promise<BorrowStatus | null> {
  const [row] = await db(d1)
    .select({ status: s.borrowRequests.status })
    .from(s.borrowRequests)
    .where(eq(s.borrowRequests.activityId, activityId));
  return row?.status ?? null;
}

/** Whether that connection already has a request waiting for this book of ours. */
export async function hasPendingIncoming(d1: D1Database, connectionId: number, ourItemId: number): Promise<boolean> {
  const [row] = await db(d1)
    .select({ id: s.borrowRequests.id })
    .from(s.borrowRequests)
    .where(
      and(
        eq(s.borrowRequests.connectionId, connectionId),
        eq(s.borrowRequests.ourItemId, ourItemId),
        eq(s.borrowRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return !!row;
}

/** Whether this household already has a request waiting for that book of theirs. */
export async function hasPendingOutgoing(d1: D1Database, connectionId: number, theirItemId: number, stamp: string): Promise<boolean> {
  const [row] = await db(d1)
    .select({ id: s.borrowRequests.id })
    .from(s.borrowRequests)
    .where(
      and(
        eq(s.borrowRequests.connectionId, connectionId),
        eq(s.borrowRequests.incoming, false),
        eq(s.borrowRequests.theirItemId, theirItemId),
        eq(s.borrowRequests.theirItemStamp, stamp),
        eq(s.borrowRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return !!row;
}

/** Declines a request of ours that they refused outright — so it doesn't sit waiting forever. */
export async function declineOwnRequest(d1: D1Database, activityId: string): Promise<void> {
  await db(d1)
    .update(s.borrowRequests)
    .set({ status: 'declined', respondedAt: sql`(datetime('now'))` })
    .where(and(eq(s.borrowRequests.activityId, activityId), eq(s.borrowRequests.incoming, false), eq(s.borrowRequests.status, 'pending')));
}

/**
 * One of our items, only if it is inside a connection view — one query, so an unknown item and an unshared one
 * can't be told apart by how long the answer takes. The SQL twin of itemMatchesView().
 */
export async function sharedItem(d1: D1Database, itemId: number): Promise<Item | null> {
  const [row] = await db(d1)
    .select()
    .from(s.items)
    .where(
      and(
        eq(s.items.id, itemId),
        sql`EXISTS (SELECT 1 FROM connection_views v
                    WHERE (v.library_id IS NULL OR v.library_id = ${s.items.libraryId})
                      AND (v.media_type IS NULL OR v.media_type = ${s.items.mediaType})
                      AND (v.status IS NULL OR v.status = ${s.items.status})
                      AND (v.owned IS NULL OR v.owned = (${s.items.copies} > 0)))`,
      ),
    );
  return row ?? null;
}

export async function countPendingIncoming(d1: D1Database, connectionId: number): Promise<number> {
  const [row] = await db(d1)
    .select({ n: count() })
    .from(s.borrowRequests)
    .where(
      and(
        eq(s.borrowRequests.connectionId, connectionId),
        eq(s.borrowRequests.incoming, true),
        eq(s.borrowRequests.status, 'pending'),
      ),
    );
  return row?.n ?? 0;
}

/** Moves a request to `status` only from one of `from`, so a repeat or a race changes nothing. */
export async function setRequestStatus(
  d1: D1Database,
  id: number,
  status: BorrowStatus,
  from: BorrowStatus[],
  dueOn: string | null = null,
): Promise<boolean> {
  const rows = await db(d1)
    .update(s.borrowRequests)
    .set({ status, dueOn, respondedAt: sql`(datetime('now'))` })
    .where(and(eq(s.borrowRequests.id, id), sql`${s.borrowRequests.status} IN (SELECT value FROM json_each(${JSON.stringify(from)}))`))
    .returning({ id: s.borrowRequests.id });
  return rows.length === 1;
}

export type IncomingRequest = BorrowRequestRow & { householdName: string; item: Item };

/** Requests from active connections waiting for an answer, oldest first, with the book asked for. */
export async function pendingIncoming(d1: D1Database): Promise<IncomingRequest[]> {
  const rows = await db(d1)
    .select({ request: s.borrowRequests, householdName: s.connections.householdName, item: s.items })
    .from(s.borrowRequests)
    .innerJoin(s.connections, eq(s.borrowRequests.connectionId, s.connections.id))
    .innerJoin(s.items, eq(s.borrowRequests.ourItemId, s.items.id))
    .where(
      and(eq(s.borrowRequests.incoming, true), eq(s.borrowRequests.status, 'pending'), eq(s.connections.status, 'active')),
    )
    .orderBy(asc(s.borrowRequests.createdAt), asc(s.borrowRequests.id));
  return rows.map((r) => ({ ...r.request, householdName: r.householdName, item: r.item }));
}

/** `returned`: they lent it and it came back — or its Borrowed entry was removed, which only a returned book allows. */
export type OutgoingRequest = BorrowRequestRow & { householdName: string; returned: boolean };

export async function recentOutgoing(d1: D1Database, limit: number): Promise<OutgoingRequest[]> {
  const rows = await db(d1)
    .select({
      request: s.borrowRequests,
      householdName: s.connections.householdName,
      borrowedId: s.borrowedItems.id,
      returnedOn: s.borrowedItems.returnedOn,
    })
    .from(s.borrowRequests)
    .innerJoin(s.connections, eq(s.borrowRequests.connectionId, s.connections.id))
    .leftJoin(s.borrowedItems, eq(s.borrowedItems.requestActivityId, s.borrowRequests.activityId))
    .where(eq(s.borrowRequests.incoming, false))
    .orderBy(desc(s.borrowRequests.createdAt), desc(s.borrowRequests.id))
    .limit(limit);
  return rows.map((r) => ({
    ...r.request,
    householdName: r.householdName,
    returned: r.request.status === 'accepted' && (r.borrowedId === null || r.returnedOn !== null),
  }));
}

/**
 * Accepting a request lends the book with an ordinary loan — so the Loans page, overdue logic and return button
 * all apply unchanged — linked to the connection and the request. The status moves first, and only from pending,
 * so one request is lent at most once. The loan is inserted only while a copy is free, decided inside that one
 * statement, so two members lending the last copy to different households at once make one loan, not two.
 * Null when nothing was lent; a failure leaves no loan behind and the request pending again.
 */
export async function lendToConnection(
  d1: D1Database,
  request: BorrowRequestRow,
  borrower: string,
  dueOn: string | null,
): Promise<number | null> {
  if (request.ourItemId === null) return null;
  if (!(await setRequestStatus(d1, request.id, 'accepted', ['pending'], dueOn))) return null;
  const reopen = () =>
    db(d1)
      .update(s.borrowRequests)
      .set({ status: 'pending', dueOn: null, respondedAt: null })
      .where(and(eq(s.borrowRequests.id, request.id), eq(s.borrowRequests.status, 'accepted')));
  let loanId: number | null = null;
  try {
    const loan = await d1
      .prepare(
        `INSERT INTO loans (item_id, borrower, due_on)
         SELECT id, ?2, ?3 FROM items
         WHERE id = ?1 AND copies > (SELECT count(*) FROM loans WHERE item_id = ?1 AND returned_on IS NULL)
         RETURNING id`,
      )
      .bind(request.ourItemId, borrower, dueOn)
      .first<{ id: number }>();
    if (!loan) {
      await reopen(); // no copy free after all
      return null;
    }
    loanId = loan.id;
    await db(d1).insert(s.connectionLoans).values({
      loanId: loan.id,
      connectionId: request.connectionId,
      requestId: request.id,
      requestActivityId: request.activityId,
    });
    return loan.id;
  } catch (err) {
    if (loanId !== null) await db(d1).delete(s.loans).where(eq(s.loans.id, loanId));
    await reopen();
    throw err;
  }
}

/**
 * Their yes to one of our requests: the request moves to accepted — from pending, or from withdrawn, since they
 * lent it anyway — and the book goes on the Borrowed page. One batch, so a pull that runs out of queries can't
 * keep the first without the second; the entry goes in first, and only while the request can still move. False
 * when nothing moved: a repeat, or an answer to a declined request.
 */
export async function acceptOwnRequest(d1: D1Database, requestId: number, loanedOn: string, dueOn: string | null): Promise<boolean> {
  const [, moved] = await d1.batch<{ id: number }>([
    d1
      .prepare(
        `INSERT INTO borrowed_items (connection_id, request_activity_id, their_item_id, title, cover_key, borrowed_on, due_on)
         SELECT connection_id, activity_id, their_item_id, item_title, cover_key, ?2, ?3 FROM borrow_requests
         WHERE id = ?1 AND incoming = 0 AND their_item_id IS NOT NULL AND status IN ('pending', 'withdrawn')
         ON CONFLICT (request_activity_id) DO NOTHING`,
      )
      .bind(requestId, loanedOn, dueOn),
    d1
      .prepare(
        `UPDATE borrow_requests SET status = 'accepted', due_on = ?2, responded_at = datetime('now')
         WHERE id = ?1 AND incoming = 0 AND status IN ('pending', 'withdrawn')
         RETURNING id`,
      )
      .bind(requestId, dueOn),
  ]);
  return moved?.results.length === 1;
}

export async function markBorrowedReturned(
  d1: D1Database,
  connectionId: number,
  requestActivityId: string,
  returnedOn: string,
): Promise<boolean> {
  const rows = await db(d1)
    .update(s.borrowedItems)
    .set({ returnedOn })
    .where(
      and(
        eq(s.borrowedItems.connectionId, connectionId),
        eq(s.borrowedItems.requestActivityId, requestActivityId),
        isNull(s.borrowedItems.returnedOn),
      ),
    )
    .returning({ id: s.borrowedItems.id });
  return rows.length === 1;
}

export async function borrowedReturned(d1: D1Database, requestActivityId: string): Promise<boolean> {
  const [row] = await db(d1)
    .select({ returnedOn: s.borrowedItems.returnedOn })
    .from(s.borrowedItems)
    .where(eq(s.borrowedItems.requestActivityId, requestActivityId));
  return !!row?.returnedOn;
}

export type BorrowedFrom = BorrowedItem & { householdName: string; baseUrl: string };

export async function listBorrowed(d1: D1Database): Promise<BorrowedFrom[]> {
  const rows = await db(d1)
    .select({ item: s.borrowedItems, householdName: s.connections.householdName, baseUrl: s.connections.baseUrl })
    .from(s.borrowedItems)
    .innerJoin(s.connections, eq(s.borrowedItems.connectionId, s.connections.id))
    .orderBy(desc(s.borrowedItems.borrowedOn), desc(s.borrowedItems.id));
  return rows.map((r) => ({ ...r.item, householdName: r.householdName, baseUrl: r.baseUrl }));
}

export async function deleteBorrowed(d1: D1Database, id: number): Promise<void> {
  // Only a book already given back: one still out stays until its return notice arrives.
  await db(d1).delete(s.borrowedItems).where(and(eq(s.borrowedItems.id, id), isNotNull(s.borrowedItems.returnedOn)));
}

/**
 * Everything about connections this household holds, as data it can take elsewhere — the catalog export
 * stays exactly as it is. No keys, and no stored copies of other households' feeds: those are theirs.
 */
export async function federationExport(d1: D1Database): Promise<Record<string, unknown>> {
  const dbi = db(d1);
  const [settings, connectionRows, views, following, commentRows, requests, lent, borrowed] = await Promise.all([
    getFederationSettings(d1),
    dbi
      .select({
        id: s.connections.id,
        householdName: s.connections.householdName,
        address: s.connections.baseUrl,
        status: s.connections.status,
        since: s.connections.createdAt,
        confirmedAt: s.connections.confirmedAt,
      })
      .from(s.connections)
      .where(eq(s.connections.status, 'active')),
    dbi.select().from(s.connectionViews),
    dbi
      .select({
        connectionId: s.feedSubscriptions.connectionId,
        view: s.feedSubscriptions.viewName,
        intervalMinutes: s.feedSubscriptions.intervalMinutes,
        retentionDays: s.feedSubscriptions.retentionDays,
        maxEntries: s.feedSubscriptions.maxEntries,
      })
      .from(s.feedSubscriptions),
    dbi
      .select({
        connectionId: s.comments.connectionId,
        onOurItem: s.comments.ourItemId,
        onTheirItem: s.comments.theirItemId,
        fromUs: s.comments.fromUs,
        author: s.comments.authorName,
        body: s.comments.body,
        createdAt: s.comments.createdAt,
      })
      .from(s.comments)
      .where(isNull(s.comments.deletedAt)),
    dbi
      .select({
        connectionId: s.borrowRequests.connectionId,
        incoming: s.borrowRequests.incoming,
        ourItemId: s.borrowRequests.ourItemId,
        theirItemId: s.borrowRequests.theirItemId,
        title: s.borrowRequests.itemTitle,
        requester: s.borrowRequests.requesterName,
        note: s.borrowRequests.note,
        status: s.borrowRequests.status,
        dueOn: s.borrowRequests.dueOn,
        createdAt: s.borrowRequests.createdAt,
      })
      .from(s.borrowRequests),
    dbi
      .select({
        connectionId: s.connectionLoans.connectionId,
        itemId: s.loans.itemId,
        borrower: s.loans.borrower,
        loanedOn: s.loans.loanedOn,
        dueOn: s.loans.dueOn,
        returnedOn: s.loans.returnedOn,
      })
      .from(s.connectionLoans)
      .innerJoin(s.loans, eq(s.connectionLoans.loanId, s.loans.id)),
    dbi
      .select({
        connectionId: s.borrowedItems.connectionId,
        theirItemId: s.borrowedItems.theirItemId,
        title: s.borrowedItems.title,
        borrowedOn: s.borrowedItems.borrowedOn,
        dueOn: s.borrowedItems.dueOn,
        returnedOn: s.borrowedItems.returnedOn,
      })
      .from(s.borrowedItems),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    library: settings ? { name: settings.householdName, address: settings.baseUrl } : null,
    connections: connectionRows,
    sharedViews: views,
    following,
    comments: commentRows,
    borrowRequests: requests,
    lentToConnections: lent,
    borrowedFromConnections: borrowed,
  };
}

