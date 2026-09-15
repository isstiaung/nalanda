// All D1 access for connections between instances (docs/proposals/connections.md). Its own
// module so queries.ts stays untouched, while src/db/ remains the only code touching D1.
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';
import type { Connection, ConnectionInvite, ConnectionStatus, FederationSettings } from './schema';

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
