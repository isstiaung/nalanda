// Messages addressed to one connection — comments and their deletions (docs/proposals/connections.md §8,
// §9). Each is pushed once, after the response, and kept in the outbox for that connection to pull. The pull
// is the guarantee and the push only makes it fast: no retry queue, nothing running in the background.
import type { Context } from 'hono';
import {
  claimOutbox,
  commentStates,
  countPush,
  dueOutboxes,
  enqueueOutbox,
  markDelivered,
  pruneTombstones,
  recordOutboxPull,
} from '../db/federation';
import type { Connection, FederationSettings } from '../db/schema';
import type { AppEnv } from '../env';
import { budgeted, isBudgetSpent, type Budget } from './budget';
import { receiveDirected } from './comments';
import {
  MAX_OUTBOX_RESPONSE_BYTES,
  MAX_PUSHES_PER_DAY,
  OUTBOX_APPLY_PER_PULL,
  OUTBOX_PAGE_SIZE,
  OUTBOX_PULL_MINUTES,
  OUTBOX_PULL_QUERIES,
} from './config';
import { getSigned, postSigned } from './http';
import { isId } from './items';
import type { Identity } from './keys';
import { isDirected, parseInboxMessage, type DirectedMessage } from './messages';

/** Queues a message for a connection, then pushes it after the response. */
export async function sendToConnection(
  c: Context<AppEnv>,
  identity: Identity,
  settings: FederationSettings,
  connection: Connection,
  message: DirectedMessage,
): Promise<void> {
  const row = await enqueueOutbox(c.env.DB, connection.id, message);
  c.executionCtx.waitUntil(
    postSigned(identity, settings.baseUrl, connection.baseUrl, '/federation/inbox', message)
      .then(async (res) => {
        if (res && res.status >= 200 && res.status < 300) await markDelivered(c.env.DB, row.id);
      })
      .catch((err) => console.error('outbox push failed', err)),
  );
}

// ---------- pulling a connection's outbox ----------

type OutboxPage = { more: boolean; messages: Array<{ seq: number; message: DirectedMessage | null }> };

export function parseOutboxPage(value: unknown): OutboxPage | null {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!v || typeof v.more !== 'boolean' || !Array.isArray(v.messages)) return null;
  const messages: OutboxPage['messages'] = [];
  for (const raw of v.messages.slice(0, OUTBOX_PAGE_SIZE)) {
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (!entry || !isId(entry.seq)) continue;
    const parsed = parseInboxMessage(entry.message);
    messages.push({ seq: entry.seq, message: parsed && isDirected(parsed) ? parsed : null });
  }
  return { more: v.more, messages };
}

/** Which of a page's messages were already applied — through a push, or an earlier pull. One query for the page. */
async function appliedAlready(db: D1Database, messages: DirectedMessage[]): Promise<(m: DirectedMessage) => boolean> {
  const states = await commentStates(
    db,
    messages.map((m) => (m.type === 'CommentCreate' ? m.id : m.comment)),
  );
  return (m) => (m.type === 'CommentCreate' ? states.has(m.id) : states.get(m.comment) === 'deleted');
}

/**
 * One pull of a connection's outbox: at most OUTBOX_APPLY_PER_PULL new messages, in order. Where it got to is
 * saved however the pull ends — through the unbudgeted handle, since running out of budget is one of the ways
 * — so a backlog drains across page loads instead of starting over.
 */
async function pullOutbox(db: D1Database, d1: D1Database, identity: Identity, settings: FederationSettings, connection: Connection) {
  const res = await getSigned(
    identity,
    settings.baseUrl,
    connection.baseUrl,
    `/federation/outbox?since=${connection.outboxCursor}`,
    MAX_OUTBOX_RESPONSE_BYTES,
  );
  const page = res?.status === 200 ? parseOutboxPage(res.body) : null;
  if (!page) return;

  let cursor = connection.outboxCursor;
  let finished = false;
  try {
    const theirs = page.messages.filter(
      (entry): entry is { seq: number; message: DirectedMessage } =>
        entry.seq > cursor && entry.message !== null && entry.message.actor === connection.baseUrl,
    );
    const applied = await appliedAlready(db, theirs.map((entry) => entry.message));
    let count = 0;
    for (const { seq, message } of page.messages) {
      if (seq <= cursor) continue; // in order, never backwards
      // Only what that household itself wrote: a message naming anyone else as its actor is skipped.
      if (message && message.actor === connection.baseUrl && !applied(message)) {
        if (count === OUTBOX_APPLY_PER_PULL) return; // the rest on a later page load
        if (!(await countPush(db, connection.id, MAX_PUSHES_PER_DAY))) {
          finished = true; // past today's limit: this waits for tomorrow
          return;
        }
        await receiveDirected(db, settings, connection, message);
        count += 1;
      }
      cursor = seq;
    }
    finished = !page.more;
    await pruneTombstones(db);
  } finally {
    await recordOutboxPull(d1, connection.id, { cursor, again: !finished && cursor > connection.outboxCursor });
  }
}

/** Pulls due outboxes, least recently pulled first, one at a time while `budget` lasts. */
export async function refreshOutboxes(d1: D1Database, identity: Identity, settings: FederationSettings, budget: Budget): Promise<void> {
  const db = budgeted(d1, budget);
  try {
    while (budget.left >= OUTBOX_PULL_QUERIES) {
      const [connection] = await dueOutboxes(db, OUTBOX_PULL_MINUTES, 1);
      if (!connection || !(await claimOutbox(db, connection.id, connection.outboxPulledAt))) return;
      try {
        await pullOutbox(db, d1, identity, settings, connection);
      } catch (err) {
        if (isBudgetSpent(err)) return;
        console.error('outbox pull failed', err);
      }
    }
  } catch (err) {
    if (!isBudgetSpent(err)) throw err;
  }
}
