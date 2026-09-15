// Messages addressed to one connection — comments, borrowing, return notices (docs/proposals/connections.md
// §8–§10). Each is pushed once, after the response, and kept in the outbox for that connection to pull. The pull
// is the guarantee and the push only makes it fast: no queue, nothing running in the background. Pushes that
// didn't land — and return notices a trigger queued without pushing — are retried on later page loads.
import type { Context } from 'hono';
import {
  claimOutbox,
  claimPushAttempt,
  commentStates,
  countPush,
  dropOutbox,
  dueOutboxes,
  enqueueOutbox,
  markDelivered,
  pruneTombstones,
  recordOutboxPull,
  requestStatuses,
  returnedRequests,
  undeliveredOutbox,
} from '../db/federation';
import type { Connection, FederationSettings } from '../db/schema';
import type { AppEnv } from '../env';
import { budgeted, isBudgetSpent, type Budget } from './budget';
import {
  MAX_OUTBOX_RESPONSE_BYTES,
  MAX_PUSHES_PER_DAY,
  OUTBOX_APPLY_PER_PULL,
  OUTBOX_PAGE_SIZE,
  OUTBOX_PULL_MINUTES,
  OUTBOX_PULL_QUERIES,
  PUSH_RETRIES_PER_REQUEST,
  PUSH_RETRY_DAYS,
  PUSH_RETRY_MINUTES,
} from './config';
import { receiveDirected } from './directed';
import { getSigned, postSigned } from './http';
import { isId } from './items';
import type { Identity } from './keys';
import { isDirected, parseInboxMessage, type DirectedMessage } from './messages';

const delivered = (status: number) => status >= 200 && status < 300;
/** An answer that won't change on a retry: the message is refused for good. */
const refused = (status: number) => status >= 400 && status < 500 && status !== 429;

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
        if (res && delivered(res.status)) await markDelivered(c.env.DB, row.id);
      })
      .catch((err) => console.error('outbox push failed', err)),
  );
}

/**
 * Queues a message and pushes it now, waiting for the answer — for a request whose sender needs to know at
 * once. Returns their status, or null when they couldn't be reached (the outbox keeps it then). A refusal
 * leaves nothing to deliver, so it leaves the outbox too.
 */
export async function sendNow(
  d1: D1Database,
  identity: Identity,
  settings: FederationSettings,
  connection: Connection,
  message: DirectedMessage,
): Promise<number | null> {
  const row = await enqueueOutbox(d1, connection.id, message);
  const res = await postSigned(identity, settings.baseUrl, connection.baseUrl, '/federation/inbox', message);
  if (!res) return null;
  if (delivered(res.status)) await markDelivered(d1, row.id);
  else if (refused(res.status)) await dropOutbox(d1, row.id);
  return res.status;
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

/** Which of a page's messages were already applied — through a push, or an earlier pull. At most three queries. */
async function appliedAlready(db: D1Database, messages: DirectedMessage[]): Promise<(m: DirectedMessage) => boolean> {
  const commentIds: string[] = [];
  const requestIds: string[] = [];
  const returnIds: string[] = [];
  for (const m of messages) {
    if (m.type === 'CommentCreate') commentIds.push(m.id);
    else if (m.type === 'CommentDelete') commentIds.push(m.comment);
    else if (m.type === 'BorrowRequest') requestIds.push(m.id);
    else if (m.type === 'Returned') returnIds.push(m.request);
    else requestIds.push(m.request);
  }
  const comments = await commentStates(db, commentIds);
  const requests = await requestStatuses(db, requestIds);
  const returned = await returnedRequests(db, returnIds);
  return (m) => {
    switch (m.type) {
      case 'CommentCreate':
        return comments.has(m.id);
      case 'CommentDelete':
        return comments.get(m.comment) === 'deleted';
      case 'BorrowRequest':
        return requests.has(m.id);
      case 'BorrowWithdraw':
      case 'BorrowDecline': {
        const status = requests.get(m.request);
        return status !== undefined && status !== 'pending';
      }
      case 'BorrowAccept': {
        const status = requests.get(m.request);
        return status === 'accepted' || status === 'declined';
      }
      case 'Returned':
        return returned.has(m.request);
    }
  };
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

/** Retries a push that didn't land, or pushes one a trigger queued — a few per page load, each now and then. */
async function retryPushes(db: D1Database, identity: Identity, settings: FederationSettings) {
  for (const row of await undeliveredOutbox(db, PUSH_RETRIES_PER_REQUEST, PUSH_RETRY_MINUTES, PUSH_RETRY_DAYS)) {
    if (!(await claimPushAttempt(db, row.id, row.attemptedAt))) continue;
    const res = await postSigned(identity, settings.baseUrl, row.connection.baseUrl, '/federation/inbox', JSON.parse(row.message));
    if (res && delivered(res.status)) await markDelivered(db, row.id);
  }
}

/**
 * Pulls due outboxes, least recently pulled first, one at a time while `budget` lasts, then retries an
 * undelivered push of our own if the budget allows.
 */
export async function refreshOutboxes(d1: D1Database, identity: Identity, settings: FederationSettings, budget: Budget): Promise<void> {
  const db = budgeted(d1, budget);
  try {
    while (budget.left >= OUTBOX_PULL_QUERIES) {
      const [connection] = await dueOutboxes(db, OUTBOX_PULL_MINUTES, 1);
      if (!connection || !(await claimOutbox(db, connection.id, connection.outboxPulledAt))) break;
      try {
        await pullOutbox(db, d1, identity, settings, connection);
      } catch (err) {
        if (isBudgetSpent(err)) return;
        console.error('outbox pull failed', err);
      }
    }
    await retryPushes(db, identity, settings);
  } catch (err) {
    if (!isBudgetSpent(err)) throw err;
  }
}
