// All D1 access for connections between instances (docs/proposals/connections.md). Its own
// module so queries.ts stays untouched, while src/db/ remains the only code touching D1.
import { and, asc, count, desc, eq, gt, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';
import {
  BACKFILL_ENTRIES,
  MAX_FEED_REVIEW_CHARS,
  MAX_STORED_ENTRIES_PER_CONNECTION,
  VOLUME_WINDOW_DAYS,
} from '../federation/config';
import type {
  ActivityKind,
  Connection,
  ConnectionInvite,
  ConnectionStatus,
  ConnectionView,
  FederationSettings,
  FeedSubscription,
  Item,
  ItemStatus,
  MediaType,
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

/** An activity is shared only while its item still shows it: a review entry needs its review. */
const stillShows = sql`(
  (${s.activityLog.kind} = 'reviewed' AND trim(coalesce(${s.items.review}, '')) <> '')
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
  const [row] = await db(d1).insert(s.connectionViews).values(values).returning();
  if (!row) throw new Error('failed to create connection view');
  await recordRecentActivity(d1);
  return row;
}

/**
 * The triggers only record while a view exists, so a household that has just shared its first view
 * would have nothing for connections to follow. This starts the log with recent activity — the last
 * VOLUME_WINDOW_DAYS, newest BACKFILL_ENTRIES — in time order, so ids follow time. OR IGNORE keeps
 * rows the triggers already wrote.
 */
async function recordRecentActivity(d1: D1Database): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO activity_log (item_id, kind, at)
       SELECT item_id, kind, at FROM (
         SELECT id AS item_id, 'reviewed' AS kind, datetime(updated_at) AS at FROM items
           WHERE trim(coalesce(review, '')) <> '' AND datetime(updated_at) > datetime('now', ?1)
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

export async function deleteConnectionView(d1: D1Database, id: number): Promise<void> {
  await db(d1).delete(s.connectionViews).where(eq(s.connectionViews.id, id));
}

export async function countItemsInView(d1: D1Database, view: ConnectionView): Promise<number> {
  const [row] = await db(d1).select({ n: count() }).from(s.items).where(inView(view));
  return row?.n ?? 0;
}

export type SharedActivity = { id: number; kind: ActivityKind; at: string; item: Item };

/**
 * Activity on items in a view with ids in (since, latest], newest first. `latest` is the log's
 * highest id when the read began — the caller's next cursor, whether or not every row fitted.
 */
export async function activityInView(
  d1: D1Database,
  view: ConnectionView,
  since: number,
  limit: number,
): Promise<{ latest: number; rows: SharedActivity[] }> {
  const dbi = db(d1);
  const [top] = await dbi
    .select({ latest: sql`coalesce(max(${s.activityLog.id}), 0)`.mapWith(Number) })
    .from(s.activityLog);
  const latest = top?.latest ?? 0;
  // A cursor past the end came from before a restore: start again rather than wait forever.
  const from = since > latest ? 0 : since;
  const rows = await dbi
    .select({ id: s.activityLog.id, kind: s.activityLog.kind, at: s.activityLog.at, item: s.items })
    .from(s.activityLog)
    .innerJoin(s.items, eq(s.activityLog.itemId, s.items.id))
    .where(and(gt(s.activityLog.id, from), lte(s.activityLog.id, latest), inView(view), stillShows))
    .orderBy(desc(s.activityLog.id))
    .limit(limit);
  return { latest, rows };
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
        + min(coalesce(length(${s.items.review}), 0), ${MAX_FEED_REVIEW_CHARS})), 0)`.mapWith(Number),
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

/** Null when this household already follows that view. */
export async function createSubscription(
  d1: D1Database,
  values: SubscriptionSettings & { connectionId: number; viewId: number; viewName: string },
): Promise<FeedSubscription | null> {
  const [row] = await db(d1).insert(s.feedSubscriptions).values(values).onConflictDoNothing().returning();
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

export async function recordPull(d1: D1Database, id: number, result: { cursor?: number; error: string | null }): Promise<void> {
  await db(d1)
    .update(s.feedSubscriptions)
    .set(result.cursor === undefined ? { lastError: result.error } : { lastError: result.error, cursor: result.cursor })
    .where(eq(s.feedSubscriptions.id, id));
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

export type NewRemoteActivity = { remoteId: number; kind: ActivityKind; publishedAt: string; item: string; bytes: number };

/** One statement whatever the page size: entries travel as a single JSON parameter (D1 caps bound parameters at 100). */
export async function storeEntries(d1: D1Database, subscriptionId: number, entries: NewRemoteActivity[]): Promise<void> {
  if (!entries.length) return;
  await d1
    .prepare(
      `INSERT OR IGNORE INTO remote_activities (subscription_id, remote_id, kind, published_at, item, bytes)
       SELECT ?1, json_extract(value, '$.remoteId'), json_extract(value, '$.kind'),
              json_extract(value, '$.publishedAt'), json_extract(value, '$.item'), json_extract(value, '$.bytes')
       FROM json_each(?2)`,
    )
    .bind(subscriptionId, JSON.stringify(entries))
    .run();
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
  remoteId: number;
  kind: ActivityKind;
  publishedAt: string;
  item: string;
  connectionId: number;
  householdName: string;
  baseUrl: string;
};

/** The newest stored entries from active connections. */
export async function feedEntries(d1: D1Database, limit: number): Promise<StoredEntry[]> {
  return db(d1)
    .select({
      remoteId: s.remoteActivities.remoteId,
      kind: s.remoteActivities.kind,
      publishedAt: s.remoteActivities.publishedAt,
      item: s.remoteActivities.item,
      connectionId: s.connections.id,
      householdName: s.connections.householdName,
      baseUrl: s.connections.baseUrl,
    })
    .from(s.remoteActivities)
    .innerJoin(s.feedSubscriptions, eq(s.remoteActivities.subscriptionId, s.feedSubscriptions.id))
    .innerJoin(s.connections, eq(s.feedSubscriptions.connectionId, s.connections.id))
    .where(eq(s.connections.status, 'active'))
    .orderBy(desc(s.remoteActivities.publishedAt), desc(s.remoteActivities.id))
    .limit(limit);
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
