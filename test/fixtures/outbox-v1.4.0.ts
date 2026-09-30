// A FIXTURE, not app code: how v1.4.0 takes a directed message in — pulled from a connection's outbox, or pushed to its
// inbox. parseOutboxPage and its type are extracted verbatim (exported here) with `git show v1.4.0:src/federation/outbox.ts`; inboxStep wraps, word for
// word, the two lines of v1.4.0:src/federation/routes.tsx's POST /federation/inbox that every message passes after its
// signature checks and before anything is written or dispatched:
//
//   const message = parseInboxMessage(parseJson(raw));
//   if (!message || message.actor !== peer.connection.baseUrl) return c.json({ error: 'malformed message' }, 400);
//
// Its imports point at ./messages-v1.4.0.ts, and at src/ for OUTBOX_PAGE_SIZE, isId and parseJson, unchanged since 1.4.0.
// 1.5.0's outbox.ts and inbox route are the same. Used by test/recommend-compat.spec.ts (ARCH.md §16 #58).
// Regenerate only to model a different release; never edit it by hand.
import { OUTBOX_PAGE_SIZE } from '../../src/federation/config';
import { parseJson } from '../../src/federation/http';
import { isId } from '../../src/federation/items';
import { isDirected, parseInboxMessage, type DirectedMessage } from './messages-v1.4.0';

// v1.4.0:src/federation/outbox.ts
export type OutboxPage = { more: boolean; messages: Array<{ seq: number; message: DirectedMessage | null }> };

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

// v1.4.0:src/federation/routes.tsx, POST /federation/inbox: the parse step, as a function of the body and the sender
export function inboxStep(raw: Uint8Array, peerBaseUrl: string): { status: 400; body: { error: string } } | null {
  const message = parseInboxMessage(parseJson(raw));
  if (!message || message.actor !== peerBaseUrl) return { status: 400, body: { error: 'malformed message' } };
  return null;
}
