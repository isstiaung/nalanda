// The messages connected instances exchange (docs/proposals/connections.md §5, §9). Shaped as
// ActivityStreams 2.0 objects — `@context`, `type`, `id`, `actor` — with types of Nalanda's own,
// named for what they mean, since nothing outside Nalanda needs to read them.
import { MAX_AUTHOR_NAME, MAX_BORROW_NOTE_CHARS, MAX_COMMENT_CHARS } from './config';
import { isHouseholdName, normaliseBaseUrl } from './http';
import { isId, isSqlDatetime, isStamp } from './items';
import { isPublicJwk, type PublicJwk } from './keys';

export const AS2_CONTEXT = 'https://www.w3.org/ns/activitystreams';

type Envelope = { '@context': typeof AS2_CONTEXT; id: string; actor: string };

/** Sent to /federation/connect when redeeming an invitation. */
export type ConnectRequest = Envelope & { type: 'ConnectRequest'; name: string; publicKey: PublicJwk; token: string };

export const CONTROL_TYPES = ['ConnectAccept', 'ConnectDecline', 'Disconnect'] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];
/** @deprecated name kept for phase 1 callers */
export type InboxType = ControlType;
export type ControlMessage = Envelope & { type: ControlType };

/** A comment on a review that belongs to one of the two households; `inReplyTo.owner` says which. */
export type CommentCreate = Envelope & {
  type: 'CommentCreate';
  inReplyTo: { owner: string; item: number; stamp: string };
  author: string;
  content: string;
  published: string;
};
/** Withdraws or removes a comment, named by the id of the CommentCreate that made it. */
export type CommentDelete = Envelope & { type: 'CommentDelete'; comment: string };

/** Asks to borrow one of the receiver's books. */
export type BorrowRequest = Envelope & { type: 'BorrowRequest'; item: number; stamp: string; requester: string; note: string | null };
/** The lender's answers, and the borrower's withdrawal, each naming the request by its activity id. */
export type BorrowAccept = Envelope & { type: 'BorrowAccept'; request: string; loanedOn: string; dueOn: string | null };
export type BorrowDecline = Envelope & { type: 'BorrowDecline'; request: string };
export type BorrowWithdraw = Envelope & { type: 'BorrowWithdraw'; request: string };
/** The lender marked the loan returned. Queued by a trigger on loans (migration 0010). */
export type Returned = Envelope & { type: 'Returned'; request: string; returnedOn: string };
export type BorrowMessage = BorrowRequest | BorrowAccept | BorrowDecline | BorrowWithdraw | Returned;

/** Addressed to one household, delivered by push and kept in the sender's outbox for pulling. */
export type DirectedMessage = CommentCreate | CommentDelete | BorrowMessage;
/** Sent to /federation/inbox. Unknown types are rejected. */
export type InboxMessage = ControlMessage | DirectedMessage;

const ACTIVITY_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isActivityId = (v: unknown): v is string => typeof v === 'string' && ACTIVITY_ID.test(v);

export function newActivityId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function connectRequest(actor: string, name: string, publicKey: PublicJwk, token: string): ConnectRequest {
  return { '@context': AS2_CONTEXT, type: 'ConnectRequest', id: newActivityId(), actor, name, publicKey, token };
}

export function inboxMessage(type: ControlType, actor: string): ControlMessage {
  return { '@context': AS2_CONTEXT, type, id: newActivityId(), actor };
}

export function commentCreate(
  actor: string,
  inReplyTo: { owner: string; item: number; stamp: string },
  author: string,
  content: string,
): CommentCreate {
  return {
    '@context': AS2_CONTEXT,
    type: 'CommentCreate',
    id: newActivityId(),
    actor,
    inReplyTo,
    author: author.slice(0, MAX_AUTHOR_NAME),
    content,
    published: sqlNow(),
  };
}

export function commentDelete(actor: string, comment: string): CommentDelete {
  return { '@context': AS2_CONTEXT, type: 'CommentDelete', id: newActivityId(), actor, comment };
}

