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

/** Marks an invite used. False if another redemption won the race, or it expired meanwhile. */
export async function consumeInvite(d1: D1Database, id: number): Promise<boolean> {
  const rows = await db(d1)
    .update(s.connectionInvites)
    .set({ usedAt: sql`(datetime('now'))` })
    .where(redeemable(eq(s.connectionInvites.id, id)))
    .returning({ id: s.connectionInvites.id });
  return rows.length === 1;
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

/** True the first time an activity id arrives; false on a replay. Prunes entries older than an hour. */
export async function markActivitySeen(d1: D1Database, activityId: string): Promise<boolean> {
  const dbi = db(d1);
  const rows = await dbi
    .insert(s.federationSeen)
    .values({ activityId })
    .onConflictDoNothing()
    .returning({ activityId: s.federationSeen.activityId });
  await dbi.delete(s.federationSeen).where(sql`${s.federationSeen.seenAt} < datetime('now', '-1 hour')`);
  return rows.length === 1;
}
