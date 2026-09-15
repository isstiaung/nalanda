// Messages addressed to one connection — comments and their deletions (docs/proposals/connections.md §8,
// §9). Each is pushed once, after the response, and kept in the outbox for that connection to pull. The pull
// is the guarantee and the push only makes it fast: no retry queue, nothing running in the background.
import type { Context } from 'hono';
import {
  claimOutbox,
  commentState,
  countPush,
  dueOutboxes,
  enqueueOutbox,
  markDelivered,
  recordOutboxPull,
} from '../db/federation';
import type { Connection, FederationSettings } from '../db/schema';
import type { AppEnv } from '../env';
import { receiveDirected } from './comments';
import {
  MAX_OUTBOX_RESPONSE_BYTES,
  MAX_PUSHES_PER_DAY,
  OUTBOX_PAGE_SIZE,
  OUTBOX_PULL_MINUTES,
  OUTBOXES_PER_REQUEST,
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

/** Whether a pulled message has already been applied — through a push, or an earlier pull. */
async function alreadyApplied(d1: D1Database, message: DirectedMessage): Promise<boolean> {
  if (message.type === 'CommentCreate') return (await commentState(d1, message.id)) !== 'absent';
  return (await commentState(d1, message.comment)) === 'deleted';
}

async function pullOutbox(d1: D1Database, identity: Identity, settings: FederationSettings, connection: Connection) {
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
  for (const { seq, message } of page.messages) {
    if (seq <= cursor) continue; // in order, never backwards
    // Only what that household itself wrote: a message naming anyone else as its actor is skipped.
    if (message && message.actor === connection.baseUrl && !(await alreadyApplied(d1, message))) {
      if (!(await countPush(d1, connection.id, MAX_PUSHES_PER_DAY))) {
        // Past today's limit: stop here, and the rest is pulled tomorrow.
        await recordOutboxPull(d1, connection.id, { cursor });
        return;
      }
      await receiveDirected(d1, settings, connection, message);
    }
    cursor = seq;
  }
  await recordOutboxPull(d1, connection.id, { cursor, again: page.more });
}

/** Pulls the outboxes of a few active connections, least recently pulled first, at most every few minutes each. */
export async function refreshOutboxes(d1: D1Database, identity: Identity, settings: FederationSettings): Promise<void> {
  for (const connection of await dueOutboxes(d1, OUTBOX_PULL_MINUTES, OUTBOXES_PER_REQUEST)) {
    if (!(await claimOutbox(d1, connection.id, connection.outboxPulledAt))) continue;
    try {
      await pullOutbox(d1, identity, settings, connection);
    } catch (err) {
      console.error('outbox pull failed', err);
    }
  }
}