export function borrowRequest(actor: string, item: number, stamp: string, requester: string, note: string | null): BorrowRequest {
  return {
    '@context': AS2_CONTEXT,
    type: 'BorrowRequest',
    id: newActivityId(),
    actor,
    item,
    stamp,
    requester: requester.slice(0, MAX_AUTHOR_NAME),
    note,
  };
}

export function borrowAccept(actor: string, request: string, loanedOn: string, dueOn: string | null): BorrowAccept {
  return { '@context': AS2_CONTEXT, type: 'BorrowAccept', id: newActivityId(), actor, request, loanedOn, dueOn };
}

export function borrowDecline(actor: string, request: string): BorrowDecline {
  return { '@context': AS2_CONTEXT, type: 'BorrowDecline', id: newActivityId(), actor, request };
}

export function borrowWithdraw(actor: string, request: string): BorrowWithdraw {
  return { '@context': AS2_CONTEXT, type: 'BorrowWithdraw', id: newActivityId(), actor, request };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v);

function isEnvelope(value: unknown): value is Envelope & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v['@context'] === AS2_CONTEXT && isActivityId(v.id) && typeof v.actor === 'string' && normaliseBaseUrl(v.actor) === v.actor;
}

export function parseConnectRequest(value: unknown): ConnectRequest | null {
  if (!isEnvelope(value) || value.type !== 'ConnectRequest') return null;
  const { name, publicKey, token } = value;
  if (!isHouseholdName(name) || !isPublicJwk(publicKey)) return null;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { '@context': AS2_CONTEXT, type: 'ConnectRequest', id: value.id, actor: value.actor, name, publicKey, token };
}

export function parseInboxMessage(value: unknown): InboxMessage | null {
  if (!value || typeof value !== 'object' || !isEnvelope(value)) return null;
  const base = { '@context': AS2_CONTEXT, id: value.id, actor: value.actor } as const;
  if ((CONTROL_TYPES as readonly unknown[]).includes(value.type)) return { ...base, type: value.type as ControlType };

  if (value.type === 'CommentCreate') {
    const reply = value.inReplyTo as Record<string, unknown> | null | undefined;
    const { author, content, published } = value;
    if (!reply || typeof reply !== 'object' || typeof reply.owner !== 'string') return null;
    if (normaliseBaseUrl(reply.owner) !== reply.owner || !isId(reply.item) || !isStamp(reply.stamp)) return null;
    if (typeof author !== 'string' || !author.trim() || author.length > MAX_AUTHOR_NAME) return null;
    if (typeof content !== 'string' || !content.trim() || content.length > MAX_COMMENT_CHARS) return null;
    if (!isSqlDatetime(published)) return null;
    return {
      ...base,
      type: 'CommentCreate',
      inReplyTo: { owner: reply.owner, item: reply.item, stamp: reply.stamp },
      author,
      content,
      published,
    };
  }
  if (value.type === 'CommentDelete') {
    return isActivityId(value.comment) ? { ...base, type: 'CommentDelete', comment: value.comment } : null;
  }

  switch (value.type) {
    case 'BorrowRequest': {
      const { item, stamp, requester, note } = value;
      if (!isId(item) || !isStamp(stamp) || typeof requester !== 'string' || !requester.trim() || requester.length > MAX_AUTHOR_NAME) return null;
      if (!(note === null || (typeof note === 'string' && note.length <= MAX_BORROW_NOTE_CHARS))) return null;
      return { ...base, type: 'BorrowRequest', item, stamp, requester, note };
    }
    case 'BorrowAccept': {
      const { request, loanedOn, dueOn } = value;
      if (!isActivityId(request) || !isDate(loanedOn) || !(dueOn === null || isDate(dueOn))) return null;
      return { ...base, type: 'BorrowAccept', request, loanedOn, dueOn };
    }
    case 'BorrowDecline':
    case 'BorrowWithdraw':
      return isActivityId(value.request) ? { ...base, type: value.type, request: value.request } : null;
    case 'Returned':
      return isActivityId(value.request) && isDate(value.returnedOn)
        ? { ...base, type: 'Returned', request: value.request, returnedOn: value.returnedOn }
        : null;
  }
  return null;
}

export const isDirected = (m: InboxMessage): m is DirectedMessage => !(CONTROL_TYPES as readonly string[]).includes(m.type);
